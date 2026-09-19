/**
 * WebSocket bridge: browser ⇄ gateway ⇄ SSH.
 *
 * The same shape as the agent proxy next door, and for the same reason: the
 * browser never holds a credential. It opens `/shell?device=<id>`, the gateway
 * looks the device up in devices.json, dials SSH over the tailnet and pipes the
 * PTY back. A key file, a passphrase or a password stays in this process.
 *
 * Wire protocol, deliberately two-channel:
 *
 *   binary frames   terminal bytes, both directions, untouched. A terminal is
 *                   a byte stream — decoding it to a JS string here would mean
 *                   re-encoding it there, and a UTF-8 sequence split across
 *                   two frames would break on the way through.
 *   text frames     JSON control. Client: {t:'resize',cols,rows}. Server:
 *                   {t:'status',state,detail} — 'connecting' | 'ready' |
 *                   'closed' | 'error'.
 *
 * Why SFTP later rides this same connection: one dial, one credential, one
 * thing to get right.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { WebSocketServer } from 'ws';
import { Client as SSHClient } from 'ssh2';

/** Give up dialling after this. The tailnet is usually fast or dead. */
const READY_TIMEOUT_MS = 15000;
/** Keepalives: three missed in a row (60s) and the session is gone. */
const KEEPALIVE_MS = 20000;
const KEEPALIVE_MAX = 3;
/** A terminal that claims 10000 columns is a bug or an attack, not a terminal. */
const MAX_COLS = 500;
const MAX_ROWS = 300;

const clamp = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** `~/.ssh/id_ed25519` → `/home/you/.ssh/id_ed25519`. */
export function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return resolve(homedir(), s.slice(2));
  return s;
}

/** The SHA-256 fingerprint OpenSSH would print for a host key. */
export function keyFingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Turn a device's `ssh` block into ssh2 connect options.
 *
 * Separated from the dialling so it can be tested without a server, and so a
 * misconfigured device fails with a sentence rather than an ECONNREFUSED.
 */
export function connectOptions(device) {
  const s = device.ssh;
  if (!s) throw new Error(`${device.id}: no ssh block in devices.json`);

  const opts = {
    host: s.host,
    port: s.port,
    username: s.username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: KEEPALIVE_MS,
    keepaliveCountMax: KEEPALIVE_MAX,
  };
  if (!opts.username) throw new Error(`${device.id}: ssh.username is required`);

  if (s.keyFile) {
    try {
      opts.privateKey = readFileSync(expandHome(s.keyFile));
    } catch (e) {
      throw new Error(`${device.id}: cannot read ssh.keyFile ${s.keyFile} — ${e.code || e.message}`);
    }
    if (s.passphrase) opts.passphrase = s.passphrase;
  } else if (s.password) {
    opts.password = s.password;
    // Some sshd configurations answer password auth only through
    // keyboard-interactive. Without this the connect fails as "All
    // configured authentication methods failed" with a correct password.
    opts.tryKeyboard = true;
  } else if (process.env.SSH_AUTH_SOCK) {
    // Nothing configured, but the gateway has an agent — use it rather than
    // failing. This is how the box's own keys reach a device without copying
    // them into devices.json.
    opts.agent = process.env.SSH_AUTH_SOCK;
  } else {
    throw new Error(`${device.id}: ssh needs keyFile, password, or an ssh-agent on the gateway`);
  }
  return opts;
}

export function createShellBridge({ devices, log = console } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client, req, device) => {
    const say = (state, detail) => {
      if (client.readyState !== client.OPEN) return;
      try { client.send(JSON.stringify({ t: 'status', state, ...(detail ? { detail } : {}) })); } catch { /* client gone */ }
    };

    const url = new URL(req.url, 'http://x');
    const cols = clamp(url.searchParams.get('cols'), 20, MAX_COLS, 80);
    const rows = clamp(url.searchParams.get('rows'), 5, MAX_ROWS, 24);

    let conn = null;
    let stream = null;
    let closed = false;

    const shutdown = (code, reason) => {
      if (closed) return;
      closed = true;
      try { stream?.end(); } catch { /* already gone */ }
      try { conn?.end(); } catch { /* already gone */ }
      try { client.close(code, reason); } catch { /* already gone */ }
    };

    let opts;
    try {
      opts = connectOptions(device);
    } catch (e) {
      say('error', e.message);
      shutdown(1011, 'ssh_config');
      return;
    }

    say('connecting', `${opts.username}@${opts.host}:${opts.port}`);

    conn = new SSHClient();

    // Host keys. A pinned fingerprint in devices.json is checked; without one
    // the key is accepted and logged, so the first connection tells you what
    // to pin. Refusing outright would mean nobody can connect until they have
    // run ssh by hand on the gateway.
    const pinned = device.ssh.fingerprint || '';

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, ch) => {
        if (err) {
          say('error', `shell: ${err.message}`);
          shutdown(1011, 'shell_failed');
          return;
        }
        stream = ch;
        say('ready');

        stream.on('data', (d) => {
          if (client.readyState === client.OPEN) client.send(d, { binary: true });
        });
        // stderr of the channel itself (not the shell's) — rare, but silently
        // dropping it hides sshd-side problems.
        stream.stderr?.on('data', (d) => {
          if (client.readyState === client.OPEN) client.send(d, { binary: true });
        });
        stream.on('close', () => { say('closed', 'session ended'); shutdown(1000, 'shell_closed'); });
      });
    });

    conn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([opts.password || '']));

    conn.on('error', (e) => {
      // ssh2's messages are already specific ("All configured authentication
      // methods failed", ECONNREFUSED); pass them through rather than
      // flattening everything to "connection failed".
      say('error', e.message || String(e));
      shutdown(1011, 'ssh_error');
    });
    conn.on('close', () => { shutdown(1000, 'ssh_closed'); });

    client.on('message', (data, isBinary) => {
      if (isBinary) {
        stream?.write(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.t === 'resize' && stream) {
        stream.setWindow(clamp(msg.rows, 5, MAX_ROWS, rows), clamp(msg.cols, 20, MAX_COLS, cols), 0, 0);
      }
    });
    client.on('close', () => shutdown(1000, 'client_closed'));
    client.on('error', () => shutdown(1011, 'client_error'));

    conn.connect({
      ...opts,
      hostVerifier: (key) => {
        const fp = keyFingerprint(key);
        if (pinned) {
          const ok = fp === pinned;
          if (!ok) log.warn?.(`[shell] ${device.id}: host key ${fp} does not match pinned ${pinned}`);
          return ok;
        }
        log.log?.(`[shell] ${device.id}: host key ${fp} (pin it as ssh.fingerprint in devices.json)`);
        return true;
      },
    });
  });

  return {
    /** Claims `/shell?device=<id>`. Returns false so other handlers can try. */
    handleUpgrade(req, socket, head) {
      const { pathname, searchParams } = new URL(req.url, 'http://x');
      if (pathname !== '/shell') return false;

      const device = devices.get(searchParams.get('device') || '');
      if (!device || !device.ssh) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, device));
      return true;
    },
    close() { wss.close(); },
  };
}
