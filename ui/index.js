/* ============================================================
   ojee-remote — module UI.

   Two transports behind one screen, because the two operating
   systems genuinely differ and pretending otherwise would mean
   lying to the user about what they can see:

     agent   Linux. A host agent captures ANY monitor through the
             desktop portal and streams H.264, decoded here with
             WebCodecs. Switching re-points the encoder; the
             machine's PRIMARY display is never touched.

     rdp     Windows. guacd streams every monitor in one session
             (multimon), so switching is a client-side crop with
             no round trip at all.

   Design points that are not obvious:

   * The decoder is fed only after a KEYFRAME. H.264 is a delta
     format; starting on a P-frame produces a smear of garbage or
     a decoder error, and both look like "the remote desktop is
     broken" rather than "we joined mid-stream".

   * Switching monitors keeps the LAST FRAME on screen until the
     new one arrives, rather than blanking. The previous build
     blanked and reconnected on a blind timer, which is what the
     black screens were.

   * One reconnect controller. The previous build scheduled from
     four places and they stacked.
   ============================================================ */

let ctx = null;
let root = null;

/* ── state ────────────────────────────────────────────────────────────── */

let devices = [];
let active = null;
let monitors = [];
let activeMonitor = null;
let mode = 'single';

let socket = null;            // agent transport
let decoder = null;
let canvas = null;
let gctx = null;
let waitingKey = true;

let guac = null;              // rdp transport
let guacEl = null;

let focused = null;           // multimon local crop
let fit = 'contain';
let zoom = 1, panX = 0, panY = 0;
const ZOOM_MIN = 1, ZOOM_MAX = 8;

let frameW = 0, frameH = 0;
let stats = { fps: 0, kbps: 0, rttMs: null, decoded: 0 };

/* ── status ───────────────────────────────────────────────────────────── */

const STATE_KIND = {
  connected: 'ok', connecting: 'info', switching: 'info',
  reconnecting: 'warn', offline: 'warn', failed: 'err', unsupported: 'err',
};
let state = 'idle';

function setState(next, label, detail = '') {
  state = next;
  const el = root?.querySelector('#rd-state');
  if (!el) return;
  el.dataset.kind = STATE_KIND[next] || '';
  el.querySelector('.rd-state-label').textContent = label;
  el.querySelector('.rd-state-detail').textContent = detail;
  const retry = root.querySelector('#rd-retry');
  if (retry) retry.hidden = !['failed', 'offline', 'unsupported'].includes(next);
}

/* ── reconnect controller ─────────────────────────────────────────────── */

const reconnect = {
  timer: null, attempt: 0, max: 5, generation: 0,

  schedule(reason) {
    this.cancel();
    if (this.attempt >= this.max) {
      setState('failed', `${active?.name || 'Device'} is not responding`, reason);
      return;
    }
    this.attempt += 1;
    // Capped: uncapped, a machine that has been off for an hour gets hammered
    // the instant it wakes.
    const wait = Math.min(1000 * 2 ** (this.attempt - 1), 15000);
    setState('reconnecting', `Reconnecting (${this.attempt}/${this.max})`,
      `${reason} · retrying in ${Math.round(wait / 1000)}s`);
    this.timer = setTimeout(() => { this.timer = null; connect(); }, wait);
  },

  cancel() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  succeed() { this.cancel(); this.attempt = 0; },
};

/* ── teardown ─────────────────────────────────────────────────────────── */

function teardown() {
  reconnect.generation += 1;
  reconnect.cancel();
  try { socket?.close(); } catch { /* already gone */ }
  socket = null;
  try { decoder?.close(); } catch { /* already closed */ }
  decoder = null;
  try { guac?.disconnect(); } catch { /* already gone */ }
  guac = null;
  guacEl?.remove();
  guacEl = null;
  waitingKey = true;
}

/* ── connect ──────────────────────────────────────────────────────────── */

