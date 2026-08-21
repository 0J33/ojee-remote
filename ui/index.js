/* ============================================================
   ojee-remote — module UI.

   Mounts in ojee-console or in ojee-ui's standalone shell; the
   only difference is ctx.base, which ctx.api()/ctx.sse() already
   handle. Nothing below knows which it is.

   Three behaviours are the whole point of this rewrite:

   1. FREEZE AND SWAP. Switching monitors rebuilds the RDP session
      on the far side. Instead of blanking and hoping, we snapshot
      the live canvas to an overlay, ask the server to switch (it
      does not answer until the compositor confirms), build the new
      connection in a DETACHED element, and cross-fade only when
      that connection produces a real frame. The user sees a dimmed
      still and a label, never black.

   2. ONE RECONNECT CONTROLLER. The old client scheduled reconnects
      from four places, so a single drop could start several
      overlapping attempts that killed each other. Here exactly one
      is ever in flight, with capped backoff, and it gives up
      loudly after five tries instead of retrying forever behind a
      spinner that looks identical to a hang.

   3. HONEST STATES. "device offline", "switching monitor",
      "reconnecting (3/5)" and "session ended" are different
      situations with different responses. They used to all render
      as the same red word.
   ============================================================ */

/**
 * guacamole-common-js is loaded dynamically rather than with a static import.
 * A static specifier would have to name a path, and the correct path differs
 * between mounted (`/remote/guac-js/…`) and standalone (`/guac-js/…`) — so a
 * static import would hardcode one and break the other. Everything else in
 * this file is already base-agnostic via ctx.api/ctx.sse; this keeps the last
 * piece that way too.
 */
let Guacamole = null;

/* ── state ────────────────────────────────────────────────────────────── */

let ctx = null;
let root = null;

let devices = [];
let active = null;          // the device object we are connected (or connecting) to
let monitors = [];          // primary-switch devices only
let mode = 'single';        // 'primary-switch' | 'multimon' | 'single'

let client = null;          // live Guacamole.Client
let tunnel = null;          // its tunnel, so a disconnect can be AWAITED
let display = null;
let canvasEl = null;

let focused = null;         // multimon: which monitor we are cropped to, or null for all
let fit = 'contain';        // 'contain' | '100'

// View transform on top of the base fit/crop, driven by pinch and two-finger
// drag. 1 / 0 / 0 is the untouched base view.
let zoom = 1, panX = 0, panY = 0;
const ZOOM_MIN = 1, ZOOM_MAX = 8;

let cursorX = 0, cursorY = 0;   // remote pixels, for the trackpad cursor

/* ── the reconnect controller ─────────────────────────────────────────── */

/**
 * Exactly one reconnect may be pending. Every path that wants to reconnect
 * goes through here, so they cannot stack.
 *
 * Backoff is capped at 15s: uncapped, a machine that has been off for an hour
 * gets hammered the instant it wakes; unbacked-off, a refusing port produces a
 * request storm.
 */
const reconnect = {
  timer: null,
  attempt: 0,
  max: 5,
  generation: 0,     // invalidates callbacks from a superseded connection

  schedule(reason) {
    this.cancel();
    if (this.attempt >= this.max) {
      setState('failed', `${active?.name || 'Device'} is not responding`, reason);
      return;
    }
    this.attempt += 1;
    const wait = Math.min(1000 * 2 ** (this.attempt - 1), 15000);
    setState('reconnecting', `Reconnecting (${this.attempt}/${this.max})`,
      `next attempt in ${Math.round(wait / 1000)}s`);
    this.timer = setTimeout(() => { this.timer = null; connect(); }, wait);
  },

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  },

  /** A successful connection clears the budget. */
  succeed() {
    this.cancel();
    this.attempt = 0;
  },
};

/* ── status ───────────────────────────────────────────────────────────── */

const STATE_KIND = {
  connected: 'ok',
  connecting: 'info',
  switching: 'info',
  reconnecting: 'warn',
  offline: 'warn',
  failed: 'err',
  ended: 'warn',
};

let state = 'idle';

