/* ============================================================
   ojee-remote — module UI.

   A device list and three ways to use a machine:

     devices   one card per machine, each carrying Screen, Shell
               and Files with their own reachability — a screen
               and a shell fail independently. Picking is a
               deliberate act — auto-connecting to "the first
               device" meant a spinner against a dual-boot
               machine that was switched off.

     screen    the ported rdp.ojee.net client, fullscreen.
               See ./session.js.

     shell     a terminal over SSH. See ./shell.js.

     files     that machine's filesystem over SFTP, on the same
               connection. See ./files.js.

   The three share one device list, one presence stream and
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

let sessionMod = null;    // lazily imported ./session.js
let shellMod = null;      // lazily imported ./shell.js
let filesMod = null;      // lazily imported ./files.js
let stopSession = null;   // teardown of whichever one is running
let inSession = false;


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
  // The Files view's verbs. more/up/folderAdd are Material's more_vert,
  // arrow_upward and create_new_folder; the rest are ojee-ui icons.json names.
  add('i-close', '<path d=\"m249-207-42-42 231-231-231-231 42-42 231 231 231-231 42 42-231 231 231 231-42 42-231-231-231 231Z\"/>');
  add('i-refresh', '<path d=\"M480-160q-133 0-226.5-93.5T160-480q0-133 93.5-226.5T480-800q85 0 149 34.5T740-671v-129h60v254H546v-60h168q-38-60-97-97t-137-37q-109 0-184.5 75.5T220-480q0 109 75.5 184.5T480-220q83 0 152-47.5T728-393h62q-29 105-115 169t-195 64Z\"/>');
  add('i-plus', '<path d=\"M450-450H200v-60h250v-250h60v250h250v60H510v250h-60v-250Z\"/>');
  add('i-check', '<path d=\"M378-246 154-470l43-43 181 181 384-384 43 43-427 427Z\"/>');
  add('i-chevron', '<path d=\"M530-481 332-679l43-43 241 241-241 241-43-43 198-198Z\"/>');
  add('i-folderUp', '<path d=\"M450-280h60v-227l74 74 42-42-146-146-146 146 42 42 74-74v227ZM140-160q-24 0-42-18.5T80-220v-520q0-23 18-41.5t42-18.5h281l60 60h339q23 0 41.5 18.5T880-680v460q0 23-18.5 41.5T820-160H140Zm0-60h680v-460H456l-60-60H140v520Zm0 0v-520 520Z\"/>');
  add('i-copy', '<path d=\"M300-200q-24 0-42-18t-18-42v-560q0-24 18-42t42-18h440q24 0 42 18t18 42v560q0 24-18 42t-42 18H300Zm0-60h440v-560H300v560ZM180-80q-24 0-42-18t-18-42v-620h60v620h500v60H180Zm120-180v-560 560Z\"/>');
  add('i-paste', '<path d=\"M180-120q-26 0-43-17t-17-43v-600q0-26 17-43t43-17h202q7-35 34.5-57.5T480-920q36 0 63.5 22.5T578-840h202q26 0 43 17t17 43v600q0 26-17 43t-43 17H180Zm0-60h600v-600h-60v90H240v-90h-60v600Zm328.5-611.5Q520-803 520-820t-11.5-28.5Q497-860 480-860t-28.5 11.5Q440-837 440-820t11.5 28.5Q463-780 480-780t28.5-11.5Z\"/>');
  add('i-move', '<path d=\"m526-410-75 75 42 42 147-147-147-147-42 42 75 75H320v60h206ZM140-160q-24 0-42-18.5T80-220v-520q0-23 18-41.5t42-18.5h281l60 60h339q23 0 41.5 18.5T880-680v460q0 23-18.5 41.5T820-160H140Zm0-60h680v-460H456l-60-60H140v520Zm0 0v-520 520Z\"/>');
  add('i-edit', '<path d=\"M180-180h44l472-471-44-44-472 471v44Zm-60 60v-128l575-574q8-8 19-12.5t23-4.5q11 0 22 4.5t20 12.5l44 44q9 9 13 20t4 22q0 11-4.5 22.5T823-694L248-120H120Zm659-617-41-41 41 41Zm-105 64-22-22 44 44-22-22Z\"/>');
  add('i-trash', '<path d=\"M261-120q-24.75 0-42.37-17.63Q201-155.25 201-180v-570h-41v-60h188v-30h264v30h188v60h-41v570q0 24-18 42t-42 18H261Zm438-630H261v570h438v-570ZM367-266h60v-399h-60v399Zm166 0h60v-399h-60v399ZM261-750v570-570Z\"/>');
  add('i-download', '<path d=\"M480-313 287-506l43-43 120 120v-371h60v371l120-120 43 43-193 193ZM220-160q-24 0-42-18t-18-42v-143h60v143h520v-143h60v143q0 24-18 42t-42 18H220Z\"/>');
  add('i-upload', '<path d=\"M450-313v-371L330-564l-43-43 193-193 193 193-43 43-120-120v371h-60ZM220-160q-24 0-42-18t-18-42v-143h60v143h520v-143h60v143q0 24-18 42t-42 18H220Z\"/>');
  add('i-sort', '<path d=\"M323-450v-316L202-645l-42-42 193-193 193 193-42 42-121-121v316h-60ZM607-80 414-273l42-42 121 121v-316h60v316l121-121 42 42L607-80Z\"/>');
  add('i-external', '<path d=\"M180-120q-24 0-42-18t-18-42v-600q0-24 18-42t42-18h279v60H180v600h600v-279h60v279q0 24-18 42t-42 18H180Zm202-219-42-43 398-398H519v-60h321v321h-60v-218L382-339Z\"/>');
  add('i-house', '<path d=\"M220-180h150v-250h220v250h150v-390L480-765 220-570v390Zm-60 60v-480l320-240 320 240v480H530v-250H430v250H160Zm320-353Z\"/>');
  add('i-more', '<path d=\"M479.86-160Q460-160 446-174.14t-14-34Q432-228 446.14-242t34-14Q500-256 514-241.86t14 34Q528-188 513.86-174t-34 14Zm0-272Q460-432 446-446.14t-14-34Q432-500 446.14-514t34-14Q500-528 514-513.86t14 34Q528-460 513.86-446t-34 14Zm0-272Q460-704 446-718.14t-14-34Q432-772 446.14-786t34-14Q500-800 514-785.86t14 34Q528-732 513.86-718t-34 14Z\"/>');
  add('i-up', '<path d=\"M450-160v-526L202-438l-42-42 320-320 320 320-42 42-248-248v526h-60Z\"/>');
  add('i-folderAdd', '<path d=\"M550-320h60v-90h90v-60h-90v-90h-60v90h-90v60h90v90ZM140-160q-24 0-42-18.5T80-220v-520q0-23 18-41.5t42-18.5h281l60 60h339q23 0 41.5 18.5T880-680v460q0 23-18.5 41.5T820-160H140Zm0-60h680v-460H456l-60-60H140v520Zm0 0v-520 520Z\"/>');
}

/* ── devices ──────────────────────────────────────────────────────────── */

