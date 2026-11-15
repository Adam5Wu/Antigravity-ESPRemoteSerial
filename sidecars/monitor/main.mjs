/**
 * Antigravity Sidecar Backend for Serial Monitor (`serial-monitor/monitor`).
 *
 * Serves the Auxiliary Side Pane Web UI and exposes local loopback endpoints for:
 *   - GET  /api/targets         (Merged list of active brokers + persisted target bookmarks)
 *   - POST /api/targets/save    (Create or update a saved target bookmark / nickname)
 *   - POST /api/targets/delete  (Remove a saved target bookmark)
 *   - POST /api/connect         (Ensure broker if needed and attach UI client stream)
 *   - POST /api/detach          (Release UI client stream lease so idle brokers can auto-exit)
 *   - GET  /api/stream          (Cursor long-poll for live log lines + broker state transitions)
 *   - POST /api/action          (Execute one-click `reboot`, `mark`, `pause`, `resume`, or `stop`)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  BrokerStreamManager,
  DEFAULT_BAUD,
  canonicalTargetKey,
  describeEndpoint,
  listActiveBrokers,
  normalizeTargetInput,
} from './broker_client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

function resolveDataDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return join(homedir(), '.gemini', 'antigravity', 'sidecar_data', 'serial-monitor', 'monitor', 'data');
}

const DATA_DIR = resolveDataDir();
const STATE_FILE = join(DATA_DIR, 'state.json');

function loadPersistedState() {
  const fallback = {
    version: 1,
    targets: {},
    lastSelectedTargetKey: null,
  };
  try {
    if (!existsSync(STATE_FILE)) return fallback;
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    const targets = {};
    if (raw?.targets && typeof raw.targets === 'object') {
      for (const [, entry] of Object.entries(raw.targets)) {
        try {
          const norm = normalizeTargetInput({
            portUrl: entry?.portUrl,
            host: entry?.host,
            port: entry?.port,
            baud: entry?.baud ?? DEFAULT_BAUD,
            nickname: entry?.nickname ?? '',
          });
          targets[norm.targetKey] = {
            targetKey: norm.targetKey,
            portUrl: norm.portUrl,
            baud: norm.baud,
            nickname: norm.nickname,
            createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
            lastUsedAt: typeof entry?.lastUsedAt === 'string' ? entry.lastUsedAt : null,
          };
        } catch {
          // Skip malformed saved entries
        }
      }
    }
    return {
      version: 1,
      targets,
      lastSelectedTargetKey:
        typeof raw?.lastSelectedTargetKey === 'string' ? canonicalTargetKey(raw.lastSelectedTargetKey) : null,
    };
  } catch (err) {
    console.error('[serial_monitor] Failed to load state.json, starting fresh:', err.message);
    return fallback;
  }
}

const persisted = loadPersistedState();

function savePersistedState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), 'utf-8');
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[serial_monitor] Failed to persist state.json:', err.message);
  }
}

const streamManager = new BrokerStreamManager();

async function buildMergedTargets() {
  const activeBrokers = await listActiveBrokers();
  streamManager.syncActiveBrokers(activeBrokers);
  const brokerMap = new Map();
  for (const b of activeBrokers) {
    if (b?.target_key) {
      brokerMap.set(b.target_key, b);
    }
  }

  const attachedKeys = streamManager.getAttachedTargetKeys();
  const allKeys = new Set([...Object.keys(persisted.targets), ...brokerMap.keys()]);

  const items = [];
  for (const key of allKeys) {
    const saved = persisted.targets[key] || null;
    const broker = brokerMap.get(key) || null;
    const portUrl = broker?.port_url || saved?.portUrl || key;
    const endpoint = describeEndpoint(portUrl);

    items.push({
      targetKey: key,
      saved: Boolean(saved),
      nickname: saved?.nickname || '',
      portUrl,
      configuredBaud: saved?.baud || broker?.baud || DEFAULT_BAUD,
      activeBaud: broker?.baud || null,
      isRemote: endpoint.isRemote,
      host: endpoint.host,
      port: endpoint.port,
      displayEndpoint: endpoint.displayEndpoint,
      active: Boolean(broker),
      uiAttached: attachedKeys.has(key),
      lastUsedAt: saved?.lastUsedAt || null,
      broker: broker
        ? {
            pid: broker.pid,
            state: broker.state || 'unknown',
            baud: broker.baud,
            watcherCount: Number(broker.watcher_count ?? 0),
            watchers: Array.isArray(broker.watchers) ? broker.watchers : [],
            leaseHolder: broker.lease_holder || null,
            linesLogged: Number(broker.lines_logged ?? 0),
            bytesRx: Number(broker.bytes_rx ?? 0),
            idleSecondsRemaining:
              typeof broker.idle_seconds_remaining === 'number' ? broker.idle_seconds_remaining : null,
            startedAt: broker.started_at || null,
            logFile: broker.log_file || null,
          }
        : null,
    });
  }

  items.sort((a, b) => {
    if (a.uiAttached !== b.uiAttached) return a.uiAttached ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.nickname && !b.nickname) return -1;
    if (!a.nickname && b.nickname) return 1;
    return a.displayEndpoint.localeCompare(b.displayEndpoint, undefined, { numeric: true });
  });

  return items;
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    contentType: 'application/json',
  });
}

// ---------------------------------------------------------------------------
// Sidecar HTTP Server Registration
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

for (const [route, [filename, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, filename), 'utf-8'), { contentType }),
    'GET'
  );
}

app.api(
  '/api/targets',
  async () => {
    const targets = await buildMergedTargets();
    return {
      ok: true,
      targets,
      lastSelectedTargetKey: persisted.lastSelectedTargetKey,
    };
  },
  'GET'
);

app.api(
  '/api/targets/save',
  async (data) => {
    try {
      const spec = normalizeTargetInput(data || {});
      const prevKey = data?.prevTargetKey ? canonicalTargetKey(data.prevTargetKey) : null;
      const existing = persisted.targets[spec.targetKey] || (prevKey ? persisted.targets[prevKey] : null);

      if (prevKey && prevKey !== spec.targetKey) {
        delete persisted.targets[prevKey];
      }

      persisted.targets[spec.targetKey] = {
        targetKey: spec.targetKey,
        portUrl: spec.portUrl,
        baud: spec.baud,
        nickname: spec.nickname,
        createdAt: existing?.createdAt || new Date().toISOString(),
        lastUsedAt: existing?.lastUsedAt || new Date().toISOString(),
      };
      persisted.lastSelectedTargetKey = spec.targetKey;
      savePersistedState();

      return {
        ok: true,
        targetKey: spec.targetKey,
        targets: await buildMergedTargets(),
      };
    } catch (err) {
      return jsonError(err.message || 'Invalid target configuration', 400);
    }
  },
  'POST'
);

app.api(
  '/api/targets/delete',
  async (data) => {
    const key = canonicalTargetKey(data?.targetKey || '');
    if (!key) return jsonError('Missing targetKey', 400);

    delete persisted.targets[key];
    if (persisted.lastSelectedTargetKey === key) {
      persisted.lastSelectedTargetKey = null;
    }
    savePersistedState();

    return {
      ok: true,
      targets: await buildMergedTargets(),
    };
  },
  'POST'
);

app.api(
  '/api/connect',
  async (data) => {
    try {
      const clientId = String(data?.clientId || 'default').trim() || 'default';
      let portUrl = '';
      let baud = DEFAULT_BAUD;
      let targetKey = data?.targetKey ? canonicalTargetKey(data.targetKey) : '';

      if (data?.host || data?.portUrl) {
        const spec = normalizeTargetInput(data);
        targetKey = spec.targetKey;
        portUrl = spec.portUrl;
        baud = spec.baud;

        if (data?.save) {
          const prevKey = data?.prevTargetKey ? canonicalTargetKey(data.prevTargetKey) : null;
          if (prevKey && prevKey !== spec.targetKey) {
            delete persisted.targets[prevKey];
          }
          const existing = persisted.targets[spec.targetKey];
          persisted.targets[spec.targetKey] = {
            targetKey: spec.targetKey,
            portUrl: spec.portUrl,
            baud: spec.baud,
            nickname: spec.nickname || existing?.nickname || '',
            createdAt: existing?.createdAt || new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          };
        }
      } else if (targetKey) {
        const saved = persisted.targets[targetKey];
        if (saved) {
          portUrl = saved.portUrl;
          baud = data?.baud ? Number(data.baud) : saved.baud;
          saved.lastUsedAt = new Date().toISOString();
        } else {
          portUrl = targetKey;
          if (/^rfc2217:\/\//i.test(portUrl) && !portUrl.includes('?')) {
            portUrl = `${portUrl}?ign_set_control`;
          }
          if (data?.baud) baud = Number(data.baud);
        }
      } else {
        return jsonError('Specify a targetKey or host/port configuration', 400);
      }

      persisted.lastSelectedTargetKey = targetKey;
      savePersistedState();

      const snapshot = await streamManager.connect({
        targetKey,
        portUrl,
        baud,
        clientId,
        spawnIfMissing: data?.spawnIfMissing !== false,
      });

      return {
        ok: true,
        snapshot,
        targets: await buildMergedTargets(),
      };
    } catch (err) {
      return jsonError(err.message || 'Failed to connect to serial broker', 502);
    }
  },
  'POST'
);

app.api(
  '/api/detach',
  async (data) => {
    const clientId = String(data?.clientId || '').trim();
    const targetKey = data?.targetKey ? canonicalTargetKey(data.targetKey) : '';

    if (targetKey) {
      streamManager.detachClient(targetKey, clientId || null);
    } else if (clientId) {
      streamManager.detachClientEverywhere(clientId);
    }

    return {
      ok: true,
      targets: await buildMergedTargets(),
    };
  },
  'POST'
);

app.api(
  '/api/stream',
  async (data) => {
    const targetKey = canonicalTargetKey(data?.targetKey || '');
    if (!targetKey) return jsonError('Missing targetKey', 400);

    const snapshot = await streamManager.poll({
      targetKey,
      clientId: String(data?.clientId || 'default'),
      sinceSeq: Number(data?.sinceSeq || 0),
      sinceStateSeq: Number(data?.sinceStateSeq || 0),
      waitMs: Number(data?.waitMs ?? 10_000),
    });

    return {
      ok: true,
      ...snapshot,
    };
  },
  'GET'
);

app.api(
  '/api/action',
  async (data) => {
    const targetKey = canonicalTargetKey(data?.targetKey || '');
    const action = String(data?.action || '').trim();
    if (!targetKey || !action) {
      return jsonError('Missing targetKey or action', 400);
    }

    try {
      const result = await streamManager.executeAction(targetKey, action, data || {});
      return {
        ok: true,
        result,
        targets: await buildMergedTargets(),
      };
    } catch (err) {
      return jsonError(err.message || `Action '${action}' failed`, 502);
    }
  },
  'POST'
);

function shutdown() {
  streamManager.closeAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[serial_monitor] state file: ${STATE_FILE}`);
app.run();
