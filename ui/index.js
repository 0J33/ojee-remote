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
    sym.setAttribute('viewBox', '0 -960 960 960');
    sym.innerHTML = paths;
    sprite.appendChild(sym);
  };
  add('i-search', '<path d=\"M796-121 533-384q-30 26-70 40.5T378-329q-108 0-183-75t-75-181q0-106 75-181t182-75q106 0 180.5 75T632-585q0 43-14 83t-42 75l264 262-44 44ZM377-389q81 0 138-57.5T572-585q0-81-57-138.5T377-781q-82 0-139.5 57.5T180-585q0 81 57.5 138.5T377-389Z\"/>');
  add('i-warn', '<path d=\"m40-120 440-760 440 760H40Zm104-60h672L480-760 144-180Zm361.5-65.68q8.5-8.67 8.5-21.5 0-12.82-8.68-21.32-8.67-8.5-21.5-8.5-12.82 0-21.32 8.68-8.5 8.67-8.5 21.5 0 12.82 8.68 21.32 8.67 8.5 21.5 8.5 12.82 0 21.32-8.68ZM454-348h60v-224h-60v224Zm26-122Z\"/>');
  add('i-server', '<path d=\"M286.88-717q-20.88 0-35.38 14.62-14.5 14.62-14.5 35.5 0 20.88 14.62 35.38 14.62 14.5 35.5 14.5 20.88 0 35.38-14.62 14.5-14.62 14.5-35.5 0-20.88-14.62-35.38-14.62-14.5-35.5-14.5Zm0 414q-20.88 0-35.38 14.62-14.5 14.62-14.5 35.5 0 20.88 14.62 35.38 14.62 14.5 35.5 14.5 20.88 0 35.38-14.62 14.5-14.62 14.5-35.5 0-20.88-14.62-35.38-14.62-14.5-35.5-14.5ZM154-839h651q16 0 25.5 9.5t9.5 25.81V-535q0 17.42-9.5 29.21T805-494H154q-15 0-24.5-11.79T120-535v-268.69q0-16.31 9.5-25.81T154-839Zm26 60v225h600v-225H180Zm-26 353h647q15 0 27 12.5t12 28.53V-121q0 20-12 30.5T801-80H159q-16 0-27.5-10.5T120-121v-263.97q0-16.03 9.5-28.53T154-426Zm26 60v226h600v-226H180Zm0-413v225-225Zm0 413v226-226Z\"/>');
  add('i-monitor', '<path d=\"M260-120v-73l47-47H140q-24 0-42-18t-18-42v-480q0-24 18-42t42-18h680q24 0 42 18t18 42v480q0 24-18 42t-42 18H652l48 47v73H260ZM140-300h680v-480H140v480Zm0 0v-480 480Z\"/>');
  add('i-terminal', '<path d=\"M140-160q-24 0-42-18t-18-42v-520q0-24 18-42t42-18h680q24 0 42 18t18 42v520q0 24-18 42t-42 18H140Zm0-60h680v-436H140v436Zm160-72-42-42 103-104-104-104 43-42 146 146-146 146Zm190 4v-60h220v60H490Z\"/>');
  add('i-file', '<path d=\"M220-80q-24 0-42-18t-18-42v-680q0-24 18-42t42-18h361l219 219v521q0 24-18 42t-42 18H220Zm331-554v-186H220v680h520v-494H551ZM220-820v186-186 680-680Z\"/>');
  add('i-folder', '<path d=\"M140-160q-24 0-42-18.5T80-220v-520q0-23 18-41.5t42-18.5h281l60 60h339q23 0 41.5 18.5T880-680v460q0 23-18.5 41.5T820-160H140Zm0-60h680v-460H456l-60-60H140v520Zm0 0v-520 520Z\"/>');
  add('i-back', '<path d=\"M561-240 320-481l241-241 43 43-198 198 198 198-43 43Z\"/>');
  add('i-keyboard', '<path d=\"M140-200q-24 0-42-18.5T80-260v-440q0-24 18-42t42-18h680q24 0 42 18t18 42v440q0 23-18 41.5T820-200H140Zm0-60h680v-440H140v440Zm160-65h360v-60H300v60Zm-97-125h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60ZM203-575h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60Zm124 0h60v-60h-60v60Zm123 0h60v-60h-60v60ZM140-260v-440 440Z\"/>');
  add('i-hide', '<path d=\"M480-554 283-357l-43-43 240-240 240 240-43 43-197-197Z\"/>');
  add('i-show', '<path d=\"M480-344 240-584l43-43 197 197 197-197 43 43-240 240Z\"/>');
  add('i-exit', '<path d=\"m122-80-42-42 298-298H160v-60h320v320h-60v-218L122-80Zm358-400v-320h60v218l298-298 42 42-298 298h218v60H480Z\"/>');
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