async function connect() {
  if (!active) return;

  const presence = devices.find((d) => d.id === active.id);
  if (presence?.online === false) {
    teardown();
    setState('offline', `${active.name} is offline`,
      presence.error ? `last probe: ${presence.error}` : 'nothing answered on that host');
    return;
  }

  teardown();
  const gen = ++reconnect.generation;
  setState('connecting', `Connecting to ${active.name}…`);

  if (active.transport === 'agent') return connectAgent(gen);
  return connectRdp(gen);
}

/* ── agent transport (Linux, portal capture) ──────────────────────────── */

async function connectAgent(gen) {
  if (!('VideoDecoder' in window)) {
    // Safari < 16.4, Firefox without the flag. Say which browser feature is
    // missing rather than showing a dead black rectangle.
    setState('unsupported', 'This browser cannot decode the stream',
      'WebCodecs (VideoDecoder) is required — Safari 16.4+, Chrome 94+');
    return;
  }

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Note there is no token here: the gateway proxies this upgrade and attaches
  // the agent's bearer header itself, so the browser never holds it.
  const url = `${wsProto}//${location.host}${ctx.base}/stream?device=${encodeURIComponent(active.id)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  socket = ws;

  let opened = false;

  ws.onopen = () => { opened = true; };

  ws.onclose = (e) => {
    if (gen !== reconnect.generation) return;
    if (state === 'switching') return;   // the switch owns its own recovery
    // 4401/4502 are the gateway's own codes and carry a real reason.
    const why = e.reason || (opened ? 'stream closed' : 'could not open stream');
    reconnect.schedule(why);
  };

  ws.onerror = () => { /* onclose always follows and carries the reason */ };

  ws.onmessage = async (ev) => {
    if (gen !== reconnect.generation) return;

    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      return handleControl(msg, ws, gen);
    }

    if (!decoder || decoder.state !== 'configured') return;
    const buf = new Uint8Array(ev.data);
    const key = (buf[0] & 0x80) !== 0;

    // H.264 is a delta format. Feeding the decoder a P-frame before any
    // keyframe yields garbage or an error, both of which read as "broken".
    if (waitingKey) {
      if (!key) return;
      waitingKey = false;
    }

    try {
      decoder.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: performance.now() * 1000,
        data: buf.subarray(1),
      }));
    } catch (e) {
      // A decoder that has gone bad cannot be recovered in place; ask for a
      // fresh keyframe and reset it.
      waitingKey = true;
      try { decoder.close(); } catch { /* already closed */ }
      decoder = null;
      ws.send(JSON.stringify({ t: 'keyframe' }));
      console.warn('[remote] decoder reset:', e.message);
    }
  };
}

async function handleControl(msg, ws, gen) {
  if (msg.t === 'ping') {
    ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
    return;
  }

  if (msg.t === 'stats') {
    stats = { fps: msg.fps, kbps: msg.bitrateKbps, rttMs: msg.rttMs, decoded: stats.decoded };
    paintStats();
    return;
  }

  if (msg.t === 'error') {
    ctx.toast('err', 'Remote error', msg.detail || '');
    return;
  }

  if (msg.t === 'ready' || msg.t === 'active') {
    monitors = msg.monitors || monitors;
    activeMonitor = msg.active || msg.monitor || activeMonitor;
    mode = active.monitors;
    await configureDecoder(msg.codec || 'avc1.42E01E', msg.w, msg.h, gen);
    reconnect.succeed();
    setState('connected', active.name, activeMonitor || '');
    renderControls();
    clearFreeze();
  }
}

async function configureDecoder(codec, w, h, gen) {
  frameW = w || frameW;
  frameH = h || frameH;

  try { decoder?.close(); } catch { /* already closed */ }
  waitingKey = true;

  ensureCanvas();
  canvas.width = frameW;
  canvas.height = frameH;

  const config = { codec, codedWidth: frameW, codedHeight: frameH, optimizeForLatency: true };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (gen !== reconnect.generation) return;

  if (!support.supported) {
    setState('unsupported', 'This browser cannot decode the stream',
      `${codec} at ${frameW}×${frameH} is not supported here`);
    return;
  }

  decoder = new VideoDecoder({
    output: (frame) => {
      stats.decoded += 1;
      // drawImage then close, every frame. A VideoFrame holds a GPU buffer;
      // failing to close it exhausts the pool within seconds and the stream
      // stops with no error anywhere obvious.
      gctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    },
    error: (e) => {
      console.warn('[remote] decoder error:', e.message);
      waitingKey = true;
    },
  });
  decoder.configure(config);
  applyTransform();
}

function ensureCanvas() {
  const stage = root.querySelector('#rd-stage');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'rd-canvas';
    gctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  }
  if (canvas.parentElement !== stage) stage.appendChild(canvas);
}

/* ── rdp transport (Windows, guacd) ───────────────────────────────────── */

let Guacamole = null;

async function connectRdp(gen) {
  if (!Guacamole) {
    // Loaded lazily and from ctx.base: a static specifier would hardcode the
    // mount point and break standalone.
    Guacamole = (await import(`${ctx.base}/guac-js/guacamole-common.js`)).default;
  }
  if (gen !== reconnect.generation) return;

  const stage = root.querySelector('#rd-stage');
  const dpr = window.devicePixelRatio || 1;

  let token;
  try {
    const r = await ctx.api(
      `/devices/${encodeURIComponent(active.id)}/token`
      + `?width=${Math.round(stage.clientWidth * dpr)}&height=${Math.round(stage.clientHeight * dpr)}`);
    token = r.token;
  } catch (e) {
    if (/offline/i.test(e.message)) {
      setState('offline', `${active.name} is offline`, e.message);
      return;
    }
    reconnect.schedule(e.message);
    return;
  }
  if (gen !== reconnect.generation) return;

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tunnel = new Guacamole.WebSocketTunnel(`${wsProto}//${location.host}${ctx.base}/guac`);
  const client = new Guacamole.Client(tunnel);
  const display = client.getDisplay();
  const el = display.getElement();

  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';
  el.style.transformOrigin = '0 0';

  let dead = false;
  const onDead = (why) => {
    if (dead || gen !== reconnect.generation) return;
    dead = true;
    if (state === 'switching') return;
    reconnect.schedule(why);
  };

  client.onstatechange = (s) => {
    if (s === 3) {
      reconnect.succeed();
      frameW = display.getWidth();
      frameH = display.getHeight();
      setState('connected', active.name, mode === 'multimon' ? 'all monitors' : '');
      loadMonitors().then(renderControls);
      applyTransform();
      clearFreeze();
    } else if (s === 5) onDead('session ended');
  };
  // DISCONNECTED does not fire for tunnel-level closures, so the tunnel is
  // watched too — missing that is why a dead session used to freeze forever.
  tunnel.onstatechange = (s) => { if (s === Guacamole.Tunnel.State.CLOSED) onDead('connection closed'); };
  client.onerror = (e) => onDead(e.message || `guacd error ${e.code}`);
  tunnel.onerror = () => onDead('tunnel error');
  client.onaudio = (stream, mimetype) => Guacamole.AudioPlayer.getInstance(stream, mimetype);
  display.onresize = () => { frameW = display.getWidth(); frameH = display.getHeight(); applyTransform(); };

  guac = client;
  guacEl = el;
  stage.appendChild(el);
  client.connect(`token=${encodeURIComponent(token)}`);
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
    if (active.transport === 'agent') ctx.toast('warn', 'Cannot list monitors', e.message);
  }
}

