/* ============================================================
   The Shell view: a terminal on a device, over the gateway's
   /shell WebSocket.

   Same bargain as the screen session — the browser holds no
   credential and never speaks to the machine directly — but a
   terminal is far simpler than a desktop: bytes in, bytes out,
   plus a size.

   What it does carry over from the screen session, because a
   phone still cannot do it otherwise:

     the key row   Esc, Tab, arrows, Ctrl. A terminal without
                   Ctrl-C on a touchscreen is a read-only log.
     ⌨             raises the OS keyboard.

   xterm.js is a UMD bundle, so it is loaded as a classic script
   from /vendor rather than imported. That keeps the module a
   plain ES module with no build step.
   ============================================================ */

let loading = null;

/** Load xterm.js + the fit addon once, from the gateway's /vendor. */
function loadXterm(base) {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (loading) return loading;

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.id = 'xterm-css';
  css.href = `${base}/vendor/xterm.css`;
  if (!document.getElementById('xterm-css')) document.head.appendChild(css);

  const script = (src) => new Promise((ok, fail) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = ok;
    el.onerror = () => fail(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });

  loading = script(`${base}/vendor/xterm.js`)
    .then(() => script(`${base}/vendor/addon-fit.js`))
    .catch((e) => { loading = null; throw e; });
  return loading;
}

/** The console's palette, read live so the terminal follows the theme. */
function themeFromCss() {
  const v = (n, dflt) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || dflt;
  return {
    background: v('--bg-1', '#0b0d10'),
    foreground: v('--ink', '#e6e8ea'),
    cursor: v('--accent', '#7cc4ff'),
    cursorAccent: v('--bg-1', '#0b0d10'),
    selectionBackground: v('--accent-08', 'rgba(124,196,255,0.22)'),
  };
}

const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['←', '\x1b[D'], ['→', '\x1b[C'], ['Home', '\x1b[H'], ['End', '\x1b[F'],
  ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'], ['^C', '\x03'], ['^D', '\x04'],
  ['^Z', '\x1a'], ['^L', '\x0c'],
];

/**
 * @param {object} o
 * @param {HTMLElement} o.host      where to render
 * @param {object} o.ctx            module context (base, esc, icon, toast)
 * @param {string} o.deviceId
 * @param {string} o.deviceName
 * @param {Function} o.onExit       back to the chooser
 * @returns {Function} teardown
 */
/** Connection state → the status dot's colour, as the Screen view uses it. */
const KIND = {
  connecting: 'info', reconnecting: 'info',
  connected: 'ok', ready: 'ok',
  closed: 'warn', disconnected: 'warn',
  error: 'err',
};

export function startShell({ host, ctx, deviceId, deviceName, onExit }) {
  host.innerHTML = `
    <section class="sh">
      <header class="rd-bar sh-bar">
        <button class="rs-icon" data-act="exit" title="Back to devices" aria-label="Back to devices">
          <svg viewBox="0 0 24 24" class="ic" aria-hidden="true">
            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" d="M15 5 L8 12 L15 19"/>
          </svg>
        </button>
        <div class="rd-status sh-state" data-kind="info">
          <b class="rd-state-label">connecting</b>
          <span class="rd-state-detail sh-name">${ctx.esc(deviceName || deviceId)}</span>
        </div>
        <div class="rd-controls">
          <button class="rs-chip" data-act="keys" title="Special keys">Keys</button>
          <button class="rs-chip" data-act="kbd" title="Show keyboard" aria-label="Show keyboard">⌨</button>
          <button class="rs-chip" data-act="reconnect" title="Reconnect">Reconnect</button>
        </div>
      </header>
      <div class="sh-keys rs-chips" hidden>
        ${KEYS.map(([label], i) => `<button class="rs-chip" data-key="${i}">${ctx.esc(label)}</button>`).join('')}
      </div>
      <div class="sh-term"></div>
    </section>`;

  const $ = (sel) => host.querySelector(sel);
  const stateEl = $('.sh-state');
  const termEl = $('.sh-term');
  const keysEl = $('.sh-keys');

  let term = null;
  let fit = null;
  let ws = null;
  let disposed = false;
  let ro = null;

  const setState = (state, detail) => {
    if (!stateEl) return;
    stateEl.dataset.state = state;
    stateEl.dataset.kind = KIND[state] || 'info';
    stateEl.querySelector('.rd-state-label').textContent = state;
    stateEl.querySelector('.rd-state-detail').textContent = detail || deviceName || deviceId;
  };

  const sendSize = () => {
    if (!term || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
  };

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // ctx.base is the module's mount path; the WS lives beside its API.
    const base = `${proto}://${location.host}${ctx.base}`;
    const url = `${base}/shell?device=${encodeURIComponent(deviceId)}&cols=${term.cols}&rows=${term.rows}`;

    setState('connecting');
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => sendSize();
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t !== 'status') return;
        if (msg.state === 'ready') { setState('connected'); term.focus(); }
        else if (msg.state === 'error') {
          setState('error', msg.detail);
          term.writeln(`\r\n\x1b[31m${msg.detail || 'connection failed'}\x1b[0m`);
        } else setState(msg.state, msg.detail);
        return;
      }
      term.write(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (disposed) return;
      // Distinguish "the shell exited" from "the link dropped": the server
      // says 'closed' before a clean end, so only an unexplained close is
      // worth shouting about.
      if (stateEl.dataset.state !== 'closed' && stateEl.dataset.state !== 'error') {
        setState('disconnected');
        term.writeln('\r\n\x1b[33mdisconnected — press Reconnect\x1b[0m');
      }
    };
    ws.onerror = () => setState('error', 'websocket');
  }

  (async () => {
    try {
      await loadXterm(ctx.base);
    } catch (e) {
      setState('error', e.message);
      ctx.toast?.('err', 'Terminal failed to load', e.message);
      return;
    }
    if (disposed) return;

    const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
    term = new window.Terminal({
      // Resolved, not a var(): xterm measures the font on a canvas, where a
      // CSS variable is just an unknown family name.
      fontFamily: mono || 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      // A phone keyboard inserts composed text; without this, dead keys and
      // autocorrect land as garbage.
      screenReaderMode: false,
      theme: themeFromCss(),
    });
    fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termEl);
    fit.fit();

    term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(d));
    });

    // Resize follows the element, not the window: the console's sidebar can
    // collapse without the window changing size at all.
    ro = new ResizeObserver(() => {
      try { fit.fit(); sendSize(); } catch { /* not laid out yet */ }
    });
    ro.observe(termEl);

    connect();
  })();

  host.addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]');
    if (key) {
      const [, seq] = KEYS[Number(key.dataset.key)] || [];
      if (seq && ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(seq));
      term?.focus();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'exit') onExit?.();
    else if (act === 'keys') keysEl.hidden = !keysEl.hidden;
    else if (act === 'kbd') term?.focus();
    else if (act === 'reconnect') {
      try { ws?.close(); } catch { /* already gone */ }
      term?.reset();
      connect();
    }
  });

  return () => {
    disposed = true;
    try { ro?.disconnect(); } catch { /* never observed */ }
    try { ws?.close(); } catch { /* already gone */ }
    try { term?.dispose(); } catch { /* never opened */ }
    ws = null; term = null; fit = null;
  };
}
