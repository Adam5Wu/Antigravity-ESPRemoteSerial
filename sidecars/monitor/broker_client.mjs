/**
 * Pure Node.js client for the bundled `tools/serial_monitor.py` broker daemon.
 *
 * Responsibilities:
 * - Discover running `_broker` daemons via `<TEMP>/agy_serial_monitor/mon_*.json` + TCP `ping`.
 * - Spawn new brokers on demand via `serial_monitor.py ensure --port ... --baud ...`.
 * - Manage live TCP `subscribe` streams with a ring buffer (`seq` cursor) + long-poll wakeup,
 *   automatically closing the `subscribe` socket when no UI client has polled within 15s (or on
 *   explicit detach) so `serial_monitor.py`'s 60s idle auto-shutdown continues to work normally.
 * - Execute one-shot control commands (`reboot`, `mark`, `pause`, `resume`, `stop`).
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCRIPT_PATH = join(__dirname, '..', '..', 'tools', 'serial_monitor.py');

export const DEFAULT_BAUD = 74880;
export const DEFAULT_RFC2217_PORT = 3030;
const MAX_BUFFER_LINES = 5000;
const INITIAL_TAIL_LINES = 400;
const CLIENT_LEASE_TTL_MS = 15_000;
const SWEEP_INTERVAL_MS = 2_500;
const BROKER_STOP_SENTINEL = '=== [BROKER_STOPPED] ===';

let cachedPythonExe = null;

function hasPyserial(pythonCandidate) {
  try {
    const res = spawnSync(pythonCandidate, ['-c', 'import serial'], {
      windowsHide: true,
      timeout: 3500,
      stdio: 'ignore',
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function discoverPythonExecutable() {
  if (process.env.SERIAL_MONITOR_PYTHON) {
    return process.env.SERIAL_MONITOR_PYTHON;
  }
  if (cachedPythonExe) {
    return cachedPythonExe;
  }

  const home = homedir();
  const pioCore = process.env.PLATFORMIO_CORE_DIR || join(home, '.platformio');
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');

  const pathCandidates = [
    join(pioCore, 'penv', 'Scripts', 'python.exe'),
    join(appData, 'uv', 'tools', 'platformio', 'Scripts', 'python.exe'),
    join(home, 'scoop', 'persist', 'uv', 'tools', 'versions', 'platformio', 'Scripts', 'python.exe'),
    join(home, 'scoop', 'persist', 'uv', 'tools', 'platformio', 'Scripts', 'python.exe'),
    join(home, 'pipx', 'venvs', 'platformio', 'Scripts', 'python.exe'),
  ];

  for (const p of pathCandidates) {
    if (existsSync(p) && hasPyserial(p)) {
      cachedPythonExe = p;
      return p;
    }
  }

  for (const cmd of ['python', 'py']) {
    if (hasPyserial(cmd)) {
      cachedPythonExe = cmd;
      return cmd;
    }
  }

  return 'python';
}

export function resolveBrokerPaths({ probePython = false } = {}) {
  const scriptPath = process.env.SERIAL_MONITOR_SCRIPT || BUNDLED_SCRIPT_PATH;
  const stateDir = process.env.SERIAL_MONITOR_STATE_DIR || join(tmpdir(), 'agy_serial_monitor');
  const pythonExe = probePython
    ? discoverPythonExecutable()
    : process.env.SERIAL_MONITOR_PYTHON || cachedPythonExe || 'python';

  return { pythonExe, scriptPath, stateDir };
}

/**
 * Exact JavaScript equivalent of `canonical_target_key(port_spec)` in `serial_monitor.py`.
 */
