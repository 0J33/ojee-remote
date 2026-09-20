/* ============================================================
   ojee-remote — module UI.

   A chooser and two ways to use a machine:

     chooser   device cards. Which machines exist, which are
               reachable, and why one is not. Picking is a
               deliberate act — auto-connecting to "the first
               device" meant a spinner against a dual-boot
               machine that was switched off.

     screen    the ported rdp.ojee.net client, fullscreen.
               See ./session.js.

     shell     a terminal over SSH. See ./shell.js.

     files     that machine's filesystem over SFTP, on the same
               connection. See ./files.js.

   The two views share one device list, one presence stream and
   one set of credentials on the gateway, which is why "ssh
   instead of rdp" is a view here and not a module of its own.

   Everything about actually driving a remote desktop lives in
   session.js. This file used to carry a second, lesser
   implementation of that — a panel with a canvas in it — and
   having two connect paths in one module was how they drifted.
   ============================================================ */

let ctx = null;
let root = null;
let devices = [];
let view = 'screen';

let sessionMod = null;    // lazily imported ./session.js
let shellMod = null;      // lazily imported ./shell.js
let filesMod = null;      // lazily imported ./files.js
let stopSession = null;   // teardown of whichever one is running
let inSession = false;

/** Which devices belong in the current view. */
const forView = (list) => (view === 'shell' || view === 'files'
  ? list.filter((d) => d.hasShell)
  : list.filter((d) => d.transport !== 'ssh'));

/* ── icons ────────────────────────────────────────────────────────────── */

/**
 * The console's sprite has no terminal glyph, and the manifest asks for one
 * by id. Modules are allowed to append their own symbols — same stroke
 * language, one sprite — so the Shell tab gets an icon in the console and in
 * the standalone shell alike.
 */
function ensureIcons() {
  const sprite = document.getElementById('sprite');
  if (!sprite) return;
  const add = (id, paths) => {
    if (document.getElementById(id)) return;
    const sym = document.createElementNS('http://www.w3.org/2000/svg', 'symbol');
    sym.id = id;
    sym.setAttribute('viewBox', '0 0 24 24');
    sym.innerHTML = paths;
    sprite.appendChild(sym);
  };
  add('i-terminal', '<rect x="3" y="4" width="18" height="16"/><path d="M7 9l3 3-3 3M13 15h4"/>');
  add('i-folder', '<path d="M3 6h6l2 2.5h10V19H3z"/>');
  add('i-file', '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>');
}

/* ── chooser ──────────────────────────────────────────────────────────── */

function chooser() {
  const shown = forView(devices);
  const shell = view === 'shell';
  const files = view === 'files';
  const cards = shown.map((d, i) => {
    // Shell and Files need sshd; Screen needs the agent or RDP. A device can
    // be up for one and down for the other, so each view asks about its own.
    const useShell = shell || files;
    const up = useShell ? d.shellOnline : d.online;
    const err = useShell ? d.shellError : d.error;
    const ms = useShell ? d.shellLatencyMs : d.latencyMs;
    const on = up === true;
    const why = up === false ? (err ? `offline · ${err}` : 'offline')
      : up === null ? 'checking…'
      : `online · ${ms}ms`;
    return `
      <button class="rd-tile${on ? '' : ' rd-tile--off'}" data-pick="${ctx.esc(d.id)}"
              style="--i:${i}" ${on ? '' : 'aria-disabled="true"'}>
        <span class="rd-tile-ic">${ctx.icon(files ? 'i-folder' : shell ? 'i-terminal' : d.transport === 'agent' ? 'i-monitor' : 'i-server', 'ic ic--xl')}</span>
        <span class="rd-tile-name">${ctx.esc(d.name)}</span>
        <span class="rd-tile-why"><span class="dot ${on ? 'dot--ok' : up === null ? 'dot--warn' : ''}"></span>${ctx.esc(why)}</span>
        <span class="rd-tile-meta">${ctx.esc(files ? 'sftp' : shell ? 'ssh' : d.transport)}${!shell && !files && d.hasFallback ? ' · rdp' : ''}</span>
      </button>`;
  }).join('');

  const empty = (shell || files)
    ? `<div class="empty">${ctx.icon('i-warn', 'ic ic--xl')}
        <b>No machine has a shell</b><span>Add an <code>ssh</code> block to a device in devices.json on the gateway — ${files ? 'files come over SFTP on that connection' : 'the terminal runs on it'}.</span></div>`
    : `<div class="empty">${ctx.icon('i-warn', 'ic ic--xl')}
        <b>No devices configured</b><span>Add one to devices.json on the gateway.</span></div>`;

  return `
  <section class="rd-choose">
    <header class="rd-choose-head">
      <h2 class="h2">Devices</h2>
      <p class="meta">${files
        ? 'Pick a machine to browse its files. Offline ones say why.'
        : shell
          ? 'Pick a machine to open a terminal on. Offline ones say why.'
          : 'Pick a machine to take over. Offline ones say why.'}</p>
    </header>
    <div class="rd-tiles">${cards || empty}</div>
  </section>`;
}

