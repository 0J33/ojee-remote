/**
 * ojee-remote — browser remote desktop, as an ojee-console module.
 *
 * Runs on the always-on box and dials each source over the tailnet. Serves the
 * module contract (`/module.json`, `/ui/index.js`, `/api/*`) plus a `/guac`
 * WebSocket that bridges the browser to guacd.
 *
 * The three things this rewrite exists to fix, all of which were failures of
 * *not knowing*, not of protocol:
 *
 *   1. Switching monitors tore down the RDP session and the client reconnected
 *      on a blind 1.2s timer — often before the compositor had finished, which
 *      is the black screen. Now the host agent confirms the switch landed
 *      (measured: 95-334ms) and the client holds the last frame until the new
 *      connection produces a real one.
 *
 *   2. Reconnects were scheduled from four places and could stack, so one drop
 *      produced several overlapping attempts that each killed the next. Now
 *      there is one reconnect controller with capped backoff, and it gives up
 *      loudly instead of retrying forever behind a spinner.
 *
 *   3. Every failure rendered as the same red "disconnected". Now "device
 *      offline", "switching monitor", "reconnecting (3/5)" and "session ended"
 *      are distinct, because the response to each is different.
 */

import 'dotenv/config';

import express from 'express';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import GuacamoleLite from 'guacamole-lite';
import GuacCrypt from 'guacamole-lite/lib/Crypt.js';

import { DeviceRegistry } from './devices.js';
import { HostAgents } from './agents.js';
import { createAgentProxy } from './agent-proxy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const {
  PORT = '8200',
  HOST = '0.0.0.0',
  DEVICES_FILE = join(ROOT, 'devices.json'),
  GUAC_KEY = '',
  GUACD_HOST = '127.0.0.1',
  GUACD_PORT = '4822',
  PRESENCE_INTERVAL_MS = '5000',
} = process.env;

// guacd is only needed for rdp/vnc devices — the Linux path goes through the
// host agent instead. A deployment with only agent-backed devices should not
// be forced to run guacd or invent a key for it.
const NEEDS_GUACD = () => devices.devices.some((d) => d.transport !== 'agent');

const devices = new DeviceRegistry({
  file: DEVICES_FILE,
  intervalMs: Number(PRESENCE_INTERVAL_MS),
});
const agents = new HostAgents();

if (NEEDS_GUACD() && (!GUAC_KEY || GUAC_KEY.length !== 32)) {
  // guacamole-lite's AES-256-CBC needs exactly 32 bytes. A wrong length fails
  // deep inside the crypt layer with an opaque error at first connect, so it
  // is checked at boot where the message can actually help.
  throw new Error(
    'GUAC_KEY must be exactly 32 characters for rdp/vnc devices.\n'
    + '  Generate: openssl rand -hex 16\n'
    + '  (agent-backed devices do not need it — remove the rdp/vnc devices to drop the requirement.)',
  );
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

/* ── module contract ────────────────────────────────────────────────────── */

const MANIFEST = {
  id: 'remote',
  name: 'Remote',
  version: pkg.version,
  views: [{ id: 'screen', label: 'Screen', icon: 'i-monitor' }],
  ui: '/ui/index.js',
  health: '/api/health',
  capabilities: ['sse', 'fullscreen', 'webcodecs'],
};

app.get('/module.json', (_req, res) => res.json(MANIFEST));

app.get('/api/health', (_req, res) => {
  const list = devices.list();
  const online = list.filter((d) => d.online === true);
  res.json({
    // Not ok when nothing is reachable: the console then shows this module as
    // degraded with the reason, instead of a nav entry that leads to a dead
    // screen. A dual-boot pair means at most one of the two is ever up, so
    // "some online" is the healthy state, not "all".
    ok: online.length > 0,
    reason: online.length ? null
      : `no device reachable (${list.map((d) => d.name).join(', ')})`,
    devices: list.length,
    online: online.length,
    transports: {
      agent: list.filter((d) => d.transport === 'agent').length,
      rdp: list.filter((d) => d.transport !== 'agent').length,
    },
    guacd: NEEDS_GUACD() ? `${GUACD_HOST}:${GUACD_PORT}` : 'not required',
  });
});

/* ── devices ────────────────────────────────────────────────────────────── */

app.get('/api/devices', (_req, res) => res.json({ devices: devices.list() }));

/**
 * Live device state over SSE. Presence flips are pushed rather than polled by
 * every open tab: with a dual-boot machine the interesting event is a device
 * coming back after a reboot, and you want the picker to notice on its own.
 */
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
  req.socket.setNoDelay(true);

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('devices', { devices: devices.list() });

  const unsubscribe = subscribe((list) => send('devices', { devices: list }));
  // Without a heartbeat an idle proxy eventually decides the connection is
  // dead and drops it silently — the UI keeps its stale list and never notices.
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  req.on('close', () => { unsubscribe(); clearInterval(beat); });
});

