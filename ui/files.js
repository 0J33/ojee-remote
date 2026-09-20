/* ============================================================
   The Files view: one device's filesystem, over SFTP.

   Deliberately not a second storage.ojee.net. That one manages a
   NAS — owners, shares, quotas, secure folders. This is a machine
   you already control: the whole disk, no ownership model, and
   the jobs are "get that file off it" and "put this on it".

   What it does borrow from storage is the part that generalises:
   transfers are a queue with progress and a panel, not a browser
   download that vanishes if you navigate. Uploads stream through
   the gateway, so a 4 GB video never sits in memory anywhere.
   ============================================================ */

const MAX_PARALLEL = 2;

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

/* A human word for what a row is, and the value the Kind column sorts on.
   Extension-based, because SFTP reports a mode and a size and nothing about
   content — the same information a file manager on the far machine has. */
const KINDS = {
  folder: [], link: [],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'ico'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv'],
  audio: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'opus', 'aac'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'deb', 'rpm'],
  document: ['pdf', 'doc', 'docx', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'epub'],
  text: ['txt', 'md', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf'],
  code: ['js', 'mjs', 'ts', 'py', 'sh', 'c', 'h', 'cpp', 'rs', 'go', 'java', 'rb', 'php', 'css', 'html', 'sql'],
  disk: ['iso', 'img', 'qcow2', 'vdi', 'vmdk'],
};
const EXT_KIND = new Map();
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) EXT_KIND.set(e, kind);