function setState(next, label, detail = '') {
  state = next;
  const el = root?.querySelector('#rd-state');
  if (!el) return;
  el.dataset.kind = STATE_KIND[next] || '';
  el.querySelector('.rd-state-label').textContent = label;
  el.querySelector('.rd-state-detail').textContent = detail;
  root.querySelector('#rd-retry').hidden = next !== 'failed' && next !== 'offline';
}

/* ── connection ───────────────────────────────────────────────────────── */

function teardown() {
  reconnect.generation += 1;
  reconnect.cancel();
  try { client?.disconnect(); } catch { /* already gone */ }
  client = null;
  tunnel = null;
  display = null;
  canvasEl = null;
}

/**
 * Disconnect and wait until the session is really gone.
 *
 * gnome-remote-desktop serves ONE session at a time. Calling disconnect() and
 * immediately reconnecting means the new session races the old one's teardown
 * — guacd accepts it, the keymaps load, and then no frame ever arrives because
 * the far side is still holding the previous session. That is what the freeze
 * overlay was sitting on top of, indefinitely.
 *
 * So: close, and wait for the tunnel to confirm. The timeout is a backstop, not
 * the mechanism — if the socket never reports closed we proceed anyway rather
 * than hanging forever.
 */
function disconnectAndWait(timeoutMs = 4000) {
  const c = client;
  const t = tunnel;
  client = null;
  tunnel = null;
  display = null;
  if (!c) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    if (t) {
      const prev = t.onstatechange;
      t.onstatechange = (state) => {
        prev?.(state);
        if (state === Guacamole.Tunnel.State.CLOSED) finish();
      };
    }
    try { c.disconnect(); } catch { finish(); }
    setTimeout(finish, timeoutMs);
  });
}

async function connect() {
  if (!active) return;

  const presence = devices.find((d) => d.id === active.id);
  if (presence?.online === false) {
    teardown();
    setState('offline', `${active.name} is offline`,
      presence.error ? `last probe: ${presence.error}` : 'nothing is listening on that host');
    return;
  }

  const gen = ++reconnect.generation;
  setState('connecting', `Connecting to ${active.name}…`);

  let token;
  try {
    const stage = root.querySelector('#rd-stage');
    const dpr = window.devicePixelRatio || 1;
    const r = await ctx.api(
      `/devices/${encodeURIComponent(active.id)}/token` +
      `?width=${Math.round(stage.clientWidth * dpr)}&height=${Math.round(stage.clientHeight * dpr)}`);
    token = r.token;
    mode = r.monitors;
  } catch (e) {
    if (gen !== reconnect.generation) return;
    if (/offline/i.test(e.message)) {
      setState('offline', `${active.name} is offline`, e.message);
      return;
    }
    reconnect.schedule(e.message);
    return;
  }
  if (gen !== reconnect.generation) return;

  let built;
  try {
    built = await buildConnection(token, gen);
  } catch {
    // buildConnection already scheduled the retry and set the status. Swallow
    // here deliberately: connect() must never throw, or a failed connection
    // escapes mount() and the host replaces this module's UI — including the
    // device picker and the retry button — with a generic error panel.
    return;
  }

  const { client: c, display: d, el, tunnel: tun } = built;
  if (gen !== reconnect.generation) {
    try { c.disconnect(); } catch { /* superseded */ }
    return;
  }

  attach(el, c, d, tun);
  reconnect.succeed();
  setState('connected', active.name, mode === 'multimon' ? 'all monitors' : '');
  await loadMonitors();
  recentre();
  applyTransform();
}

/**
 * Build a connection into a DETACHED element and resolve on its first real
 * frame. Nothing is put on screen until there is something to show — which is
 * what lets the caller keep the previous image visible in the meantime.
 */