const subscribers = new Set();
const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const broadcast = (list) => { for (const fn of subscribers) { try { fn(list); } catch { /* one bad subscriber must not stop the rest */ } } };

/* ── monitors ───────────────────────────────────────────────────────────── */

app.get('/api/devices/:id/monitors', async (req, res) => {
  const d = devices.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'unknown_device' });

  if (d.transport !== 'agent' && d.monitors !== 'primary-switch') {
    // multimon sends every screen in one stream; the client crops locally, so
    // there is nothing for the server to enumerate.
    return res.json({ mode: d.monitors, monitors: [] });
  }
  try {
    const monitors = await agents.monitors(d);
    res.json({ mode: d.monitors, monitors });
  } catch (e) {
    res.status(502).json({ error: 'agent_unreachable', detail: e.message });
  }
});

/**
 * Discard the host's saved portal grant and request a new one.
 *
 * Needed because a grant covers exactly the displays ticked in the dialog and
 * cannot be widened: plug in a monitor afterwards and the agent can see it
 * through the compositor but never capture it. A prompt appears on that
 * machine — someone has to accept it, which is the point.
 */
app.post('/api/devices/:id/regrant', async (req, res) => {
  const d = devices.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'unknown_device' });
  if (d.transport !== 'agent') {
    return res.status(400).json({ error: 'not_agent_backed',
      detail: 'only agent-backed devices have a portal grant' });
  }
  try {
    res.json(await agents.regrant(d));
  } catch (e) {
    res.status(502).json({ error: 'agent_unreachable', detail: e.message });
  }
});

/**
 * Switch which monitor is streamed.
 *
 * This does NOT return until the host agent confirms the compositor has
 * applied the change and RDP is accepting again. That is the entire fix: the
 * old client fired a blind 1.2s timer and reconnected into a half-rebuilt
 * session, which is what produced the black screens and the reconnect loop.
 */
app.post('/api/devices/:id/primary', async (req, res) => {
  const d = devices.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'unknown_device' });
  if (d.monitors !== 'primary-switch') {
    return res.status(400).json({ error: 'not_switchable', mode: d.monitors });
  }

  const monitor = String(req.body?.monitor || '').trim();
  if (!monitor) return res.status(400).json({ error: 'monitor_required' });

  try {
    const result = await agents.setPrimary(d, monitor);
    res.json(result);
  } catch (e) {
    const status = e.status || 502;
    res.status(status).json({ error: e.code || 'switch_failed', detail: e.message });
  }
});

/* ── connection tokens ──────────────────────────────────────────────────── */

/**
 * Mint a one-shot encrypted connection token.
 *
 * Credentials ride inside AES-256-CBC ciphertext that only guacd's side can
 * read; the browser holds an opaque blob. That is what lets the client
 * reconnect without the server ever handing it a password.
 */