/*
 * One landing view: every machine, each with its three verbs on the card.
 * This used to be three tabs — Screen, Shell, Files — each showing the same
 * device list filtered and captioned differently, so "open a terminal on the
 * HP" was tab, then card, then terminal, and a machine's screen and shell
 * state were never on screen together. Now the card is the machine and the
 * buttons are what you can do to it.
 */

/** The three verbs, and what each needs from a device. */
const ACTIONS = [
  { id: 'screen', label: 'Screen', icon: 'i-monitor',
    has: (d) => d.transport !== 'ssh',
    up: (d) => d.online, ms: (d) => d.latencyMs, err: (d) => d.error,
    none: 'no screen — this machine is terminal-only' },
  { id: 'shell', label: 'Shell', icon: 'i-terminal',
    has: (d) => d.hasShell,
    up: (d) => d.shellOnline, ms: (d) => d.shellLatencyMs, err: (d) => d.shellError,
    none: 'no ssh block in devices.json' },
  { id: 'files', label: 'Files', icon: 'i-folder',
    has: (d) => d.hasShell,
    up: (d) => d.shellOnline, ms: (d) => d.shellLatencyMs, err: (d) => d.shellError,
    none: 'files come over SFTP — add an ssh block' },
];

const stateOf = (a, d) => {
  if (!a.has(d)) return { key: 'na', text: 'n/a' };
  const up = a.up(d);
  if (up === true) return { key: 'on', text: Number.isFinite(a.ms(d)) ? `${Math.round(a.ms(d))}ms` : 'online' };
  if (up === false) return { key: 'off', text: 'offline' };
  return { key: 'wait', text: 'checking' };
};

