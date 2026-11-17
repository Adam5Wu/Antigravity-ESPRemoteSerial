/*
 * Serial Monitor Auxiliary Side Pane Frontend.
 *
 * Pure UI client for shared `serial_monitor.py` brokers via the Node.js sidecar:
 * - Auto-discovers running brokers started by any conversation + persisted bookmarks
 * - Starts new brokers with (host, port, baud) or attaches to existing ones
 * - Cursor long-polls `/api/stream` with rAF-batched DOM rendering & ANSI/ESP-IDF coloring
 * - Releases its UI watch lease on Detach or tab close so brokers still idle-exit after 60s
 */
(() => {
  const TARGETS_POLL_MS = 2500;
  const MAX_CLIENT_LINES = 5000;
  const PRESET_BAUDS = new Set(['74880', '115200', '230400', '460800', '921600', '2000000', '57600', '9600']);

  const $ = (id) => document.getElementById(id);

  const clientId = `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const state = {
    targets: [],
    selectedKey: null,
    initialLoadDone: false,

    // Stream state for selectedKey
    attached: false,
    connecting: false,
    sessionId: null,
    streamState: 'detached', // connecting | attached | reconnecting | stopped | detached
    sinceSeq: 0,
    sinceStateSeq: 0,
    liveBroker: null,
    pollEpoch: 0,
    pollAbort: null,

    // Log buffer & viewport state
    lines: [], // { seq, ts, fullTs, kind, text, plainText }
    clearedUpToSeq: 0,
    pendingRenderQueue: [],
    rafScheduled: false,
    following: true,
    unreadCount: 0,

    // View toggles & search/highlight/filter
    showTs: true,
    wrapLines: true,
    filterOnly: false,
    filterRaw: '',
    querySpec: null,

    // Drawer / toast / visibility
    drawerOpen: false,
    toastTimer: null,
    actionBusy: false,
    paneVisible: true,
    pausedByHide: false,
    hideDetachTimer: null,
  };

  // ---------- Host Theme Synchronization ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = computed.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncThemeScheme();
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Sidecar API Helpers ----------
  function apiFetch(path, options = {}) {
    if (window.sidecar?.fetch) {
      return window.sidecar.fetch(path, options);
    }
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(path, { ...options, headers });
  }

  async function apiJson(path, options = {}) {
    const res = await apiFetch(path, options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function hideToast() {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    const el = $('toast');
    el.classList.remove('visible');
    el.setAttribute('aria-hidden', 'true');
  }

  function showToast(msg, isError = false, ttlMs = 3200) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', Boolean(isError));
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('visible');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      state.toastTimer = null;
      el.classList.remove('visible');
      el.setAttribute('aria-hidden', 'true');
    }, ttlMs);
  }

  // ---------- Formatting & ANSI Parsing ----------
  // eslint-disable-next-line no-control-regex
  const ANSI_TOKEN_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]/g;

  function stripAnsi(str) {
    return String(str || '').replace(ANSI_TOKEN_RE, '');
  }

  const SGR_FG_CLASSES = {
    30: 'fg-gray',
    90: 'fg-gray',
    31: 'fg-red',
    91: 'fg-red',
    32: 'fg-green',
    92: 'fg-green',
    33: 'fg-yellow',
    93: 'fg-yellow',
    34: 'fg-blue',
    94: 'fg-blue',
    35: 'fg-magenta',
    95: 'fg-magenta',
    36: 'fg-cyan',
    96: 'fg-cyan',
  };

  function detectHeuristicClass(plain) {
    if (/^\s*E\s*\(\d+\)/.test(plain) || /\b(Guru Meditation Error|Backtrace:|PANIC|FATAL)\b/i.test(plain)) {
      return 'lvl-err';
    }
    if (/^\s*W\s*\(\d+\)/.test(plain) || /^\s*\[?WARN(ING)?\]?[:\s]/i.test(plain)) {
      return 'lvl-warn';
    }
    if (/^\s*I\s*\(\d+\)/.test(plain)) {
      return 'lvl-info';
    }
    return '';
  }

  function parseAnsiSegments(rawText) {
    const text = String(rawText || '');
    if (!text.includes('\x1b[')) {
      return [
        {
          text,
          fgClass: detectHeuristicClass(text),
          bold: false,
          dim: false,
        },
      ];
    }

    const segments = [];
    let fgClass = '';
    let bold = false;
    let dim = false;
    let lastIdx = 0;
    ANSI_TOKEN_RE.lastIndex = 0;

    const pushSeg = (segText) => {
      if (!segText) return;
      segments.push({ text: segText, fgClass, bold, dim });
    };

    let match;
    while ((match = ANSI_TOKEN_RE.exec(text)) !== null) {
      pushSeg(text.slice(lastIdx, match.index));
      lastIdx = ANSI_TOKEN_RE.lastIndex;

      if (match[1] !== undefined) {
        const codes = match[1] === '' ? [0] : match[1].split(';').map((c) => Number.parseInt(c || '0', 10));
        for (const code of codes) {
          if (code === 0) {
            fgClass = '';
            bold = false;
            dim = false;
          } else if (code === 1) {
            bold = true;
          } else if (code === 2) {
            dim = true;
          } else if (code === 22) {
            bold = false;
            dim = false;
          } else if (code === 39) {
            fgClass = '';
          } else if (SGR_FG_CLASSES[code]) {
            fgClass = SGR_FG_CLASSES[code];
          }
        }
      }
    }
    pushSeg(text.slice(lastIdx));
    return segments;
  }

  function createStyledRunNode(sliceText, seg, isHighlighted) {
    if (isHighlighted) {
      const mark = document.createElement('mark');
      mark.className = 'match-hl';
      if (seg.bold) mark.classList.add('ansi-bold');
      mark.textContent = sliceText;
      return mark;
    }
    if (!seg.fgClass && !seg.bold && !seg.dim) {
      return document.createTextNode(sliceText);
    }
    const span = document.createElement('span');
    if (seg.fgClass) span.classList.add(seg.fgClass);
    if (seg.bold) span.classList.add('ansi-bold');
    if (seg.dim) span.classList.add('ansi-dim');
    span.textContent = sliceText;
    return span;
  }

  function appendSegmentsWithHighlights(container, segments, ranges) {
    if (!ranges || ranges.length === 0) {
      if (segments.length === 1 && !segments[0].bold && !segments[0].dim) {
        container.textContent = segments[0].text;
        if (segments[0].fgClass) container.classList.add(segments[0].fgClass);
        return;
      }
      for (const seg of segments) {
        if (!seg.text) continue;
        container.appendChild(createStyledRunNode(seg.text, seg, false));
      }
      return;
    }

    let charOffset = 0;
    let rIdx = 0;
    for (const seg of segments) {
      const len = seg.text.length;
      if (len === 0) continue;
      const segStart = charOffset;
      const segEnd = segStart + len;
      charOffset = segEnd;

      while (rIdx < ranges.length && ranges[rIdx][1] <= segStart) {
        rIdx++;
      }

      let cursor = segStart;
      while (cursor < segEnd) {
        if (rIdx >= ranges.length || ranges[rIdx][0] >= segEnd) {
          container.appendChild(createStyledRunNode(seg.text.slice(cursor - segStart, segEnd - segStart), seg, false));
          cursor = segEnd;
        } else if (cursor < ranges[rIdx][0]) {
          const plainEnd = Math.min(segEnd, ranges[rIdx][0]);
          container.appendChild(createStyledRunNode(seg.text.slice(cursor - segStart, plainEnd - segStart), seg, false));
          cursor = plainEnd;
        } else {
          const hlEnd = Math.min(segEnd, ranges[rIdx][1]);
          container.appendChild(createStyledRunNode(seg.text.slice(cursor - segStart, hlEnd - segStart), seg, true));
          cursor = hlEnd;
          if (cursor >= ranges[rIdx][1]) {
            rIdx++;
          }
        }
      }
    }
  }

  function formatBytes(n) {
    const bytes = Number(n) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  // ---------- Search / Highlight / Filter Logic ----------
  function compileQuery(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
      const lastSlash = trimmed.lastIndexOf('/');
      const pattern = trimmed.slice(1, lastSlash);
      const rawFlags = trimmed.slice(lastSlash + 1);
      if (pattern && /^[gimsuy]*$/.test(rawFlags)) {
        try {
          const flags = rawFlags.includes('g') ? rawFlags : `${rawFlags}g`;
          const re = new RegExp(pattern, flags);
          return {
            findRanges(str) {
              if (!str) return { matched: false, ranges: [] };
              re.lastIndex = 0;
              const ranges = [];
              let matched = false;
              let m;
              let guard = 0;
              while ((m = re.exec(str)) !== null && guard++ < 256) {
                matched = true;
                if (m[0].length === 0) {
                  re.lastIndex = m.index + 1;
                  if (re.lastIndex > str.length) break;
                  continue;
                }
                ranges.push([m.index, m.index + m[0].length]);
              }
              return { matched, ranges };
            },
          };
        } catch {
          // Fall through to case-insensitive substring while regex is incomplete
        }
      }
    }

    const needle = trimmed.toLowerCase();
    const nLen = needle.length;
    return {
      findRanges(str) {
        if (!str) return { matched: false, ranges: [] };
        const lower = str.toLowerCase();
        const ranges = [];
        let pos = 0;
        let guard = 0;
        while (pos <= lower.length - nLen && guard++ < 256) {
          const idx = lower.indexOf(needle, pos);
          if (idx === -1) break;
          ranges.push([idx, idx + nLen]);
          pos = idx + nLen;
        }
        return { matched: ranges.length > 0, ranges };
      },
    };
  }

  function getEntryDisplayBody(entry) {
    if (entry.kind === 'mark') return `MARK · ${entry.text}`;
    if (entry.kind === 'meta') return entry.text;
    return entry.plainText;
  }

  function evaluateEntryMatch(entry) {
    if (!state.querySpec) {
      return { matched: false, bodyRanges: null, tsRanges: null };
    }
    const bodyRes = state.querySpec.findRanges(getEntryDisplayBody(entry));
    const tsRes =
      state.showTs && entry.ts ? state.querySpec.findRanges(entry.ts) : { matched: false, ranges: [] };
    return {
      matched: bodyRes.matched || tsRes.matched,
      bodyRanges: bodyRes.ranges,
      tsRanges: tsRes.ranges,
    };
  }

  // ---------- DOM Log Rendering ----------
  function buildLineElement(entry, evalRes) {
    const row = document.createElement('div');
    row.className = `log-line kind-${entry.kind}`;
    row.dataset.seq = String(entry.seq);

    if (evalRes?.matched) {
      row.dataset.matched = '1';
      // Highlight entire row ONLY when Filter mode is off
      if (!state.filterOnly) {
        row.classList.add('line-matched');
      }
    }

    if (entry.kind === 'meta') {
      if (/\b(Paused|Reconnect|dropped|disconnected|Stopping|stopped)\b/i.test(entry.plainText)) {
        row.classList.add('meta-warn');
      } else if (/\b(Connected|Reconnected|Resuming|started)\b/i.test(entry.plainText)) {
        row.classList.add('meta-ok');
      }
    }

    if (entry.ts) {
      const tsEl = document.createElement('span');
      tsEl.className = 'log-ts';
      appendSegmentsWithHighlights(
        tsEl,
        [{ text: entry.ts, fgClass: '', bold: false, dim: false }],
        evalRes?.tsRanges
      );
      if (entry.fullTs) tsEl.title = entry.fullTs;
      row.appendChild(tsEl);
    }

    const txtEl = document.createElement('span');
    txtEl.className = 'log-text';
    if (entry.kind === 'mark') {
      appendSegmentsWithHighlights(
        txtEl,
        [{ text: `MARK · ${entry.text}`, fgClass: '', bold: false, dim: false }],
        evalRes?.bodyRanges
      );
    } else if (entry.kind === 'meta') {
      appendSegmentsWithHighlights(
        txtEl,
        [{ text: entry.text, fgClass: '', bold: false, dim: false }],
        evalRes?.bodyRanges
      );
    } else {
      appendSegmentsWithHighlights(txtEl, parseAnsiSegments(entry.text), evalRes?.bodyRanges);
    }
    row.appendChild(txtEl);
    return row;
  }

  function updateFilterCounter() {
    const countEl = $('filter-count');
    const clearBtn = $('filter-clear');
    const hasQuery = Boolean(state.querySpec);
    clearBtn.classList.toggle('hidden', !state.filterRaw.length);
    if (!hasQuery) {
      countEl.classList.add('hidden');
      return;
    }
    let totalPool = 0;
    let matched = 0;
    for (const entry of state.lines) {
      if (entry.seq <= state.clearedUpToSeq) continue;
      totalPool++;
      if (evaluateEntryMatch(entry).matched) {
        matched++;
      }
    }
    countEl.textContent = `${matched}/${totalPool}`;
    countEl.classList.remove('hidden');
  }

  function updateFollowPill() {
    const pill = $('follow-pill');
    if (state.following) {
      pill.classList.add('hidden');
      state.unreadCount = 0;
    } else {
      pill.textContent = state.unreadCount > 0 ? `↓ Follow (${state.unreadCount} new)` : '↓ Jump to bottom';
      pill.classList.remove('hidden');
    }
  }

  function scrollToBottom() {
    const vp = $('log-viewport');
    vp.scrollTop = vp.scrollHeight;
    state.following = true;
    state.unreadCount = 0;
    updateFollowPill();
  }

  function renderFullViewport() {
    state.pendingRenderQueue = [];
    const vp = $('log-viewport');
    vp.textContent = '';

    const frag = document.createDocumentFragment();
    let count = 0;
    for (const entry of state.lines) {
      if (entry.seq <= state.clearedUpToSeq) continue;
      const evalRes = evaluateEntryMatch(entry);
      if (state.filterOnly && state.querySpec && !evalRes.matched) continue;
      frag.appendChild(buildLineElement(entry, evalRes));
      count++;
    }

    if (count === 0) {
      const hint = document.createElement('div');
      hint.className = 'log-empty-hint';
      if (state.filterOnly && state.querySpec) {
        hint.textContent = 'No lines match the current filter.';
      } else if (state.connecting) {
        hint.textContent = 'Connecting to serial broker…';
      } else if (state.attached) {
        hint.textContent = 'Attached — waiting for UART output…';
      } else {
        const tgt = getSelectedTarget();
        hint.textContent = tgt?.active
          ? 'Broker is running in background. Click Attach to stream live output.'
          : 'Broker is idle. Click Start to connect to this board.';
      }
      frag.appendChild(hint);
    }

    vp.appendChild(frag);
    updateFilterCounter();
    if (state.following) {
      scrollToBottom();
    } else {
      updateFollowPill();
    }
  }

  function flushPendingLines() {
    state.rafScheduled = false;
    if (state.pendingRenderQueue.length === 0) return;

    const batch = state.pendingRenderQueue;
    state.pendingRenderQueue = [];

    const vp = $('log-viewport');
    const emptyHint = vp.querySelector('.log-empty-hint');

    const frag = document.createDocumentFragment();
    let appended = 0;
    for (const entry of batch) {
      if (entry.seq <= state.clearedUpToSeq) continue;
      const evalRes = evaluateEntryMatch(entry);
      if (state.filterOnly && state.querySpec && !evalRes.matched) continue;
      frag.appendChild(buildLineElement(entry, evalRes));
      appended++;
    }

    if (appended > 0) {
      if (emptyHint) emptyHint.remove();
      vp.appendChild(frag);

      // Trim excess DOM nodes when exceeding MAX_CLIENT_LINES
      while (vp.childElementCount > MAX_CLIENT_LINES) {
        vp.firstElementChild?.remove();
      }
    }

    updateFilterCounter();

    if (state.following) {
      vp.scrollTop = vp.scrollHeight;
    } else if (appended > 0) {
      state.unreadCount += appended;
      updateFollowPill();
    }
  }

  function enqueueLines(newEntries) {
    if (!Array.isArray(newEntries) || newEntries.length === 0) return;

    let lastKnownSeq = state.lines.length > 0 ? state.lines[state.lines.length - 1].seq : 0;
    for (const raw of newEntries) {
      if (raw.seq <= lastKnownSeq) continue;
      lastKnownSeq = raw.seq;
      const entry = {
        ...raw,
        plainText: stripAnsi(raw.text),
      };
      state.lines.push(entry);
      state.pendingRenderQueue.push(entry);
    }

    if (state.lines.length > MAX_CLIENT_LINES) {
      state.lines.splice(0, state.lines.length - MAX_CLIENT_LINES);
    }

    if (!state.rafScheduled && state.pendingRenderQueue.length > 0) {
      state.rafScheduled = true;
      requestAnimationFrame(flushPendingLines);
    }
  }

  // ---------- Target & Toolbar UI Rendering ----------
  function getSelectedTarget() {
    if (!state.selectedKey) return null;
    return state.targets.find((t) => t.targetKey === state.selectedKey) || null;
  }

  function effectiveBrokerInfo(target) {
    if (!target) return null;
    if (state.selectedKey === target.targetKey && state.liveBroker) {
      return {
        pid: state.liveBroker.pid,
        state: state.liveBroker.state || 'streaming',
        baud: state.liveBroker.baud || target.configuredBaud,
        watcherCount: Number(state.liveBroker.watcher_count ?? state.liveBroker.watcherCount ?? 0),
        watchers: state.liveBroker.watchers || [],
        leaseHolder: state.liveBroker.lease_holder || state.liveBroker.leaseHolder || null,
        linesLogged: Number(state.liveBroker.lines_logged ?? state.liveBroker.linesLogged ?? 0),
        bytesRx: Number(state.liveBroker.bytes_rx ?? state.liveBroker.bytesRx ?? 0),
        logFile: state.liveBroker.log_file || state.liveBroker.logFile || null,
      };
    }
    return target.broker || null;
  }

  function renderHeaderAndTargets() {
    const activeCount = state.targets.filter((t) => t.active).length;
    const badge = $('header-badge');
    if (state.attached) {
      badge.textContent = activeCount > 1 ? `Attached · ${activeCount} active` : 'Attached';
      badge.classList.add('live');
    } else if (activeCount > 0) {
      badge.textContent = `${activeCount} active`;
      badge.classList.add('live');
    } else {
      badge.textContent = 'Idle';
      badge.classList.remove('live');
    }

    const strip = $('target-strip');
    strip.textContent = '';
    if (state.targets.length === 0) {
      strip.classList.add('hidden');
    } else {
      strip.classList.remove('hidden');
      for (const t of state.targets) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `target-chip${t.targetKey === state.selectedKey ? ' selected' : ''}`;
        chip.setAttribute('role', 'tab');
        chip.setAttribute('aria-selected', t.targetKey === state.selectedKey ? 'true' : 'false');

        const bState = t.broker?.state || (t.active ? 'streaming' : 'idle');
        const dot = document.createElement('span');
        dot.className = `chip-dot ${t.active ? bState : 'idle'}`;
        chip.appendChild(dot);

        const titleSpan = document.createElement('span');
        titleSpan.className = 'chip-title';
        titleSpan.textContent = t.nickname || t.displayEndpoint;
        chip.appendChild(titleSpan);

        const subSpan = document.createElement('span');
        subSpan.className = 'chip-sub';
        const baud = t.activeBaud || t.configuredBaud;
        subSpan.textContent = t.nickname ? `${t.displayEndpoint}` : `${baud}`;
        chip.appendChild(subSpan);

        chip.title = `${t.nickname ? `${t.nickname} — ` : ''}${t.displayEndpoint} @ ${baud} baud (${
          t.active ? `active: ${bState}` : 'saved / idle'
        })`;

        chip.addEventListener('click', () => handleTargetChipClick(t));
        strip.appendChild(chip);
      }
    }

    const hasTargets = state.targets.length > 0 || Boolean(state.selectedKey);
    $('empty-state').classList.toggle('hidden', hasTargets);
    $('monitor-section').classList.toggle('hidden', !hasTargets);

    renderMonitorToolbar();
  }

  function renderMonitorToolbar() {
    const target = getSelectedTarget();
    if (!target) return;

    const broker = effectiveBrokerInfo(target);
    const isRunning = Boolean(broker) && state.streamState !== 'stopped';
    const bState = broker?.state || 'idle';
    const baud = broker?.baud || target.configuredBaud;

    // Status pill
    const pill = $('status-pill');
    const statusText = $('status-text');
    pill.className = 'status-pill';

    if (state.connecting) {
      pill.classList.add('state-reconnecting');
      statusText.textContent = 'Connecting…';
    } else if (!isRunning) {
      pill.classList.add('state-idle');
      statusText.textContent = 'Idle';
    } else if (bState === 'leased') {
      pill.classList.add('state-leased');
      const reason = broker?.leaseHolder?.reason || 'esptool';
      statusText.textContent = `Flashing (${reason})`;
    } else if (bState === 'paused') {
      pill.classList.add('state-paused');
      statusText.textContent = 'Paused';
    } else if (bState === 'reconnecting' || state.streamState === 'reconnecting') {
      pill.classList.add('state-reconnecting');
      statusText.textContent = 'Reconnecting…';
    } else if (state.attached) {
      pill.classList.add('state-streaming');
      statusText.textContent = 'Streaming';
    } else {
      pill.classList.add('state-streaming');
      statusText.textContent = 'Running (Detached)';
    }

    // Endpoint summary
    const titlePrefix = target.nickname ? `${target.nickname} · ` : '';
    $('endpoint-summary').textContent = `${titlePrefix}${target.displayEndpoint} @ ${baud}`;

    // Telemetry label
    const tel = $('telemetry-label');
    if (isRunning && broker) {
      const wCount = broker.watcherCount ?? 0;
      tel.textContent = `${wCount}w · ${formatBytes(broker.bytesRx)}`;
      const watcherNames = (broker.watchers || []).map((w) => w.label || `pid-${w.pid}`).join(', ') || 'none';
      tel.title = [
        `Broker PID: ${broker.pid}`,
        `Watchers (${wCount}): ${watcherNames}`,
        `Lines logged: ${broker.linesLogged}`,
        broker.logFile ? `Log: ${broker.logFile}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    } else {
      tel.textContent = target.saved ? 'Saved' : '';
      tel.title = target.portUrl || '';
    }

    // Buttons
    const attachBtn = $('btn-attach');
    if (state.connecting) {
      attachBtn.textContent = 'Connecting…';
      attachBtn.disabled = true;
      attachBtn.classList.remove('ctrl-primary');
    } else if (state.attached) {
      attachBtn.textContent = 'Detach';
      attachBtn.disabled = false;
      attachBtn.classList.remove('ctrl-primary');
      attachBtn.title = 'Detach this UI view (broker stays alive for agents or idles out after 60s)';
    } else if (isRunning) {
      attachBtn.textContent = 'Attach';
      attachBtn.disabled = false;
      attachBtn.classList.add('ctrl-primary');
      attachBtn.title = 'Attach live UI stream to this running broker';
    } else {
      attachBtn.textContent = 'Start';
      attachBtn.disabled = false;
      attachBtn.classList.add('ctrl-primary');
      attachBtn.title = `Start serial broker (${target.displayEndpoint} @ ${baud}) and attach`;
    }

    const busyOrNotRunning = state.actionBusy || !isRunning;
    $('btn-reboot').disabled = busyOrNotRunning || bState === 'leased' || bState === 'paused';

    const pauseBtn = $('btn-pause');
    pauseBtn.disabled = busyOrNotRunning || bState === 'leased';
    if (bState === 'paused') {
      pauseBtn.textContent = 'Resume';
      pauseBtn.classList.add('ctrl-active');
      pauseBtn.title = 'Re-acquire serial port and resume streaming';
    } else {
      pauseBtn.textContent = 'Pause';
      pauseBtn.classList.remove('ctrl-active');
      pauseBtn.title = 'Temporarily release serial port';
    }

    $('btn-mark').disabled = busyOrNotRunning;
    $('btn-stop').disabled = busyOrNotRunning;
  }

  // ---------- Stream Lifecycle & Long-Poll ----------
  function cancelActivePoll() {
    state.pollEpoch++;
    if (state.pollAbort) {
      try {
        state.pollAbort.abort();
      } catch {
        // ignore
      }
      state.pollAbort = null;
    }
  }

  function applyStreamSnapshot(snap) {
    if (!snap) return;

    if (snap.sessionId && snap.sessionId !== state.sessionId) {
      state.sessionId = snap.sessionId;
      state.lines = [];
      state.pendingRenderQueue = [];
      state.clearedUpToSeq = 0;
      state.sinceSeq = 0;
      renderFullViewport();
    } else if (snap.truncated) {
      state.lines = [];
      state.pendingRenderQueue = [];
      state.clearedUpToSeq = 0;
      renderFullViewport();
    }

    state.streamState = snap.streamState || state.streamState;
    state.sinceStateSeq = Number(snap.stateSeq || 0);
    if (typeof snap.seq === 'number' && snap.seq > state.sinceSeq) {
      state.sinceSeq = snap.seq;
    }
    state.liveBroker = snap.broker || null;

    if (Array.isArray(snap.lines) && snap.lines.length > 0) {
      enqueueLines(snap.lines);
    }

    if (snap.streamState === 'stopped' || snap.streamState === 'detached') {
      state.attached = false;
      state.liveBroker = null;
    } else {
      state.attached = true;
    }

    renderHeaderAndTargets();
  }

  async function runStreamLoop(targetKey, epoch) {
    while (state.pollEpoch === epoch && state.attached && state.selectedKey === targetKey) {
      const controller = new AbortController();
      state.pollAbort = controller;
      try {
        const qs = new URLSearchParams({
          targetKey,
          clientId,
          sinceSeq: String(state.sinceSeq),
          sinceStateSeq: String(state.sinceStateSeq),
          waitMs: '10000',
        });
        const snap = await apiJson(`/api/stream?${qs.toString()}`, {
          method: 'GET',
          signal: controller.signal,
        });
        if (state.pollEpoch !== epoch) return;
        applyStreamSnapshot(snap);

        if (snap.streamState === 'stopped' || snap.streamState === 'detached') {
          await refreshTargets();
          renderFullViewport();
          return;
        }
      } catch (err) {
        if (controller.signal.aborted || state.pollEpoch !== epoch) return;
        await new Promise((r) => setTimeout(r, 900));
      } finally {
        if (state.pollAbort === controller) {
          state.pollAbort = null;
        }
      }
    }
  }

  async function connectToTarget(payload, { resetLogsIfNewTarget = false } = {}) {
    cancelActivePoll();
    const epoch = state.pollEpoch;

    if (resetLogsIfNewTarget) {
      state.lines = [];
      state.pendingRenderQueue = [];
      state.clearedUpToSeq = 0;
      state.sessionId = null;
      state.sinceSeq = 0;
      state.sinceStateSeq = 0;
      state.following = true;
      state.unreadCount = 0;
    }

    state.connecting = true;
    renderHeaderAndTargets();
    renderFullViewport();

    try {
      const res = await apiJson('/api/connect', {
        method: 'POST',
        body: JSON.stringify({ ...payload, clientId }),
      });
      if (state.pollEpoch !== epoch) return;

      state.connecting = false;
      if (Array.isArray(res.targets)) {
        state.targets = res.targets;
      }
      if (res.snapshot?.targetKey) {
        state.selectedKey = res.snapshot.targetKey;
      }
      state.attached = true;
      applyStreamSnapshot(res.snapshot);
      if (state.lines.length === 0) {
        renderFullViewport();
      }
      runStreamLoop(state.selectedKey, epoch);
    } catch (err) {
      state.connecting = false;
      state.attached = false;
      renderHeaderAndTargets();
      renderFullViewport();
      showToast(err.message || 'Failed to attach to serial broker', true);
    }
  }

  async function detachCurrentTarget({ fromAutoHide = false } = {}) {
    const key = state.selectedKey;
    cancelActivePoll();
    state.attached = false;
    state.connecting = false;
    state.pausedByHide = Boolean(fromAutoHide);
    state.streamState = 'detached';
    state.liveBroker = null;
    renderHeaderAndTargets();

    if (!key) return;
    try {
      const res = await apiJson('/api/detach', {
        method: 'POST',
        body: JSON.stringify({ targetKey: key, clientId }),
      });
      if (Array.isArray(res.targets)) {
        state.targets = res.targets;
      }
      renderHeaderAndTargets();
    } catch (err) {
      if (!fromAutoHide) {
        showToast(err.message || 'Detach failed', true);
      }
    }
  }

  async function handleTargetChipClick(target) {
    const switching = state.selectedKey !== target.targetKey;
    state.selectedKey = target.targetKey;
    state.pausedByHide = false;
    if (switching) {
      closeMarkBar();
    }
    if (switching || !state.attached) {
      await connectToTarget({ targetKey: target.targetKey }, { resetLogsIfNewTarget: switching });
    } else {
      renderHeaderAndTargets();
    }
  }

  // ---------- Target Discovery Polling ----------
  async function refreshTargets() {
    try {
      const data = await apiJson('/api/targets', { method: 'GET' });
      state.targets = Array.isArray(data.targets) ? data.targets : [];

      if (!state.initialLoadDone) {
        state.initialLoadDone = true;
        if (state.targets.length === 0) {
          openDrawer();
          renderHeaderAndTargets();
          return;
        }

        const preferred =
          state.targets.find((t) => t.active && t.targetKey === data.lastSelectedTargetKey) ||
          state.targets.find((t) => t.active) ||
          state.targets.find((t) => t.targetKey === data.lastSelectedTargetKey) ||
          state.targets[0];

        if (preferred) {
          state.selectedKey = preferred.targetKey;
          renderHeaderAndTargets();
          renderFullViewport();
          return;
        }
      }

      if (state.selectedKey && !state.targets.some((t) => t.targetKey === state.selectedKey)) {
        state.selectedKey = state.targets[0]?.targetKey || null;
      } else if (!state.selectedKey && state.targets.length > 0) {
        state.selectedKey = state.targets[0].targetKey;
      }

      if (state.attached && state.selectedKey) {
        const sel = state.targets.find((t) => t.targetKey === state.selectedKey);
        if (sel?.broker) {
          state.liveBroker = sel.broker;
        }
      }

      // If the user was previously attached, collapsed/hid the side pane, and reopened it while the broker is still active
      if (state.paneVisible && state.pausedByHide && !state.attached && !state.connecting && state.selectedKey) {
        const cur = getSelectedTarget();
        state.pausedByHide = false;
        if (cur?.active) {
          connectToTarget({ targetKey: cur.targetKey, spawnIfMissing: false }, { resetLogsIfNewTarget: false });
          return;
        }
      }

      renderHeaderAndTargets();
    } catch {
      // Ignore transient background poll error
    }
  }

  // ---------- Target Configuration Drawer ----------
  function syncPortFieldVisibility() {
    const val = $('cfg-host').value.trim();
    const isLocalCom = /^com\d+$/i.test(val);
    $('cfg-port-sep').classList.toggle('hidden', isLocalCom);
    $('cfg-port').classList.toggle('hidden', isLocalCom);
  }

  function setBaudControlValue(baud) {
    const str = String(baud || 74880);
    const sel = $('cfg-baud-select');
    const custom = $('cfg-baud-custom');
    if (PRESET_BAUDS.has(str)) {
      sel.value = str;
      custom.classList.add('hidden');
    } else {
      sel.value = 'custom';
      custom.value = str;
      custom.classList.remove('hidden');
    }
  }

  function getBaudControlValue() {
    const sel = $('cfg-baud-select').value;
    if (sel === 'custom') {
      return Number.parseInt($('cfg-baud-custom').value, 10);
    }
    return Number.parseInt(sel, 10);
  }

  function openDrawer(editTarget = null) {
    state.drawerOpen = true;
    $('target-drawer').classList.remove('hidden');
    $('toggle-drawer-btn').classList.add('active');

    if (editTarget) {
      $('edit-prev-key').value = editTarget.targetKey;
      $('cfg-host').value = editTarget.host || editTarget.displayEndpoint || '';
      $('cfg-port').value = editTarget.port || 3030;
      setBaudControlValue(editTarget.configuredBaud || editTarget.activeBaud || 74880);
      $('cfg-nickname').value = editTarget.nickname || '';
      $('cfg-delete-btn').classList.toggle('hidden', !editTarget.saved);
      $('cfg-connect-btn').textContent = editTarget.active ? 'Save & Attach' : 'Start & Save';
    } else {
      $('edit-prev-key').value = '';
      if (!$('cfg-host').value) {
        $('cfg-host').value = '';
        $('cfg-port').value = '3030';
        setBaudControlValue(74880);
      }
      $('cfg-nickname').value = '';
      $('cfg-delete-btn').classList.add('hidden');
      $('cfg-connect-btn').textContent = 'Connect';
    }

    syncPortFieldVisibility();
    setTimeout(() => $('cfg-host').focus(), 20);
  }

  function closeDrawer() {
    state.drawerOpen = false;
    $('target-drawer').classList.add('hidden');
    $('toggle-drawer-btn').classList.remove('active');
    $('edit-prev-key').value = '';
  }

  function readDrawerSpec() {
    const host = $('cfg-host').value.trim();
    const isLocalCom = /^com\d+$/i.test(host);
    const port = isLocalCom ? '' : $('cfg-port').value.trim();
    const baud = getBaudControlValue();
    const nickname = $('cfg-nickname').value.trim();
    const prevTargetKey = $('edit-prev-key').value.trim() || undefined;
    return { host, port, baud, nickname, prevTargetKey };
  }

  // ---------- Broker Actions ----------
  async function runAction(action, extra = {}, successMsg = '') {
    const target = getSelectedTarget();
    if (!target || state.actionBusy) return;

    state.actionBusy = true;
    renderMonitorToolbar();
    try {
      const res = await apiJson('/api/action', {
        method: 'POST',
        body: JSON.stringify({
          targetKey: target.targetKey,
          action,
          ...extra,
        }),
      });
      if (Array.isArray(res.targets)) {
        state.targets = res.targets;
      }
      if (action === 'stop') {
        cancelActivePoll();
        state.attached = false;
        state.streamState = 'stopped';
        state.liveBroker = null;
      }
      if (successMsg) {
        showToast(successMsg, false, 2000);
      }
    } catch (err) {
      showToast(err.message || `Action '${action}' failed`, true);
    } finally {
      state.actionBusy = false;
      renderHeaderAndTargets();
    }
  }

  function openMarkBar() {
    $('mark-form').classList.remove('hidden');
    const input = $('mark-input');
    if (!input.value) input.value = 'checkpoint';
    input.focus();
    input.select();
  }

  function closeMarkBar() {
    $('mark-form').classList.add('hidden');
  }

  // ---------- Event Wiring ----------
  $('toast').addEventListener('click', () => hideToast());

  $('refresh-btn').addEventListener('click', () => {
    refreshTargets();
  });

  $('toggle-drawer-btn').addEventListener('click', () => {
    if (state.drawerOpen) closeDrawer();
    else openDrawer(null);
  });

  $('edit-target-btn').addEventListener('click', () => {
    const tgt = getSelectedTarget();
    if (!tgt) return;
    if (state.drawerOpen && $('edit-prev-key').value === tgt.targetKey) {
      closeDrawer();
    } else {
      openDrawer(tgt);
    }
  });

  $('cfg-host').addEventListener('input', () => {
    const raw = $('cfg-host').value.trim();
    // Auto-extract host & port if user pastes `rfc2217://192.168.1.50:3030...` or `192.168.1.50:3030`
    const urlMatch = /^[a-z0-9+.-]+:\/\/([^/:?\s]+):(\d{1,5})/i.exec(raw);
    if (urlMatch) {
      $('cfg-host').value = urlMatch[1];
      $('cfg-port').value = urlMatch[2];
    } else {
      const hpMatch = /^([^\s:/?]+):(\d{1,5})$/.exec(raw);
      if (hpMatch) {
        $('cfg-host').value = hpMatch[1];
        $('cfg-port').value = hpMatch[2];
      }
    }
    syncPortFieldVisibility();
  });

  $('cfg-port').addEventListener(
    'wheel',
    (ev) => {
      if (document.activeElement !== $('cfg-port')) return;
      ev.preventDefault();
      const cur = Number.parseInt($('cfg-port').value || '3030', 10) || 3030;
      const delta = ev.deltaY < 0 ? 1 : -1;
      $('cfg-port').value = String(Math.max(1, Math.min(65535, cur + delta)));
    },
    { passive: false }
  );

  $('cfg-baud-select').addEventListener('change', () => {
    const isCustom = $('cfg-baud-select').value === 'custom';
    $('cfg-baud-custom').classList.toggle('hidden', !isCustom);
    if (isCustom) $('cfg-baud-custom').focus();
  });

  $('cfg-cancel-btn').addEventListener('click', () => closeDrawer());

  $('cfg-save-btn').addEventListener('click', async () => {
    try {
      const spec = readDrawerSpec();
      const res = await apiJson('/api/targets/save', {
        method: 'POST',
        body: JSON.stringify(spec),
      });
      state.targets = res.targets || state.targets;
      state.selectedKey = res.targetKey || state.selectedKey;
      closeDrawer();
      renderHeaderAndTargets();
      renderFullViewport();
      showToast('Target saved', false, 1800);
    } catch (err) {
      showToast(err.message || 'Invalid target settings', true);
    }
  });

  $('cfg-delete-btn').addEventListener('click', async () => {
    const prevKey = $('edit-prev-key').value.trim();
    if (!prevKey) return;
    try {
      const res = await apiJson('/api/targets/delete', {
        method: 'POST',
        body: JSON.stringify({ targetKey: prevKey }),
      });
      state.targets = res.targets || [];
      if (state.selectedKey === prevKey && !state.targets.some((t) => t.targetKey === prevKey)) {
        state.selectedKey = state.targets[0]?.targetKey || null;
      }
      closeDrawer();
      renderHeaderAndTargets();
      renderFullViewport();
      showToast('Removed saved bookmark', false, 1800);
    } catch (err) {
      showToast(err.message || 'Delete failed', true);
    }
  });

  $('target-drawer').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const spec = readDrawerSpec();
      const shouldSave = Boolean(spec.nickname || spec.prevTargetKey);
      closeDrawer();
      await connectToTarget(
        { ...spec, save: shouldSave || true },
        { resetLogsIfNewTarget: spec.prevTargetKey !== state.selectedKey }
      );
    } catch (err) {
      showToast(err.message || 'Failed to connect', true);
    }
  });

  $('btn-attach').addEventListener('click', async () => {
    const tgt = getSelectedTarget();
    if (!tgt) return;
    if (state.attached) {
      await detachCurrentTarget();
      renderFullViewport();
    } else {
      await connectToTarget({ targetKey: tgt.targetKey }, { resetLogsIfNewTarget: false });
    }
  });

  // One-click hardware RTS reboot over serial
  $('btn-reboot').addEventListener('click', () => {
    runAction('reboot', {}, 'RTS hardware reboot pulsed');
  });

  $('btn-pause').addEventListener('click', () => {
    const tgt = getSelectedTarget();
    const broker = effectiveBrokerInfo(tgt);
    if (broker?.state === 'paused') {
      runAction('resume', {}, 'Serial port resumed');
    } else {
      runAction('pause', { timeout: 300 }, 'Serial port paused (5m safety timeout)');
    }
  });

  $('btn-mark').addEventListener('click', (ev) => {
    if (ev.shiftKey) {
      openMarkBar();
      return;
    }
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const autoLabel = `mark-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    runAction('mark', { label: autoLabel });
  });

  $('mark-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const label = $('mark-input').value.trim() || 'checkpoint';
    closeMarkBar();
    runAction('mark', { label });
  });

  $('mark-cancel').addEventListener('click', () => closeMarkBar());

  $('btn-stop').addEventListener('click', () => {
    runAction('stop', {}, 'Serial broker stopped');
  });

  // Search / Highlight / Filter & Viewport Options
  $('filter-input').addEventListener('input', () => {
    state.filterRaw = $('filter-input').value;
    state.querySpec = compileQuery(state.filterRaw);
    renderFullViewport();
  });

  $('filter-clear').addEventListener('click', () => {
    $('filter-input').value = '';
    state.filterRaw = '';
    state.querySpec = null;
    renderFullViewport();
  });

  $('toggle-filter').addEventListener('click', () => {
    state.filterOnly = !state.filterOnly;
    $('toggle-filter').classList.toggle('active', state.filterOnly);
    renderFullViewport();
  });

  $('toggle-ts').addEventListener('click', () => {
    state.showTs = !state.showTs;
    $('toggle-ts').classList.toggle('active', state.showTs);
    $('log-viewport').classList.toggle('hide-ts', !state.showTs);
    if (state.querySpec) {
      renderFullViewport();
    }
  });

  $('toggle-wrap').addEventListener('click', () => {
    state.wrapLines = !state.wrapLines;
    $('toggle-wrap').classList.toggle('active', state.wrapLines);
    $('log-viewport').classList.toggle('wrap-lines', state.wrapLines);
  });

  $('btn-clear').addEventListener('click', () => {
    state.clearedUpToSeq = state.sinceSeq;
    state.unreadCount = 0;
    renderFullViewport();
  });

  $('log-viewport').addEventListener('scroll', () => {
    const vp = $('log-viewport');
    const distFromBottom = vp.scrollHeight - vp.scrollTop - vp.clientHeight;
    const atBottom = distFromBottom <= 28;
    if (atBottom !== state.following) {
      state.following = atBottom;
      if (atBottom) state.unreadCount = 0;
      updateFollowPill();
    }
  });

  $('follow-pill').addEventListener('click', () => scrollToBottom());

  // Release UI stream subscription immediately when closing or reloading the side pane
  window.addEventListener('pagehide', () => {
    cancelActivePoll();
    try {
      apiFetch('/api/detach', {
        method: 'POST',
        body: JSON.stringify({ clientId }),
        keepalive: true,
      });
    } catch {
      // 15s sidecar lease TTL cleans up automatically as fallback
    }
  });

  // Detect Aux Pane collapse / tab hiding (`display: none` -> 0x0 iframe) so cached hidden iframes
  // do not hold a `serial-ui` subscription open or poll in the background.
  function computePaneVisible() {
    if (document.visibilityState === 'hidden') return false;
    const docEl = document.documentElement;
    return docEl.clientWidth > 16 && docEl.clientHeight > 16;
  }

  function updatePaneVisibility() {
    const visible = computePaneVisible();
    if (visible === state.paneVisible) return;
    state.paneVisible = visible;

    if (!visible) {
      if (state.attached && !state.hideDetachTimer) {
        state.hideDetachTimer = setTimeout(() => {
          state.hideDetachTimer = null;
          if (!state.paneVisible && state.attached) {
            detachCurrentTarget({ fromAutoHide: true });
          }
        }, 3000);
      }
    } else {
      if (state.hideDetachTimer) {
        clearTimeout(state.hideDetachTimer);
        state.hideDetachTimer = null;
      }
      refreshTargets();
    }
  }

  state.paneVisible = computePaneVisible();
  document.addEventListener('visibilitychange', updatePaneVisibility);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(updatePaneVisibility).observe(document.documentElement);
  }

  // Start initial discovery & periodic active-broker sync (only when visible)
  if (state.paneVisible) {
    refreshTargets();
  }
  setInterval(() => {
    if (state.paneVisible) {
      refreshTargets();
    }
  }, TARGETS_POLL_MS);
})();
