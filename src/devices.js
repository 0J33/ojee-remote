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
 * How each device's monitors behave. Declared per device rather than inferred,
 * because the two are genuinely different and the UI has to be honest about it:
 *
 *   primary-switch  gnome-remote-desktop streams ONE monitor — whichever is
 *                   primary. Switching means asking the host agent to move the
 *                   primary flag, which rebuilds the session. You see one
 *                   screen at a time and there is no way around it.
 *
 *   multimon        the RDP server sends every monitor in one stream. The
 *                   client shows the merged canvas and crops locally, so
 *                   switching is instant and free. Windows can do this;
 *                   gnome-remote-desktop cannot.
 *
 *   single          one screen, no switching (a headless box, a VM).
 */
const MONITOR_MODES = new Set(['primary-switch', 'multimon', 'single']);

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

      const protocol = d.protocol || 'rdp';
      if (!['rdp', 'vnc'].includes(protocol)) {
        throw new Error(`${where}: protocol must be "rdp" or "vnc".`);
      }

      const monitors = d.monitors || (protocol === 'rdp' ? 'single' : 'single');
      if (!MONITOR_MODES.has(monitors)) {
        throw new Error(`${where}: monitors must be one of ${[...MONITOR_MODES].join(', ')}.`);
      }
      if (monitors === 'primary-switch' && !d.agent?.url) {
        // Catch this at load rather than at the first click. Without an agent
        // there is no way to move the primary flag, so the chips would render
        // and then fail on use.
        throw new Error(`${where}: monitors "primary-switch" needs an agent — install agent/ on that host and set agent.url.`);
      }

      return {
        id: d.id,
        name: d.name || d.id,
        protocol,
        host: d.host,
        port: Number(d.port) || (protocol === 'rdp' ? 3389 : 5900),
        username: d.username || '',
        password: d.password || '',
        domain: d.domain || '',
        monitors,
        agent: d.agent ? { url: String(d.agent.url).replace(/\/+$/, ''), token: d.agent.token || '' } : null,
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
      protocol: d.protocol,
      monitors: d.monitors,
      hasAgent: !!d.agent?.url,
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
  probe(device) {
    return new Promise((resolve) => {
      const started = Date.now();
      const sock = connect({ host: device.host, port: device.port });
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

export { MONITOR_MODES, PROBE_TIMEOUT_MS };
