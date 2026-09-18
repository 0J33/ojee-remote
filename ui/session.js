/* ============================================================
   ojee-remote — the fullscreen session.

   A faithful port of the original rdp.ojee.net client, restyled
   onto the design system. The rewrite I did before dropped most
   of what made that app usable, and it should not have: this is
   the version that worked.

   What comes back with it:

   * A TRACKPAD, not absolute touch. The finger moves the remote
     cursor relatively — Chrome-Remote-Desktop semantics — so you
     do not have to land your thumb exactly on a 12px close box.
     Tap = left, long-press = right, tap-then-drag = drag-select,
     two fingers = scroll or pinch.
   * L / M / R click buttons. A phone has no right mouse button;
     without these, half a desktop is unreachable.
   * Modifiers that LATCH in three states: off, armed (one-shot,
     clears after the next key) and locked. You cannot hold Ctrl
     and tap C on a touchscreen.
   * Ctrl+Alt+Del, the full navigation key row, and F1–F12.
   * Hide/reveal, so the remote screen can own the whole display.
   * visualViewport handling: when the on-screen keyboard opens,
     the view slides up just enough to keep the pointer above it,
     at the same zoom, and slides back when it closes.

   Transport-agnostic by design. `client` is a small interface —
   fbSize, sendMouseFb, sendKey, sendCtrlAltDel, disconnect — so
   the same interaction model drives guacd and the H.264 agent
   without knowing which it is talking to.
   ============================================================ */

import Guacamole from '../guac-js/guacamole-common.js';
import { hudMarkup } from './session-hud.js';
import { connectAgent, canUseWebCodecs, canUseMse } from './agent-transport.js';

/**
 * Mount the fullscreen session into `host` and connect to `deviceId`.
 *
 * @param {object}   o
 * @param {Element}  o.host      where the session renders
 * @param {object}   o.ctx       the module context (api, sse, toast, esc…)
 * @param {string}   o.deviceId  which device to open
 * @param {Function} o.onExit    called when the user leaves the session
 * @returns {Function} teardown
 */
