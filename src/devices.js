/**
 * Device inventory and live presence.
 *
 * A "device" is a machine you can remote into. The gateway runs on the
 * always-on box and dials each one over the tailnet, which is the whole point
 * of the rewrite: the old build ran ON the laptop, so it was unreachable
 * exactly when you most wanted it — laptop asleep, or booted into the other OS.
 *
 * Presence is polled, not assumed. With a dual-boot machine exactly one of
 * `loq-linux` / `loq-windows` can be up at a time, and showing both as
 * available means every other click is a connection that hangs. A device you
 * cannot reach should say so before you tap it, not after eight seconds of
 * spinner.
 *
 * Credentials never leave this process. `sanitize()` is the only thing the
 * browser ever sees.
 */

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

/** Milliseconds a TCP probe waits before calling a device unreachable. */
const PROBE_TIMEOUT_MS = 2500;

/**
 * How a device's monitors behave. Declared per device rather than inferred,
 * because they are genuinely different and the UI has to be honest about it.
 *
 *   portal          the host agent captures any monitor through the desktop
 *                   portal. Switching re-points the encoder; the machine's
 *                   PRIMARY display is never touched, so nobody sitting at it
 *                   has their top bar and dock moved. Linux default.
 *
 *   multimon        the RDP server sends every monitor in one stream and the
 *                   client crops locally, so switching is instant and free.
 *                   Windows can do this; gnome-remote-desktop cannot.
 *
 *   single          one screen, no switching (a headless box, a VM).
 *
 *   primary-switch  legacy. Streams whichever monitor is primary and switches
 *                   by MOVING the primary flag — which rearranges the local
 *                   desktop. Kept only for hosts that cannot run the agent.
 */
const MONITOR_MODES = new Set(['portal', 'multimon', 'single', 'primary-switch']);

/**
 * How the gateway reaches a device's pixels.
 *
 *   agent  A host agent captures via the desktop portal and streams H.264 over
 *          a WebSocket. Any monitor, or all of them, and the machine's PRIMARY
 *          display is never touched. This is the Linux path.
 *
 *   rdp    guacd speaks RDP to the machine. Windows can stream every monitor
 *          in one session (multimon), which gnome-remote-desktop cannot — so
 *          the Windows side gets the merged canvas for free.
 */
const TRANSPORTS = new Set(['agent', 'rdp', 'vnc']);