/**
 * Switch which monitor is shown.
 *
 * agent    one message; the far side re-points its encoder. The previous frame
 *          stays on screen until the new stream produces one.
 * multimon a local crop — no network at all.
 */
async function switchMonitor(name) {
  if (!active || name === activeMonitor) return;

  if (mode === 'multimon') {
    focused = monitors.find((m) => m.name === name) || null;
    activeMonitor = focused ? name : null;
    resetView();
    applyTransform();
    renderControls();
    return;
  }

  if (active.transport !== 'agent' || !socket || socket.readyState !== WebSocket.OPEN) {
    ctx.toast('warn', 'Cannot switch', 'the stream is not connected');
    return;
  }

  setState('switching', `Switching to ${name}…`, 'holding the last frame');
  freeze(`switching → ${name}`);
  waitingKey = true;      // the new monitor starts with its own keyframe
  socket.send(JSON.stringify({ t: 'select', monitor: name }));
}

/* ── freeze overlay ───────────────────────────────────────────────────── */

function freeze(label) {
  const overlay = root.querySelector('#rd-freeze');
  const img = overlay.querySelector('img');
  try {
    // The canvas already holds the last decoded frame, so this is just a copy
    // — no extra decode, no request to the far side.
    if (canvas) { img.src = canvas.toDataURL('image/jpeg', 0.7); img.hidden = false; }
    else img.hidden = true;
  } catch { img.hidden = true; }
  overlay.querySelector('.rd-freeze-label').textContent = label;
  overlay.hidden = false;
}