app.get('/api/devices/:id/token', async (req, res) => {
  const d = devices.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'unknown_device' });

  const p = devices.presence.get(d.id);
  if (p?.online === false) {
    // Refuse early with a reason. Minting a token for an unreachable host just
    // moves the failure to a place with less context.
    return res.status(409).json({
      error: 'device_offline',
      detail: p.error ? `${d.host}:${d.port} — ${p.error}` : `${d.host}:${d.port} is not accepting connections`,
    });
  }

  const width = Math.min(Number(req.query.width) || 1920, 8192);
  const height = Math.min(Number(req.query.height) || 1080, 8192);

  const settings = d.protocol === 'rdp'
    ? {
        hostname: d.host,
        port: String(d.port),
        username: d.username,
        password: d.password,
        domain: d.domain,
        // NLA, not "any".
        //
        // gnome-remote-desktop requires CredSSP/NLA and refuses plain TLS with
        // HYBRID_REQUIRED_BY_SERVER. Guacamole's "any" lets the negotiation
        // pick, and when it picks TLS the handshake fails — the session dies
        // before a single frame arrives. Verified directly:
        //
        //   xfreerdp … /sec:tls  → ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED
        //   xfreerdp … /sec:nla  → connects
        //
        // The previous build shipped 'any', which is a large part of why it
        // "kept disconnecting" independently of the monitor-switch bug.
        // Override per device via `settings` if a host needs something else —
        // some Windows configurations want 'tls' or 'rdp'.
        security: 'nla',
        // Both ends present self-signed certificates.
        'ignore-cert': 'true',
        // Lets the session resize cleanly if the server renegotiates rather
        // than stretching a stale framebuffer.
        'resize-method': 'display-update',
        'enable-wallpaper': 'true',
        // Windows can stream every monitor in one session; g-r-d cannot.
        ...(d.monitors === 'multimon' ? { 'enable-multimon': 'true' } : {}),
        ...d.settings,
      }
    : {
        hostname: d.host,
        port: String(d.port),
        password: d.password,
        ...d.settings,
      };

  const crypt = new GuacCrypt('AES-256-CBC', GUAC_KEY);
  const token = crypt.encrypt({
    connection: { type: d.protocol, settings: { ...settings, width: String(width), height: String(height), dpi: '96' } },
  });
  res.json({ token, protocol: d.protocol, monitors: d.monitors });
});

/* ── static: module UI + standalone shell ───────────────────────────────── */

app.use('/ui', express.static(join(ROOT, 'ui'), {
  setHeaders: (res) => res.setHeader('cache-control', 'no-cache'),
}));
app.use('/guac-js', express.static(join(ROOT, 'node_modules', 'guacamole-common-js', 'dist', 'esm')));
// The standalone shell. Mounted in a console this is never requested; served
// alone it is the whole front end. See the README — standalone is tested, not
// assumed, because this deployment only ever runs it mounted.
app.use(express.static(join(ROOT, 'public'), { extensions: ['html'] }));

/* ── guacd bridge ───────────────────────────────────────────────────────── */

const server = createServer(app);

const guac = NEEDS_GUACD() ? new GuacamoleLite(
  // `server: undefined` is load-bearing: guacamole-lite injects a default
  // `port: 8080` unless a `server` key is present, and ws refuses a config
  // holding both `port` and `noServer`.
  { server: undefined, noServer: true },
  { host: GUACD_HOST, port: Number(GUACD_PORT) },
  {
    crypt: { cypher: 'AES-256-CBC', key: GUAC_KEY },
    log: { level: 'ERRORS' },
    // Default 10s kills an idle viewing session and freezes the canvas on its
    // last frame — the "connects but not really" symptom. 0 disables it.
    maxInactivityTime: 0,
  },
) : null;

// guacamole-lite hijacks SIGTERM/SIGINT to close its ws server WITHOUT exiting
// the process, leaving a zombie that answers HTTP but 503s every tunnel and
// makes systemd restarts hang until SIGKILL. Detach; the default signal
// behaviour (exit) is what we want.
if (guac) {
  process.removeListener('SIGTERM', guac.sigTermHandler);
  process.removeListener('SIGINT', guac.sigIntHandler);
}

const agentProxy = createAgentProxy({ devices });

server.on('upgrade', (req, socket, head) => {
  // Auth already happened: mounted, the console's three gates ran before it
  // proxied here; standalone, the tailnet is the boundary.

  // Agent-backed devices — the Linux path. The proxy attaches the agent's
  // bearer token, which the browser therefore never has to hold.
  if (agentProxy.handleUpgrade(req, socket, head)) return;

  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/guac' && guac) {
    guac.webSocketServer.handleUpgrade(req, socket, head, (ws) =>
      guac.webSocketServer.emit('connection', ws, req));
    return;
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

/* ── boot ───────────────────────────────────────────────────────────────── */

devices.start({ onChange: broadcast });

server.listen(Number(PORT), HOST, () => {
  console.log(`ojee-remote ${pkg.version} on http://${HOST}:${PORT}`);
  console.log(`  guacd ${NEEDS_GUACD() ? `${GUACD_HOST}:${GUACD_PORT}` : 'not required (no rdp/vnc devices)'}`);
  for (const d of devices.devices) {
    const where = d.transport === 'agent' ? d.agent.url : `${d.protocol}://${d.host}:${d.port}`;
    console.log(`  ${d.id.padEnd(14)} ${d.transport.padEnd(6)} ${where}  [${d.monitors}]`);
  }
});

const shutdown = () => {
  devices.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app, server, devices, agents };