export class DeviceRegistry {
  /**
   * @param {object} opts
   * @param {string} opts.file        path to devices.json
   * @param {number} opts.intervalMs  default presence poll interval
   */
  constructor({ file, intervalMs = 5000 } = {}) {
    this.file = file;
    this.intervalMs = intervalMs;
    this.devices = [];
    this.presence = new Map();   // id -> { online, since, latencyMs, checkedAt, error }
    this.timer = null;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      throw new Error(`${this.file}: ${e.message}\nCopy devices.example.json and fill it in.`);
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${this.file}: expected a non-empty array of devices.`);
    }

    const seen = new Set();
    this.devices = raw.map((d, i) => {
      const where = `devices[${i}]${d.id ? ` (${d.id})` : ''}`;
      if (!d.id || !/^[a-z][a-z0-9-]*$/.test(d.id)) {
        throw new Error(`${where}: id must be lowercase letters, digits and dashes.`);
      }
      if (seen.has(d.id)) throw new Error(`${where}: duplicate id.`);
      seen.add(d.id);
      if (!d.host) throw new Error(`${where}: host is required.`);

      // `transport` is the new axis; `protocol` is kept for rdp/vnc devices.
      const transport = d.transport || (d.agent?.url ? 'agent' : 'rdp');
      if (!TRANSPORTS.has(transport)) {
        throw new Error(`${where}: transport must be one of ${[...TRANSPORTS].join(', ')}.`);
      }
      const protocol = d.protocol || (transport === 'agent' ? 'h264' : 'rdp');

      const monitors = d.monitors || (transport === 'agent' ? 'portal' : 'single');
      if (!MONITOR_MODES.has(monitors)) {
        throw new Error(`${where}: monitors must be one of ${[...MONITOR_MODES].join(', ')}.`);
      }
      if (transport === 'agent' && !d.agent?.url) {
        // Caught at load rather than at the first click: without an agent there
        // is nothing to stream from, so the device would render and then fail.
        throw new Error(`${where}: transport "agent" needs agent.url — install agent/ on that host.`);
      }
      if (monitors === 'primary-switch') {
        // Supported, but it moves the machine's primary display and rearranges
        // the desk of whoever is sitting at it. "portal" does the same job
        // without that cost; this exists only for hosts that cannot run the agent.
        console.warn(`[devices] ${d.id}: monitors "primary-switch" MOVES the primary display on that machine. Prefer "portal".`);
      }

      return {
        id: d.id,
        name: d.name || d.id,
        transport,
        protocol,
        host: d.host,
        port: Number(d.port) || (protocol === 'rdp' ? 3389 : 5900),
        username: d.username || '',
        password: d.password || '',
        domain: d.domain || '',
        monitors,
        agent: d.agent ? { url: String(d.agent.url).replace(/\/+$/, ''), token: d.agent.token || '' } : null,
        /**
         * A second way in, for clients the primary transport cannot serve.
         *
         * The agent transport is H.264 over WebCodecs — lower latency and
         * better quality, and iOS Safari will not decode it. guacd streams
         * drawing instructions that Guacamole.js paints with canvas 2D, which
         * every browser can do; it is exactly what the original rdp.ojee.net
         * used and why that worked on a phone. Declaring both lets the client
         * pick per device rather than the deployment picking for everyone.
         */
        fallback: d.fallback ? {
          protocol: d.fallback.protocol || 'rdp',
          host: d.fallback.host || d.host,
          port: Number(d.fallback.port) || 3389,
          username: d.fallback.username || '',
          password: d.fallback.password || '',
          security: d.fallback.security || 'any',
        } : null,
        presence: { intervalMs: Number(d.presence?.intervalMs) || this.intervalMs },
        // Optional per-device overrides passed through to guacd.
        settings: d.settings || {},
      };
    });

    for (const d of this.devices) {
      if (!this.presence.has(d.id)) {
        this.presence.set(d.id, { online: null, since: null, latencyMs: null, checkedAt: 0, error: null });
      }
    }
    return this.devices;
  }

  get(id) {
    return this.devices.find((d) => d.id === id) || null;
  }

  /**
   * What the browser is allowed to know. Note what is absent: username,
   * password, domain. An RDP credential reaches guacd inside an encrypted
   * token and never touches the client — the version of this that returned a
   * VNC password as JSON is gone.
   */
  sanitize(d) {
    const p = this.presence.get(d.id) || {};
    return {
      id: d.id,
      name: d.name,
      transport: d.transport,
      protocol: d.protocol,
      monitors: d.monitors,
      hasAgent: !!d.agent?.url,
      // Whether a canvas-2D route exists for this device. The client needs to
      // know BEFORE it tries, so a browser that cannot decode H.264 can take
      // the other path instead of showing a black screen and a frame counter.
      // A boolean only — the credentials behind it never leave this process.
      hasFallback: !!d.fallback,
      online: p.online,
      since: p.since,
      latencyMs: p.latencyMs,
      checkedAt: p.checkedAt,
      error: p.error,
    };
  }

  list() {
    return this.devices.map((d) => this.sanitize(d));
  }

  /**
   * One TCP probe. Deliberately not an RDP handshake: a handshake against
   * gnome-remote-desktop opens and tears down a session, and doing that every
   * five seconds would fight the real client for the socket.
   */
  /** Where a probe should actually connect for this device. */
  probeTarget(device) {
    // An agent-backed device is reachable when its AGENT answers, not when some
    // RDP port does — it may not be running an RDP server at all. Probing
    // device.port there would report every Linux host permanently offline.
    if (device.transport === 'agent' && device.agent?.url) {
      const u = new URL(device.agent.url);
      return { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
    }
    return { host: device.host, port: device.port };
  }

  probe(device) {
    return new Promise((resolve) => {
      const started = Date.now();
      const sock = connect(this.probeTarget(device));
      let settled = false;

      const done = (online, error) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve({ online, latencyMs: online ? Date.now() - started : null, error });
      };

      sock.setTimeout(PROBE_TIMEOUT_MS);
      sock.once('connect', () => done(true, null));
      sock.once('timeout', () => done(false, 'timed out'));
      sock.once('error', (e) => done(false, e.code || e.message));
    });
  }

  async refresh(device) {
    const r = await this.probe(device);
    const prev = this.presence.get(device.id) || {};
    const flipped = prev.online !== r.online;
    this.presence.set(device.id, {
      online: r.online,
      // `since` answers "how long has it been up/down", which is the question
      // you actually have when a machine is misbehaving.
      since: flipped ? Date.now() : (prev.since ?? Date.now()),
      latencyMs: r.latencyMs,
      checkedAt: Date.now(),
      error: r.error,
    });
    return flipped;
  }

  /** Poll everything on a loop. Returns a stop function. */
  start({ onChange } = {}) {
    if (this.timer) return () => this.stop();
    const tick = async () => {
      const flips = await Promise.all(this.devices.map((d) => this.refresh(d).catch(() => false)));
      if (flips.some(Boolean)) onChange?.(this.list());
      this.timer = setTimeout(tick, this.intervalMs);
      this.timer.unref?.();
    };
    tick();
    return () => this.stop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export { MONITOR_MODES, TRANSPORTS, PROBE_TIMEOUT_MS };