function buildConnection(token, gen) {
  return new Promise((resolve, reject) => {
    const tun = new Guacamole.WebSocketTunnel(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${ctx.base}/guac`);
    const c = new Guacamole.Client(tun);
    const d = c.getDisplay();
    const el = d.getElement();

    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.transformOrigin = '0 0';

    let settled = false;
    let dead = false;

    // ONE death path. The client's DISCONNECTED state does not fire for
    // tunnel-level closures (the server closing the socket), so the tunnel is
    // watched too — missing that is why a dead session used to freeze on its
    // last frame forever with no reconnect.
    const onDead = (why) => {
      if (dead || gen !== reconnect.generation) return;
      dead = true;
      if (!settled) { settled = true; reject(new Error(why)); return; }
      if (state === 'switching') return;   // the switch owns its own recovery
      reconnect.schedule(why);
    };

    // First sync with a sized display means a frame has actually arrived.
    // Resolving on CONNECTED alone would hand back a blank canvas — which is
    // precisely the black screen we are removing.
    c.onsync = () => {
      if (settled || gen !== reconnect.generation) return;
      if (d.getWidth() > 0 && d.getHeight() > 0) {
        settled = true;
        resolve({ client: c, display: d, el, tunnel: tun });
      }
    };
    c.onstatechange = (s) => { if (s === 5) onDead('session ended'); };
    tun.onstatechange = (s) => { if (s === Guacamole.Tunnel.State.CLOSED) onDead('connection closed'); };
    c.onerror = (e) => onDead(e.message || `guacd error ${e.code}`);
    tun.onerror = (e) => onDead(e?.message || 'tunnel error');
    c.onaudio = (stream, mimetype) => Guacamole.AudioPlayer.getInstance(stream, mimetype);
    d.onresize = () => applyTransform();

    c.connect(`token=${encodeURIComponent(token)}`);

    // A connection that completes the handshake but never sends a frame must
    // be abandoned QUICKLY, not waited out.
    //
    // gnome-remote-desktop can accept NLA, let guacd load its keymaps and
    // negotiate audio, and then send no graphics at all — it does this while
    // recovering from session churn. Every signal the client can see says
    // "connected", so a long timeout here is indistinguishable from a hang.
    // Eight seconds is well past a healthy handshake (~1s on a tailnet) and
    // short enough that the retry lands while the user is still watching.
    setTimeout(() => {
      if (settled || gen !== reconnect.generation) return;
      settled = true;
      try { c.disconnect(); } catch { /* nothing to close */ }
      reject(new Error('connected but no frames — retrying'));
    }, 8000);
  }).catch((e) => {
    if (gen === reconnect.generation) reconnect.schedule(e.message);
    throw e;
  });
}

function attach(el, c, d, tun) {
  const stage = root.querySelector('#rd-stage');
  const old = canvasEl;

  stage.appendChild(el);
  client = c;
  tunnel = tun;
  display = d;
  canvasEl = el;

  if (old && old !== el) old.remove();
  clearFreeze();
}

/* ── freeze and swap ──────────────────────────────────────────────────── */

/**
 * Snapshot what is on screen right now into an overlay.
 *
 * The still is what the user looks at while the far side rebuilds. Without it
 * the canvas is destroyed the moment we disconnect and they get black — the
 * original complaint.
 */
function freeze(label) {
  const stage = root.querySelector('#rd-stage');
  const overlay = root.querySelector('#rd-freeze');
  const img = overlay.querySelector('img');

  const source = canvasEl?.querySelector('canvas') || canvasEl;
  if (source?.toDataURL) {
    try {
      img.src = source.toDataURL('image/jpeg', 0.7);
      // Match the still to where the live canvas actually sat, or it jumps.
      img.style.transform = canvasEl.style.transform;
      img.style.transformOrigin = '0 0';
      img.hidden = false;
    } catch {
      // A tainted canvas cannot be read. Fall back to a dim panel rather than
      // failing the switch — a dim panel is still not black.
      img.hidden = true;
    }
  } else {
    img.hidden = true;
  }

  overlay.querySelector('.rd-freeze-label').textContent = label;
  overlay.hidden = false;
  stage.classList.add('is-frozen');
}

function clearFreeze() {
  const overlay = root.querySelector('#rd-freeze');
  const stage = root.querySelector('#rd-stage');
  if (!overlay.hidden) {
    // Cross-fade rather than cut: the still and the new frame are the same
    // desktop a moment apart, and a hard cut reads as a glitch.
    overlay.classList.add('is-fading');
    setTimeout(() => {
      overlay.hidden = true;
      overlay.classList.remove('is-fading');
      overlay.querySelector('img').removeAttribute('src');
    }, 200);
  }
  stage.classList.remove('is-frozen');
}

/**
 * Switch which monitor is streamed, without ever showing black.
 *
 *   freeze  →  server switches (and confirms)  →  new connection built
 *   detached  →  swap on its first real frame  →  cross-fade
 */
async function switchMonitor(monitor) {
  if (!active || monitor.primary) return;

  const previous = state;
  setState('switching', `Switching to ${monitor.name}…`, 'holding the last frame');
  freeze(`switching → ${monitor.name}`);

  // Stop the old session's death handler from scheduling a reconnect: we are
  // deliberately tearing it down and will rebuild it ourselves.
  reconnect.generation += 1;
  reconnect.cancel();

  // Close and WAIT. The far side serves one session at a time, so overlapping
  // the teardown with the next connect gets the new session accepted by guacd
  // and then starved of frames.
  await disconnectAndWait();

  let result;
  try {
    result = await ctx.api(`/devices/${encodeURIComponent(active.id)}/primary`, {
      method: 'POST',
      body: JSON.stringify({ monitor: monitor.name }),
    });
  } catch (e) {
    ctx.toast('err', 'Could not switch monitor', e.message);
    setState(previous === 'connected' ? 'connecting' : previous, 'Recovering…');
    // The far side may or may not have switched; reconnecting resyncs us to
    // whatever is actually true now.
    reconnect.attempt = 0;
    await connect();
    return;
  }

  // The server only answers once the compositor confirmed, so there is no
  // guessing left to do.
  reconnect.attempt = 0;
  await connect();

  if (result?.waitedMs != null) {
    ctx.toast('ok', `Now showing ${monitor.name}`, `switch confirmed in ${result.waitedMs}ms`);
  }
}

/* ── monitors ─────────────────────────────────────────────────────────── */

async function loadMonitors() {
  monitors = [];
  if (!active) return;
  try {
    const r = await ctx.api(`/devices/${encodeURIComponent(active.id)}/monitors`);
    mode = r.mode;
    monitors = r.monitors || [];
  } catch (e) {
    // Not fatal — the stream still works, you just cannot switch. Say so
    // rather than rendering chips that fail when tapped.
    if (mode === 'primary-switch') {
      ctx.toast('warn', 'Monitor switching unavailable', e.message);
    }
  }
  renderControls();
}

/* ── view transform ───────────────────────────────────────────────────── */

function frameSize() {
  const w = display?.getWidth?.() || 0;
  const h = display?.getHeight?.() || 0;
  return { w: w || 1920, h: h || 1080 };
}

/** Where the visible content sits inside the frame — the whole thing, or one monitor. */
function viewportRect() {
  const f = frameSize();
  if (mode === 'multimon' && focused) {
    return { x: focused.x, y: focused.y, w: focused.w, h: focused.h };
  }
  return { x: 0, y: 0, w: f.w, h: f.h };
}

function applyTransform() {
  if (!canvasEl) return;
  const stage = root.querySelector('#rd-stage');
  const box = stage.getBoundingClientRect();
  const r = viewportRect();

  const base = fit === 'contain' || focused
    ? Math.min(box.width / r.w, box.height / r.h)
    : 1;
  const s = base * zoom;

  const tx = (box.width - r.w * s) / 2 - r.x * s + panX;
  const ty = (box.height - r.h * s) / 2 - r.y * s + panY;

  canvasEl.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

function recentre() {
  const r = viewportRect();
  cursorX = Math.round(r.x + r.w / 2);
  cursorY = Math.round(r.y + r.h / 2);
  sendPointer(0);
}

function resetView() {
  zoom = 1; panX = 0; panY = 0;
}

/* ── input ────────────────────────────────────────────────────────────── */

const BTN = { left: 0x01, middle: 0x02, right: 0x04 };

function sendPointer(mask) {
  if (!client) return;
  client.sendMouseState(new Guacamole.Mouse.State(
    cursorX, cursorY,
    !!(mask & 0x01), !!(mask & 0x02), !!(mask & 0x04),
    !!(mask & 0x08), !!(mask & 0x10),
  ));
}

function clickAt(button) {
  sendPointer(BTN[button]);
  setTimeout(() => sendPointer(0), 60);
}

const MOD_KEYSYM = { Control: 0xffe3, Alt: 0xffe9, Shift: 0xffe1, Meta: 0xffeb };
const SPECIAL = {
  Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, Backspace: 0xff08, Delete: 0xffff,
  ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53,
  Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
};

// off → armed (applies to the next key only) → locked (until tapped off).
// Sticky modifiers are the only way to type Ctrl+C on a touchscreen.
const mods = new Map(Object.keys(MOD_KEYSYM).map((m) => [m, 'off']));

function pressKey(keysym) {
  if (!client) return;
  const held = [...mods].filter(([, v]) => v !== 'off').map(([m]) => MOD_KEYSYM[m]);
  for (const k of held) client.sendKeyEvent(1, k);
  client.sendKeyEvent(1, keysym);
  client.sendKeyEvent(0, keysym);
  for (const k of held.reverse()) client.sendKeyEvent(0, k);
  // Armed modifiers fire once and clear; locked ones stay.
  for (const [m, v] of mods) if (v === 'armed') mods.set(m, 'off');
  renderControls();
}

function sendCtrlAltDel() {
  if (!client) return;
  for (const [ks, down] of [[0xffe3, 1], [0xffe9, 1], [0xffff, 1], [0xffff, 0], [0xffe9, 0], [0xffe3, 0]]) {
    client.sendKeyEvent(down, ks);
  }
}

/* ── rendering ────────────────────────────────────────────────────────── */

function shell() {
  return `
  <div class="rd">
    <div class="rd-bar">
      <div class="rd-status" id="rd-state" data-kind="">
        <span class="rd-state-label">Starting…</span>
        <span class="rd-state-detail meta"></span>
        <button class="btn btn--sm" id="rd-retry" hidden>Retry</button>
      </div>
      <div class="rd-controls" id="rd-controls"></div>
    </div>

    <div class="rd-stage" id="rd-stage" tabindex="-1">
      <div class="rd-freeze" id="rd-freeze" hidden>
        <img alt="">
        <span class="rd-freeze-label meta"></span>
      </div>
    </div>

    <div class="rd-keys" id="rd-keys"></div>
  </div>`;
}

/**
 * The device picker is the module's primary navigation, not a chip group that
 * hides itself below two entries. With a dual-boot machine, "which of these is
 * actually up" is the first question every single time.
 */
function renderDevices() {
  const box = root.querySelector('#rd-devices');
  if (!box) return;
  box.innerHTML = devices.map((d) => {
    const dot = d.online === true ? 'dot--ok' : d.online === false ? '' : 'dot--warn';
    const why = d.online === false
      ? (d.error ? `offline — ${d.error}` : 'offline')
      : d.online === null ? 'checking…' : `online · ${d.latencyMs}ms`;
    return `
      <button class="rd-device${active?.id === d.id ? ' on' : ''}"
              data-device="${ctx.esc(d.id)}" aria-pressed="${active?.id === d.id}"
              ${d.online === false ? 'data-offline="1"' : ''}>
        <span class="dot ${dot}"></span>
        <span class="rd-device-name">${ctx.esc(d.name)}</span>
        <span class="rd-device-why meta">${ctx.esc(why)}</span>
      </button>`;
  }).join('');

  box.querySelectorAll('[data-device]').forEach((b) => {
    // An offline device is still clickable: selecting it shows WHY it is
    // unreachable, which is more useful than a control that does nothing.
    b.addEventListener('click', () => selectDevice(b.dataset.device));
  });
}

function renderControls() {
  const box = root.querySelector('#rd-controls');
  if (!box) return;

  const monitorChips = () => {
    if (mode === 'primary-switch' && monitors.length > 1) {
      return `
        <div class="rd-group">
          <span class="label">Screen</span>
          <div class="segctl">
            ${monitors.map((m, i) => `
              <button data-monitor="${ctx.esc(m.name)}" aria-pressed="${m.primary}"
                      title="${ctx.esc(m.name)} · ${m.w}×${m.h}${m.primary ? ' · streaming' : ''}">
                ${i + 1}${m.primary ? '' : ''}
              </button>`).join('')}
          </div>
        </div>`;
    }
    if (mode === 'multimon' && monitors.length > 1) {
      // Local crop — instant, no reconnect, because the stream already
      // contains every screen.
      return `
        <div class="rd-group">
          <span class="label">Screen</span>
          <div class="segctl">
            <button data-focus="" aria-pressed="${!focused}">All</button>
            ${monitors.map((m, i) => `
              <button data-focus="${ctx.esc(m.name)}" aria-pressed="${focused?.name === m.name}">${i + 1}</button>`).join('')}
          </div>
        </div>`;
    }
    return '';
  };

  box.innerHTML = `
    <div class="rd-group rd-group--devices">
      <span class="label">Device</span>
      <div class="rd-devices" id="rd-devices"></div>
    </div>
    ${monitorChips()}
    <div class="rd-group">
      <span class="label">Fit</span>
      <div class="segctl">
        <button data-fit="contain" aria-pressed="${fit === 'contain'}">Fit</button>
        <button data-fit="100" aria-pressed="${fit === '100'}">1:1</button>
      </div>
    </div>
    <div class="rd-group">
      <span class="label">Send</span>
      <div class="segctl">
        <button data-chord="cad" title="Ctrl+Alt+Del">⌃⌥⌦</button>
        <button data-keys="1" aria-pressed="false" title="On-screen keys">⌨</button>
      </div>
    </div>`;

  renderDevices();

  box.querySelectorAll('[data-monitor]').forEach((b) => b.addEventListener('click', () => {
    const m = monitors.find((x) => x.name === b.dataset.monitor);
    if (m) switchMonitor(m);
  }));

  box.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => {
    focused = b.dataset.focus ? monitors.find((m) => m.name === b.dataset.focus) : null;
    resetView();
    applyTransform();
    recentre();
    renderControls();
  }));

  box.querySelectorAll('[data-fit]').forEach((b) => b.addEventListener('click', () => {
    fit = b.dataset.fit;
    resetView();
    applyTransform();
    renderControls();
  }));

  box.querySelector('[data-chord="cad"]')?.addEventListener('click', sendCtrlAltDel);
  box.querySelector('[data-keys]')?.addEventListener('click', () => {
    const keys = root.querySelector('#rd-keys');
    keys.classList.toggle('is-open');
    renderKeys();
  });

  root.querySelector('#rd-retry')?.addEventListener('click', () => {
    reconnect.attempt = 0;
    connect();
  });
}

function renderKeys() {
  const box = root.querySelector('#rd-keys');
  if (!box.classList.contains('is-open')) { box.innerHTML = ''; return; }

  const special = ['Escape', 'Tab', 'Backspace', 'Enter', 'Delete',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
  const label = { Escape: 'Esc', Backspace: '⌫', Enter: '⏎', Delete: 'Del', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn' };

  box.innerHTML = `
    <div class="rd-keyrow">
      ${[...mods.keys()].map((m) => `
        <button class="btn btn--sm${mods.get(m) === 'off' ? ' btn--ghost' : ''}"
                data-mod="${m}" aria-pressed="${mods.get(m) !== 'off'}"
                title="${mods.get(m) === 'armed' ? 'next key only' : mods.get(m) === 'locked' ? 'locked' : ''}">
          ${m === 'Control' ? 'Ctrl' : m === 'Shift' ? '⇧' : m === 'Meta' ? '⌘' : 'Alt'}
        </button>`).join('')}
      <span class="rd-mod-hint meta">tap once = next key · twice = lock</span>
    </div>
    <div class="rd-keyrow">
      ${special.map((k) => `<button class="btn btn--sm btn--ghost" data-key="${k}">${label[k] || k}</button>`).join('')}
    </div>
    <div class="rd-keyrow">
      ${Array.from({ length: 12 }, (_, i) => `<button class="btn btn--sm btn--ghost" data-key="F${i + 1}">F${i + 1}</button>`).join('')}
    </div>
    <div class="rd-keyrow">
      <button class="btn btn--sm" data-click="left">Left click</button>
      <button class="btn btn--sm btn--ghost" data-click="middle">Middle</button>
      <button class="btn btn--sm btn--ghost" data-click="right">Right click</button>
    </div>`;

  box.querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.mod;
    mods.set(m, mods.get(m) === 'off' ? 'armed' : mods.get(m) === 'armed' ? 'locked' : 'off');
    renderKeys();
  }));
  box.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => {
    pressKey(SPECIAL[b.dataset.key]);
    renderKeys();
  }));
  box.querySelectorAll('[data-click]').forEach((b) => b.addEventListener('click', () => clickAt(b.dataset.click)));
}

/* ── device selection ─────────────────────────────────────────────────── */

async function selectDevice(id) {
  const d = devices.find((x) => x.id === id);
  if (!d || active?.id === id) return;

  teardown();
  active = d;
  monitors = [];
  focused = null;
  mode = d.monitors;
  resetView();
  reconnect.attempt = 0;
  renderControls();
  await connect();
}

/* ── pointer + gestures ───────────────────────────────────────────────── */

function wireStage() {
  const stage = root.querySelector('#rd-stage');

  // Absolute pointer: tap where you want to click. A trackpad-style relative
  // cursor is better for precision work but worse for everything else, and
  // the on-screen keys cover the cases where you need a specific button.
  const toRemote = (clientX, clientY) => {
    const box = stage.getBoundingClientRect();
    const r = viewportRect();
    const base = fit === 'contain' || focused
      ? Math.min(box.width / r.w, box.height / r.h)
      : 1;
    const s = base * zoom;
    const tx = (box.width - r.w * s) / 2 - r.x * s + panX;
    const ty = (box.height - r.h * s) / 2 - r.y * s + panY;
    return {
      x: Math.round((clientX - box.left - tx) / s),
      y: Math.round((clientY - box.top - ty) / s),
    };
  };

  stage.addEventListener('pointerdown', (e) => {
    if (!client || e.pointerType === 'touch') return;
    const p = toRemote(e.clientX, e.clientY);
    cursorX = p.x; cursorY = p.y;
    sendPointer(e.button === 2 ? BTN.right : e.button === 1 ? BTN.middle : BTN.left);
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!client || e.pointerType === 'touch') return;
    const p = toRemote(e.clientX, e.clientY);
    cursorX = p.x; cursorY = p.y;
    sendPointer(e.buttons & 1 ? BTN.left : e.buttons & 2 ? BTN.right : e.buttons & 4 ? BTN.middle : 0);
  });
  stage.addEventListener('pointerup', () => sendPointer(0));
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  stage.addEventListener('wheel', (e) => {
    if (!client) return;
    e.preventDefault();
    sendPointer(e.deltaY < 0 ? 0x08 : 0x10);
    setTimeout(() => sendPointer(0), 30);
  }, { passive: false });

  // Touch: tap to click, pinch to zoom, two-finger drag to pan.
  let touchStart = null;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), pinch: null };
    } else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      touchStart = {
        pinch: {
          dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          zoom, panX, panY,
          cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2,
        },
      };
    }
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && touchStart?.pinch) {
      e.preventDefault();
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const cx = (a.clientX + b.clientX) / 2;
      const cy = (a.clientY + b.clientY) / 2;
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, touchStart.pinch.zoom * (dist / touchStart.pinch.dist)));
      panX = touchStart.pinch.panX + (cx - touchStart.pinch.cx);
      panY = touchStart.pinch.panY + (cy - touchStart.pinch.cy);
      applyTransform();
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    // A short single tap with no movement is a click. Anything longer or
    // draggier was a gesture, and clicking on gesture end is how you end up
    // opening things by accident while panning.
    if (touchStart && !touchStart.pinch && e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const moved = Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y);
      if (moved < 10 && Date.now() - touchStart.t < 400) {
        const p = toRemote(t.clientX, t.clientY);
        cursorX = p.x; cursorY = p.y;
        clickAt('left');
      }
    }
    touchStart = null;
  }, { passive: true });

  // Physical keyboard, when there is one.
  const onKeyDown = (e) => {
    if (!client || state !== 'connected') return;
    if (e.metaKey && e.key === 'v') return;      // let the browser paste
    const ks = SPECIAL[e.key] ?? (e.key.length === 1 ? e.key.charCodeAt(0) : null);
    if (ks == null) return;
    e.preventDefault();
    if (e.ctrlKey) client.sendKeyEvent(1, MOD_KEYSYM.Control);
    if (e.altKey) client.sendKeyEvent(1, MOD_KEYSYM.Alt);
    if (e.shiftKey) client.sendKeyEvent(1, MOD_KEYSYM.Shift);
    client.sendKeyEvent(1, ks);
    client.sendKeyEvent(0, ks);
    if (e.shiftKey) client.sendKeyEvent(0, MOD_KEYSYM.Shift);
    if (e.altKey) client.sendKeyEvent(0, MOD_KEYSYM.Alt);
    if (e.ctrlKey) client.sendKeyEvent(0, MOD_KEYSYM.Control);
  };
  window.addEventListener('keydown', onKeyDown);
  ctx.onCleanup(() => window.removeEventListener('keydown', onKeyDown));

  const onResize = () => applyTransform();
  window.addEventListener('resize', onResize);
  ctx.onCleanup(() => window.removeEventListener('resize', onResize));
}

/* ── module contract ──────────────────────────────────────────────────── */

export default {
  async mount(el, context) {
    root = el;
    ctx = context;

    // A module ships its own CSS and injects it once. Scoped by an id so a
    // remount does not stack duplicate stylesheets, and loaded from ctx.base
    // so it resolves whether mounted (/remote/ui/…) or standalone (/ui/…).
    if (!document.getElementById('rd-css')) {
      const link = document.createElement('link');
      link.id = 'rd-css';
      link.rel = 'stylesheet';
      link.href = `${ctx.base}/ui/remote.css`;
      document.head.appendChild(link);
    }

    Guacamole = (await import(`${ctx.base}/guac-js/guacamole-common.js`)).default;

    el.innerHTML = shell();

    devices = (await ctx.api('/devices')).devices || [];
    renderControls();
    wireStage();

    // Presence pushed from the server, so a machine finishing its boot shows
    // up on its own rather than on the next manual refresh.
    ctx.sse('/events', {
      events: {
        devices: ({ devices: next }) => {
          const before = devices.find((d) => d.id === active?.id)?.online;
          devices = next;
          renderDevices();
          const now = devices.find((d) => d.id === active?.id)?.online;

          // A device that just came back should reconnect on its own — that is
          // the entire point of watching presence.
          if (active && before === false && now === true && state !== 'connected') {
            reconnect.attempt = 0;
            connect();
          }
          if (active && now === false && state === 'connected') {
            setState('offline', `${active.name} went offline`, 'the host stopped accepting connections');
          }
        },
      },
    });

    // Prefer something that is actually up.
    const first = devices.find((d) => d.online === true) || devices[0];
    if (!first) {
      setState('failed', 'No devices configured', 'add one to devices.json');
      return;
    }
    // Not awaited: mount() should return as soon as the UI is on screen. A
    // connection can take seconds, and blocking mount on it would leave the
    // shell showing a skeleton the whole time — and would surface a
    // connection failure as a MODULE failure.
    selectDevice(first.id);
  },

  async setView() {
    // One view. Re-applying the transform covers a resize that happened while
    // this module was not the visible one.
    applyTransform();
  },

  async unmount() {
    teardown();
    devices = [];
    active = null;
    monitors = [];
    root = null;
    ctx = null;
  },
};