function deviceCard(d, i) {
  const states = ACTIONS.map((a) => stateOf(a, d));
  const anyOn = states.some((st) => st.key === 'on');
  const anyWait = states.some((st) => st.key === 'wait');
  const offErr = ACTIONS.map((a) => (a.has(d) && a.up(d) === false ? a.err(d) : null)).find(Boolean);
  const head = anyOn ? 'online' : anyWait ? 'checking…' : `offline${offErr ? ` · ${offErr}` : ''}`;
  const kind = d.transport === 'ssh' ? 'ssh' : `${d.transport}${d.hasFallback ? ' · rdp' : ''}${d.hasShell ? ' · ssh' : ''}`;
  const btns = ACTIONS.map((a, k) => {
    const st = states[k];
    return `
      <button class="rd-act rd-act--${st.key}" data-act="${a.id}" data-dev="${ctx.esc(d.id)}"
              ${st.key === 'na' ? 'disabled' : ''}
              ${st.key === 'off' ? 'aria-disabled="true"' : ''}
              title="${ctx.esc(st.key === 'na' ? a.none : `${a.label} · ${st.key === 'off' ? (a.err(d) || 'offline') : st.text}`)}">
        ${ctx.icon(a.icon, 'ic')}
        <span class="rd-act-label">${a.label}</span>
        <span class="rd-act-state"><span class="rd-act-dot" aria-hidden="true"></span>${ctx.esc(st.text)}</span>
      </button>`;
  }).join('');
  return `
    <article class="rd-card${anyOn ? '' : anyWait ? ' rd-card--wait' : ' rd-card--off'}" style="--i:${i}">
      <header class="rd-card-head">
        <span class="rd-card-ic">${ctx.icon(d.transport === 'ssh' ? 'i-server' : 'i-monitor', 'ic ic--lg')}</span>
        <span class="rd-card-title">
          <span class="rd-card-name">${ctx.esc(d.name)}</span>
          <span class="rd-card-why"><span class="dot ${anyOn ? 'dot--ok' : anyWait ? 'dot--warn' : ''}"></span>${ctx.esc(head)}</span>
        </span>
        <span class="rd-card-meta">${ctx.esc(kind)}</span>
      </header>
      <div class="rd-acts">${btns}</div>
    </article>`;
}

function chooser() {
  const cards = devices.map(deviceCard).join('');
  const empty = `<div class="empty">${ctx.icon('i-warn', 'ic ic--xl')}
      <b>No devices configured</b><span>Add one to devices.json on the gateway.</span></div>`;
  return `
  <section class="rd-choose">
    <header class="rd-choose-head">
      <h2 class="h2">Devices</h2>
      <p class="meta">Take over the screen, open a terminal, or move files. Offline ones say why.</p>
    </header>
    <div class="rd-cards">${cards || empty}</div>
  </section>`;
}

function showChooser() {
  inSession = false;
  // The session owns a WebSocket, timers and a body class. Let it clean up
  // after itself rather than trusting innerHTML to do it.
  try { stopSession?.(); } catch { /* already torn down */ }
  stopSession = null;
  paintChooser();
}

function paintChooser() {
  root.innerHTML = chooser();
  root.querySelectorAll('.rd-act[data-act]').forEach((b) => b.addEventListener('click', () => {
    const d = devices.find((x) => x.id === b.dataset.dev);
    const a = ACTIONS.find((x) => x.id === b.dataset.act);
    if (!d || !a || !a.has(d)) return;
    if (a.up(d) === false) {
      ctx.toast('warn', `${d.name} · ${a.label} is offline`,
        a.err(d) || (a.id === 'screen' ? 'Nothing is answering on that machine.' : 'sshd is not answering on that machine.'));
      return;
    }
    if (a.id === 'shell') enterShell(d);
    else if (a.id === 'files') enterFiles(d);
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
    devices = (await ctx.api('/devices')).devices || [];
    showChooser();

    ctx.sse('/events', {
      events: {
        devices: ({ devices: next }) => {
          devices = next;
          // Only repaint the chooser. Repainting during a session would tear
          // down the very screen the user is working in.
          if (!inSession) paintChooser();
        },
      },
    });
  },

  /**
   * One view now. Re-selecting it from the console's nav returns to the
   * device list, tearing down whatever is running first: a terminal and a
   * desktop both own a WebSocket, and leaving one open behind the other is
   * how you end up typing into a machine you can no longer see.
   */
  async setView() {
    if (inSession) showChooser();
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
