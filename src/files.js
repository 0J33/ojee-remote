/**
 * Files on a device, over SFTP.
 *
 * Same dial, same credential and same code path as the Shell view: SFTP is a
 * subsystem of the SSH connection ssh2 already opens, so a machine that has a
 * terminal has files with no extra configuration, no second port, and nothing
 * new to install on the far end. Windows gets it too the moment OpenSSH is
 * enabled there.
 *
 * Connections are pooled per device rather than per request. Dialling costs a
 * second or two (measured: 3.5s to the server box over the tailnet) and a file
 * browser makes a request per click, so a connection per request would make
 * every directory listing feel broken. Idle pools are closed, because a held
 * SSH session on a laptop that goes to sleep is a socket that hangs.
 *
 * There is no path confinement, deliberately: the point is the whole machine,
 * and the console's auth gates are already the boundary for something strictly
 * more powerful — this module injects input into the desktop.
 */

import { Client as SSHClient } from 'ssh2';

import { connectOptions, hostVerifierFor } from './shell.js';

/** Close a pooled connection after this long with nothing using it. */
const IDLE_MS = 60_000;
/** A directory listing beyond this is a mistake or a trap; the UI says so. */
const MAX_ENTRIES = 5000;

/** ssh2 hands back OpenSSH's numeric status; these are the ones users hit. */
const SFTP_STATUS = {
  2: { http: 404, code: 'not_found' },
  3: { http: 403, code: 'permission_denied' },
  4: { http: 500, code: 'failure' },
  6: { http: 409, code: 'not_a_directory' },
  7: { http: 409, code: 'not_a_file' },
  10: { http: 409, code: 'not_empty' },
  11: { http: 409, code: 'exists' },
};

export function sftpError(err) {
  const mapped = SFTP_STATUS[err?.code] || null;
  return {
    http: mapped?.http || 500,
    code: mapped?.code || 'sftp_error',
    detail: err?.message || String(err),
  };
}