function showChooser() {
  inSession = false;
  // The session owns a WebSocket, timers and a body class. Let it clean up
  // after itself rather than trusting innerHTML to do it.
  try { stopSession?.(); } catch { /* already torn down */ }
  stopSession = null;

  root.innerHTML = chooser();
  root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
    const d = devices.find((x) => x.id === b.dataset.pick);
    if (!d) return;
    const needsShell = view === 'shell' || view === 'files';
    const up = needsShell ? d.shellOnline : d.online;
    if (up === false) {
      ctx.toast('warn', `${d.name} is offline`,
        (needsShell ? d.shellError : d.error)
        || (needsShell ? 'sshd is not answering on that machine.' : 'Nothing is answering on that machine.'));
      return;
    }
    if (view === 'shell') enterShell(d);
    else if (view === 'files') enterFiles(d);
    else enterSession(d.id);
  }));
}

/* ── session ──────────────────────────────────────────────────────────── */

async function enterSession(id) {
  inSession = true;
  if (!sessionMod) sessionMod = await import(`${ctx.base}/ui/session.js`);
  if (!document.getElementById('rs-css')) {
    const link = document.createElement('link');
    link.id = 'rs-css';
    link.rel = 'stylesheet';
    link.href = `${ctx.base}/ui/session.css`;
    document.head.appendChild(link);
  }
  stopSession = sessionMod.startSession({
    host: root,
    ctx,
    deviceId: id,
    onExit: showChooser,
  });
}

async function enterShell(device) {
  inSession = true;
  if (!shellMod) shellMod = await import(`${ctx.base}/ui/shell.js`);
  if (!document.getElementById('sh-css')) {
    const link = document.createElement('link');
    link.id = 'sh-css';
    link.rel = 'stylesheet';
    link.href = `${ctx.base}/ui/shell.css`;
    document.head.appendChild(link);
  }
  stopSession = shellMod.startShell({
    host: root,
    ctx,
    deviceId: device.id,
    deviceName: device.name,
    onExit: showChooser,
  });
}

async function enterFiles(device) {
  inSession = true;
  if (!filesMod) filesMod = await import(`${ctx.base}/ui/files.js`);
  if (!document.getElementById('fs-css')) {
    const link = document.createElement('link');
    link.id = 'fs-css';
    link.rel = 'stylesheet';
    link.href = `${ctx.base}/ui/files.css`;
    document.head.appendChild(link);
  }
  stopSession = filesMod.startFiles({
    host: root,
    ctx,
    deviceId: device.id,
    deviceName: device.name,
    onExit: showChooser,
  });
}

/* ── module contract ──────────────────────────────────────────────────── */

export default {
  async mount(mountEl, context) {
    root = mountEl;
    ctx = context;

    if (!document.getElementById('rd-css')) {
      const link = document.createElement('link');
      link.id = 'rd-css';
      link.rel = 'stylesheet';
      link.href = `${ctx.base}/ui/remote.css`;
      document.head.appendChild(link);
    }

    ensureIcons();
    view = context.view || 'screen';
    devices = (await ctx.api('/devices')).devices || [];
    showChooser();

    ctx.sse('/events', {
      events: {
        devices: ({ devices: next }) => {
          devices = next;
          // Only repaint the chooser. Repainting during a session would tear
          // down the very screen the user is working in.
          if (!inSession) showChooser();
        },
      },
    });
  },

  /**
   * Screen ⇄ Shell. Whatever is running is torn down first: a terminal and a
   * desktop both own a WebSocket, and leaving one open behind the other is
   * how you end up typing into a machine you can no longer see.
   */
  async setView(next) {
    if (next === view) return;
    view = ['shell', 'files'].includes(next) ? next : 'screen';
    showChooser();
  },

  async unmount() {
    try { stopSession?.(); } catch { /* already torn down */ }
    stopSession = null;
    sessionMod = null;
    shellMod = null;
    filesMod = null;
    inSession = false;
    devices = [];
    root = null;
    ctx = null;
  },
};
