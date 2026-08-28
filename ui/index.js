/* ============================================================
   ojee-remote — module UI.

   Two screens, and only two:

     chooser   device cards. Which machines exist, which are
               reachable, and why one is not. Picking is a
               deliberate act — auto-connecting to "the first
               device" meant a spinner against a dual-boot
               machine that was switched off.

     session   the ported rdp.ojee.net client, fullscreen.
               See ./session.js.

   Everything about actually driving a remote desktop lives in
   session.js. This file used to carry a second, lesser
   implementation of that — a panel with a canvas in it — and
   having two connect paths in one module was how they drifted.
   ============================================================ */

let ctx = null;
let root = null;
let devices = [];

let sessionMod = null;    // lazily imported ./session.js
let stopSession = null;   // its teardown
let inSession = false;

/* ── chooser ──────────────────────────────────────────────────────────── */

function chooser() {
  const cards = devices.map((d, i) => {
    const on = d.online === true;
    const why = d.online === false ? (d.error ? `offline · ${d.error}` : 'offline')
      : d.online === null ? 'checking…'
      : `online · ${d.latencyMs}ms`;
    return `
      <button class="rd-tile${on ? '' : ' rd-tile--off'}" data-pick="${ctx.esc(d.id)}"
              style="--i:${i}" ${on ? '' : 'aria-disabled="true"'}>
        <span class="rd-tile-ic">${ctx.icon(d.transport === 'agent' ? 'i-monitor' : 'i-server', 'ic ic--xl')}</span>
        <span class="rd-tile-name">${ctx.esc(d.name)}</span>
        <span class="rd-tile-why"><span class="dot ${on ? 'dot--ok' : d.online === null ? 'dot--warn' : ''}"></span>${ctx.esc(why)}</span>
        <span class="rd-tile-meta">${ctx.esc(d.transport)}${d.hasFallback ? ' · rdp' : ''}</span>
      </button>`;
  }).join('');

  return `
  <section class="rd-choose">
    <header class="rd-choose-head">
      <h2 class="h2">Devices</h2>
      <p class="meta">Pick a machine to take over. Offline ones say why.</p>
    </header>
    <div class="rd-tiles">${cards || `<div class="empty">${ctx.icon('i-warn', 'ic ic--xl')}
      <b>No devices configured</b><span>Add one to devices.json on the gateway.</span></div>`}</div>
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
    if (d.online === false) {
      ctx.toast('warn', `${d.name} is offline`,
        d.error || 'Nothing is answering on that machine.');
      return;
    }
    enterSession(d.id);
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

  async setView() { /* one view; nothing to switch */ },

  async unmount() {
    try { stopSession?.(); } catch { /* already torn down */ }
    stopSession = null;
    sessionMod = null;
    inSession = false;
    devices = [];
    root = null;
    ctx = null;
  },
};