export function startSession({ host, ctx: context, deviceId, onExit }) {
  const root = host;
  const ctx = context;
  root.innerHTML = hudMarkup();


  // ── DOM ───────────────────────────────────────────────────────────────
  const screenEl = root.querySelector('#rd-screen');
  const statusEl = root.querySelector('#rd-status');
  const devicesEl = root.querySelector('#rd-devices');
  const monitorsEl = root.querySelector('#rd-monitors');
  const hudTop = root.querySelector('#rd-hud-top');
  const hudBottom = root.querySelector('#rd-hud-bottom');
  const reveal = root.querySelector('#rd-reveal');

  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';

  // ── state ─────────────────────────────────────────────────────────────
  // `client` is the protocol-agnostic adapter the input/view code talks to.
  // It wraps either noVNC (VNC devices) or guacamole-common-js (RDP devices):
  //   { kind, el, fbSize(), sendMouseFb(x, y, mask), sendKey(keysym, code, down),
  //     sendCtrlAltDel(), disconnect() }
  // Mouse coords are always FRAMEBUFFER pixels; each adapter converts as needed.
  let client = null;
  let rfb = null;   // set only while a VNC device is active (noVNC internals)
  let devices = [];                // [{ id, name, local, hasPassword }]
  let activeDevice = null;         // device obj
  let monitors = [];
  let activeFit = 'contain';       // 'contain' | '100'
  let focusedMonitor = null;       // monitor obj | null (= "All")
  let cursorX = 0, cursorY = 0;    // remote-pixel coords for the trackpad cursor

  // Client-side view zoom on top of the base fit/focus transform. Pinch changes
  // viewZoom; two-finger drag while zoomed changes viewTx/viewTy. All in screen
  // pixels of the #screen container. viewZoom == 1 && tx/ty == 0 → base view.
  let viewZoom = 1;
  let viewTx = 0, viewTy = 0;

  // On-screen keyboard: how far the view is slid up to keep the pointer above
  // it, and the screen size the fit was computed for before it opened.
  let kbdOpen = false;
  let kbdShift = 0;
  let frozenView = null;
  const VIEW_ZOOM_MIN = 1;
  const VIEW_ZOOM_MAX = 8;

  // Modifier state machine: 'off' → 'armed' (next key only) → 'locked' (until tapped off)
  const MOD_NAMES = ['Control', 'Alt', 'Shift', 'Meta'];
  const modState = new Map(MOD_NAMES.map((m) => [m, 'off']));

  // X11 keysyms — used by sendKey (noVNC translates them to RFB key events).
  const MOD_KEYSYM = {
    Control: 0xffe3, Alt: 0xffe9, Shift: 0xffe1, Meta: 0xffeb, // _L variants
  };
  const MOD_CODE = {
    Control: 'ControlLeft', Alt: 'AltLeft', Shift: 'ShiftLeft', Meta: 'MetaLeft',
  };
  const SPECIAL_KEYSYM = {
    Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, Backspace: 0xff08, Delete: 0xffff,
    ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53,
    Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
    F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
    F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  };

  // Mouse button bitmask bits (per RFB spec).
  const BTN_LEFT = 0x01, BTN_MIDDLE = 0x02, BTN_RIGHT = 0x04;

  /* guacd reports failures as numeric statuses. Passed through raw they read
     as "rdp error: 519", which tells you nothing; named, they usually tell you
     the whole story — 519 is "nothing is listening on that port", which for a
     laptop means it is off, asleep, or its RDP server is not running. */
  const GUAC_STATUS = {
    256: 'the host closed the session',
    512: 'the remote desktop server hit an error',
    513: 'the host is too busy to accept a session',
    514: 'the host stopped responding',
    515: 'the remote desktop server failed',
    516: 'that session no longer exists',
    517: 'the host is already in a conflicting session',
    518: 'the session was closed on the host',
    519: 'nothing is listening for RDP on that host — it may be off, asleep, or its remote desktop is disabled',
    520: 'the host refused the connection',
    521: 'someone else is already connected to that session',
    522: 'the session timed out',
    523: 'the session was closed',
    768: 'the host rejected the connection request',
    769: 'the host refused these credentials',
    771: 'the host refused access to this session',
    776: 'the host gave up waiting',
    797: 'too many connections to that host',
  };

  function guacReason(e) {
    const code = typeof e === 'object' ? (e.code ?? e.status) : e;
    const named = GUAC_STATUS[code];
    if (named) return named;
    const msg = (typeof e === 'object' && (e.message || e.reason)) || '';
    return msg || `the connection failed (${code ?? 'unknown'})`;
  }

  // ── status helpers ────────────────────────────────────────────────────
  function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  }

  // ── connection ────────────────────────────────────────────────────────
  let reconnectTimer = null;
  let userSwitchedDevice = false;  // prevents the auto-reconnect after a manual switch
  let rdpGeneration = 0;           // invalidates stale RDP death handlers after reconnects

  /* Retrying is for a connection that was interrupted. It is NOT a way to fix
     a host that is locked, asleep, or refusing the protocol — those fail the
     same way every time, and dialling again on a 1.5s timer forever produces
     the thing this replaces: a session that says "reconnecting…" indefinitely
     and never explains why. Six tries over about a minute, then stop and say
     what happened, with the action that actually fixes it. */
  const MAX_ATTEMPTS = 6;
  const BACKOFF_MS = [1500, 3000, 6000, 10000, 15000, 20000];
  let attempts = 0;
  let lastReason = '';        // the real one, kept because onDead overwrites the status

  function connectionOk() {
    attempts = 0;
    lastReason = '';
    hideBlocker();
  }

  function scheduleReconnect(why) {
    if (why) lastReason = why;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (userSwitchedDevice) { userSwitchedDevice = false; return; }

    if (attempts >= MAX_ATTEMPTS) { giveUp(); return; }
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    attempts += 1;
    setStatus(`reconnecting ${attempts}/${MAX_ATTEMPTS}${lastReason ? ` · ${lastReason}` : ''}`, 'err');
    reconnectTimer = setTimeout(connect, delay);
  }

  /** Ask the host whether its screen is locked. Never throws: this runs while
      something is already going wrong, and a failed diagnosis must not become
      the error being reported. */
  async function lockState() {
    try {
      return await ctx.api(`/devices/${encodeURIComponent(activeDevice.id)}/lock`);
    } catch {
      return null;
    }
  }

  async function giveUp() {
    setStatus(lastReason || 'cannot connect', 'err');
    const lock = await lockState();
    if (lock?.locked) {
      showBlocker({
        title: `${activeDevice.name} is locked`,
        detail: 'Its screen is locked, which is why the session will not open. '
              + 'Unlocking does not need the password — reaching this page already proved who you are.',
        actions: [
          { label: 'Unlock and connect', primary: true, run: unlockAndConnect },
          { label: 'Try again', run: retryNow },
        ],
      });
      return;
    }
    showBlocker({
      title: `Cannot reach ${activeDevice.name}`,
      detail: (lastReason || 'the host did not accept the connection')
            + (lock && lock.locked === false ? ' · its screen is not locked, so that is not the reason' : ''),
      actions: [
        { label: 'Try again', primary: true, run: retryNow },
        { label: 'Leave', run: () => onExit?.() },
      ],
    });
  }

  function retryNow() {
    attempts = 0;
    hideBlocker();
    connect();
  }

  async function unlockAndConnect() {
    setStatus('unlocking…');
    try {
      const r = await ctx.api(`/devices/${encodeURIComponent(activeDevice.id)}/unlock`,
        { method: 'POST' });
      if (r && r.ok === false) throw new Error(r.error || 'the screen stayed locked');
      ctx.toast?.('ok', 'Unlocked', `${activeDevice.name} is unlocked.`);
      retryNow();
    } catch (e) {
      ctx.toast?.('err', 'Could not unlock', e.message);
      setStatus(`could not unlock: ${e.message}`, 'err');
    }
  }

  // ── the blocker ───────────────────────────────────────────────────────
  /* A status chip is thirty characters wide and holds no buttons. When the
     session has stopped trying, what is needed is the reason and the way out,
     in the middle of the screen where the picture used to be. */
  let blockerEl = null;

  function hideBlocker() {
    blockerEl?.remove();
    blockerEl = null;
  }

  function showBlocker({ title, detail, actions = [] }) {
    hideBlocker();
    blockerEl = document.createElement('div');
    blockerEl.className = 'rs-blocker';
    const card = document.createElement('div');
    card.className = 'rs-blocker-card';

    const h = document.createElement('h2');
    h.className = 'rs-blocker-title';
    h.textContent = title;
    card.appendChild(h);

    const p = document.createElement('p');
    p.className = 'rs-blocker-detail';
    p.textContent = detail;
    card.appendChild(p);

    const row = document.createElement('div');
    row.className = 'rs-blocker-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `rs-blocker-btn${a.primary ? ' is-primary' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', () => a.run());
      row.appendChild(b);
    }
    card.appendChild(row);
    blockerEl.appendChild(card);
    // Into .rs, not the host element: .rs is the positioned, fixed-inset
    // ancestor, and `position: absolute` against an unpositioned host would
    // anchor the overlay to the page instead of the session.
    (root.querySelector('.rs') || root).appendChild(blockerEl);
  }

  async function connect() {
    if (!activeDevice) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setStatus(`connecting to ${activeDevice.name}…`);
    // An agent device streams the whole desktop as H.264 - the only path that
    // can show every monitor, switch between them without moving the primary
    // display, and let the pointer cross screens. Decoded by WebCodecs where
    // that genuinely works, by a <video> through Media Source on iOS, and only
    // failing both does it drop to guacd, which shows the primary monitor.
    const forced = new URLSearchParams(location.search).get('rdtransport');
    if (activeDevice.transport === 'agent' && activeDevice.hasAgent && !agentUnusable) {
      if (forced !== 'rdp' && forced !== 'mse' && canUseWebCodecs()) return connectAgentSession('webcodecs');
      if (forced !== 'rdp' && canUseMse()) return connectAgentSession('mse');
    }
    if (activeDevice.transport === 'agent' && !activeDevice.hasFallback) {
      setStatus('this browser cannot decode the stream', 'err');
      return;
    }
    return connectRdp();
  }

  let agentUnusable = false;       // set once this browser proves it cannot decode

  function connectAgentSession(mode) {
    const url = `${wsProto}//${location.host}${ctx.base}/stream?device=${encodeURIComponent(activeDevice.id)}`;
    const myGen = ++rdpGeneration;
    let opened = false;
    const adapter = connectAgent({
      url,
      mode,
      onOpen: () => { opened = true; },
      onLayout: (layout) => {
        if (myGen !== rdpGeneration) return;
        const shared = layout.monitors.filter((m) => m.capturable).length;
        const total = layout.monitors.length;
        const what = layout.active === 'desktop'
          ? (shared < total ? `desktop · ${shared} of ${total} monitors shared` : 'desktop')
          : (layout.active || '');
        connectionOk();
        setStatus(`connected · ${activeDevice.name}${what ? ' · ' + what : ''}`, 'ok');
        const firstLayout = !monitors.length;
        loadMonitors();
        // A focused monitor that vanished (unplugged) cannot stay focused.
        if (focusedMonitor && !monitors.some((m) => m.name === focusedMonitor.name)) focusedMonitor = null;
        else if (focusedMonitor) focusedMonitor = monitors.find((m) => m.name === focusedMonitor.name);
        if (firstLayout) recenterCursor();
        clampCursor();
        applyFitOrFocus();
      },
      onClose: (why) => {
        if (myGen !== rdpGeneration) return;
        if (userSwitchedDevice) { userSwitchedDevice = false; return; }
        scheduleReconnect(opened ? why : `cannot reach the host agent (${why})`);
      },
      onFailure: (detail) => {
        if (myGen !== rdpGeneration) return;
        console.warn('[remote] agent transport failed:', detail);
        // Try the other decode path before giving up on the agent entirely.
        adapter.disconnect();
        if (mode === 'webcodecs' && canUseMse()) {
          setStatus('switching decoder…');
          connectAgentSession('mse');
          return;
        }
        agentUnusable = true;
        if (activeDevice.hasFallback) {
          ctx.toast?.('info', 'Switching transport', 'This browser could not decode the video stream; using the canvas path.');
          connectRdp();
        } else {
          setStatus(`cannot decode the stream: ${detail}`, 'err');
        }
      },
      onError: (detail) => ctx.toast?.('err', 'Remote', detail),
    });

    screenEl.innerHTML = '';
    screenEl.appendChild(adapter.el);
    screenEl.appendChild(cursorEl);
    client = adapter;
    drawCursor();
  }

  // The agent's frames carry no pointer: on an X11 session mutter's screencast
  // leaves the cursor out even when asked to embed it. guacd drew its own
  // cursor layer; here the session draws one where the pointer was last SENT
  // (already clamped onto a real screen), so it never lags the video and a
  // trackpad user can always see what a tap will hit.
  const cursorEl = document.createElement('div');
  cursorEl.className = 'rd-cursor';
  cursorEl.setAttribute('aria-hidden', 'true');
  cursorEl.innerHTML = '<svg viewBox="0 0 16 24" width="12" height="18"><path d="M1 1v19.5l4.8-4.6 3.1 7.1 3.2-1.4-3.1-7H15.5z" fill="#000" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';

  function drawCursor() {
    if (client?.kind !== 'agent') { cursorEl.hidden = true; return; }
    const v = viewTransform();
    const x = v.tx + cursorX * v.s;
    const y = v.ty + cursorY * v.s;
    cursorEl.style.transform = `translate(${x}px, ${y}px)`;
    cursorEl.hidden = false;
  }

  /* connectVnc() removed.

     It fetched /api/devices/:id/credentials, which handed a VNC password to the
     browser in cleartext JSON. Every device now connects through guacd, whose
     credentials are encrypted into a connection token the client cannot read,
     or through the H.264 agent. Nothing is lost: guacd speaks VNC too. */

  async function connectRdp() {
    let token = '';
    try {
      // Ask for the token at the size we will actually display, so guacd
      // negotiates a framebuffer that fits rather than one we then scale.
      const dpr = window.devicePixelRatio || 1;
      const q = `?width=${Math.round(window.innerWidth * dpr)}`
              + `&height=${Math.round(window.innerHeight * dpr)}`;
      token = (await ctx.api(
        `/devices/${encodeURIComponent(activeDevice.id)}/token${q}`)).token;
    } catch (e) {
      scheduleReconnect(`token fetch failed: ${e.message}`);
      return;
    }

    const tunnel = new Guacamole.WebSocketTunnel(`${wsProto}//${location.host}${ctx.base}/guac`);
    const gc = new Guacamole.Client(tunnel);
    const display = gc.getDisplay();
    const el = display.getElement();

    screenEl.innerHTML = '';
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.transformOrigin = '0 0';
    screenEl.appendChild(el);

    client = {
      kind: 'rdp',
      el,
      fbSize: () => ({ w: display.getWidth() || 0, h: display.getHeight() || 0 }),
      sendMouseFb: (fbX, fbY, mask) => {
        gc.sendMouseState(new Guacamole.Mouse.State(
          fbX, fbY,
          !!(mask & 0x01),   // left
          !!(mask & 0x02),   // middle
          !!(mask & 0x04),   // right
          !!(mask & 0x08),   // wheel up
          !!(mask & 0x10),   // wheel down
        ));
      },
      sendKey: (keysym, _code, down) => gc.sendKeyEvent(down ? 1 : 0, keysym),
      sendCtrlAltDel: () => {
        const seq = [[0xffe3, 1], [0xffe9, 1], [0xffff, 1], [0xffff, 0], [0xffe9, 0], [0xffe3, 0]];
        for (const [ks, down] of seq) gc.sendKeyEvent(down, ks);
      },
      disconnect: () => { try { gc.disconnect(); } catch {} },
    };

    // Single death path, fired at most once per connection generation. The
    // client's DISCONNECTED state does NOT fire on tunnel-level closures (e.g.
    // the server closing the WebSocket), so we watch the tunnel too — missing
    // that was why a dead session froze on its last frame with no reconnect.
    const myGen = ++rdpGeneration;
    let deadHandled = false;
    // guacd says WHY on the error channel and then closes the tunnel, which
    // used to overwrite the reason with a bare "reconnecting…" a frame later.
    let lastGuacError = '';
    const onDead = () => {
      if (deadHandled || myGen !== rdpGeneration) return;
      deadHandled = true;
      scheduleReconnect(lastGuacError);
    };

    gc.onstatechange = async (state) => {
      // 3 = CONNECTED, 5 = DISCONNECTED (Guacamole.Client state constants)
      if (state === 3) {
        connectionOk();
        setStatus(`connected · ${activeDevice.name}`, 'ok');
        await loadMonitors();
        recenterCursor();
        applyFitOrFocus();
      } else if (state === 5) {
        onDead();
      }
    };
    tunnel.onstatechange = (s) => {
      if (s === Guacamole.Tunnel.State.CLOSED) onDead();
    };
    gc.onerror = (e) => {
      lastGuacError = guacReason(e);
      setStatus(lastGuacError, 'err');
    };
    tunnel.onerror = () => onDead();
    display.onresize = () => applyFitOrFocus();
    // Remote audio (g-r-d streams RDP audio; L16 PCM plays via Web Audio).
    gc.onaudio = (stream, mimetype) => Guacamole.AudioPlayer.getInstance(stream, mimetype);

    const dpr = window.devicePixelRatio || 1;
    gc.connect(
      `token=${encodeURIComponent(token)}` +
      `&width=${Math.round(screenEl.clientWidth * dpr)}` +
      `&height=${Math.round(screenEl.clientHeight * dpr)}&dpi=96`,
    );
  }

  async function loadMonitors() {
    if (!activeDevice) return;
    // An agent session already knows the layout: the stream carries it, in
    // desktop coordinates, and updates it when monitors are plugged or moved.
    if (client?.kind === 'agent') {
      const l = client.layout;
      monitors = l && l.active === 'desktop' ? l.monitors : [];
      renderMonitorChips();
      return;
    }
    monitors = [];
    // A guacd session to an agent-capable host streams whichever monitor is
    // primary, and switching would mean moving the primary display - which is
    // exactly what the agent exists to avoid. No chips rather than chips that fail.
    if (activeDevice.monitors !== 'primary-switch') {
      renderMonitorChips();
      return;
    }
    // `local` in the original meant "the machine the gateway runs on", which
    // was the only one whose monitors it could enumerate. That job belongs to
    // the host agent now, so the question is whether the device HAS one —
    // and it is asked regardless of which transport is streaming, because
    // switching the primary display works either way.
    if (!activeDevice.hasAgent) {
      renderMonitorChips();
      return;
    }
    try {
      const r = { ok: true, json: async () => ctx.api(
        `/devices/${encodeURIComponent(activeDevice.id)}/monitors`) };
      monitors = (await r.json()).monitors || [];
    } catch {
      /* keep empty */
    }
    renderMonitorChips();
  }

  // The original used this to tell an RDP session (one merged framebuffer,
  // monitors switched server-side) from a VNC one (a framebuffer per screen).
  // Every session is the former now.
  const isRdp = () => client?.kind === 'rdp';

  function renderMonitorChips() {
    monitorsEl.innerHTML = '';
    if (monitors.length <= 1) {
      root.querySelector('#rd-monitors-group').hidden = true;
      return;
    }
    root.querySelector('#rd-monitors-group').hidden = false;

    // RDP mirrors ONE monitor (gnome-remote-desktop is primary-only), so the
    // chips pick which monitor the server streams — no "All" merged view and
    // no client-side cropping. VNC devices keep the original crop behavior.
    if (isRdp()) {
      monitors.forEach((m, i) => {
        const b = document.createElement('button');
        b.className = 'rs-chip' + (m.primary ? ' on' : '');
        b.textContent = String(i + 1);
        b.title = `${m.name}  ${m.w}×${m.h}` + (m.primary ? '  (streaming)' : '');
        b.onclick = () => switchPrimary(m);
        monitorsEl.appendChild(b);
      });
      return;
    }

    const allBtn = document.createElement('button');
    allBtn.className = 'rs-chip' + (focusedMonitor === null ? ' on' : '');
    allBtn.textContent = 'All';
    allBtn.onclick = () => focusMonitor(null);
    monitorsEl.appendChild(allBtn);

    // Numbered left to right, the way they sit on the desk.
    const ordered = [...monitors].sort((a, b) => (a.x - b.x) || (a.y - b.y));
    ordered.forEach((m, i) => {
      const b = document.createElement('button');
      b.className = 'rs-chip' + (focusedMonitor && focusedMonitor.name === m.name ? ' on' : '')
        + (m.capturable === false ? ' rd-unshared' : '');
      b.textContent = m.primary ? `${i + 1}★` : String(i + 1);
      b.title = `${m.name}  ${m.w}×${m.h}  @${m.x},${m.y}`
        + (m.capturable === false ? '  - not shared: re-share on the host to see it' : '');
      // An unshared monitor is still part of the desk - the pointer can go
      // there and focusing it shows where it is - it just renders black.
      b.onclick = () => focusMonitor(m);
      monitorsEl.appendChild(b);
    });

    if (client?.kind === 'agent' && monitors.some((m) => m.capturable === false)) {
      const r = document.createElement('button');
      r.className = 'rs-chip rd-reshare';
      r.textContent = 'Re-share';
      r.title = 'Ask the host to share every monitor. Someone at the machine has to accept the prompt.';
      r.onclick = regrant;
      monitorsEl.appendChild(r);
    }
  }

  async function regrant() {
    setStatus('waiting for the host to accept the share prompt…');
    ctx.toast?.('info', 'Re-share requested',
      'A screen-share prompt is open on the host. Tick every monitor there and allow it.');
    try {
      await ctx.api(`/devices/${encodeURIComponent(activeDevice.id)}/regrant`, { method: 'POST' });
      // The agent rebuilds its capture; reconnect so the stream picks it up.
      client?.disconnect();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 800);
    } catch (e) {
      setStatus(`re-share failed: ${e.message}`, 'err');
    }
  }

  // RDP monitor switch: ask the server to make this monitor GNOME-primary.
  // g-r-d drops the session on the change; the disconnect handler's auto-
  // reconnect (1.5s) lands on the newly-streamed monitor and refreshes chips.
  async function switchPrimary(m) {
    if (m.primary) return;
    setStatus(`switching to ${m.name}…`);
    try {
        // The gateway does not return until the host confirms the compositor
        // applied the change, so there is nothing to poll for here.
        await ctx.api(`/devices/${encodeURIComponent(activeDevice.id)}/primary`, {
          method: 'POST',
          body: JSON.stringify({ monitor: m.name }),
        });
    } catch (e) {
      setStatus(`switch failed: ${e.message}`, 'err');
      return;
    }
    // Don't rely on g-r-d dropping the session (it may already be dead, or the
    // drop may race the switch): force our own reconnect deterministically.
    client?.disconnect();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1200);
  }

  function focusMonitor(m) {
    focusedMonitor = m;
    resetView();
    renderMonitorChips();
    applyFitOrFocus();
    // Always snap the cursor to a known-good spot. For a focused monitor that's
    // its centre; for "All" it's the centre of the merged framebuffer. Without
    // this, switching back to All can strand the cursor at (0,0) when noVNC
    // hadn't populated _fbWidth at the time of the connect event.
    recenterCursor();
  }

  // Derive the merged framebuffer size. Prefer what noVNC reports; fall back to
  // xrandr's monitor list (covers the case where _fbWidth/_fbHeight haven't been
  // populated yet — which is what made the trackpad feel broken in All mode).
  function fbDims() {
    const size = client?.fbSize() || { w: 0, h: 0 };
    let w = size.w;
    let h = size.h;
    // The monitor-span fallback only makes sense for VNC, where the stream IS
    // the merged layout. An RDP stream is a single monitor — deriving 4920×1920
    // from xrandr would wildly mis-scale it while the display size settles.
    if ((!w || !h) && monitors.length && !isRdp()) {
      for (const m of monitors) {
        w = Math.max(w, m.x + m.w);
        h = Math.max(h, m.y + m.h);
      }
    }
    return { w: w || 1920, h: h || 1080 };
  }

  function recenterCursor() {
    if (focusedMonitor) {
      const m = focusedMonitor;
      cursorX = m.x + Math.floor(m.w / 2);
      cursorY = m.y + Math.floor(m.h / 2);
    } else {
      const d = fbDims();
      cursorX = Math.floor(d.w / 2);
      cursorY = Math.floor(d.h / 2);
    }
    clampCursor();
    sendPointer(0);
  }

  // Base transform: what CSS `translate(...) scale(...)` on the canvas is needed
  // to render the current view mode (fit / 1:1 / focused monitor) at viewZoom=1.
  function baseTransform() {
    // While the on-screen keyboard is up, fit to the screen as it was before it
    // opened: the keyboard covers the desk, it does not make the desk smaller.
    const view = frozenView || screenEl.getBoundingClientRect();
    const d = fbDims();
    if (focusedMonitor) {
      const m = focusedMonitor;
      const s = Math.min(view.width / m.w, view.height / m.h);
      return {
        s,
        tx: (view.width  - m.w * s) / 2 - m.x * s,
        ty: (view.height - m.h * s) / 2 - m.y * s,
      };
    }
    if (activeFit === 'contain') {
      const s = Math.min(view.width / d.w, view.height / d.h);
      return {
        s,
        tx: (view.width  - d.w * s) / 2,
        ty: (view.height - d.h * s) / 2,
      };
    }
    // 1:1 — top-left aligned, native pixels.
    return { s: 1, tx: 0, ty: 0 };
  }

  // Apply the current transform to the canvas. We always drive it ourselves
  // (rfb.scaleViewport is off) so we can compose the base view with the user's
  // pinch-zoom / two-finger pan on top.
  function applyFitOrFocus() {
    if (!client) return;
    if (rfb) rfb.scaleViewport = false;
    const canvas = client.el;
    if (!canvas) return;
    updateKeyboardShift();
    const { s, tx, ty } = viewTransform();
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    drawCursor();
  }

  // Base fit/focus, then the user's pinch zoom and pan, then the slide that
  // keeps the pointer above an open on-screen keyboard. Composed left-to-right:
  // T(0,-kbdShift) · T(vtx,vty) · S(vz) · T(b.tx,b.ty) · S(b.s).
  function viewTransform() {
    const b = baseTransform();
    return {
      s: b.s * viewZoom,
      tx: b.tx * viewZoom + viewTx,
      ty: b.ty * viewZoom + viewTy - kbdShift,
    };
  }

  function setKeyboardOpen(open) {
    if (open === kbdOpen && !open) return;
    kbdOpen = open;
    document.body.classList.toggle('keyboard-open', open);
    if (!open) {
      kbdShift = 0;
      if (document.activeElement?.id !== 'rd-kbd-helper') frozenView = null;
    }
    applyFitOrFocus();
  }

  // The part of the screen the keyboard leaves visible, in screen pixels.
  function visibleBand() {
    const vv = window.visualViewport;
    const h = screenEl.getBoundingClientRect().height;
    if (!vv || !kbdOpen) return { top: 0, bottom: h };
    return { top: vv.offsetTop, bottom: Math.min(h, vv.offsetTop + vv.height) };
  }

  // Slide just enough to bring the pointer into the comfortable part of the
  // visible band, leaving room below it to see what it is pointing at. A
  // pointer already in view does not move the picture at all.
  function updateKeyboardShift() {
    if (!kbdOpen) { kbdShift = 0; return; }
    const b = baseTransform();
    const unshifted = b.ty * viewZoom + viewTy + cursorY * b.s * viewZoom;
    const band = visibleBand();
    const h = Math.max(1, band.bottom - band.top);
    const lo = band.top + h * 0.15;
    const hi = band.bottom - h * 0.3;
    const y = unshifted - kbdShift;
    if (y > hi) kbdShift = unshifted - hi;
    else if (y < lo) kbdShift = unshifted - lo;
    // Sliding DOWN is only ever needed to undo a page the browser scrolled up.
    kbdShift = Math.max(-band.top, kbdShift);
  }

  function resetView() {
    viewZoom = 1;
    viewTx = 0;
    viewTy = 0;
  }

  // ── where the pointer is allowed to be ──────────────────────────────
  // The desktop's bounding box has dead space - above and below the landscape
  // monitors beside the rotated one - that no screen covers. A pointer left
  // there is invisible and unrecoverable by feel, so it is pulled back onto the
  // nearest real screen. This is a CLIENT concern: mutter would clamp it too,
  // but by then the local cursor and the remote one disagree.
  function monitorAt(x, y) {
    return monitors.find((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) || null;
  }

  function clampToScreens(x, y) {
    if (client?.kind !== 'agent' || !monitors.length) {
      const d = fbDims();
      return { x: clamp(x, 0, d.w - 1), y: clamp(y, 0, d.h - 1) };
    }
    if (monitorAt(x, y)) return { x, y };
    let best = null, bestD = Infinity;
    for (const m of monitors) {
      const cx = clamp(x, m.x, m.x + m.w - 1);
      const cy = clamp(y, m.y, m.y + m.h - 1);
      const dist = (cx - x) ** 2 + (cy - y) ** 2;
      if (dist < bestD) { bestD = dist; best = { x: cx, y: cy }; }
    }
    return best || { x, y };
  }

  function clampCursor() {
    const p = clampToScreens(cursorX, cursorY);
    cursorX = p.x; cursorY = p.y;
  }

  // Dragging off the focused monitor onto a neighbour moves the focus with it,
  // so a window carried from one screen to the next stays in view.
  function followFocus() {
    if (!focusedMonitor || client?.kind !== 'agent') return;
    const m = monitorAt(cursorX, cursorY);
    if (m && m.name !== focusedMonitor.name) {
      focusedMonitor = m;
      resetView();
      renderMonitorChips();
      applyFitOrFocus();
    }
  }

  // Cursor must stay within the focused monitor (or the full canvas if "All").
  // Agent sessions use clampToScreens instead: the pointer may cross screens.
  function cursorBounds() {
    if (focusedMonitor) {
      const m = focusedMonitor;
      return { minX: m.x, minY: m.y, maxX: m.x + m.w - 1, maxY: m.y + m.h - 1 };
    }
    const d = fbDims();
    return { minX: 0, minY: 0, maxX: d.w - 1, maxY: d.h - 1 };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ── pointer send helpers ──────────────────────────────────────────────
  // The adapter takes framebuffer coords; each protocol implementation handles
  // its own conversion (noVNC's viewport-scale dance lives in connectVnc).
  function sendPointer(mask) {
    client?.sendMouseFb(cursorX, cursorY, mask);
    if (kbdOpen) applyFitOrFocus();   // may slide the view; redraws the cursor
    else drawCursor();
  }

  function clickButton(bit) {
    sendPointer(bit);   // press
    sendPointer(0);     // release
  }


  // ── trackpad input handling (Chrome-Remote-Desktop semantics) ─────────
  //
  // Gesture catalogue:
  //   • Quick tap            → left click at cursor
  //   • Long press (>500 ms) → right click at cursor
  //   • Slow drag            → just move the cursor (no click)
  //   • Tap, then drag       → tap registers as left click, then a second touch
  //                            within 350 ms begins a left-button-held drag
  //                            (drag-select, drag-move, etc.)
  //   • Two-finger drag      → wheel scroll at cursor, OR pinch-to-zoom.
  //                            We classify by whichever motion crosses its
  //                            threshold first: distance change → pinch (Ctrl
  //                            +wheel at cursor), vertical centroid drift →
  //                            scroll. Once classified the gesture is locked.
  //
  // Decision is made at the right moment to avoid false positives: a tap is only
  // committed when the finger lifts within the tap window AND the finger never
  // crossed the movement threshold. A drag commits to "no click" the moment the
  // finger crosses the movement threshold, which also cancels the long-press
  // timer so a slow finger can't accidentally trigger a right click.

  // Finger travel → cursor travel ON SCREEN. A fixed desktop-pixel gain made the
  // pointer crawl in All mode, where one screen pixel is several desktop pixels,
  // and jump when pinched in. Dividing by the view scale keeps the pointer under
  // the same feel at every zoom.
  const TRACKPAD_GAIN = 1;
  const trackpadStep = () => TRACKPAD_GAIN / (baseTransform().s * viewZoom);
  const TAP_MAX_MS = 250;            // touch shorter than this with no move → tap
  const HOLD_RIGHT_MS = 500;         // touch held this long with no move → right
  const TAP_DRAG_GAP_MS = 350;       // window after a tap to start tap-and-drag
  const MOVE_THRESHOLD = 10;         // pixels — beyond this, finger is dragging
  const TWO_FINGER_LOCK_PX = 14;     // one axis must move this much to commit
  const SCROLL_STEP_PX = 24;         // finger travel per wheel tick (scroll)

  // State machine. Only one is active at any time.
  //   idle               — no fingers
  //   pending_tap        — one finger down, still deciding (might tap / hold / drag)
  //   dragging_cursor    — finger crossed move-threshold without a prior tap
  //   holding_right      — long-press fired; right button held until lift
  //   awaiting_drag      — just finished a tap, watching for a re-tap to drag
  //   dragging_left      — re-tap arrived in window; left button held during drag
  //   two_finger         — two fingers down; sub-mode decided in touchmove
  let tpState = 'idle';
  let tpStartedAt = 0;
  let tpStartX = 0, tpStartY = 0;
  let tpLastX = 0, tpLastY = 0;
  let tpLastTapEndedAt = 0;
  let tpHoldRightTimer = null;
  let tpAwaitingDragTimer = null;
  let tpScrollAccum = 0;
  let tpTwoFingerMode = null;        // null → deciding · 'scroll' · 'view'
  let tpInitialDist = 0;
  let tpInitialCentroidX = 0;
  let tpInitialCentroidY = 0;
  let tpLastDist = 0;
  let tpLastCx = 0, tpLastCy = 0;

  function isHudInteractive(target) {
    return !!(target && target.closest && target.closest(
      'button, summary, input, a, [contenteditable], select, label, .chip-details[open] .fkeys'
    ));
  }

  function clearHoldRightTimer() {
    if (tpHoldRightTimer) { clearTimeout(tpHoldRightTimer); tpHoldRightTimer = null; }
  }
  function clearAwaitingDragTimer() {
    if (tpAwaitingDragTimer) { clearTimeout(tpAwaitingDragTimer); tpAwaitingDragTimer = null; }
  }

  document.addEventListener('touchstart', (e) => {
    if (isHudInteractive(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    // 2-finger gesture: scroll (remote wheel) OR view-zoom/pan (client-side).
    // Decided in touchmove based on whether the distance between fingers
    // changes first, or the centroid drifts vertically first.
    if (e.touches.length >= 2) {
      clearHoldRightTimer();
      clearAwaitingDragTimer();
      tpState = 'two_finger';
      tpTwoFingerMode = null;
      tpScrollAccum = 0;
      const t1 = e.touches[0], t2 = e.touches[1];
      tpInitialDist = tpLastDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      tpInitialCentroidX = tpLastCx = (t1.clientX + t2.clientX) / 2;
      tpInitialCentroidY = tpLastCy = (t1.clientY + t2.clientY) / 2;
      return;
    }

    const t = e.touches[0];
    tpStartX = tpLastX = t.clientX;
    tpStartY = tpLastY = t.clientY;
    tpStartedAt = Date.now();

    // Tap-and-drag: second touch arrived within the gap window after a tap.
    if (tpState === 'awaiting_drag') {
      clearAwaitingDragTimer();
      tpState = 'dragging_left';
      sendPointer(BTN_LEFT);   // press, don't release yet
      return;
    }

    tpState = 'pending_tap';

    // Long-press → right click. Cancelled if the finger moves or lifts early.
    clearHoldRightTimer();
    tpHoldRightTimer = setTimeout(() => {
      if (tpState === 'pending_tap') {
        tpState = 'holding_right';
        sendPointer(BTN_RIGHT);
        if (navigator.vibrate) navigator.vibrate(15);  // haptic confirmation
      }
    }, HOLD_RIGHT_MS);
  }, { passive: false, capture: true });

  document.addEventListener('touchmove', (e) => {
    if (tpState === 'idle' || isHudInteractive(e.target)) return;
    e.preventDefault();
    e.stopPropagation();

    // Two-finger gesture. Classification on first significant motion:
    //   • fingers spread/pinch     → 'view'   (client-side zoom + pan of the
    //                                          canvas, anchored at the centroid)
    //   • fingers slide together   → 'scroll' if we're at 1× zoom (remote wheel),
    //                                 'view' pan if we're already zoomed in.
    if (tpState === 'two_finger' || e.touches.length >= 2) {
      tpState = 'two_finger';
      if (e.touches.length < 2) return;

      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const cx = (t1.clientX + t2.clientX) / 2;
      const cy = (t1.clientY + t2.clientY) / 2;

      if (!tpTwoFingerMode) {
        const dDist = Math.abs(dist - tpInitialDist);
        const dCent = Math.hypot(cx - tpInitialCentroidX, cy - tpInitialCentroidY);
        if (dDist >= TWO_FINGER_LOCK_PX || dCent >= TWO_FINGER_LOCK_PX) {
          if (dDist > dCent) {
            tpTwoFingerMode = 'view';        // pinch → view zoom
          } else if (viewZoom > 1.01) {
            tpTwoFingerMode = 'view';        // already zoomed → pan
          } else {
            tpTwoFingerMode = 'scroll';      // slide at 1× → remote wheel
            tpScrollAccum = 0;
          }
        }
        // Rebase per-frame references and skip emitting anything this frame so
        // the next frame's delta is clean and not doubled.
        tpLastDist = dist;
        tpLastCx = cx;
        tpLastCy = cy;
        return;
      }

      if (tpTwoFingerMode === 'view') {
        // Zoom anchored at the MOUSE cursor's current on-screen position —
        // the pinch changes scale, but the point of the desktop under the
        // cursor stays put. Any centroid drift on top of that pans the view.
        //
        // Canvas → screen: screen = viewZoom * (cursor * base.s + base.tx) + viewTx
        // For the cursor's screen position to be invariant across a zoom step:
        //   viewTx_new = viewTx_old + (viewZoom_old - viewZoom_new) * baseScreenX
        const rRaw = dist / (tpLastDist || dist);
        const newZoom = clamp(viewZoom * rRaw, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
        const b = baseTransform();
        const baseScreenX = cursorX * b.s + b.tx;
        const baseScreenY = cursorY * b.s + b.ty;
        viewTx += (viewZoom - newZoom) * baseScreenX;
        viewTy += (viewZoom - newZoom) * baseScreenY;
        viewZoom = newZoom;
        // Centroid delta → pan (useful once you're zoomed in and need to reach
        // an area the cursor isn't already near).
        viewTx += cx - tpLastCx;
        viewTy += cy - tpLastCy;
        if (viewZoom <= VIEW_ZOOM_MIN + 0.001) {
          viewZoom = 1; viewTx = 0; viewTy = 0;
        }
        applyFitOrFocus();
      } else if (tpTwoFingerMode === 'scroll') {
        tpScrollAccum += cy - tpLastCy;
        while (tpScrollAccum <= -SCROLL_STEP_PX) { clickButton(0x08); tpScrollAccum += SCROLL_STEP_PX; }
        while (tpScrollAccum >=  SCROLL_STEP_PX) { clickButton(0x10); tpScrollAccum -= SCROLL_STEP_PX; }
      }

      tpLastDist = dist;
      tpLastCx = cx;
      tpLastCy = cy;
      return;
    }

    const t = e.touches[0];
    const dx = t.clientX - tpLastX;
    const dy = t.clientY - tpLastY;
    tpLastX = t.clientX;
    tpLastY = t.clientY;

    const totalDist = Math.hypot(t.clientX - tpStartX, t.clientY - tpStartY);

    // First time we cross the move threshold during a pending_tap, commit to
    // "this is a drag, not a tap" — cancel the long-press timer so a slow
    // pan can never trigger a right click.
    if (tpState === 'pending_tap' && totalDist > MOVE_THRESHOLD) {
      clearHoldRightTimer();
      tpState = 'dragging_cursor';
    }

    // Update virtual cursor.
    const step = trackpadStep();
    if (client?.kind === 'agent') {
      const p = clampToScreens(cursorX + dx * step, cursorY + dy * step);
      cursorX = p.x;
      cursorY = p.y;
      followFocus();
    } else {
      const b = cursorBounds();
      cursorX = clamp(cursorX + dx * step, b.minX, b.maxX);
      cursorY = clamp(cursorY + dy * step, b.minY, b.maxY);
    }

    let mask = 0;
    if (tpState === 'dragging_left')  mask = BTN_LEFT;
    if (tpState === 'holding_right')  mask = BTN_RIGHT;
    sendPointer(mask);
  }, { passive: false, capture: true });

  document.addEventListener('touchend', (e) => {
    if (tpState === 'idle') return;
    if (!isHudInteractive(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.touches.length > 0) return;   // still touching with another finger

    const heldFor = Date.now() - tpStartedAt;

    switch (tpState) {
      case 'pending_tap': {
        clearHoldRightTimer();
        if (heldFor <= TAP_MAX_MS) {
          // Commit the left click.
          sendPointer(BTN_LEFT);
          sendPointer(0);
          tpLastTapEndedAt = Date.now();
          tpState = 'awaiting_drag';
          clearAwaitingDragTimer();
          tpAwaitingDragTimer = setTimeout(() => {
            if (tpState === 'awaiting_drag') tpState = 'idle';
            tpAwaitingDragTimer = null;
          }, TAP_DRAG_GAP_MS);
        } else {
          // Held past tap window but didn't quite trigger right (e.g. tab
          // backgrounded between timer fires). Just go idle.
          tpState = 'idle';
        }
        break;
      }
      case 'holding_right':
        sendPointer(0);  // release right button
        tpState = 'idle';
        break;
      case 'dragging_left':
        sendPointer(0);  // release left button
        tpState = 'idle';
        break;
      case 'dragging_cursor':
      case 'two_finger':
      default:
        tpTwoFingerMode = null;
        tpState = 'idle';
    }
  }, { passive: false, capture: true });

  document.addEventListener('touchcancel', () => {
    // Browser yanked the touch (system gesture, multitask switch, etc.).
    // Release anything we might be holding and reset cleanly.
    clearHoldRightTimer();
    clearAwaitingDragTimer();
    if (tpState === 'holding_right' || tpState === 'dragging_left') {
      sendPointer(0);
    }
    tpTwoFingerMode = null;
    tpState = 'idle';
  }, { capture: true });

  // ── desktop mouse and keyboard ──────────────────────────────────────
  // The trackpad above is for fingers. A real mouse is ABSOLUTE: the pointer
  // goes where you point, mapped back through the current fit/focus/zoom
  // transform into desktop pixels. Touch pointer events are left to the
  // trackpad handlers, which already own them.
  function screenToFb(clientX, clientY) {
    const rect = screenEl.getBoundingClientRect();
    const v = viewTransform();
    return { x: (clientX - rect.left - v.tx) / v.s, y: (clientY - rect.top - v.ty) / v.s };
  }

  let mouseMask = 0;
  let wheelAccum = 0;
  const BUTTON_BIT = { 0: BTN_LEFT, 1: BTN_MIDDLE, 2: BTN_RIGHT };

  function pointFromMouse(e) {
    const p = screenToFb(e.clientX, e.clientY);
    const c = clampToScreens(Math.round(p.x), Math.round(p.y));
    cursorX = c.x;
    cursorY = c.y;
  }

  const onPointerMove = (e) => {
    if (e.pointerType === 'touch' || !client) return;
    pointFromMouse(e);
    sendPointer(mouseMask);
  };
  const onPointerDown = (e) => {
    if (e.pointerType === 'touch' || !client || isHudInteractive(e.target)) return;
    const bit = BUTTON_BIT[e.button];
    if (!bit) return;
    e.preventDefault();
    screenEl.focus({ preventScroll: true });
    try { screenEl.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    pointFromMouse(e);
    syncModifiers(e);
    mouseMask |= bit;
    sendPointer(mouseMask);
  };
  const onPointerUp = (e) => {
    if (e.pointerType === 'touch' || !client) return;
    const bit = BUTTON_BIT[e.button];
    if (!bit || !(mouseMask & bit)) return;
    e.preventDefault();
    pointFromMouse(e);
    mouseMask &= ~bit;
    sendPointer(mouseMask);
  };
  // Losing capture mid-drag (alt-tab, the window losing focus) must not leave
  // a button stuck down on the host.
  const releaseMouse = () => {
    if (mouseMask) { mouseMask = 0; sendPointer(0); }
  };
  const onWheel = (e) => {
    if (!client || isHudInteractive(e.target)) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    wheelAccum += px;
    // Trackpads send many small deltas; one wheel notch per ~40px of travel.
    while (wheelAccum <= -40) { sendPointer(mouseMask | 0x08); sendPointer(mouseMask); wheelAccum += 40; }
    while (wheelAccum >= 40) { sendPointer(mouseMask | 0x10); sendPointer(mouseMask); wheelAccum -= 40; }
  };
  const onContextMenu = (e) => { if (screenEl.contains(e.target)) e.preventDefault(); };

  screenEl.addEventListener('pointermove', onPointerMove);
  screenEl.addEventListener('pointerdown', onPointerDown);
  screenEl.addEventListener('pointerup', onPointerUp);
  screenEl.addEventListener('pointercancel', releaseMouse);
  screenEl.addEventListener('lostpointercapture', (e) => { if (e.pointerType !== 'touch') releaseMouse(); });
  screenEl.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('blur', releaseMouse);

  // Physical keyboard. The on-screen keyboard helper is an <input> and handles
  // its own events; everything else typed while the session is open goes to the
  // host. Keysyms for guacd, KeyboardEvent.code for the agent (uinput keycodes).
  const CODE_KEYSYM = {
    Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, NumpadEnter: 0xff0d, Backspace: 0xff08,
    Delete: 0xffff, Insert: 0xff63, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56,
    ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53,
    ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3, ControlRight: 0xffe4,
    AltLeft: 0xffe9, AltRight: 0xffea, MetaLeft: 0xffeb, MetaRight: 0xffec, CapsLock: 0xffe5,
    F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
    F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  };
  const heldCodes = new Set();
  const onKey = (down) => (e) => {
    if (!client) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    if (e.isComposing || e.keyCode === 229) return;
    const code = e.code;
    const keysym = CODE_KEYSYM[code] ?? (e.key && e.key.length === 1 ? e.key.codePointAt(0) : null);
    if (keysym == null && !code) return;
    e.preventDefault();
    const isModifier = MODIFIER_FLAGS.some(([, codes]) => codes.includes(code));
    if (down && !isModifier) syncModifiers(e);
    if (down) heldCodes.add(code); else heldCodes.delete(code);
    client.sendKey(keysym, code, down);
    if (!down && !isModifier) syncModifiers(e);
  };
  // The event's modifier flags are the truth. A modifier pressed before the
  // page had focus never sent its keydown, and one released while focus was
  // elsewhere never sent its keyup; either way the host disagrees about Ctrl.
  const MODIFIER_FLAGS = [
    ['shiftKey', ['ShiftLeft', 'ShiftRight']],
    ['ctrlKey', ['ControlLeft', 'ControlRight']],
    ['altKey', ['AltLeft', 'AltRight']],
    ['metaKey', ['MetaLeft', 'MetaRight']],
  ];
  function syncModifiers(e) {
    if (!client) return;
    for (const [flag, codes] of MODIFIER_FLAGS) {
      const held = codes.filter((c) => heldCodes.has(c));
      if (e[flag] && !held.length) {
        heldCodes.add(codes[0]);
        client.sendKey(CODE_KEYSYM[codes[0]], codes[0], true);
      } else if (!e[flag] && held.length) {
        for (const c of held) { heldCodes.delete(c); client.sendKey(CODE_KEYSYM[c], c, false); }
      }
    }
  }
  const onKeyDown = onKey(true);
  const onKeyUp = onKey(false);
  // Keys held when the window loses focus never get their keyup; release them
  // so the host is not left with Ctrl stuck down.
  const releaseKeys = () => {
    for (const code of heldCodes) client?.sendKey(CODE_KEYSYM[code] ?? null, code, false);
    heldCodes.clear();
  };
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', releaseKeys);

  // ── key send (with modifier wrapping) ─────────────────────────────────
  function withMods(fn) {
    if (!client) return;
    const fired = [];
    for (const m of MOD_NAMES) {
      const s = modState.get(m);
      if (s === 'armed' || s === 'locked') {
        client.sendKey(MOD_KEYSYM[m], MOD_CODE[m], true);
        fired.push({ name: m, state: s });
      }
    }
    fn();
    for (const m of fired) {
      client.sendKey(MOD_KEYSYM[m.name], MOD_CODE[m.name], false);
      if (m.state === 'armed') {
        modState.set(m.name, 'off');
        renderModChip(m.name);
      }
    }
  }

  function sendKeysym(keysym, code) {
    withMods(() => {
      client.sendKey(keysym, code, true);
      client.sendKey(keysym, code, false);
    });
  }

  function sendModWrappedClick(bit) {
    withMods(() => clickButton(bit));
  }

  // ── modifier chips ────────────────────────────────────────────────────
  function cycleMod(name) {
    const cur = modState.get(name);
    const next = cur === 'off' ? 'armed' : cur === 'armed' ? 'locked' : 'off';
    modState.set(name, next);
    renderModChip(name);
  }

  function renderModChip(name) {
    const chip = root.querySelector(`.rs-mod[data-mod="${name}"]`);
    if (!chip) return;
    const s = modState.get(name);
    chip.classList.toggle('on', s === 'locked');
    chip.classList.toggle('armed', s === 'armed');
  }

  root.querySelectorAll('.rs-mod').forEach((b) => {
    b.onclick = () => cycleMod(b.dataset.mod);
  });

  // ── special key chips ─────────────────────────────────────────────────
  root.querySelectorAll('button[data-key]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.key;
      const ks = SPECIAL_KEYSYM[k];
      if (ks) sendKeysym(ks, k);
    };
  });

  // ── click chips ───────────────────────────────────────────────────────
  root.querySelector('#rd-click-left').onclick = () => sendModWrappedClick(BTN_LEFT);
  root.querySelector('#rd-click-middle').onclick = () => sendModWrappedClick(BTN_MIDDLE);
  root.querySelector('#rd-click-right').onclick = () => sendModWrappedClick(BTN_RIGHT);

  // ── ctrl+alt+del ──────────────────────────────────────────────────────
  root.querySelector('#rd-ctrlaltdel').onclick = () => client?.sendCtrlAltDel();

  // ── input-mode + fit chips ────────────────────────────────────────────
  root.querySelectorAll('button[data-fit]').forEach((b) => {
    b.onclick = () => {
      activeFit = b.dataset.fit;
      root.querySelectorAll('button[data-fit]').forEach((x) => x.classList.toggle('on', x === b));
      focusedMonitor = null;
      resetView();
      renderMonitorChips();
      applyFitOrFocus();
    };
  });

  // ── keyboard helper (on-screen IME on mobile) ─────────────────────────
  root.querySelector('#rd-kbd').onclick = () => {
    let helper = document.getElementById('rd-kbd-helper');
    if (!helper) {
      helper = document.createElement('input');
      helper.id = 'rd-kbd-helper';
      helper.autocomplete = 'off';
      helper.autocapitalize = 'off';
      helper.spellcheck = false;
      helper.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      helper.addEventListener('input', (e) => {
        const v = e.target.value;
        for (const ch of v) {
          const cp = ch.codePointAt(0);
          sendKeysym(cp, ch);
        }
        e.target.value = '';
      });
      helper.addEventListener('keydown', (e) => {
        const ks = SPECIAL_KEYSYM[e.key];
        if (ks) {
          e.preventDefault();
          sendKeysym(ks, e.key);
        }
      });
      helper.addEventListener('blur', () => {
        // The keyboard is going away (or never came, on a desktop browser).
        frozenView = null;
        setKeyboardOpen(false);
      });
      document.body.appendChild(helper);
    }
    // Capture the fit BEFORE the keyboard appears. Where the browser resizes
    // the layout for the keyboard, the screen is already shorter by the time
    // the viewport event arrives.
    if (document.activeElement !== helper) {
      const r = screenEl.getBoundingClientRect();
      frozenView = { width: r.width, height: r.height };
    }
    helper.focus();
  };

  // ── HUD show/hide ─────────────────────────────────────────────────────
  // EXIT, not logout. The console owns the session; this button leaves the
  // remote machine and returns to the device list, which is what you actually
  // want when you are done with one machine — signing out of the whole console
  // was never the right pairing.
  root.querySelector('#rd-exit').onclick = () => onExit?.();
  root.querySelector('#rd-hide').onclick = () => {
    hudTop.classList.add('hidden');
    hudBottom.classList.add('hidden');
    reveal.classList.add('show');
  };
  reveal.onclick = () => {
    hudTop.classList.remove('hidden');
    hudBottom.classList.remove('hidden');
    reveal.classList.remove('show');
  };

  window.addEventListener('resize', () => {
    applyFitOrFocus();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && client) {
      loadMonitors();
    }
  });

  // ── mobile on-screen keyboard handling ────────────────────────────────
  // The keyboard covers the bottom of the screen. The old handling shrank the
  // screen to the space left and re-fitted into it, which changed the scale
  // underneath an existing pinch zoom and pan and threw the view somewhere
  // unrelated. Now the zoom stays exactly where it was and the view only slides
  // up - as far as needed and no further - to keep the pointer, which is what
  // you were looking at, clear of the keys. Closing the keyboard slides it back.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    let closedHeight = vv.height;
    const onVvChange = () => {
      const typing = document.activeElement?.id === 'rd-kbd-helper';
      if (!typing) closedHeight = vv.height;       // rotations, browser chrome
      setKeyboardOpen(typing && vv.height < closedHeight - 80);
    };
    vv.addEventListener('resize', onVvChange);
    vv.addEventListener('scroll', onVvChange);
  }

  /**
   * Open one device directly.
   *
   * The original discovered devices and picked the first; the chooser has
   * already made that choice, so this jumps straight to connecting and only
   * fetches the list to render the Dev chips for switching in-session.
   */
  async function bootSession(id) {
    try {
      const { devices: list } = await ctx.api('/devices');
      devices = list || [];
    } catch {
      devices = [];
    }
    activeDevice = devices.find((d) => d.id === id) || devices[0] || null;
    if (!activeDevice) {
      setStatus('device not found', 'err');
      return;
    }
    renderDeviceChips();
    connect();
  }

  // The old app discovered devices and picked the first; here the chooser has
  // already made that choice, so jump straight to it. (loadDevices() used to
  // live above for that old flow. It had rotted — it treated ctx.api's parsed
  // JSON as a fetch Response, so `r.ok` was undefined and every call threw
  // "cannot load device list" — and nothing had called it in a long time.)
  bootSession(deviceId);

  return function teardown() {
    rdpGeneration++;                 // stale close handlers must not reconnect
    releaseMouse();
    releaseKeys();
    document.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', releaseMouse);
    window.removeEventListener('blur', releaseKeys);
    try { client?.disconnect(); } catch { /* already gone */ }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearHoldRightTimer();
    clearAwaitingDragTimer();
    document.getElementById('rd-kbd-helper')?.remove();
    document.body.classList.remove('keyboard-open');
  };
}
