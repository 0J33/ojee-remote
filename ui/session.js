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
     the canvas shrinks above it instead of hiding behind it.

   Transport-agnostic by design. `client` is a small interface —
   fbSize, sendMouseFb, sendKey, sendCtrlAltDel, disconnect — so
   the same interaction model drives guacd and the H.264 agent
   without knowing which it is talking to.
   ============================================================ */

import Guacamole from '../guac-js/guacamole-common.js';
import { hudMarkup } from './session-hud.js';

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

  // ── status helpers ────────────────────────────────────────────────────
  function setStatus(text, kind = '') {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  }

  // ── connection ────────────────────────────────────────────────────────
  let reconnectTimer = null;
  let userSwitchedDevice = false;  // prevents the auto-reconnect after a manual switch
  let rdpGeneration = 0;           // invalidates stale RDP death handlers after reconnects

  async function connect() {
    if (!activeDevice) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setStatus(`connecting to ${activeDevice.name}…`);
    // Everything goes through guacd now. The original branched on protocol
    // because it also spoke VNC directly; guacd speaks both, and routing one
    // way removes the transport as a variable.
    return connectRdp();
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
      setStatus(`token fetch failed: ${e.message}`, 'err');
      reconnectTimer = setTimeout(connect, 3000);
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
    const onDead = () => {
      if (deadHandled || myGen !== rdpGeneration) return;
      deadHandled = true;
      if (userSwitchedDevice) { userSwitchedDevice = false; return; }
      setStatus('reconnecting…', 'err');
      reconnectTimer = setTimeout(connect, 1500);
    };

    gc.onstatechange = async (state) => {
      // 3 = CONNECTED, 5 = DISCONNECTED (Guacamole.Client state constants)
      if (state === 3) {
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
    gc.onerror = (e) => setStatus(`rdp error: ${e.message || e.code || 'unknown'}`, 'err');
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

  async function loadDevices() {
    try {
      const r = await ctx.api('/devices');
      if (!r.ok) throw new Error(r.statusText);
      devices = (await r.json()).devices || [];
    } catch (e) {
      setStatus('cannot load device list', 'err');
      return;
    }
    if (!devices.length) {
      setStatus('no devices configured', 'err');
      return;
    }
    activeDevice = devices[0];
    renderDeviceChips();
    connect();
  }

  function renderDeviceChips() {
    root.querySelector('#rd-devices-group').hidden = devices.length <= 1;
    devicesEl.innerHTML = '';
    devices.forEach((d) => {
      const b = document.createElement('button');
      b.className = 'rs-chip' + (activeDevice && d.id === activeDevice.id ? ' on' : '');
      b.textContent = d.name;
      b.title = d.local ? 'this host' : 'remote (over Tailscale)';
      b.onclick = () => switchDevice(d);
      devicesEl.appendChild(b);
    });
  }

  async function switchDevice(d) {
    if (!d || (activeDevice && d.id === activeDevice.id)) return;
    activeDevice = d;
    focusedMonitor = null;
    monitors = [];
    resetView();
    renderDeviceChips();
    renderMonitorChips();
    if (client) {
      userSwitchedDevice = true;
      client.disconnect();
      client = null;
      rfb = null;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    await connect();
  }

  // ── monitors ──────────────────────────────────────────────────────────
  async function loadMonitors() {
    if (!activeDevice) return;
    monitors = [];
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
  const isRdp = () => true;

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

    monitors.forEach((m, i) => {
      const b = document.createElement('button');
      b.className = 'rs-chip' + (focusedMonitor === m ? ' on' : '');
      b.textContent = m.primary ? `${i + 1}★` : String(i + 1);
      b.title = `${m.name}  ${m.w}×${m.h}  @${m.x},${m.y}`;
      b.onclick = () => focusMonitor(m);
      monitorsEl.appendChild(b);
    });
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
    sendPointer(0);
  }

  // Base transform: what CSS `translate(...) scale(...)` on the canvas is needed
  // to render the current view mode (fit / 1:1 / focused monitor) at viewZoom=1.
  function baseTransform() {
    const view = screenEl.getBoundingClientRect();
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
    const b = baseTransform();
    // First put the canvas into base position/scale, then apply the user zoom
    // and pan. Two independent transforms composed left-to-right in CSS matrix
    // math: T(vtx,vty) · S(vz) · T(b.tx,b.ty) · S(b.s).
    const s  = b.s * viewZoom;
    const tx = b.tx * viewZoom + viewTx;
    const ty = b.ty * viewZoom + viewTy;
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
  }

  function resetView() {
    viewZoom = 1;
    viewTx = 0;
    viewTy = 0;
  }

  // Cursor must stay within the focused monitor (or the full canvas if "All").
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

  const SENS = 1.7;                  // finger-to-cursor sensitivity multiplier
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
    const b = cursorBounds();
    cursorX = clamp(cursorX + dx * SENS, b.minX, b.maxX);
    cursorY = clamp(cursorY + dy * SENS, b.minY, b.maxY);

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
    let helper = root.querySelector('#rd-kbd-helper');
    if (!helper) {
      helper = document.createElement('input');
      helper.id = 'kbd-helper';
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
      document.body.appendChild(helper);
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
  // When the OSK opens, `visualViewport.height` drops below the layout viewport
  // height. We shrink #screen to that height (so the remote canvas fits above
  // the keyboard instead of being covered by it) and slide the HUD out of the
  // way — the physical OSK is the only UI the user needs at that moment.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVvChange = () => {
      const kbdOpen = vv.height < window.innerHeight - 100;
      document.body.classList.toggle('keyboard-open', kbdOpen);
      if (kbdOpen) {
        screenEl.style.bottom = 'auto';
        screenEl.style.height = vv.height + 'px';
      } else {
        screenEl.style.bottom = '';
        screenEl.style.height = '';
      }
      // noVNC listens to window "resize" for rescale, not visualViewport events.
      window.dispatchEvent(new Event('resize'));
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

  // The old app called loadDevices() at the end of the script; here the device
  // is already chosen, so jump straight to it.
  bootSession(deviceId);

  return function teardown() {
    try { client?.disconnect(); } catch { /* already gone */ }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearHoldRightTimer();
    clearAwaitingDragTimer();
    root.querySelector('#rd-kbd-helper')?.remove();
    document.body.classList.remove('keyboard-open');
  };
}
