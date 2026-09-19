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
const NEEDS_GUACD = () => devices.devices.some(
  (d) => d.transport !== 'agent' || d.fallback);

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
  icon: 'i-monitor',
  capabilities: ['sse', 'fullscreen', 'webcodecs', 'summary'],
};

app.get('/module.json', (_req, res) => res.json(MANIFEST));

app.get('/api/health', (_req, res) => {
  const list = devices.list();
  const online = list.filter((d) => d.online === true);
  res.json({
    // Health is about THIS service. It used to be `online.length > 0`, which
    // made the gateway report itself broken whenever the laptop was switched
    // off — so the console greyed the module out, pointed its nav entry at
    // Settings, and the phone announced "Remote is unreachable" every time
    // the laptop went in a bag. The gateway was fine throughout. Which
    // devices are reachable is in the summary, where it is information.
    ok: true,
    reason: null,
    devices: list.length,
    online: online.length,
    transports: {
      agent: list.filter((d) => d.transport === 'agent').length,
      rdp: list.filter((d) => d.transport !== 'agent').length,
    },
    guacd: NEEDS_GUACD() ? `${GUACD_HOST}:${GUACD_PORT}` : 'not required',
  });
});

/**
 * The console's front page.
 *
 * What is worth knowing before you open this module is whether the machine you
 * want is reachable right now — not how many devices are configured, which
 * never changes. A dual-boot pair means exactly one of the two is up at a
 * time, so "1 of 3" is the healthy state and the names are the information.
 */
app.get('/api/summary', (_req, res) => {
  const list = devices.list();
  const online = list.filter((d) => d.online === true);
  const offline = list.filter((d) => d.online === false);
  const unknown = list.filter((d) => d.online == null);

  const facts = [
    { k: 'Reachable', v: online.length ? online.map((d) => d.name).join(', ') : 'nothing' },
    offline.length ? { k: 'Offline', v: offline.map((d) => d.name).join(', ') } : null,
    // Latency is the one number here that changes and that you would act on:
    // a link that has gone from 8ms to 400ms is a session that will feel awful
    // before you have finished opening it.
    online.length && Number.isFinite(online[0].latencyMs)
      ? { k: 'Latency', v: online.map((d) => `${d.name} ${Math.round(d.latencyMs)}ms`).slice(0, 2).join(' · ') }
      : null,
    unknown.length ? { k: 'Not probed yet', v: unknown.map((d) => d.name).join(', ') } : null,
  ].filter(Boolean).slice(0, 4);

  // A device being off is not something this module can fix or should warn
  // about: every device here is a personal machine you connect to when you
  // want it, and a laptop being shut down is how laptops are used. Whether a
  // machine is healthy is fleet's question. This card says what you could
  // connect to right now, and stays quiet about the rest.
  res.json({
    status: 'ok',
    headline: online.length
      ? `${online.length} of ${list.length} reachable`
      : list.length === 1
        ? `${list[0].name} is offline`
        : 'nothing to connect to right now',
    facts,
    alerts: [],
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
 * Is that machine's screen locked, and lift it if so.
 *
 * These exist because "the host is locked" was indistinguishable from "the
 * host is broken": gnome-remote-desktop refuses a connection to a locked
 * session, guacd reported upstream failure, and the client dialled again on a
 * timer forever. Now the reason is a fact the UI can state, with the one
 * action that fixes it next to it.
 */
app.get('/api/devices/:id/lock', async (req, res) => {
  const d = devices.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'unknown_device' });
  try {
    res.json(await agents.lockState(d));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.code || 'agent_unreachable', detail: e.message });
  }
});

app.post('/api/devices/:id/unlock', async (req, res) => {
  const d = devices.get(req.params.id);
  if (!d) return res.status(404).json({ error: 'unknown_device' });
  if (!d.agent?.url) {
    // An RDP-only device has no agent to ask, and saying so is better than a
    // 502 that reads like the machine is down.
    return res.status(501).json({ error: 'no_agent',
      detail: `${d.name} has no host agent, so its screen cannot be unlocked remotely` });
  }
  try {
    const r = await agents.unlock(d);
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.code || 'agent_unreachable', detail: e.message });
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

  // An agent-backed device asked for over guacd means the client cannot use
  // WebCodecs — iOS Safari being the case that matters — so serve its fallback
  // rather than refusing. Credentials come from the fallback block; the browser
  // only ever learns that one exists.
  const useFallback = d.transport === 'agent' || req.query.transport === 'rdp';
  const fb = useFallback ? d.fallback : null;
  if (useFallback && !fb) {
    return res.status(409).json({
      error: 'no_fallback',
      detail: `${d.name} has no rdp/vnc fallback — add a "fallback" block to devices.json`,
    });
  }
  const target = fb
    ? { protocol: fb.protocol, host: fb.host, port: fb.port,
        username: fb.username, password: fb.password, domain: '',
        security: fb.security, monitors: 'single', settings: {} }
    : d;

  const settings = target.protocol === 'rdp'
    ? {
        hostname: target.host,
        port: String(target.port),
        username: target.username,
        password: target.password,
        domain: target.domain,
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
        security: target.security || 'nla',
        // Both ends present self-signed certificates.
        'ignore-cert': 'true',
        // Lets the session resize cleanly if the server renegotiates rather
        // than stretching a stale framebuffer.
        'resize-method': 'display-update',
        'enable-wallpaper': 'true',
        // Windows can stream every monitor in one session; g-r-d cannot.
        ...(target.monitors === 'multimon' ? { 'enable-multimon': 'true' } : {}),
        ...target.settings,
      }
    : {
        hostname: target.host,
        port: String(target.port),
        password: target.password,
        ...target.settings,
      };

  const crypt = new GuacCrypt('AES-256-CBC', GUAC_KEY);
  const token = crypt.encrypt({
    connection: { type: target.protocol, settings: { ...settings, width: String(width), height: String(height), dpi: '96' } },
  });
  res.json({ token, protocol: target.protocol, monitors: target.monitors });
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