export function canonicalTargetKey(portSpec) {
  const spec = String(portSpec || '').trim();
  const schemeIdx = spec.indexOf('://');
  if (schemeIdx !== -1) {
    const scheme = spec.slice(0, schemeIdx).toLowerCase();
    let rest = spec.slice(schemeIdx + 3);
    const qIdx = rest.indexOf('?');
    if (qIdx !== -1) rest = rest.slice(0, qIdx);
    const hIdx = rest.indexOf('#');
    if (hIdx !== -1) rest = rest.slice(0, hIdx);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return `${scheme}://${rest.toLowerCase()}`;
    }
    const netloc = rest.slice(0, slashIdx).toLowerCase();
    const path = rest.slice(slashIdx);
    return `${scheme}://${netloc}${path}`;
  }
  return spec.toLowerCase();
}

/**
 * Extract human-friendly endpoint info from a `portUrl` or `targetKey`.
 */
export function describeEndpoint(portSpec) {
  const key = canonicalTargetKey(portSpec);
  const schemeIdx = key.indexOf('://');
  if (schemeIdx !== -1) {
    const scheme = key.slice(0, schemeIdx);
    const rest = key.slice(schemeIdx + 3);
    const slashIdx = rest.indexOf('/');
    const netloc = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    let host = netloc;
    let port = null;
    const colonIdx = netloc.lastIndexOf(':');
    if (colonIdx > 0 && !netloc.endsWith(']')) {
      host = netloc.slice(0, colonIdx);
      const parsedPort = Number.parseInt(netloc.slice(colonIdx + 1), 10);
      if (Number.isInteger(parsedPort)) port = parsedPort;
    }
    return {
      isRemote: true,
      scheme,
      host,
      port,
      displayEndpoint: netloc,
    };
  }
  const raw = String(portSpec || '').trim();
  const upperCom = /^com\d+$/i.test(raw) ? raw.toUpperCase() : raw || key;
  return {
    isRemote: false,
    scheme: 'serial',
    host: upperCom,
    port: null,
    displayEndpoint: upperCom,
  };
}

/**
 * Normalize user target inputs (`{ host, port, baud, portUrl, nickname }`) into a validated spec.
 */
export function normalizeTargetInput(input = {}) {
  const rawBaud = input.baud !== undefined && input.baud !== '' ? Number(input.baud) : DEFAULT_BAUD;
  if (!Number.isInteger(rawBaud) || rawBaud < 300 || rawBaud > 12_000_000) {
    throw new Error('Baud rate must be an integer between 300 and 12,000,000');
  }

  const nickname = typeof input.nickname === 'string' ? input.nickname.trim().slice(0, 64) : '';
  let portUrl = typeof input.portUrl === 'string' ? input.portUrl.trim() : '';
  let hostInput = typeof input.host === 'string' ? input.host.trim() : '';
  let portInput =
    input.port !== undefined && input.port !== null && String(input.port).trim() !== ''
      ? String(input.port).trim()
      : '';

  if (!portUrl) {
    if (!hostInput) {
      throw new Error('Host/IP (or COM port) is required');
    }

    // Case 1: Full URL pasted into host field (e.g. rfc2217://192.168.1.50:3030?ign_set_control)
    if (hostInput.includes('://')) {
      portUrl = hostInput;
    } else if (/^com\d+$/i.test(hostInput)) {
      // Case 2: Local Windows COM port name (e.g. COM4)
      portUrl = hostInput.toUpperCase();
    } else {
      // Case 3: Remote host[:port] + port
      let host = hostInput;
      let portStr = portInput;

      // Support pasting `192.168.1.50:3030` directly into Host input
      const hostPortMatch = /^([^\s:/?]+):(\d{1,5})$/.exec(host);
      if (hostPortMatch) {
        host = hostPortMatch[1];
        portStr = hostPortMatch[2];
      }

      if (!host || /[\s/?#\\]/.test(host)) {
        throw new Error(`Invalid host '${host}'`);
      }

      const portNum = portStr ? Number.parseInt(portStr, 10) : DEFAULT_RFC2217_PORT;
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        throw new Error('TCP port must be between 1 and 65535');
      }
      portUrl = `rfc2217://${host}:${portNum}?ign_set_control`;
    }
  }

  // Ensure rfc2217:// URLs always include ?ign_set_control unless query flags were already provided
  if (/^rfc2217:\/\//i.test(portUrl) && !portUrl.includes('?')) {
    portUrl = `${portUrl}?ign_set_control`;
  }

  const targetKey = canonicalTargetKey(portUrl);
  if (!targetKey) {
    throw new Error('Invalid serial port target');
  }
  const endpoint = describeEndpoint(portUrl);
  if (endpoint.isRemote && (!endpoint.host || !endpoint.port)) {
    throw new Error('Remote RFC2217 target requires both host and TCP port (e.g. 192.168.1.50:3030)');
  }

  return {
    targetKey,
    portUrl,
    baud: rawBaud,
    nickname,
    ...endpoint,
  };
}

