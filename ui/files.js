/* ============================================================
   The Files view: one device's filesystem, over SFTP.

   Deliberately not a second storage.ojee.net. That one manages a
   NAS — owners, shares, quotas, secure folders. This is a machine
   you already control: the whole disk, no ownership model, and
   the jobs are "get that file off it", "put this on it", and
   tidy up while you are there.

   One interaction model on every screen, because the old one was
   two: single-click selected and double-click opened, which a
   phone cannot do — a tap on a folder only ever selected it, so
   on a phone you could not go into a folder at all.

     folder row      a click or tap opens it
     file row        a tap toggles it; a mouse click selects it
                     (ctrl/cmd adds, shift extends); double-click
                     opens it in a tab
     checkbox        always toggles, whatever else is held
     ⋮ on the row    every action for that one entry

   A selection raises an action bar at the bottom, where a thumb
   already is. Move and Copy are cut-and-paste: pick, walk to the
   destination with the same navigation you already know, Paste.

   Transfers are a queue with per-file progress and a cancel, not
   a browser download that vanishes if you navigate. Uploads
   stream through the gateway, so a 4 GB video never sits in
   memory anywhere; folders upload with their structure.
   ============================================================ */

const MAX_PARALLEL = 2;
const PHONE = '(max-width: 720px)';

const fmtSize = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / (1024 ** i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

const fmtWhen = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
};

const parentOf = (p) => {
  const parts = String(p || '/').split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
};

const joinPath = (dir, name) => `${String(dir).replace(/\/+$/, '')}/${name}`;
const baseName = (p) => String(p).split('/').filter(Boolean).pop() || '/';

/** Types a browser tab can show. Anything else, Open means download. */
const PREVIEW = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico',
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav', 'pdf',
  'txt', 'md', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'js', 'mjs', 'ts', 'py', 'sh', 'c', 'h', 'cpp', 'rs', 'go', 'java', 'rb', 'php', 'css', 'html',
  'svg', 'xml', 'sql', 'service']);
const previewable = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && PREVIEW.has(name.slice(dot + 1).toLowerCase());
};

/** A name that is not in `taken`: "a.txt" → "a (copy).txt" → "a (copy 2).txt". */
function freeName(name, taken, word = 'copy') {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const n = `${stem} (${word}${i > 1 ? ` ${i}` : ''})${ext}`;
    if (!taken.has(n)) return n;
  }
}

/**
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {object} o.ctx            module context (base, api, esc, icon, toast, modal)
 * @param {string} o.deviceId
 * @param {string} o.deviceName
 * @param {Function} o.onExit
 * @returns {Function} teardown
 */