function clearFreeze() {
  const overlay = root.querySelector('#rd-freeze');
  if (!overlay || overlay.hidden) return;
  overlay.classList.add('is-fading');
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove('is-fading');
    overlay.querySelector('img').removeAttribute('src');
  }, 200);
}

/* ── view transform ───────────────────────────────────────────────────── */

function viewportRect() {
  if (mode === 'multimon' && focused) {
    return { x: focused.x, y: focused.y, w: focused.w, h: focused.h };
  }
  return { x: 0, y: 0, w: frameW || 1920, h: frameH || 1080 };
}

function applyTransform() {
  const el = canvas || guacEl;
  if (!el) return;
  const stage = root.querySelector('#rd-stage');
  const box = stage.getBoundingClientRect();
  const r = viewportRect();

  const base = (fit === 'contain' || focused)
    ? Math.min(box.width / r.w, box.height / r.h)
    : 1;
  const s = base * zoom;
  const tx = (box.width - r.w * s) / 2 - r.x * s + panX;
  const ty = (box.height - r.h * s) / 2 - r.y * s + panY;
  el.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  el.style.transformOrigin = '0 0';
}

const resetView = () => { zoom = 1; panX = 0; panY = 0; };

/* ── input ────────────────────────────────────────────────────────────── */

/** Screen coords → a fraction of the monitor currently shown. */
function toFraction(clientX, clientY) {
  const stage = root.querySelector('#rd-stage');
  const box = stage.getBoundingClientRect();
  const r = viewportRect();
  const base = (fit === 'contain' || focused)
    ? Math.min(box.width / r.w, box.height / r.h)
    : 1;
  const s = base * zoom;
  const tx = (box.width - r.w * s) / 2 - r.x * s + panX;
  const ty = (box.height - r.h * s) / 2 - r.y * s + panY;
  return {
    fx: Math.max(0, Math.min(1, ((clientX - box.left - tx) / s - r.x) / r.w)),
    fy: Math.max(0, Math.min(1, ((clientY - box.top - ty) / s - r.y) / r.h)),
    px: (clientX - box.left - tx) / s,
    py: (clientY - box.top - ty) / s,
  };
}

const send = (msg) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
};

const BTN = ['left', 'middle', 'right'];

function pointerAt(clientX, clientY, buttons = 0) {
  const p = toFraction(clientX, clientY);
  if (active?.transport === 'agent') {
    send({ t: 'pointer', x: p.fx, y: p.fy });
  } else if (guac) {
    guac.sendMouseState(new Guacamole.Mouse.State(
      Math.round(p.px), Math.round(p.py),
      !!(buttons & 1), !!(buttons & 4), !!(buttons & 2), false, false));
  }
}

function buttonAt(clientX, clientY, button, down) {
  pointerAt(clientX, clientY, down ? (button === 2 ? 2 : button === 1 ? 4 : 1) : 0);
  if (active?.transport === 'agent') {
    send({ t: 'button', b: BTN[button] || 'left', down });
  }
}

/* ── keyboard ─────────────────────────────────────────────────────────── */