/**
 * Send a single newline-delimited JSON command to a running broker's control port.
 */
export function sendCtrlRequest(ctrlHost, ctrlPort, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ctrlHost, port: Number(ctrlPort) });
    let settled = false;
    let buf = '';

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(val);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`, 'utf-8');
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const nlIdx = buf.indexOf('\n');
      if (nlIdx !== -1) {
        const line = buf.slice(0, nlIdx).trim();
        try {
          finish(null, line ? JSON.parse(line) : { ok: false, error: 'empty response' });
        } catch (err) {
          finish(new Error(`Invalid broker JSON: ${err.message}`));
        }
      }
    });
    socket.on('timeout', () => finish(new Error('Broker control request timed out')));
    socket.on('error', (err) => finish(err));
    socket.on('end', () => {
      const line = buf.trim();
      if (!line) {
        finish(new Error('Broker closed connection without responding'));
      } else {
        try {
          finish(null, JSON.parse(line));
        } catch (err) {
          finish(new Error(`Invalid broker JSON: ${err.message}`));
        }
      }
    });
  });
}

/**
 * Scan `<TEMP>/agy_serial_monitor/mon_*.json` and ping all active brokers in parallel.
 */
export async function listActiveBrokers() {
  const { stateDir } = resolveBrokerPaths();
  if (!existsSync(stateDir)) return [];

  let entries = [];
  try {
    entries = readdirSync(stateDir).filter((name) => name.startsWith('mon_') && name.endsWith('.json'));
  } catch {
    return [];
  }

  const probes = entries.map(async (name) => {
    const fpath = join(stateDir, name);
    try {
      const raw = JSON.parse(readFileSync(fpath, 'utf-8'));
      if (!raw?.ctrl_host || !raw?.ctrl_port) return null;
      const resp = await sendCtrlRequest(raw.ctrl_host, Number(raw.ctrl_port), { cmd: 'ping' }, 350);
      if (!resp?.ok) return null;
      return {
        ...raw,
        ...resp,
        state_file: fpath,
      };
    } catch {
      return null;
    }
  });

  const results = await Promise.all(probes);
  return results.filter(Boolean);
}

export async function findActiveBroker(targetKey) {
  const key = canonicalTargetKey(targetKey);
  const brokers = await listActiveBrokers();
  return brokers.find((b) => b.target_key === key) || null;
}

/**
 * Ensure a detached `serial_monitor.py` broker is running for `(portUrl, baud)`.
 */
export async function ensureBroker({ portUrl, baud = DEFAULT_BAUD }) {
  const key = canonicalTargetKey(portUrl);
  const existing = await findActiveBroker(key);
  if (existing) {
    return existing;
  }

  const { pythonExe, scriptPath } = resolveBrokerPaths({ probePython: true });
  if (!existsSync(scriptPath)) {
    throw new Error(`serial_monitor.py not found at ${scriptPath}`);
  }

  const args = [scriptPath, 'ensure', '--port', portUrl, '--baud', String(baud)];

  const stdout = await new Promise((resolve, reject) => {
    execFile(
      pythonExe,
      args,
      { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
      (err, out, stderr) => {
        if (err) {
          const detail = (stderr || out || err.message || '').toString().trim();
          if (/No module named ['"]serial['"]/i.test(detail)) {
            reject(
              new Error(
                `Python (${pythonExe}) is missing 'pyserial'. Install it ('pip install pyserial') or set SERIAL_MONITOR_PYTHON.`
              )
            );
            return;
          }
          reject(new Error(`Failed to start serial broker: ${detail}`));
          return;
        }
        resolve(out);
      }
    );
  });

  let info = null;
  try {
    info = JSON.parse(stdout);
  } catch {
    // Fall back to fresh discovery below
  }

  const live = await findActiveBroker(key);
  if (live) return live;
  if (info?.ctrl_host && info?.ctrl_port) return info;
  throw new Error(`Broker started for ${key} but could not be reached`);
}

const LINE_TS_RE = /^\[(\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2}\.\d{3}))\]\s?(.*)$/;
const META_RE = /^===\s*\[MONITOR\]\s*(.*?)\s*===$/;
const MARK_RE = /^===\s*\[MARK\]\s*(.*?)\s*===$/;

export function parseBrokerLogLine(rawLine, seq) {
  const clean = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  const match = LINE_TS_RE.exec(clean);
  if (!match) {
    return { seq, fullTs: '', ts: '', kind: 'device', text: clean };
  }
  const [, fullTs, shortTs, body] = match;
  const metaMatch = META_RE.exec(body);
  if (metaMatch) {
    return { seq, fullTs, ts: shortTs, kind: 'meta', text: metaMatch[1] };
  }
  const markMatch = MARK_RE.exec(body);
  if (markMatch) {
    return { seq, fullTs, ts: shortTs, kind: 'mark', text: markMatch[1] };
  }
  return { seq, fullTs, ts: shortTs, kind: 'device', text: body };
}

function formatNowShortTs() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

let nextSessionCounter = 1;

/**
 * Live `subscribe` stream session to a single `serial_monitor.py` broker.
 */
class StreamSession {
  constructor({ targetKey, portUrl, baud }) {
    this.sessionId = `s${Date.now().toString(36)}_${nextSessionCounter++}`;
    this.targetKey = targetKey;
    this.portUrl = portUrl || targetKey;
    this.baud = baud || DEFAULT_BAUD;

    this.state = 'connecting'; // connecting | attached | reconnecting | stopped | detached
    this.lastError = null;
    this.brokerInfo = null;

    this.seq = 0;
    this.stateSeq = 1;
    this.lines = []; // { seq, fullTs, ts, kind, text }

    this.clients = new Map(); // clientId -> lastSeenMs
    this.waiters = new Set(); // () => void

    this._socket = null;
    this._closed = false;
    this._intentionalStop = false;
    this._firstAttach = true;
    this._reconnectTimer = null;
    this._statusRefreshTimer = null;
    this._refreshInFlight = false;
    this._refreshPending = false;
  }

  touchClient(clientId) {
    if (clientId) {
      this.clients.set(clientId, Date.now());
    }
  }

  removeClient(clientId) {
    this.clients.delete(clientId);
    return this.clients.size;
  }

  pruneExpiredClients(nowMs = Date.now()) {
    for (const [cid, seenAt] of this.clients.entries()) {
      if (nowMs - seenAt > CLIENT_LEASE_TTL_MS) {
        this.clients.delete(cid);
      }
    }
    return this.clients.size;
  }

  markIntentionalStop() {
    this._intentionalStop = true;
  }

  _bumpState() {
    this.stateSeq++;
    this._notifyWaiters();
  }

  _pushLine(entry) {
    this.lines.push(entry);
    if (this.lines.length > MAX_BUFFER_LINES) {
      this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES);
    }
    this._notifyWaiters();
  }

  _pushSystemNotice(text) {
    const seq = ++this.seq;
    this._pushLine({
      seq,
      fullTs: '',
      ts: formatNowShortTs(),
      kind: 'meta',
      text,
    });
  }

  _notifyWaiters() {
    if (this.waiters.size === 0) return;
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const wake of pending) {
      try {
        wake();
      } catch {
        // ignore
      }
    }
  }

  applyBrokerInfo(latest) {
    if (!latest || this._closed) return;
    const prev = this.brokerInfo;
    const prevLeasePid = prev?.lease_holder?.pid ?? null;
    const nextLeasePid = latest?.lease_holder?.pid ?? null;
    const stateChanged =
      !prev ||
      prev.pid !== latest.pid ||
      prev.state !== latest.state ||
      prev.baud !== latest.baud ||
      prev.watcher_count !== latest.watcher_count ||
      prevLeasePid !== nextLeasePid;

    this.brokerInfo = latest;
    this.portUrl = latest.port_url || this.portUrl;
    this.baud = latest.baud || this.baud;
    if (stateChanged) {
      this._bumpState();
    }
  }

  scheduleStatusRefresh(delayMs = 40) {
    if (this._closed) return;
    if (this._refreshInFlight) {
      this._refreshPending = true;
      return;
    }
    if (this._statusRefreshTimer) return;

    this._statusRefreshTimer = setTimeout(async () => {
      this._statusRefreshTimer = null;
      if (this._closed) return;
      this._refreshInFlight = true;
      let nextDelay = null;
      try {
        const latest = await findActiveBroker(this.targetKey);
        if (latest) {
          this.applyBrokerInfo(latest);
          if (latest.state === 'starting' || latest.state === 'resuming') {
            nextDelay = 250;
          }
        }
      } catch {
        // ignore transient ping failure
      } finally {
        this._refreshInFlight = false;
        if (!this._closed) {
          if (this._refreshPending) {
            this._refreshPending = false;
            this.scheduleStatusRefresh(35);
          } else if (nextDelay !== null) {
            this.scheduleStatusRefresh(nextDelay);
          }
        }
      }
    }, delayMs);
  }

  async start({ spawnIfMissing = false } = {}) {
    if (this._closed) return;
    this._connectLoop(spawnIfMissing);
  }

  async _connectLoop(spawnIfMissing) {
    if (this._closed) return;

    let broker = await findActiveBroker(this.targetKey);
    if (!broker && spawnIfMissing && !this._intentionalStop) {
      try {
        broker = await ensureBroker({ portUrl: this.portUrl, baud: this.baud });
      } catch (err) {
        this.state = 'reconnecting';
        this.lastError = err.message;
        this._bumpState();
        this._scheduleReconnect(1200, true);
        return;
      }
    }

    if (!broker) {
      this.state = 'stopped';
      this.brokerInfo = null;
      this._bumpState();
      return;
    }

    this.brokerInfo = broker;
    this.portUrl = broker.port_url || this.portUrl;
    this.baud = broker.baud || this.baud;

    const tailLines = this._firstAttach ? INITIAL_TAIL_LINES : 0;
    const sock = net.createConnection({
      host: broker.ctrl_host,
      port: Number(broker.ctrl_port),
    });
    this._socket = sock;
    sock.setKeepAlive(true, 15_000);

    let gotAck = false;
    let buf = '';
    let stoppedSentinelSeen = false;

    sock.on('connect', () => {
      if (this._closed) {
        sock.destroy();
        return;
      }
      const req = {
        cmd: 'subscribe',
        tail_lines: tailLines,
        client_pid: process.pid,
        label: 'serial-ui',
      };
      sock.write(`${JSON.stringify(req)}\n`, 'utf-8');
    });

    sock.on('data', (chunk) => {
      if (this._closed) return;
      buf += chunk.toString('utf-8');
      let nlIdx;
      while ((nlIdx = buf.indexOf('\n')) !== -1) {
        const rawLine = buf.slice(0, nlIdx);
        buf = buf.slice(nlIdx + 1);

        if (!gotAck) {
          gotAck = true;
          try {
            const ack = JSON.parse(rawLine.trim());
            if (!ack?.ok) {
              this.lastError = ack?.error || 'Broker rejected subscription';
              this.state = 'stopped';
              this._bumpState();
              sock.destroy();
              return;
            }
            this._firstAttach = false;
            this.state = 'attached';
            this.lastError = null;
            this.scheduleStatusRefresh(20);
            this._bumpState();
          } catch (err) {
            this.lastError = `Malformed subscribe ack: ${err.message}`;
            sock.destroy();
            return;
          }
          continue;
        }

        if (rawLine.trim() === BROKER_STOP_SENTINEL) {
          stoppedSentinelSeen = true;
          this._intentionalStop = true;
          this.state = 'stopped';
          this.brokerInfo = null;
          this._pushSystemNotice('Broker stopped');
          this._bumpState();
          sock.destroy();
          return;
        }

        const entry = parseBrokerLogLine(rawLine, ++this.seq);
        if (this.brokerInfo) {
          let hintedState = null;
          if (entry.kind === 'device' && this.brokerInfo.state !== 'streaming') {
            hintedState = 'streaming';
          } else if (entry.kind === 'meta') {
            if (/^(Connected|Reconnected) to\b/.test(entry.text)) {
              hintedState = 'streaming';
            } else if (/^(Serial link dropped|Reconnect pending)\b/.test(entry.text)) {
              hintedState = 'reconnecting';
            } else if (/^Paused for\b/.test(entry.text)) {
              hintedState = 'leased';
            } else if (/^Paused \(/.test(entry.text)) {
              hintedState = 'paused';
            }
          }
          if (hintedState && this.brokerInfo.state !== hintedState) {
            this.brokerInfo = { ...this.brokerInfo, state: hintedState };
            this.stateSeq++;
          }
        }
        this._pushLine(entry);
        if (entry.kind === 'meta' || (entry.kind === 'device' && this._refreshPending)) {
          this.scheduleStatusRefresh(25);
        }
      }
    });

    sock.on('error', (err) => {
      if (this._closed || stoppedSentinelSeen || this._intentionalStop) return;
      this.lastError = err.message;
    });

    sock.on('close', () => {
      if (this._socket === sock) {
        this._socket = null;
      }
      if (this._closed) return;

      if (stoppedSentinelSeen || this._intentionalStop) {
        this.state = 'stopped';
        this.brokerInfo = null;
        this._bumpState();
        return;
      }

      if (this.clients.size === 0) {
        this.destroy();
        return;
      }

      this.state = 'reconnecting';
      this._bumpState();
      this._scheduleReconnect(600, true);
    });
  }

  _scheduleReconnect(delayMs, spawnIfMissing) {
    if (this._closed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed && this.clients.size > 0 && !this._intentionalStop) {
        this._connectLoop(spawnIfMissing);
      }
    }, delayMs);
  }

  getSnapshot(sinceSeq = 0) {
    let slice = [];
    let truncated = false;

    if (this.lines.length > 0) {
      const oldestSeq = this.lines[0].seq;
      if (sinceSeq > 0 && sinceSeq < oldestSeq - 1) {
        truncated = true;
      }
      if (sinceSeq <= 0) {
        slice = this.lines;
      } else {
        let idx = this.lines.length;
        while (idx > 0 && this.lines[idx - 1].seq > sinceSeq) {
          idx--;
        }
        slice = this.lines.slice(idx);
      }
    }

    return {
      sessionId: this.sessionId,
      targetKey: this.targetKey,
      portUrl: this.portUrl,
      baud: this.baud,
      streamState: this.state,
      stateSeq: this.stateSeq,
      seq: this.seq,
      truncated,
      lastError: this.lastError,
      broker: this.brokerInfo,
      lines: slice,
    };
  }

  waitForUpdate({ sinceSeq = 0, sinceStateSeq = 0, waitMs = 10_000 } = {}) {
    if (
      this._closed ||
      this.seq > sinceSeq ||
      (sinceStateSeq > 0 && this.stateSeq !== sinceStateSeq) ||
      this.state === 'stopped'
    ) {
      return Promise.resolve(this.getSnapshot(sinceSeq));
    }

    const clampedWait = Math.max(0, Math.min(Number(waitMs) || 10_000, 15_000));
    if (clampedWait === 0) {
      return Promise.resolve(this.getSnapshot(sinceSeq));
    }

    return new Promise((resolve) => {
      let timer = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(this.getSnapshot(sinceSeq));
      };
      this.waiters.add(wake);
      timer = setTimeout(wake, clampedWait);
    });
  }

  destroy() {
    if (this._closed) return;
    this._closed = true;
    this.state = 'detached';
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._statusRefreshTimer) {
      clearTimeout(this._statusRefreshTimer);
      this._statusRefreshTimer = null;
    }
    if (this._socket) {
      try {
        this._socket.destroy();
      } catch {
        // ignore
      }
      this._socket = null;
    }
    this.clients.clear();
    this._notifyWaiters();
  }
}

export class BrokerStreamManager {
  constructor() {
    this.sessions = new Map(); // targetKey -> StreamSession
    this._sweepTimer = setInterval(() => this._sweepIdleSessions(), SWEEP_INTERVAL_MS);
    this._sweepTimer.unref?.();
  }

  _sweepIdleSessions() {
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      const remaining = session.pruneExpiredClients(now);
      if (remaining === 0) {
        session.destroy();
        this.sessions.delete(key);
      }
    }
  }

  getAttachedTargetKeys() {
    const out = new Set();
    for (const [key, session] of this.sessions.entries()) {
      if (!session._closed && session.state !== 'stopped') {
        out.add(key);
      }
    }
    return out;
  }

  syncActiveBrokers(activeBrokers) {
    if (!Array.isArray(activeBrokers)) return;
    const byKey = new Map();
    for (const b of activeBrokers) {
      if (b?.target_key) byKey.set(b.target_key, b);
    }
    for (const [key, session] of this.sessions.entries()) {
      if (session._closed || session.state === 'stopped') continue;
      const latest = byKey.get(key);
      if (latest) {
        session.applyBrokerInfo(latest);
      }
    }
  }

  /**
   * Detach a specific `clientId` from all targets EXCEPT `keepTargetKey` (if provided).
   */
  detachClientEverywhere(clientId, keepTargetKey = null) {
    if (!clientId) return;
    for (const [key, session] of this.sessions.entries()) {
      if (keepTargetKey && key === keepTargetKey) continue;
      const rem = session.removeClient(clientId);
      if (rem === 0) {
        session.destroy();
        this.sessions.delete(key);
      }
    }
  }

  detachClient(targetKey, clientId) {
    const key = canonicalTargetKey(targetKey);
    const session = this.sessions.get(key);
    if (!session) return { detached: true };
    if (clientId) {
      const rem = session.removeClient(clientId);
      if (rem === 0) {
        session.destroy();
        this.sessions.delete(key);
      }
    } else {
      session.destroy();
      this.sessions.delete(key);
    }
    return { detached: true };
  }

  /**
   * Ensure broker (if needed) and attach `clientId` to a live `StreamSession`.
   */
  async connect({ portUrl, targetKey, baud = DEFAULT_BAUD, clientId, spawnIfMissing = true }) {
    const key = canonicalTargetKey(targetKey || portUrl);
    if (!key) throw new Error('Missing targetKey or portUrl');

    // A single UI view watches one active board at a time; release any prior target watch for this view
    if (clientId) {
      this.detachClientEverywhere(clientId, key);
    }

    let broker = await findActiveBroker(key);
    if (!broker && spawnIfMissing) {
      broker = await ensureBroker({ portUrl: portUrl || key, baud });
    }
    if (!broker) {
      throw new Error(`No active serial monitor broker for '${key}'`);
    }

    let session = this.sessions.get(key);
    if (session && (session._closed || session.state === 'stopped')) {
      session.destroy();
      this.sessions.delete(key);
      session = null;
    }

    if (!session) {
      session = new StreamSession({
        targetKey: key,
        portUrl: broker.port_url || portUrl || key,
        baud: broker.baud || baud,
      });
      session.brokerInfo = broker;
      this.sessions.set(key, session);
      session.touchClient(clientId || 'default');
      await session.start({ spawnIfMissing: false });
    } else {
      session.brokerInfo = broker;
      session.touchClient(clientId || 'default');
      session.scheduleStatusRefresh(10);
    }

    // Wait briefly (up to 350ms) for initial tail replay if session just started connecting
    if (session.state === 'connecting') {
      await session.waitForUpdate({ sinceSeq: 0, sinceStateSeq: session.stateSeq, waitMs: 350 });
    }

    return session.getSnapshot(0);
  }

  async poll({ targetKey, clientId, sinceSeq = 0, sinceStateSeq = 0, waitMs = 10_000 }) {
    const key = canonicalTargetKey(targetKey);
    const session = this.sessions.get(key);
    if (!session || session._closed) {
      const liveBroker = await findActiveBroker(key);
      return {
        sessionId: null,
        targetKey: key,
        streamState: 'detached',
        stateSeq: 0,
        seq: 0,
        truncated: false,
        lastError: null,
        broker: liveBroker,
        lines: [],
      };
    }

    session.touchClient(clientId || 'default');
    return session.waitForUpdate({
      sinceSeq: Number(sinceSeq) || 0,
      sinceStateSeq: Number(sinceStateSeq) || 0,
      waitMs: Number(waitMs) || 10_000,
    });
  }

  async executeAction(targetKey, action, params = {}) {
    const key = canonicalTargetKey(targetKey);
    const broker = await findActiveBroker(key);
    if (!broker) {
      if (action === 'stop') {
        const sess = this.sessions.get(key);
        if (sess) {
          sess.destroy();
          this.sessions.delete(key);
        }
        return { ok: true, state: 'stopped' };
      }
      throw new Error(`No active serial monitor broker running for ${key}`);
    }

    const ctrlHost = broker.ctrl_host;
    const ctrlPort = Number(broker.ctrl_port);
    const session = this.sessions.get(key);

    if (action === 'stop') {
      if (session) {
        session.markIntentionalStop();
      }
      const resp = await sendCtrlRequest(ctrlHost, ctrlPort, { cmd: 'stop' }, 5000);
      if (session) {
        session.destroy();
        this.sessions.delete(key);
      }
      return resp;
    }

    if (action === 'reboot') {
      const resp = await sendCtrlRequest(ctrlHost, ctrlPort, { cmd: 'reboot', capture: 0 }, 8000);
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Hardware RTS reboot failed');
      }
      session?.scheduleStatusRefresh(50);
      return resp;
    }

    if (action === 'mark') {
      const label = String(params.label || 'checkpoint').trim().slice(0, 80) || 'checkpoint';
      const resp = await sendCtrlRequest(ctrlHost, ctrlPort, { cmd: 'mark', label }, 5000);
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Failed to insert log mark');
      }
      session?.scheduleStatusRefresh(50);
      return resp;
    }

    if (action === 'pause') {
      const timeout = Number(params.timeout) > 0 ? Number(params.timeout) : 300;
      const resp = await sendCtrlRequest(
        ctrlHost,
        ctrlPort,
        { cmd: 'pause', timeout, reason: 'serial-ui' },
        5000
      );
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Failed to pause serial monitor');
      }
      session?.scheduleStatusRefresh(50);
      return resp;
    }

    if (action === 'resume') {
      const resp = await sendCtrlRequest(
        ctrlHost,
        ctrlPort,
        { cmd: 'resume', reason: 'serial-ui', reset: Boolean(params.reset) },
        5000
      );
      if (!resp?.ok) {
        throw new Error(resp?.error || 'Failed to resume serial monitor');
      }
      session?.scheduleStatusRefresh(50);
      return resp;
    }

    throw new Error(`Unsupported broker action '${action}'`);
  }

  closeAll() {
    clearInterval(this._sweepTimer);
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }
}