/** `/a/b/../c` → `/a/c`. Absolute, no NULs, no trailing slash except root. */
export function cleanPath(p, { base = '/' } = {}) {
  const raw = String(p ?? '').replace(/\0/g, '');
  if (!raw) return base;
  const abs = raw.startsWith('/') ? raw : `${base.replace(/\/+$/, '')}/${raw}`;
  const out = [];
  for (const part of abs.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

/** One POSIX-shell word: single-quoted, with embedded quotes spliced. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** What the browser is told about one directory entry. */
export function entryOf(name, attrs, longname = '') {
  const mode = attrs?.mode ?? 0;
  const type = (mode & 0o170000) === 0o040000 ? 'dir'
    : (mode & 0o170000) === 0o120000 ? 'link'
    : 'file';
  return {
    name,
    type,
    size: attrs?.size ?? 0,
    // Seconds on the wire, milliseconds in the browser. Doing it here keeps
    // one convention on the client side.
    mtime: (attrs?.mtime ?? 0) * 1000,
    mode: mode & 0o7777,
    // The ls-style line carries the symlink target and the owner, which the
    // attrs do not. Kept raw so the UI can show it on hover.
    longname: longname || '',
  };
}

export function createFileService({ devices, log = console } = {}) {
  /** deviceId → { conn, sftp, timer, users } */
  const pool = new Map();

  const release = (id) => {
    const held = pool.get(id);
    if (!held) return;
    held.users -= 1;
    if (held.users > 0) return;
    clearTimeout(held.timer);
    held.timer = setTimeout(() => {
      pool.delete(id);
      try { held.conn.end(); } catch { /* already gone */ }
    }, IDLE_MS);
    held.timer.unref?.();
  };

  const acquire = (device) => new Promise((resolve, reject) => {
    const held = pool.get(device.id);
    if (held) {
      clearTimeout(held.timer);
      held.users += 1;
      resolve(held);
      return;
    }

    let opts;
    try { opts = connectOptions(device); } catch (e) { reject(e); return; }

    const conn = new SSHClient();
    const fail = (e) => { pool.delete(device.id); try { conn.end(); } catch { /* already gone */ } reject(e); };

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return fail(err);
        const entry = { conn, sftp, timer: null, users: 1 };
        pool.set(device.id, entry);
        // A dropped connection must not leave a dead handle in the pool for
        // the next request to use.
        conn.on('close', () => { if (pool.get(device.id) === entry) pool.delete(device.id); });
        resolve(entry);
      });
    });
    conn.on('error', fail);
    conn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([opts.password || '']));
    conn.connect({ ...opts, hostVerifier: hostVerifierFor(device, log) });
  });

  /** Run `fn(sftp)` on a pooled connection for this device. */
  async function withSftp(device, fn) {
    if (!device?.ssh) {
      const e = new Error(`${device?.id || 'device'} has no ssh block — files need one`);
      e.http = 409;
      throw e;
    }
    const { sftp } = await acquire(device);
    try {
      return await fn(sftp);
    } finally {
      release(device.id);
    }
  }

  /**
   * Run one command on the device over the pooled connection and hand back
   * the exec channel. SFTP v3 has no copy and no archive, and both are one
   * coreutils call away on the far end — so they ride the same connection
   * rather than being rebuilt as a byte shuttle through the gateway.
   */
  async function execOn(device, cmd) {
    if (!device?.ssh) { const e = new Error('no ssh block'); e.http = 409; throw e; }
    const { conn } = await acquire(device);
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, channel) => {
        if (err) { release(device.id); reject(err); return; }
        let released = false;
        const done = () => { if (!released) { released = true; release(device.id); } };
        channel.once('close', done);
        channel.once('error', done);
        resolve(channel);
      });
    });
  }

  /** Run a command to completion: `{ code, stdout, stderr }`, output capped. */
  async function execAll(device, cmd) {
    const ch = await execOn(device, cmd);
    return new Promise((resolve) => {
      let stdout = ''; let stderr = ''; let code = null;
      ch.on('data', (b) => { if (stdout.length < 65536) stdout += b; });
      ch.stderr.on('data', (b) => { if (stderr.length < 65536) stderr += b; });
      ch.on('exit', (c) => { code = c; });
      ch.on('close', () => resolve({ code, stdout, stderr: stderr.trim() }));
    });
  }

  const promisify = (sftp, method, ...args) => new Promise((resolve, reject) => {
    sftp[method](...args, (err, out) => (err ? reject(err) : resolve(out)));
  });

  return {
    /** One directory, sorted directories-first then by name. */
    async list(device, path) {
      return withSftp(device, async (sftp) => {
        // No path means "where ssh drops you" — a file browser should open in
        // the home directory, not at `/`. realpath also resolves symlinks, so
        // the breadcrumb shows where you actually are.
        const real = await promisify(sftp, 'realpath', path ? cleanPath(path) : '.');
        const raw = await promisify(sftp, 'readdir', real);
        const entries = raw
          .slice(0, MAX_ENTRIES)
          .map((e) => entryOf(e.filename, e.attrs, e.longname))
          .sort((a, b) => (a.type === b.type
            ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            : a.type === 'dir' ? -1 : 1));
        return { path: real, entries, truncated: raw.length > MAX_ENTRIES };
      });
    },

    async stat(device, path) {
      return withSftp(device, async (sftp) => {
        const p = cleanPath(path);
        const attrs = await promisify(sftp, 'stat', p);
        return { path: p, ...entryOf(p.split('/').pop() || '/', attrs) };
      });
    },

    /** `parents` is mkdir -p: every missing level is made, and an existing
     *  directory is success — what a folder upload needs before its files. */
    async mkdir(device, path, { parents = false } = {}) {
      return withSftp(device, async (sftp) => {
        const p = cleanPath(path);
        if (!parents) {
          await promisify(sftp, 'mkdir', p);
          return { path: p };
        }
        let acc = '';
        for (const part of p.split('/').filter(Boolean)) {
          acc += `/${part}`;
          try {
            const st = await promisify(sftp, 'stat', acc);
            if ((st.mode & 0o170000) !== 0o040000) {
              const e = new Error(`${acc} exists and is not a folder`);
              e.http = 409; e.code = 6;
              throw e;
            }
          } catch (e) {
            if (e.code !== 2) throw e;          // anything but "no such file"
            await promisify(sftp, 'mkdir', acc);
          }
        }
        return { path: p };
      });
    },

    /**
     * Copy one entry, recursively for a folder. `cp -a` on the device: SFTP
     * has no copy, and shuttling every byte down to the gateway and back up
     * again would turn a local disk copy into two network transfers.
     */
    async copy(device, from, to) {
      const a = cleanPath(from); const b = cleanPath(to);
      if (b === a || b.startsWith(`${a}/`)) {
        const e = new Error('cannot copy a folder into itself');
        e.http = 409; throw e;
      }
      // Refuse rather than merge or overwrite: the UI picks a free name, and
      // cp's own no-clobber flag changed exit status between coreutils 9.x
      // releases, so it cannot be trusted to say whether it did anything.
      const taken = await withSftp(device, (sftp) => promisify(sftp, 'lstat', b).then(() => true, () => false));
      if (taken) { const e = new Error(`${b} already exists`); e.http = 409; e.code = 11; throw e; }
      const { code, stderr } = await execAll(device, `cp -a -- ${shq(a)} ${shq(b)}`);
      if (code !== 0) {
        const e = new Error(stderr || `cp exited ${code}`);
        e.http = 409; throw e;
      }
      return { from: a, to: b };
    },

    /**
     * Several entries of one folder as a tar stream, for downloading a folder
     * or a multi-selection in one go. Uncompressed on purpose: most of what
     * is worth pulling off a machine (video, photos, archives) is already
     * compressed, and gzip would only make the far end's CPU the bottleneck.
     */
    async archive(device, dir, names) {
      const d = cleanPath(dir);
      const list = (Array.isArray(names) ? names : [names]).map(String);
      if (!list.length) { const e = new Error('nothing to archive'); e.http = 400; throw e; }
      for (const n of list) {
        if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\0')) {
          const e = new Error(`not a name in that folder: ${n}`); e.http = 400; throw e;
        }
      }
      // Look before packing: tar that cannot find a name still writes an
      // end-of-archive block before it exits, so its failure would arrive as
      // a small, valid, empty .tar rather than as an error.
      await withSftp(device, async (sftp) => {
        for (const n of list) await promisify(sftp, 'lstat', `${d.replace(/\/+$/, '')}/${n}`);
      });
      return execOn(device, `tar -cf - -C ${shq(d)} -- ${list.map(shq).join(' ')}`);
    },

    async move(device, from, to) {
      return withSftp(device, async (sftp) => {
        const a = cleanPath(from); const b = cleanPath(to);
        await promisify(sftp, 'rename', a, b);
        return { from: a, to: b };
      });
    },

    /** Delete one entry. A directory needs `recursive` — an accident here is
     *  expensive, so it is never implied. */
    async remove(device, path, { recursive = false } = {}) {
      return withSftp(device, async (sftp) => {
        const p = cleanPath(path);
        const attrs = await promisify(sftp, 'lstat', p);
        const isDir = (attrs.mode & 0o170000) === 0o040000;
        if (!isDir) { await promisify(sftp, 'unlink', p); return { path: p }; }
        if (!recursive) {
          // SFTP v3 collapses ENOTEMPTY into a bare "Failure", which tells a
          // user nothing. Look first, so the refusal names the reason.
          const kids = await promisify(sftp, 'readdir', p);
          if (kids.length) {
            const e = new Error(`${p} is not empty (${kids.length} item${kids.length === 1 ? '' : 's'})`);
            e.http = 409;
            e.code = 10;
            throw e;
          }
          await promisify(sftp, 'rmdir', p);
          return { path: p };
        }
        const walk = async (dir) => {
          const kids = await promisify(sftp, 'readdir', dir);
          for (const k of kids) {
            const kid = `${dir.replace(/\/+$/, '')}/${k.filename}`;
            if ((k.attrs.mode & 0o170000) === 0o040000) await walk(kid);
            else await promisify(sftp, 'unlink', kid);
          }
          await promisify(sftp, 'rmdir', dir);
        };
        await walk(p);
        return { path: p, recursive: true };
      });
    },

    /**
     * A readable stream of one file, plus its size so the response can carry
     * Content-Length and support Range. The connection is held until the
     * stream ends — releasing it mid-transfer would close the socket under it.
     */
    async read(device, path, { start, end } = {}) {
      if (!device?.ssh) { const e = new Error('no ssh block'); e.http = 409; throw e; }
      const { sftp } = await acquire(device);
      try {
        const p = cleanPath(path);
        const attrs = await promisify(sftp, 'stat', p);
        const stream = sftp.createReadStream(p, start != null ? { start, end } : undefined);
        const done = () => release(device.id);
        stream.once('close', done);
        stream.once('error', done);
        return { stream, size: attrs.size ?? 0, name: p.split('/').pop() || 'file', path: p };
      } catch (e) {
        release(device.id);
        throw e;
      }
    },

    /**
     * A writable stream for one file. `offset` resumes an interrupted upload:
     * the browser asks how much arrived (stat), then sends the rest.
     */
    async write(device, path, { offset = 0 } = {}) {
      if (!device?.ssh) { const e = new Error('no ssh block'); e.http = 409; throw e; }
      const { sftp } = await acquire(device);
      try {
        const p = cleanPath(path);
        const stream = sftp.createWriteStream(p, offset > 0 ? { flags: 'r+', start: offset } : { flags: 'w' });
        const done = () => release(device.id);
        stream.once('close', done);
        stream.once('error', done);
        return { stream, path: p };
      } catch (e) {
        release(device.id);
        throw e;
      }
    },

    /** Close every pooled connection (shutdown). */
    close() {
      for (const [id, held] of pool) {
        clearTimeout(held.timer);
        try { held.conn.end(); } catch { /* already gone */ }
        pool.delete(id);
      }
    },

    /** Exposed for the health endpoint: which devices hold a live connection. */
    open() { return [...pool.keys()]; },

    log,
  };
}