// Browser KeyboardEvent.code → Linux input-event-codes. The agent injects at
// the uinput layer, which speaks keycodes, not keysyms and not JS key names.
const LINUX_KEY = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7,
  Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Minus: 12, Equal: 13, Backspace: 14,
  Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22,
  KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28,
  ControlLeft: 29, KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35,
  KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41,
  ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  F11: 87, F12: 88,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
  End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  ControlRight: 97, AltRight: 100, MetaLeft: 125, MetaRight: 126,
};

function onKeyDown(e) {
  if (state !== 'connected' || !active) return;
  // Let the browser keep its own clipboard shortcuts.
  if ((e.metaKey || e.ctrlKey) && ['c', 'v', 'x'].includes(e.key.toLowerCase())) return;
  const code = LINUX_KEY[e.code];
  if (code == null) return;
  e.preventDefault();
  send({ t: 'key', code, down: true });
}

function onKeyUp(e) {
  if (state !== 'connected' || !active) return;
  const code = LINUX_KEY[e.code];
  if (code == null) return;
  e.preventDefault();
  send({ t: 'key', code, down: false });
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
    <div class="rd-stage" id="rd-stage" tabindex="0">
      <div class="rd-freeze" id="rd-freeze" hidden>
        <img alt=""><span class="rd-freeze-label meta"></span>
      </div>
    </div>
    <div class="rd-foot">
      <span class="meta" id="rd-stats"></span>
      <span class="meta rd-hint">click to focus · type to send keys</span>
    </div>
  </div>`;
}

function paintStats() {
  const el = root?.querySelector('#rd-stats');
  if (!el) return;
  if (state !== 'connected') { el.textContent = ''; return; }
  const bits = [];
  if (frameW) bits.push(`${frameW}×${frameH}`);
  if (stats.fps) bits.push(`${stats.fps} fps`);
  if (stats.kbps) bits.push(`${stats.kbps} kbps`);
  if (stats.rttMs != null) bits.push(`${stats.rttMs} ms`);
  el.textContent = bits.join(" · ");
}

function renderDevices() {
  const box = root.querySelector('#rd-devices');
  if (!box) return;
  box.innerHTML = devices.map((d) => {
    const dot = d.online === true ? 'dot--ok' : d.online === false ? '' : 'dot--warn';
    const why = d.online === false ? (d.error ? `offline — ${d.error}` : 'offline')
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
    // An offline device stays clickable: selecting it explains WHY, which
    // beats a control that silently does nothing.
    b.addEventListener('click', () => selectDevice(b.dataset.device));
  });
}

function renderControls() {
  const box = root.querySelector('#rd-controls');
  if (!box) return;

  const chips = monitors.length > 1 ? `
    <div class="rd-group">
      <span class="label">Screen</span>
      <div class="segctl">
        ${mode === 'multimon' ? `<button data-monitor="" aria-pressed="${!focused}">All</button>` : ''}
        ${monitors.map((m, i) => `
          <button data-monitor="${ctx.esc(m.name)}"
                  aria-pressed="${(mode === 'multimon' ? focused?.name : activeMonitor) === m.name}"
                  title="${ctx.esc(m.name)} · ${m.w}×${m.h}">${i + 1}</button>`).join('')}
      </div>
    </div>` : '';

  box.innerHTML = `
    <div class="rd-group rd-group--devices">
      <span class="label">Device</span>
      <div class="rd-devices" id="rd-devices"></div>
    </div>
    ${chips}
    <div class="rd-group">
      <span class="label">Fit</span>
      <div class="segctl">
        <button data-fit="contain" aria-pressed="${fit === 'contain'}">Fit</button>
        <button data-fit="100" aria-pressed="${fit === '100'}">1:1</button>
      </div>
    </div>`;

  renderDevices();
  box.querySelectorAll('[data-monitor]').forEach((b) => b.addEventListener('click', () => {
    if (!b.dataset.monitor) { focused = null; activeMonitor = null; resetView(); applyTransform(); renderControls(); return; }
    switchMonitor(b.dataset.monitor);
  }));
  box.querySelectorAll('[data-fit]').forEach((b) => b.addEventListener('click', () => {
    fit = b.dataset.fit; resetView(); applyTransform(); renderControls();
  }));
  root.querySelector('#rd-retry')?.addEventListener('click', () => {
    reconnect.attempt = 0;
    connect();
  });
}

async function selectDevice(id) {
  const d = devices.find((x) => x.id === id);
  if (!d || active?.id === id) return;
  teardown();
  active = d;
  monitors = [];
  activeMonitor = null;
  focused = null;
  mode = d.monitors;
  frameW = frameH = 0;
  resetView();
  reconnect.attempt = 0;
  renderControls();
  await connect();
}

/* ── stage wiring ─────────────────────────────────────────────────────── */

function wireStage() {
  const stage = root.querySelector('#rd-stage');

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    stage.focus();
    stage.setPointerCapture(e.pointerId);
    buttonAt(e.clientX, e.clientY, e.button, true);
  });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointerAt(e.clientX, e.clientY, e.buttons);
  });
  stage.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') return;
    buttonAt(e.clientX, e.clientY, e.button, false);
  });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (active?.transport === 'agent') send({ t: 'scroll', dy: e.deltaY < 0 ? 1 : -1 });
  }, { passive: false });

  // Touch: tap to click, pinch to zoom, two-finger drag to pan.
  let touch = null;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), pinch: null };
    } else if (e.touches.length === 2) {
      const [a, b] = e.touches;
      touch = { pinch: {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        zoom, panX, panY,
        cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2,
      } };
    }
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !touch?.pinch) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, touch.pinch.zoom * (dist / touch.pinch.dist)));
    panX = touch.pinch.panX + ((a.clientX + b.clientX) / 2 - touch.pinch.cx);
    panY = touch.pinch.panY + ((a.clientY + b.clientY) / 2 - touch.pinch.cy);
    applyTransform();
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    // A short, still tap is a click. Anything longer or draggier was a
    // gesture — clicking on gesture end is how you open things by accident
    // while panning.
    if (touch && !touch.pinch && e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const moved = Math.hypot(t.clientX - touch.x, t.clientY - touch.y);
      if (moved < 10 && Date.now() - touch.t < 400) {
        buttonAt(t.clientX, t.clientY, 0, true);
        setTimeout(() => buttonAt(t.clientX, t.clientY, 0, false), 60);
      }
    }
    touch = null;
  }, { passive: true });

  stage.addEventListener('keydown', onKeyDown);
  stage.addEventListener('keyup', onKeyUp);

  const onResize = () => applyTransform();
  window.addEventListener('resize', onResize);
  ctx.onCleanup(() => window.removeEventListener('resize', onResize));
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

    mountEl.innerHTML = shell();
    wireStage();

    devices = (await ctx.api('/devices')).devices || [];
    renderControls();

    ctx.sse('/events', {
      events: {
        devices: ({ devices: next }) => {
          const before = devices.find((d) => d.id === active?.id)?.online;
          devices = next;
          renderDevices();
          const now = devices.find((d) => d.id === active?.id)?.online;
          // A machine that finished booting should come back on its own —
          // that is the entire point of watching presence.
          if (active && before === false && now === true && state !== 'connected') {
            reconnect.attempt = 0;
            connect();
          }
          if (active && now === false && state === 'connected') {
            setState('offline', `${active.name} went offline`, 'the host stopped answering');
          }
        },
      },
    });

    const first = devices.find((d) => d.online === true) || devices[0];
    if (!first) {
      setState('failed', 'No devices configured', 'add one to devices.json');
      return;
    }
    // Not awaited: mount() should return once the UI is on screen. Blocking on
    // a connection would surface a CONNECTION failure as a MODULE failure and
    // let the host replace this UI with its generic error panel.
    selectDevice(first.id);
  },

  async setView() {
    applyTransform();
  },

  async unmount() {
    teardown();
    devices = [];
    active = null;
    monitors = [];
    canvas = null;
    gctx = null;
    root = null;
    ctx = null;
  },
};