function kindOf(e) {
  if (e.type === 'dir') return 'folder';
  if (e.type === 'link') return 'link';
  const dot = e.name.lastIndexOf('.');
  if (dot <= 0) return 'file';
  return EXT_KIND.get(e.name.slice(dot + 1).toLowerCase()) || `${e.name.slice(dot + 1).toLowerCase()} file`;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {object} o.ctx            module context (base, api, esc, icon, toast)
 * @param {string} o.deviceId
 * @param {string} o.deviceName
 * @param {Function} o.onExit
 * @returns {Function} teardown
 */
export function startFiles({ host, ctx, deviceId, deviceName, onExit }) {
  const api = `${ctx.base}/api/devices/${encodeURIComponent(deviceId)}/fs`;

  let cwd = null;
  let entries = [];
  let selected = new Set();
  let busy = false;
  let disposed = false;
  // Sorting and filtering are the browser's, not the server's: the listing is
  // already in hand and a round trip to re-order it would be slower than the
  // scroll it interrupts.
  let sortKey = 'name';
  let sortDir = 1;
  let filter = '';
  const transfers = [];        // { id, dir, name, path, size, done, state, error, xhr }
  let running = 0;

  host.innerHTML = `
    <section class="fs">
      <header class="fs-bar">
        <button class="rs-icon" data-act="exit" title="Back to devices" aria-label="Back to devices">
          <svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" d="M15 5 L8 12 L15 19"/></svg>
        </button>
        <nav class="fs-crumbs" aria-label="Path"></nav>
        <div class="fs-tools">
          <label class="fs-search">
            <svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5 L21 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>
            <input class="input fs-search-input" type="search" placeholder="Filter" aria-label="Filter this folder" />
          </label>
          <button class="rs-chip" data-act="refresh" title="Refresh">Refresh</button>
          <button class="rs-chip" data-act="mkdir" title="New folder">New folder</button>
          <button class="rs-chip on" data-act="upload" title="Upload files here">Upload</button>
        </div>
      </header>
      <div class="fs-selbar" hidden>
        <span class="fs-selcount label"></span>
        <button class="rs-chip" data-act="download">Download</button>
        <button class="rs-chip" data-act="rename">Rename</button>
        <button class="rs-chip rs-chip--warn" data-act="delete">Delete</button>
        <button class="rs-chip" data-act="clear">Clear</button>
      </div>
      <div class="fs-listwrap">
        <div class="fs-row fs-listhead" role="row">
          <span class="fs-check"><input type="checkbox" data-act="all" aria-label="Select everything in this folder" /></span>
          <button class="fs-sort is-on" data-sort="name">Name</button>
          <button class="fs-sort" data-sort="mtime">Modified</button>
          <button class="fs-sort" data-sort="size">Size</button>
          <button class="fs-sort" data-sort="type">Kind</button>
        </div>
        <div class="fs-list" tabindex="0"><div class="empty"><b>Loading</b></div></div>
      </div>
      <div class="fs-drop" hidden><span>Drop to upload here</span></div>
      <div class="fs-transfers" hidden>
        <div class="fs-tr-head">
          <span class="label">Transfers</span>
          <span class="fs-tr-sum"></span>
          <button class="rs-chip" data-act="tr-clear">Clear finished</button>
        </div>
        <div class="fs-tr-list"></div>
      </div>
      <input type="file" class="fs-file" multiple hidden />
    </section>`;

  const $ = (s) => host.querySelector(s);
  const listEl = $('.fs-list');
  const crumbEl = $('.fs-crumbs');
  const selBar = $('.fs-selbar');
  const dropEl = $('.fs-drop');
  const trWrap = $('.fs-transfers');
  const trList = $('.fs-tr-list');
  const trSum = $('.fs-tr-sum');
  const fileInput = $('.fs-file');
  const searchEl = $('.fs-search-input');

  /* ── data ─────────────────────────────────────────────────────────── */

  async function load(path) {
    if (disposed) return;
    busy = true;
    paint();
    try {
      const q = path ? `?path=${encodeURIComponent(path)}` : '';
      const r = await ctx.api(`/devices/${encodeURIComponent(deviceId)}/fs${q}`);
      cwd = r.path;
      entries = r.entries || [];
      selected = new Set();
      if (r.truncated) ctx.toast('warn', 'Long folder', 'Only the first 5000 entries are shown.');
    } catch (e) {
      // A folder you cannot read is a normal thing to click on; say which one
      // and stay where you were rather than emptying the view.
      ctx.toast('err', 'Cannot open folder', e.message || String(e));
      if (cwd == null) { cwd = '/'; entries = []; }
    } finally {
      busy = false;
      paint();
    }
  }

  async function call(path, body) {
    return ctx.api(`/devices/${encodeURIComponent(deviceId)}/fs${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /* ── transfers ────────────────────────────────────────────────────── */

  function pump() {
    while (running < MAX_PARALLEL) {
      const next = transfers.find((t) => t.state === 'queued');
      if (!next) break;
      running += 1;
      (next.dir === 'up' ? runUpload : runDownload)(next).finally(() => {
        running -= 1;
        paintTransfers();
        pump();
      });
    }
    paintTransfers();
  }

  function runUpload(t) {
    return new Promise((resolve) => {
      t.state = 'running';
      const xhr = new XMLHttpRequest();
      t.xhr = xhr;
      xhr.open('PUT', `${api}/upload?path=${encodeURIComponent(t.path)}`);
      xhr.upload.onprogress = (e) => { t.done = e.loaded; paintTransfers(); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { t.state = 'done'; t.done = t.size; }
        else { t.state = 'error'; t.error = errorText(xhr); }
        if (t.state === 'done' && parentOf(t.path) === cwd) load(cwd);
        resolve();
      };
      xhr.onerror = () => { t.state = 'error'; t.error = 'network'; resolve(); };
      xhr.onabort = () => { t.state = 'cancelled'; resolve(); };
      xhr.send(t.file);
    });
  }

  function runDownload(t) {
    // Downloads go straight to the browser's own download manager — it
    // resumes, it survives a tab close, and it writes to disk without the
    // file passing through JS memory. The queue tracks that it happened.
    return new Promise((resolve) => {
      t.state = 'running';
      const a = document.createElement('a');
      a.href = `${api}/download?path=${encodeURIComponent(t.path)}`;
      a.download = t.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      t.state = 'done';
      t.done = t.size;
      resolve();
    });
  }

  function errorText(xhr) {
    try { return JSON.parse(xhr.responseText).detail || xhr.statusText; }
    catch { return xhr.statusText || `HTTP ${xhr.status}`; }
  }

  function queueUploads(fileList) {
    const here = cwd;
    for (const file of fileList) {
      transfers.push({
        id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        dir: 'up', name: file.name, path: joinPath(here, file.name),
        size: file.size, done: 0, state: 'queued', file, error: null, xhr: null,
      });
    }
    trWrap.hidden = transfers.length === 0;
    pump();
  }

  function queueDownloads(names) {
    for (const name of names) {
      const e = entries.find((x) => x.name === name);
      if (!e || e.type === 'dir') continue;
      transfers.push({
        id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        dir: 'down', name, path: joinPath(cwd, name),
        size: e.size, done: 0, state: 'queued', error: null, xhr: null,
      });
    }
    trWrap.hidden = transfers.length === 0;
    pump();
  }

  /* ── paint ────────────────────────────────────────────────────────── */

  function paintCrumbs() {
    const parts = String(cwd || '/').split('/').filter(Boolean);
    // The root's own label is the first separator — joining every crumb with
    // one rendered "//home/ojee".
    let html = `<button class="fs-crumb" data-cd="/">${ctx.esc(deviceName || deviceId)}</button>`;
    let acc = '';
    parts.forEach((part) => {
      acc += `/${part}`;
      html += '<span class="fs-crumb-sep">/</span>';
      html += `<button class="fs-crumb" data-cd="${ctx.esc(acc)}">${ctx.esc(part)}</button>`;
    });
    const n = visible().length;
    html += `<span class="fs-crumb-count meta">${n} item${n === 1 ? '' : 's'}${filter ? ' shown' : ''}</span>`;
    crumbEl.innerHTML = html;
  }

  /** What the list is showing: the filter applied, then the chosen order. */
  function visible() {
    const q = filter.trim().toLowerCase();
    const rows = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice();
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => (a.size || 0) - (b.size || 0),
      mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      type: (a, b) => kindOf(a).localeCompare(kindOf(b)) || a.name.localeCompare(b.name),
    }[sortKey];
    // Directories stay above files whatever the column: a folder is not a big
    // or a small file, and mixing them makes a listing unreadable.
    return rows.sort((a, b) => (a.type === b.type ? cmp(a, b) * sortDir : a.type === 'dir' ? -1 : 1));
  }

  function paint() {
    paintCrumbs();
    for (const b of host.querySelectorAll('.fs-sort')) {
      const on = b.dataset.sort === sortKey;
      b.classList.toggle('is-on', on);
      b.dataset.dir = on ? (sortDir > 0 ? 'asc' : 'desc') : '';
    }
    if (busy && !entries.length) {
      listEl.innerHTML = `<div class="empty"><b>Loading</b></div>`;
      return;
    }
    const rows = visible();
    // The parent is a row rather than a button in the toolbar, because that is
    // where the hand already is. At the root it stays, inert, so the list does
    // not jump by one row the moment you reach the top.
    const atTop = !cwd || cwd === '/';
    const up = `
      <div class="fs-row fs-row--up${atTop ? ' is-top' : ''}" ${atTop ? '' : `data-cd="${ctx.esc(parentOf(cwd))}"`}>
        <span class="fs-check"></span>
        <span class="fs-name"><span class="fs-ic" aria-hidden="true">${ctx.icon('i-folder', 'ic')}</span><span class="fs-name-text">..</span></span>
        <span class="fs-when"></span><span class="fs-size"></span><span class="fs-kind"></span>
      </div>`;
    if (!rows.length) {
      listEl.innerHTML = up + `<div class="empty">${ctx.icon('i-folder', 'ic ic--xl')}
        <b>${filter ? 'Nothing matches' : 'Empty folder'}</b>
        <p>${filter ? 'No name in this folder contains what you typed.' : 'Drop files here to upload them to this folder.'}</p></div>`;
    } else {
      listEl.innerHTML = up + rows.map((e) => `
        <div class="fs-row${selected.has(e.name) ? ' is-sel' : ''}" data-name="${ctx.esc(e.name)}" data-type="${e.type}"
             title="${ctx.esc(e.longname || e.name)}">
          <span class="fs-check"><input type="checkbox" tabindex="-1" aria-label="Select ${ctx.esc(e.name)}"${selected.has(e.name) ? ' checked' : ''} /></span>
          <span class="fs-name">
            <span class="fs-ic" aria-hidden="true">${ctx.icon(e.type === 'dir' ? 'i-folder' : 'i-file', 'ic')}</span>
            <span class="fs-name-text">${ctx.esc(e.name)}</span>
          </span>
          <span class="fs-when">${fmtWhen(e.mtime)}</span>
          <span class="fs-size">${e.type === 'file' ? fmtSize(e.size) : ''}</span>
          <span class="fs-kind">${ctx.esc(kindOf(e))}</span>
        </div>`).join('');
    }
    paintSelection();
  }

  /**
   * Selection is painted in place. Re-rendering the list for a click would
   * throw away the scroll position — click a row half way down a long folder
   * and the list jumps back to the top — and rebuild thousands of nodes for a
   * class change.
   */
  function paintSelection() {
    for (const row of listEl.querySelectorAll('.fs-row[data-name]')) {
      const on = selected.has(row.dataset.name);
      row.classList.toggle('is-sel', on);
      const box = row.querySelector('input[type="checkbox"]');
      if (box) box.checked = on;
    }
    const n = selected.size;
    const total = visible().length;
    const all = $('[data-act="all"]');
    all.checked = n > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
    selBar.hidden = n === 0;
    if (n) $('.fs-selcount').textContent = `${n} selected`;
    $('[data-act="rename"]').disabled = n !== 1;
  }

  function paintTransfers() {
    if (!transfers.length) { trWrap.hidden = true; return; }
    trWrap.hidden = false;
    const active = transfers.filter((t) => t.state === 'queued' || t.state === 'running').length;
    trSum.textContent = active ? `${active} in progress` : 'all done';
    trList.innerHTML = transfers.slice(-20).map((t) => {
      const pct = t.size ? Math.min(100, Math.round((t.done / t.size) * 100)) : (t.state === 'done' ? 100 : 0);
      const label = t.state === 'error' ? `failed — ${ctx.esc(t.error || '')}`
        : t.state === 'cancelled' ? 'cancelled'
        : t.state === 'done' ? (t.dir === 'up' ? 'uploaded' : 'downloaded')
        : t.state === 'queued' ? 'waiting'
        : `${pct}% · ${fmtSize(t.done)} of ${fmtSize(t.size)}`;
      return `
        <div class="fs-tr ${t.state}">
          <span class="fs-tr-dir" aria-hidden="true">${t.dir === 'up' ? '↑' : '↓'}</span>
          <span class="fs-tr-name">${ctx.esc(t.name)}</span>
          <span class="fs-tr-state">${label}</span>
          ${t.state === 'running' && t.dir === 'up'
            ? `<button class="rs-chip" data-cancel="${t.id}">Cancel</button>`
            : ''}
          <span class="bar fs-tr-bar"><span class="fill${t.state === 'error' ? ' fill--err' : ''}" style="width:${pct}%"></span></span>
        </div>`;
    }).join('');
  }

  /* ── interaction ──────────────────────────────────────────────────── */

  host.addEventListener('click', async (e) => {
    const cd = e.target.closest('[data-cd]');
    if (cd) return load(cd.dataset.cd);

    const cancel = e.target.closest('[data-cancel]');
    if (cancel) {
      const t = transfers.find((x) => x.id === cancel.dataset.cancel);
      try { t?.xhr?.abort(); } catch { /* already finished */ }
      return;
    }

    const sort = e.target.closest('[data-sort]');
    if (sort) {
      const key = sort.dataset.sort;
      // Same column again reverses it; a new column starts ascending, except
      // size and date, where "biggest" and "newest" are what you came for.
      if (key === sortKey) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'size' || key === 'mtime' ? -1 : 1; }
      return paint();
    }

    if (e.target.closest('[data-act="all"]')) {
      const names = visible().map((x) => x.name);
      selected = selected.size === names.length ? new Set() : new Set(names);
      return paintSelection();
    }

    const row = e.target.closest('.fs-row[data-name]');
    if (row) {
      const { name, type } = row.dataset;
      // A checkbox is the one control that always means "add to the
      // selection", whatever modifier is or is not held.
      if (e.target.closest('.fs-check')) {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
        return paintSelection();
      }
      if (e.detail > 1 && type !== 'file') return load(joinPath(cwd, name));   // double-click a folder
      if (e.metaKey || e.ctrlKey) {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
      } else if (e.shiftKey && selected.size) {
        const names = visible().map((x) => x.name);
        const last = [...selected].pop();
        const [a, b] = [names.indexOf(last), names.indexOf(name)].sort((x, y) => x - y);
        for (const n of names.slice(a, b + 1)) selected.add(n);
      } else {
        selected = new Set([name]);
      }
      return paintSelection();
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'exit') return onExit?.();
    if (act === 'up') return load(parentOf(cwd));
    if (act === 'refresh') return load(cwd);
    if (act === 'clear') { selected = new Set(); return paintSelection(); }
    if (act === 'upload') return fileInput.click();
    if (act === 'tr-clear') {
      for (let i = transfers.length - 1; i >= 0; i--) {
        if (['done', 'error', 'cancelled'].includes(transfers[i].state)) transfers.splice(i, 1);
      }
      return paintTransfers();
    }
    if (act === 'download') return queueDownloads([...selected]);
    if (act === 'mkdir') {
      const name = window.prompt('New folder name');
      if (!name) return;
      try { await call('/mkdir', { path: joinPath(cwd, name) }); await load(cwd); }
      catch (err) { ctx.toast('err', 'Could not create folder', err.message); }
      return;
    }
    if (act === 'rename') {
      const [only] = [...selected];
      if (!only) return;
      const name = window.prompt('Rename to', only);
      if (!name || name === only) return;
      try { await call('/move', { from: joinPath(cwd, only), to: joinPath(cwd, name) }); await load(cwd); }
      catch (err) { ctx.toast('err', 'Could not rename', err.message); }
      return;
    }
    if (act === 'delete') {
      const names = [...selected];
      if (!names.length) return;
      const dirs = names.filter((n) => entries.find((x) => x.name === n)?.type === 'dir');
      const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
      const warn = dirs.length
        ? `\n\n${dirs.length} of them ${dirs.length === 1 ? 'is a folder' : 'are folders'} — everything inside goes too.`
        : '';
      if (!window.confirm(`Delete ${what} on ${deviceName}?${warn}\n\nThis cannot be undone.`)) return;
      for (const n of names) {
        try {
          await call('/delete', { path: joinPath(cwd, n), recursive: dirs.includes(n) });
        } catch (err) {
          ctx.toast('err', `Could not delete ${n}`, err.message);
        }
      }
      await load(cwd);
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
    if (fileInput.files?.length) queueUploads([...fileInput.files]);
    fileInput.value = '';
  });

  // Drag and drop onto the list. `dragover` has to be cancelled or the browser
  // navigates to the file instead.
  let dragDepth = 0;
  const onDragEnter = (e) => { e.preventDefault(); dragDepth += 1; dropEl.hidden = false; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  const onDragLeave = () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.hidden = true; };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropEl.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) queueUploads(files);
  };
  host.addEventListener('dragenter', onDragEnter);
  host.addEventListener('dragover', onDragOver);
  host.addEventListener('dragleave', onDragLeave);
  host.addEventListener('drop', onDrop);

  // Keys that a file list is expected to answer.
  const onKey = (e) => {
    if (disposed || !host.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (e.key === 'Backspace') { e.preventDefault(); load(parentOf(cwd)); }
    else if (e.key === 'Enter' && selected.size === 1) {
      const [only] = [...selected];
      const ent = entries.find((x) => x.name === only);
      if (ent?.type !== 'file') load(joinPath(cwd, only));
    } else if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      selected = new Set(entries.map((x) => x.name));
      paintSelection();
    } else if (e.key === 'Escape' && selected.size) {
      selected = new Set();
      paintSelection();
    }
  };
  host.addEventListener('keydown', onKey);

  load(null);

  return () => {
    disposed = true;
    for (const t of transfers) { try { t.xhr?.abort(); } catch { /* finished */ } }
    host.removeEventListener('dragenter', onDragEnter);
    host.removeEventListener('dragover', onDragOver);
    host.removeEventListener('dragleave', onDragLeave);
    host.removeEventListener('drop', onDrop);
    host.removeEventListener('keydown', onKey);
  };
}