export function startFiles({ host, ctx, deviceId, deviceName, onExit }) {
  const dev = encodeURIComponent(deviceId);
  const api = `${ctx.base}/api/devices/${dev}/fs`;
  const esc = ctx.esc;
  const ic = (name, cls = 'ic') => ctx.icon(name, cls);
  const phone = window.matchMedia(PHONE);

  let cwd = null;
  let entries = [];
  let selected = new Set();
  let anchor = null;             // last clicked name, for shift-range
  let busy = false;
  let loadSeq = 0;
  let failed = null;             // why the first listing could not load
  let disposed = false;
  // Sorting and filtering are the browser's, not the server's: the listing is
  // already in hand and a round trip to re-order it would be slower than the
  // scroll it interrupts.
  let sortKey = 'name';
  let sortDir = 1;
  let filter = '';
  let clip = null;               // { mode: 'move'|'copy', dir, names }
  let lastPointer = 'mouse';
  const transfers = [];          // see queueUploads
  const madeDirs = new Set();
  let running = 0;
  let trOpen = true;

  host.innerHTML = `
    <section class="fs">
      <header class="fs-top">
        <button class="rs-icon" data-act="exit" title="Back to devices" aria-label="Back to devices">${ic('i-back')}</button>
        <div class="fs-where">
          <span class="fs-dev">${esc(deviceName || deviceId)} · files</span>
          <nav class="fs-crumbs" aria-label="Path"></nav>
        </div>
      </header>
      <div class="fs-tools">
        <span class="fs-nav">
          <button class="rs-icon" data-act="up" title="Up one folder (Backspace)" aria-label="Up one folder">${ic('i-up')}</button>
          <button class="rs-icon" data-act="home" title="Home folder" aria-label="Home folder">${ic('i-house')}</button>
          <button class="rs-icon" data-act="refresh" title="Refresh" aria-label="Refresh">${ic('i-refresh')}</button>
        </span>
        <label class="fs-search">
          ${ic('i-search')}
          <input class="input fs-search-input" type="search" placeholder="Filter" aria-label="Filter this folder" />
        </label>
        <span class="fs-make">
          <button class="rs-chip fs-chip fs-sortbtn" data-act="sortmenu" aria-label="Sort">${ic('i-sort')}<span>Sort</span></button>
          <button class="rs-chip fs-chip" data-act="mkdir" title="New folder" aria-label="New folder">${ic('i-folderAdd')}<span>New folder</span></button>
          <button class="rs-chip fs-chip" data-act="upload-dir" title="Upload a folder" aria-label="Upload a folder">${ic('i-folderUp')}<span>Folder</span></button>
          <button class="rs-chip fs-chip on" data-act="upload" title="Upload files" aria-label="Upload files">${ic('i-upload')}<span>Upload</span></button>
        </span>
      </div>
      <div class="fs-clipbar" hidden>
        <span class="fs-clip-txt"></span>
        <button class="rs-chip fs-chip on" data-act="paste">${ic('i-paste')}<span>Paste here</span></button>
        <button class="rs-icon" data-act="clip-cancel" title="Cancel" aria-label="Cancel move or copy">${ic('i-close')}</button>
      </div>
      <div class="fs-listwrap">
        <div class="fs-row fs-listhead" role="row">
          <span class="fs-check"><input type="checkbox" data-act="all" aria-label="Select everything in this folder" /></span>
          <button class="fs-sort" data-sort="name">Name</button>
          <button class="fs-sort" data-sort="mtime">Modified</button>
          <button class="fs-sort fs-sort--r" data-sort="size">Size</button>
          <span class="fs-count"></span>
        </div>
        <div class="fs-list" tabindex="0" role="grid" aria-label="Folder contents"></div>
        <div class="fs-drop" hidden><span>${ic('i-upload', 'ic ic--xl')}Drop to upload into this folder</span></div>
      </div>
      <div class="fs-selbar" hidden>
        <button class="rs-icon" data-act="clear" title="Clear selection (Esc)" aria-label="Clear selection">${ic('i-close')}</button>
        <span class="fs-selcount"></span>
        <span class="fs-selacts">
          <button class="fs-sa" data-act="download" title="Download">${ic('i-download')}<span>Download</span></button>
          <button class="fs-sa" data-act="cut" title="Move to another folder">${ic('i-move')}<span>Move</span></button>
          <button class="fs-sa" data-act="copy" title="Copy to another folder">${ic('i-copy')}<span>Copy</span></button>
          <button class="fs-sa" data-act="rename" title="Rename (F2)">${ic('i-edit')}<span>Rename</span></button>
          <button class="fs-sa fs-sa--warn" data-act="delete" title="Delete (Del)">${ic('i-trash')}<span>Delete</span></button>
        </span>
      </div>
      <div class="fs-transfers" hidden>
        <div class="fs-tr-head">
          <button class="fs-tr-toggle" data-act="tr-toggle" aria-expanded="true">
            ${ic('i-show')}<span class="fs-tr-title">Transfers</span><span class="fs-tr-sum"></span>
          </button>
          <span class="fs-bar fs-tr-total"><span class="fs-fill"></span></span>
          <button class="rs-chip" data-act="tr-clear">Clear done</button>
        </div>
        <div class="fs-tr-list"></div>
      </div>
      <div class="fs-scrim" hidden></div>
      <div class="fs-menu" role="menu" hidden></div>
      <input type="file" class="fs-file" multiple hidden />
      <input type="file" class="fs-dir" webkitdirectory multiple hidden />
    </section>`;

  const $ = (s) => host.querySelector(s);
  // Listeners go on the view's own element, not on `host`: host is the
  // module's root and outlives this view, so a click handler left on it kept
  // answering clicks on the device list after you had left.
  const view = $('.fs');
  const listEl = $('.fs-list');
  const crumbEl = $('.fs-crumbs');
  const countEl = $('.fs-count');
  const selBar = $('.fs-selbar');
  const clipBar = $('.fs-clipbar');
  const dropEl = $('.fs-drop');
  const trWrap = $('.fs-transfers');
  const trList = $('.fs-tr-list');
  const trSum = $('.fs-tr-sum');
  const trTotal = $('.fs-tr-total .fs-fill');
  const menuEl = $('.fs-menu');
  const scrim = $('.fs-scrim');
  const fileInput = $('.fs-file');
  const dirInput = $('.fs-dir');
  const searchEl = $('.fs-search-input');

  /* ── data ─────────────────────────────────────────────────────────── */

  async function load(path, { keepSelection = false } = {}) {
    if (disposed) return;
    const seq = ++loadSeq;
    busy = true;
    paint();
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : '';
      const r = await ctx.api(`/devices/${dev}/fs${q}`);
      if (seq !== loadSeq || disposed) return;
      const moved = r.path !== cwd;
      cwd = r.path;
      entries = r.entries || [];
      failed = null;
      if (moved || !keepSelection) { selected = new Set(); anchor = null; }
      else for (const n of [...selected]) if (!entries.some((x) => x.name === n)) selected.delete(n);
      if (moved) {
        filter = '';
        searchEl.value = '';
        listEl.scrollTop = 0;
      }
      if (r.truncated) ctx.toast('warn', 'Long folder', 'Only the first 5000 entries are shown.');
    } catch (e) {
      if (seq !== loadSeq || disposed) return;
      // A folder you cannot read is a normal thing to click on; say which one
      // and stay where you were rather than emptying the view.
      if (cwd == null) failed = e.message || String(e);
      else ctx.toast('err', 'Cannot open folder', e.message || String(e));
    } finally {
      if (seq === loadSeq) {
        busy = false;
        paint();
      }
    }
  }

  const reload = () => load(cwd, { keepSelection: true });

  async function call(path, body) {
    return ctx.api(`/devices/${dev}/fs${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /* ── dialogs ──────────────────────────────────────────────────────── */

  /** A one-field prompt on the console's modal. Resolves the text or null. */
  async function ask({ title, label, value = '', ok = 'Save', select = null }) {
    const body = document.createElement('div');
    body.className = 'fs-ask';
    body.innerHTML = `<label class="fs-ask-label" for="fs-ask-in">${esc(label)}</label>
      <input id="fs-ask-in" class="input fs-ask-input" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <span class="fs-ask-err" role="alert"></span>`;
    const input = body.querySelector('input');
    input.value = value;
    const p = ctx.modal({
      title, body,
      actions: [{ label: 'Cancel', value: null, variant: 'ghost' }, { label: ok, value: 'ok' }],
    });
    // Enter submits: the modal's own buttons live in its footer.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      [...(body.closest('.modal')?.querySelectorAll('.modal-foot button') || [])].pop()?.click();
    });
    requestAnimationFrame(() => {
      input.focus();
      if (select) input.setSelectionRange(select[0], select[1]); else input.select();
    });
    const r = await p;
    return r === 'ok' ? input.value.trim() : null;
  }

  const badName = (n) => (!n ? 'A name is needed.'
    : n.includes('/') ? 'A name cannot contain “/”.'
      : n === '.' || n === '..' ? 'That name is reserved.' : null);

  /* ── transfers ────────────────────────────────────────────────────── */

  const active = () => transfers.filter((t) => t.state === 'queued' || t.state === 'running');

  function pump() {
    while (running < MAX_PARALLEL) {
      const next = transfers.find((t) => t.state === 'queued');
      if (!next) break;
      running += 1;
      runUpload(next).finally(() => {
        running -= 1;
        // A finished, clean batch folds down to its one-line summary and
        // hands the room back to the list.
        if (!active().length && !transfers.some((t) => t.state === 'error')) trOpen = false;
        paintTransfers();
        // One reload when a batch landing here finishes, not one per file.
        if (!active().some((t) => t.base === cwd)
            && transfers.some((t) => t.state === 'done' && !t.seen && t.base === cwd)) {
          for (const t of transfers) if (t.base === cwd) t.seen = true;
          reload();
        }
        pump();
      });
    }
    paintTransfers();
  }

  async function ensureDir(dir) {
    if (madeDirs.has(dir)) return;
    await call('/mkdir', { path: dir, parents: true });
    madeDirs.add(dir);
  }

  async function runUpload(t) {
    t.state = 'running';
    t.started = performance.now();
    paintTransfers();
    if (t.mkdir) {
      try { await ensureDir(t.mkdir); } catch (e) {
        t.state = 'error'; t.error = e.message; return;
      }
      if (t.state !== 'running') return;       // cancelled while the folder was made
    }
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      t.xhr = xhr;
      xhr.open('PUT', `${api}/upload?path=${encodeURIComponent(t.dest)}`);
      xhr.upload.onprogress = (e) => {
        const now = performance.now();
        if (t.lastAt) {
          const inst = ((e.loaded - t.done) / Math.max(1, now - t.lastAt)) * 1000;
          t.rate = t.rate ? t.rate * 0.8 + inst * 0.2 : inst;
        }
        t.lastAt = now;
        t.done = e.loaded;
        paintTransfers();
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { t.state = 'done'; t.done = t.size; }
        else { t.state = 'error'; t.error = errorText(xhr); }
        resolve();
      };
      xhr.onerror = () => { t.state = 'error'; t.error = 'network error'; resolve(); };
      xhr.onabort = () => {
        t.state = 'cancelled';
        // A cancelled upload leaves a partial file on the device that looks
        // exactly like the real one. Remove it rather than let it pass.
        call('/delete', { path: t.dest }).catch(() => {});
        resolve();
      };
      xhr.send(t.file);
    });
  }

  function errorText(xhr) {
    try { return JSON.parse(xhr.responseText).detail || xhr.statusText; }
    catch { return xhr.statusText || `HTTP ${xhr.status}`; }
  }

  /**
   * @param {{file: File, rel: string}[]} items  rel is "a.txt" or "Folder/sub/a.txt"
   */
  async function queueUploads(items) {
    if (!items.length || cwd == null) return;
    const here = cwd;
    const tops = [...new Set(items.map((x) => x.rel.split('/')[0]))];
    const taken = new Set(entries.map((e) => e.name));
    const clash = tops.filter((n) => taken.has(n));
    let skip = new Set();
    if (clash.length) {
      const list = clash.slice(0, 6).map((n) => `<li>${esc(n)}</li>`).join('');
      const more = clash.length > 6 ? `<li>…and ${clash.length - 6} more</li>` : '';
      const choice = await ctx.modal({
        title: clash.length === 1 ? 'Already here' : `${clash.length} already here`,
        body: `<p class="fs-ask-p">${clash.length === 1 ? 'This name exists' : 'These names exist'} in <b>${esc(here)}</b>.
          Replace overwrites; a folder is merged into, file by file.</p><ul class="fs-ask-list">${list}${more}</ul>`,
        actions: [
          { label: 'Cancel', value: null, variant: 'ghost' },
          { label: 'Skip those', value: 'skip', variant: 'ghost' },
          { label: 'Replace', value: 'replace', variant: 'danger' },
        ],
      });
      if (!choice) return;
      if (choice === 'skip') skip = new Set(clash);
    }
    let n = 0;
    for (const { file, rel } of items) {
      if (skip.has(rel.split('/')[0])) continue;
      const dest = joinPath(here, rel);
      const parent = parentOf(dest);
      transfers.push({
        id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        name: baseName(rel), dest, base: here, file, size: file.size, done: 0,
        mkdir: parent !== here ? parent : null,
        state: 'queued', error: null, xhr: null, rate: 0,
      });
      n += 1;
    }
    if (!n) return;
    trOpen = true;
    pump();
  }

  function cancel(t) {
    if (t.state === 'queued') { t.state = 'cancelled'; paintTransfers(); return; }
    if (t.state === 'running') {
      if (t.xhr) { try { t.xhr.abort(); } catch { /* finished */ } }
      else { t.state = 'cancelled'; paintTransfers(); }
    }
  }

  function retry(t) {
    t.state = 'queued'; t.done = 0; t.error = null; t.xhr = null; t.rate = 0; t.lastAt = 0;
    pump();
  }

  /* ── downloads & opening ──────────────────────────────────────────── */

  // Downloads go straight to the browser's own download manager — it
  // resumes, survives the tab closing, and writes to disk without the file
  // passing through JS memory. So they are not in the transfer queue: the
  // browser already shows them, and a second, lying progress bar would not.
  function fetchUrl(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function download(names) {
    const list = names.map((n) => entries.find((x) => x.name === n)).filter(Boolean);
    if (!list.length) return;
    if (list.length === 1 && list[0].type === 'file') {
      fetchUrl(`${api}/download?path=${encodeURIComponent(joinPath(cwd, list[0].name))}`);
      ctx.toast('ok', 'Download started', list[0].name);
      return;
    }
    // A folder, or several things: one .tar, streamed as the far end packs it.
    const q = list.map((e) => `&name=${encodeURIComponent(e.name)}`).join('');
    fetchUrl(`${api}/archive?dir=${encodeURIComponent(cwd)}${q}`);
    ctx.toast('ok', 'Packing a .tar', list.length === 1 ? `${list[0].name}.tar` : `${list.length} items from ${baseName(cwd)}`);
  }

  function openFile(name) {
    const url = `${api}/download?path=${encodeURIComponent(joinPath(cwd, name))}`;
    if (previewable(name)) window.open(`${url}&inline=1`, '_blank', 'noopener');
    else { fetchUrl(url); ctx.toast('ok', 'Download started', name); }
  }

  /** Open a row: a folder is entered, a link is asked about, a file opened. */
  async function openEntry(name) {
    const e = entries.find((x) => x.name === name);
    if (!e) return;
    if (e.type === 'dir') return load(joinPath(cwd, name));
    if (e.type === 'link') {
      // readdir reports the link, not what it points at. stat follows it.
      try {
        const st = await ctx.api(`/devices/${dev}/fs/stat?path=${encodeURIComponent(joinPath(cwd, name))}`);
        if (st.type === 'dir') return load(joinPath(cwd, name));
      } catch (err) {
        return ctx.toast('err', 'Broken link', err.message);
      }
    }
    return openFile(name);
  }

  /* ── management ───────────────────────────────────────────────────── */

  async function mkdir() {
    const name = await ask({ title: 'New folder', label: `In ${cwd}`, value: '', ok: 'Create' });
    if (name == null) return;
    const bad = badName(name);
    if (bad) return ctx.toast('warn', 'Not created', bad);
    try {
      await call('/mkdir', { path: joinPath(cwd, name) });
      await reload();
      selected = new Set([name]);
      paintSelection();
      listEl.querySelector(`.fs-row[data-name="${CSS.escape(name)}"]`)?.scrollIntoView({ block: 'nearest' });
    } catch (err) { ctx.toast('err', 'Could not create folder', err.message); }
  }

  async function rename(only) {
    if (!only) return;
    const dot = only.lastIndexOf('.');
    const e = entries.find((x) => x.name === only);
    const name = await ask({
      title: 'Rename', label: only, value: only, ok: 'Rename',
      // The stem is selected, not the extension — renaming a photo should not
      // start by deleting ".jpg".
      select: [0, dot > 0 && e?.type === 'file' ? dot : only.length],
    });
    if (name == null || name === only) return;
    const bad = badName(name);
    if (bad) return ctx.toast('warn', 'Not renamed', bad);
    if (entries.some((x) => x.name === name)) return ctx.toast('warn', 'Not renamed', `${name} already exists here.`);
    try {
      await call('/move', { from: joinPath(cwd, only), to: joinPath(cwd, name) });
      selected = new Set([name]);
      await reload();
    } catch (err) { ctx.toast('err', 'Could not rename', err.message); }
  }

  async function remove(names) {
    if (!names.length) return;
    const dirs = names.filter((n) => entries.find((x) => x.name === n)?.type === 'dir');
    const what = names.length === 1 ? `<b>${esc(names[0])}</b>` : `<b>${names.length} items</b>`;
    const warn = dirs.length
      ? `<p class="fs-ask-p fs-ask-warn">${dirs.length === 1 && names.length === 1 ? 'It is a folder' : `${dirs.length} of them ${dirs.length === 1 ? 'is a folder' : 'are folders'}`} — everything inside goes too.</p>`
      : '';
    const ok = await ctx.modal({
      title: 'Delete',
      body: `<p class="fs-ask-p">Delete ${what} from ${esc(cwd)} on ${esc(deviceName || deviceId)}?</p>${warn}
        <p class="fs-ask-p">There is no bin — this cannot be undone.</p>`,
      actions: [{ label: 'Cancel', value: null, variant: 'ghost' }, { label: 'Delete', value: 'ok', variant: 'danger' }],
    });
    if (ok !== 'ok') return;
    let bad = 0;
    for (const n of names) {
      try {
        await call('/delete', { path: joinPath(cwd, n), recursive: dirs.includes(n) });
        selected.delete(n);
      } catch (err) {
        bad += 1;
        ctx.toast('err', `Could not delete ${n}`, err.message);
      }
    }
    if (!bad) ctx.toast('ok', 'Deleted', names.length === 1 ? names[0] : `${names.length} items`);
    await reload();
  }

  function setClip(mode, names) {
    if (!names.length) return;
    clip = { mode, dir: cwd, names: [...names] };
    selected = new Set();
    paintSelection();
    paintClip();
  }

  async function paste() {
    if (!clip) return;
    const { mode, dir, names } = clip;
    if (mode === 'move' && dir === cwd) {
      ctx.toast('warn', 'Already here', 'Open the folder to move them into, then Paste.');
      return;
    }
    const taken = new Set(entries.map((e) => e.name));
    let ok = 0;
    for (const n of names) {
      const from = joinPath(dir, n);
      if (cwd === from || cwd.startsWith(`${from}/`)) {
        ctx.toast('warn', `Skipped ${n}`, 'A folder cannot go inside itself.');
        continue;
      }
      if (mode === 'move' && taken.has(n)) {
        ctx.toast('warn', `Skipped ${n}`, 'Something with that name is already here.');
        continue;
      }
      const to = joinPath(cwd, mode === 'copy' ? freeName(n, taken) : n);
      taken.add(baseName(to));
      try {
        await call(mode === 'move' ? '/move' : '/copy', { from, to });
        ok += 1;
      } catch (err) {
        ctx.toast('err', `Could not ${mode} ${n}`, err.message);
      }
    }
    if (ok) ctx.toast('ok', mode === 'move' ? 'Moved' : 'Copied', `${ok} item${ok === 1 ? '' : 's'} into ${baseName(cwd)}`);
    clip = null;
    paintClip();
    await reload();
  }

  /* ── row menu ─────────────────────────────────────────────────────── */

  let menuFor = null;

  function openMenu(btn, items) {
    menuEl.innerHTML = items.map((it) => (it === '-' ? '<span class="fs-menu-sep" role="separator"></span>' : `
      <button class="fs-menu-item${it.warn ? ' fs-menu-item--warn' : ''}${it.on ? ' is-on' : ''}" role="menuitem" data-menu="${it.id}">
        ${ic(it.icon)}<span>${esc(it.label)}</span>${it.hint ? `<span class="fs-menu-hint">${esc(it.hint)}</span>` : ''}
      </button>`)).join('');
    menuEl.hidden = false;
    const sheet = phone.matches;
    menuEl.classList.toggle('fs-menu--sheet', sheet);
    scrim.hidden = !sheet;
    if (sheet) {
      menuEl.style.left = ''; menuEl.style.top = '';
    } else {
      const r = btn.getBoundingClientRect();
      const m = menuEl.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
      const below = r.bottom + 4 + m.height < window.innerHeight - 8;
      menuEl.style.left = `${left}px`;
      menuEl.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - m.height - 4)}px`;
    }
    menuEl.querySelector('button')?.focus({ preventScroll: true });
  }

  function closeMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    scrim.hidden = true;
    menuFor = null;
  }

  function rowMenu(btn, name) {
    const e = entries.find((x) => x.name === name);
    if (!e) return;
    const isDir = e.type === 'dir';
    menuFor = { kind: 'row', name };
    openMenu(btn, [
      isDir || e.type === 'link'
        ? { id: 'open', icon: 'i-folder', label: isDir ? 'Open' : 'Open link' }
        : { id: 'open', icon: 'i-external', label: previewable(name) ? 'Open in a tab' : 'Open (download)' },
      { id: 'download', icon: 'i-download', label: isDir ? 'Download as .tar' : 'Download', hint: isDir ? '' : fmtSize(e.size) },
      '-',
      { id: 'rename', icon: 'i-edit', label: 'Rename' },
      { id: 'cut', icon: 'i-move', label: 'Move to…' },
      { id: 'copy', icon: 'i-copy', label: 'Copy to…' },
      { id: 'select', icon: 'i-check', label: selected.has(name) ? 'Deselect' : 'Select' },
      '-',
      { id: 'delete', icon: 'i-trash', label: 'Delete', warn: true },
    ]);
  }

  function sortMenu(btn) {
    menuFor = { kind: 'sort' };
    const arrow = (k) => (sortKey === k ? (sortDir > 0 ? '↑' : '↓') : '');
    openMenu(btn, [
      { id: 'sort:name', icon: 'i-sort', label: 'Name', hint: arrow('name'), on: sortKey === 'name' },
      { id: 'sort:mtime', icon: 'i-sort', label: 'Modified', hint: arrow('mtime'), on: sortKey === 'mtime' },
      { id: 'sort:size', icon: 'i-sort', label: 'Size', hint: arrow('size'), on: sortKey === 'size' },
    ]);
  }

  function menuPick(id) {
    const m = menuFor;
    closeMenu();
    if (!m) return;
    if (m.kind === 'sort') return setSort(id.split(':')[1]);
    const n = m.name;
    if (id === 'open') return openEntry(n);
    if (id === 'download') return download([n]);
    if (id === 'rename') return rename(n);
    if (id === 'cut') return setClip('move', [n]);
    if (id === 'copy') return setClip('copy', [n]);
    if (id === 'delete') return remove([n]);
    if (id === 'select') {
      if (selected.has(n)) selected.delete(n); else selected.add(n);
      return paintSelection();
    }
  }

  function setSort(key) {
    // Same column again reverses it; a new column starts ascending, except
    // size and date, where "biggest" and "newest" are what you came for.
    if (key === sortKey) sortDir = -sortDir;
    else { sortKey = key; sortDir = key === 'size' || key === 'mtime' ? -1 : 1; }
    paint();
  }

  /* ── paint ────────────────────────────────────────────────────────── */

  function paintCrumbs() {
    const parts = String(cwd || '').split('/').filter(Boolean);
    let html = `<button class="fs-crumb" data-cd="/" title="/">/</button>`;
    let acc = '';
    parts.forEach((part, i) => {
      acc += `/${part}`;
      html += `${i ? '<span class="fs-crumb-sep" aria-hidden="true">/</span>' : ''}<button class="fs-crumb${i === parts.length - 1 ? ' is-here' : ''}" data-cd="${esc(acc)}"${i === parts.length - 1 ? ' aria-current="location"' : ''}>${esc(part)}</button>`;
    });
    if (!parts.length) html = '<button class="fs-crumb is-here" data-cd="/" aria-current="location">/</button>';
    crumbEl.innerHTML = html;
    // On a phone the path is one scrolling line; where you are is its end.
    crumbEl.scrollLeft = crumbEl.scrollWidth;
  }

  /** What the list is showing: the filter applied, then the chosen order. */
  function visible() {
    const q = filter.trim().toLowerCase();
    const rows = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice();
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => (a.size || 0) - (b.size || 0),
      mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0),
    }[sortKey];
    // Directories stay above files whatever the column: a folder is not a big
    // or a small file, and mixing them makes a listing unreadable.
    const rank = (e) => (e.type === 'dir' ? 0 : 1);
    return rows.sort((a, b) => (rank(a) === rank(b) ? cmp(a, b) * sortDir : rank(a) - rank(b)));
  }

  function rowHtml(e) {
    const on = selected.has(e.name);
    const isDir = e.type === 'dir';
    const sub = [isDir ? 'folder' : e.type === 'link' ? 'link' : fmtSize(e.size), fmtWhen(e.mtime)].filter(Boolean).join(' · ');
    return `
      <div class="fs-row fs-item${on ? ' is-sel' : ''}${clip && clip.dir === cwd && clip.mode === 'move' && clip.names.includes(e.name) ? ' is-cut' : ''}"
           data-name="${esc(e.name)}" data-type="${e.type}" role="row" aria-selected="${on}" title="${esc(e.longname || e.name)}">
        <span class="fs-check"><input type="checkbox" tabindex="-1" aria-label="Select ${esc(e.name)}"${on ? ' checked' : ''} /></span>
        <span class="fs-name">
          <span class="fs-ic" aria-hidden="true">${ic(isDir ? 'i-folder' : 'i-file')}</span>
          <span class="fs-name-col">
            <span class="fs-name-text">${esc(e.name)}${e.type === 'link' ? ' <span class="fs-link">↪</span>' : ''}</span>
            <span class="fs-sub">${esc(sub)}</span>
          </span>
        </span>
        <span class="fs-when">${fmtWhen(e.mtime)}</span>
        <span class="fs-size">${e.type === 'file' ? fmtSize(e.size) : ''}</span>
        <span class="fs-racts">
          <button class="fs-ra fs-ra--dl" data-row="download" title="${isDir ? 'Download as .tar' : 'Download'}" aria-label="Download ${esc(e.name)}">${ic('i-download')}</button>
          <button class="fs-ra" data-row="menu" title="More" aria-label="More actions for ${esc(e.name)}" aria-haspopup="menu">${ic('i-more')}</button>
        </span>
      </div>`;
  }

  function paint() {
    if (disposed) return;
    paintCrumbs();
    for (const b of host.querySelectorAll('.fs-sort')) {
      const on = b.dataset.sort === sortKey;
      b.classList.toggle('is-on', on);
      b.dataset.dir = on ? (sortDir > 0 ? 'asc' : 'desc') : '';
    }
    host.querySelector('[data-act="up"]').disabled = !cwd || cwd === '/';
    listEl.classList.toggle('is-busy', busy);

    if (failed && cwd == null) {
      listEl.innerHTML = `<div class="empty fs-empty">${ic('i-warn', 'ic ic--xl')}
        <b>Cannot list files</b><span>${esc(failed)}</span>
        <button class="rs-chip" data-act="refresh">Try again</button></div>`;
      countEl.textContent = '';
      paintSelection();
      return;
    }
    if (cwd == null) {
      listEl.innerHTML = `<div class="empty fs-empty"><b>Loading</b><span>Opening ${esc(deviceName || deviceId)} over SFTP…</span></div>`;
      return;
    }
    const rows = visible();
    const n = rows.length;
    countEl.textContent = `${n} item${n === 1 ? '' : 's'}${filter ? ` of ${entries.length}` : ''}`;
    if (!rows.length) {
      listEl.innerHTML = `<div class="empty fs-empty">${ic('i-folder', 'ic ic--xl')}
        <b>${filter ? 'Nothing matches' : 'Empty folder'}</b>
        <span>${filter ? 'No name in this folder contains what you typed.' : phone.matches ? 'Tap Upload to put files here.' : 'Drop files or folders here, or use Upload.'}</span></div>`;
    } else {
      listEl.innerHTML = rows.map(rowHtml).join('');
    }
    paintSelection();
    paintClip();
  }

  /**
   * Selection is painted in place. Re-rendering the list for a click would
   * throw away the scroll position and rebuild thousands of nodes for a
   * class change.
   */
  function paintSelection() {
    for (const row of listEl.querySelectorAll('.fs-item')) {
      const on = selected.has(row.dataset.name);
      row.classList.toggle('is-sel', on);
      row.setAttribute('aria-selected', String(on));
      const box = row.querySelector('input[type="checkbox"]');
      if (box) box.checked = on;
    }
    const n = selected.size;
    const total = visible().length;
    const all = $('[data-act="all"]');
    all.checked = n > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
    selBar.hidden = n === 0;
    host.classList.toggle('fs-has-sel', n > 0);
    if (!n) return;
    const names = [...selected];
    const dirs = names.filter((x) => entries.find((e) => e.name === x)?.type === 'dir').length;
    $('.fs-selcount').innerHTML = `${n}<span class="fs-selword"> selected</span>`;
    $('[data-act="rename"]').disabled = n !== 1;
    const dl = $('[data-act="download"]');
    const asTar = n > 1 || dirs > 0;
    dl.title = asTar ? 'Download as one .tar' : 'Download';
    dl.querySelector('span').innerHTML = `Download${asTar ? '<span class="fs-tarword"> .tar</span>' : ''}`;
  }

  function paintClip() {
    clipBar.hidden = !clip;
    if (!clip) return;
    const what = clip.names.length === 1 ? clip.names[0] : `${clip.names.length} items`;
    const verb = clip.mode === 'move' ? 'Moving' : 'Copying';
    $('.fs-clip-txt').innerHTML = `<b>${verb} ${esc(what)}</b> <span class="fs-clip-from">from ${esc(clip.dir)} — open the destination, then paste</span>`;
    $('[data-act="paste"] span').textContent = clip.mode === 'move' ? 'Move here' : 'Paste here';
    for (const row of listEl.querySelectorAll('.fs-item')) {
      row.classList.toggle('is-cut', clip.mode === 'move' && clip.dir === cwd && clip.names.includes(row.dataset.name));
    }
  }

  /* Transfer rows are keyed and updated in place. Rebuilding the list on
     every progress event (several a second per file) replaced the Cancel
     button between mousedown and mouseup, so the click never landed. */
  const trRows = new Map();
  let trFrame = 0;

  function paintTransfers() {
    if (trFrame) return;
    trFrame = requestAnimationFrame(() => { trFrame = 0; paintTransfersNow(); });
  }

  function paintTransfersNow() {
    if (disposed) return;
    if (!transfers.length) { trWrap.hidden = true; trRows.clear(); trList.innerHTML = ''; return; }
    trWrap.hidden = false;
    trWrap.classList.toggle('is-closed', !trOpen);
    $('[data-act="tr-toggle"]').setAttribute('aria-expanded', String(trOpen));
    const act = active();
    const failedN = transfers.filter((t) => t.state === 'error').length;
    const bytes = act.reduce((s, t) => s + t.size, 0);
    const done = act.reduce((s, t) => s + t.done, 0);
    const rate = act.reduce((s, t) => s + (t.state === 'running' ? t.rate || 0 : 0), 0);
    const count = (st) => transfers.filter((t) => t.state === st).length;
    trSum.textContent = act.length
      ? `${act.length} uploading · ${fmtSize(done)} of ${fmtSize(bytes)}${rate ? ` · ${fmtSize(rate)}/s` : ''}`
      : [[count('done'), 'uploaded'], [failedN, 'failed'], [count('cancelled'), 'cancelled']]
        .filter(([k]) => k).map(([k, w]) => `${k} ${w}`).join(' · ');
    trTotal.style.width = `${bytes ? Math.round((done / bytes) * 100) : act.length || !count('done') ? 0 : 100}%`;
    trTotal.classList.toggle('fs-fill--err', !act.length && failedN > 0);

    const keep = new Set(transfers.map((t) => t.id));
    for (const [id, el] of trRows) if (!keep.has(id)) { el.remove(); trRows.delete(id); }
    for (const t of transfers) {
      let el = trRows.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'fs-tr';
        el.dataset.id = t.id;
        el.innerHTML = `
          <span class="fs-tr-ic" aria-hidden="true">${ic('i-upload')}</span>
          <span class="fs-tr-name"><span class="fs-tr-file">${esc(t.name)}</span><span class="fs-tr-dest">${esc(parentOf(t.dest))}</span></span>
          <span class="fs-tr-state"></span>
          <span class="fs-tr-btns"></span>
          <span class="fs-bar fs-tr-bar"><span class="fs-fill"></span></span>`;
        trList.appendChild(el);
        trRows.set(t.id, el);
      }
      const pct = t.size ? Math.min(100, Math.round((t.done / t.size) * 100)) : (t.state === 'done' ? 100 : 0);
      const label = t.state === 'error' ? `failed — ${t.error || ''}`
        : t.state === 'cancelled' ? 'cancelled'
        : t.state === 'done' ? `uploaded · ${fmtSize(t.size)}`
        : t.state === 'queued' ? `waiting · ${fmtSize(t.size)}`
        : `${pct}% · ${fmtSize(t.done)} of ${fmtSize(t.size)}${t.rate ? ` · ${fmtSize(t.rate)}/s` : ''}`;
      if (el.dataset.state !== t.state) {
        el.dataset.state = t.state;
        el.className = `fs-tr fs-tr--${t.state}`;
        el.querySelector('.fs-tr-btns').innerHTML = t.state === 'queued' || t.state === 'running'
          ? `<button class="fs-ra" data-cancel="${t.id}" title="Cancel" aria-label="Cancel ${esc(t.name)}">${ic('i-close')}</button>`
          : t.state === 'error' || t.state === 'cancelled'
            ? `<button class="fs-ra" data-retry="${t.id}" title="Try again" aria-label="Retry ${esc(t.name)}">${ic('i-refresh')}</button>`
            : '';
      }
      el.querySelector('.fs-tr-state').textContent = label;
      el.querySelector('.fs-tr-state').title = label;
      el.querySelector('.fs-tr-bar .fs-fill').style.width = `${pct}%`;
    }
  }

  /* ── interaction ──────────────────────────────────────────────────── */

  const onPointer = (e) => { lastPointer = e.pointerType || 'mouse'; };
  view.addEventListener('pointerdown', onPointer, true);

  view.addEventListener('click', async (e) => {
    const mi = e.target.closest('[data-menu]');
    if (mi) return menuPick(mi.dataset.menu);
    if (e.target === scrim) return closeMenu();
    if (!menuEl.hidden && !e.target.closest('.fs-menu')) closeMenu();

    const cd = e.target.closest('[data-cd]');
    if (cd) return load(cd.dataset.cd);

    const cancelBtn = e.target.closest('[data-cancel]');
    if (cancelBtn) { const t = transfers.find((x) => x.id === cancelBtn.dataset.cancel); if (t) cancel(t); return; }
    const retryBtn = e.target.closest('[data-retry]');
    if (retryBtn) { const t = transfers.find((x) => x.id === retryBtn.dataset.retry); if (t) retry(t); return; }

    const sort = e.target.closest('[data-sort]');
    if (sort) return setSort(sort.dataset.sort);

    if (e.target.closest('[data-act="all"]')) {
      const names = visible().map((x) => x.name);
      selected = selected.size === names.length ? new Set() : new Set(names);
      return paintSelection();
    }

    const row = e.target.closest('.fs-item');
    if (row) {
      const { name, type } = row.dataset;
      const rowAct = e.target.closest('[data-row]')?.dataset.row;
      if (rowAct === 'download') return download([name]);
      if (rowAct === 'menu') return rowMenu(e.target.closest('[data-row]'), name);
      // A checkbox is the one control that always means "add to the
      // selection", whatever modifier is or is not held.
      if (e.target.closest('.fs-check')) {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
        anchor = name;
        return paintSelection();
      }
      if (e.shiftKey && anchor) {
        const names = visible().map((x) => x.name);
        const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
        if (a >= 0) { for (const n of names.slice(a, b + 1)) selected.add(n); return paintSelection(); }
      }
      if (e.metaKey || e.ctrlKey) {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
        anchor = name;
        return paintSelection();
      }
      // Folders open on a single click or tap, everywhere.
      if (type === 'dir' || type === 'link') return openEntry(name);
      // Files: a tap toggles (a phone has no modifiers, and a selection is
      // built one tap at a time); a mouse click selects just this one.
      if (lastPointer === 'touch' || lastPointer === 'pen') {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
      } else {
        selected = selected.size === 1 && selected.has(name) ? new Set() : new Set([name]);
      }
      anchor = name;
      return paintSelection();
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'exit') return leave();
    if (act === 'up') return cwd && cwd !== '/' && load(parentOf(cwd));
    if (act === 'home') return load(null);
    if (act === 'refresh') return cwd == null ? load(null) : reload();
    if (act === 'clear') { selected = new Set(); return paintSelection(); }
    if (act === 'upload') return fileInput.click();
    if (act === 'upload-dir') return dirInput.click();
    if (act === 'sortmenu') return sortMenu(e.target.closest('[data-act]'));
    if (act === 'mkdir') return mkdir();
    if (act === 'paste') return paste();
    if (act === 'clip-cancel') { clip = null; return paintClip(); }
    if (act === 'tr-toggle') { trOpen = !trOpen; return paintTransfersNow(); }
    if (act === 'tr-clear') {
      for (let i = transfers.length - 1; i >= 0; i--) {
        if (['done', 'cancelled'].includes(transfers[i].state)) transfers.splice(i, 1);
      }
      return paintTransfersNow();
    }
    const names = [...selected];
    if (act === 'download') return download(names);
    if (act === 'cut') return setClip('move', names);
    if (act === 'copy') return setClip('copy', names);
    if (act === 'rename') return names.length === 1 && rename(names[0]);
    if (act === 'delete') return remove(names);
  });

  // Double-click a file (mouse only — a phone has its row menu) to open it.
  view.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.fs-item');
    if (!row || e.target.closest('.fs-check, [data-row]')) return;
    if (row.dataset.type === 'file') openFile(row.dataset.name);
  });

  // Right-click is the row menu on a desktop.
  view.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.fs-item');
    if (!row || lastPointer === 'touch') return;
    e.preventDefault();
    const btn = row.querySelector('[data-row="menu"]');
    rowMenu(btn, row.dataset.name);
    if (!phone.matches) {
      menuEl.style.left = `${Math.min(e.clientX, window.innerWidth - menuEl.offsetWidth - 8)}px`;
      menuEl.style.top = `${Math.min(e.clientY, window.innerHeight - menuEl.offsetHeight - 8)}px`;
    }
  });

  searchEl.addEventListener('input', () => {
    filter = searchEl.value;
    // Filtering away a selected row must not leave it selected and invisible,
    // because Delete would then act on something you cannot see.
    const shown = new Set(visible().map((x) => x.name));
    for (const n of [...selected]) if (!shown.has(n)) selected.delete(n);
    paint();
  });

  fileInput.addEventListener('change', () => {
    const items = [...(fileInput.files || [])].map((file) => ({ file, rel: file.name }));
    fileInput.value = '';
    queueUploads(items);
  });
  dirInput.addEventListener('change', () => {
    const items = [...(dirInput.files || [])].map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
    dirInput.value = '';
    queueUploads(items);
  });

  /* Drag and drop onto the list, folders included. `dragover` has to be
     cancelled or the browser navigates to the file instead. Only drags that
     carry files raise the target — dragging a crumb or selected text does
     not mean "upload". */
  const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  const onDragEnter = (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault(); dragDepth += 1; dropEl.hidden = false;
  };
  const onDragOver = (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e) => {
    if (!carriesFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.hidden = true;
  };
  const onDrop = async (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropEl.hidden = true;
    // Entries must be taken synchronously — the DataTransfer is emptied the
    // moment this handler yields.
    const roots = [...(e.dataTransfer.items || [])]
      .map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
    if (!roots.some(Boolean)) {
      return queueUploads([...(e.dataTransfer.files || [])].map((file) => ({ file, rel: file.name })));
    }
    const items = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
        if (file) items.push({ file, rel: prefix + file.name });
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      // readEntries hands back a batch at a time (100 in Chrome) until empty.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej)).catch(() => []);
        if (!batch.length) break;
        for (const kid of batch) await walk(kid, `${prefix}${entry.name}/`);
      }
    };
    for (const r of roots) if (r) await walk(r, '');
    queueUploads(items);
  };
  view.addEventListener('dragenter', onDragEnter);
  view.addEventListener('dragover', onDragOver);
  view.addEventListener('dragleave', onDragLeave);
  view.addEventListener('drop', onDrop);

  // Keys that a file list is expected to answer — but not while typing.
  const onKey = (e) => {
    if (disposed) return;
    if (document.querySelector('.modal-backdrop')) return;
    if (!menuEl.hidden) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } return; }
    const typing = e.target.closest?.('input, textarea, [contenteditable]') && e.target.type !== 'checkbox';
    if (typing) {
      if (e.key === 'Escape' && e.target === searchEl && searchEl.value) { searchEl.value = ''; searchEl.dispatchEvent(new Event('input')); }
      return;
    }
    const inHere = host.contains(document.activeElement) || document.activeElement === document.body;
    if (!inHere) return;
    const names = [...selected];
    if (e.key === 'Backspace' || (e.key === 'ArrowUp' && e.altKey)) {
      e.preventDefault();
      if (cwd && cwd !== '/') load(parentOf(cwd));
    } else if (e.key === 'Enter' && names.length === 1) {
      e.preventDefault();
      openEntry(names[0]);
    } else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      selected = new Set(visible().map((x) => x.name));
      paintSelection();
    } else if (e.key === 'Escape') {
      if (selected.size) { selected = new Set(); paintSelection(); } else if (clip) { clip = null; paintClip(); }
    } else if (e.key === 'Delete' && names.length) {
      e.preventDefault();
      remove(names);
    } else if (e.key === 'F2' && names.length === 1) {
      e.preventDefault();
      rename(names[0]);
    }
  };
  document.addEventListener('keydown', onKey);

  const onResize = () => closeMenu();
  window.addEventListener('resize', onResize);
  listEl.addEventListener('scroll', closeMenu, { passive: true });

  // Closing the tab mid-upload loses the upload; the browser asks first.
  const onUnload = (e) => {
    if (!active().length) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onUnload);

  /** Back to the device list — after asking, if that would cancel uploads. */
  async function leave() {
    const n = active().length;
    if (n) {
      const ok = await ctx.modal({
        title: 'Uploads running',
        body: `<p class="fs-ask-p">${n} upload${n === 1 ? ' is' : 's are'} still going. Leaving cancels ${n === 1 ? 'it' : 'them'}.</p>`,
        actions: [{ label: 'Stay', value: null, variant: 'ghost' }, { label: 'Leave and cancel', value: 'ok', variant: 'danger' }],
      });
      if (ok !== 'ok') return;
    }
    onExit?.();
  }

  load(null);

  return () => {
    disposed = true;
    if (trFrame) cancelAnimationFrame(trFrame);
    for (const t of transfers) { try { t.xhr?.abort(); } catch { /* finished */ } }
    view.removeEventListener('pointerdown', onPointer, true);
    view.removeEventListener('dragenter', onDragEnter);
    view.removeEventListener('dragover', onDragOver);
    view.removeEventListener('dragleave', onDragLeave);
    view.removeEventListener('drop', onDrop);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('beforeunload', onUnload);
  };
}
