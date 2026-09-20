/* ============================================================
   ojee-remote — the agent transport.

   The host agent streams H.264 over one WebSocket. By default that
   stream is the WHOLE DESKTOP: every shared monitor composited into
   one frame, laid out exactly as mutter arranges them. The session
   treats that frame as its framebuffer, in desktop pixels, which is
   what makes the merged canvas work again — focusing a monitor is a
   crop, neighbours show at the edges, and the pointer crosses from
   one screen to the next.

   Two ways to turn the stream into pixels, picked per browser:

   * WebCodecs  VideoDecoder → canvas. Chrome, Firefox, Android,
                desktop Safari.
   * MSE        Remuxed to fragmented MP4 and played by a <video>
                through ManagedMediaSource / MediaSource. This is for
                iOS Safari, which ships a VideoDecoder constructor and
                then decodes nothing (a black canvas at a healthy frame
                rate). The <video> element decodes in hardware there.

   The returned adapter is the same small interface the guacd client
   implements, so the trackpad, keys and view code do not care which
   transport is live:
     { kind, el, fbSize(), sendMouseFb(x, y, mask),
       sendKey(keysym, code, down), sendCtrlAltDel(), disconnect() }
   Mouse coordinates are framebuffer pixels = desktop pixels.
   ============================================================ */

import { spsSize } from './h264.js';


/* ── which decode path this browser can actually use ─────────────────── */

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * `'VideoDecoder' in window` is necessary and nowhere near sufficient: iOS
 * Safari has the constructor and decodes nothing. A blunt test that lands on
 * a working path beats a precise one that lands on a black rectangle.
 */
export function canUseWebCodecs() {
  return 'VideoDecoder' in window && !IS_IOS;
}

function mediaSourceCtor() {
  return window.ManagedMediaSource || window.MediaSource || null;
}

export function canUseMse() {
  const MS = mediaSourceCtor();
  try {
    return !!MS && MS.isTypeSupported('video/mp4; codecs="avc1.640033"');
  } catch {
    return false;
  }
}

/* ── H.264 byte handling ─────────────────────────────────────────────── */

// The agent sends Annex-B access units. Both decode paths want AVCC: an avcC
// record built from SPS/PPS, and each sample as length-prefixed NALs.

function splitNals(buf) {
  const nals = [];
  const n = buf.length;
  const startAt = (p) => {
    for (let k = p; k + 2 < n; k++) {
      if (buf[k] === 0 && buf[k + 1] === 0) {
        if (buf[k + 2] === 1) return [k, 3];
        if (buf[k + 2] === 0 && k + 3 < n && buf[k + 3] === 1) return [k, 4];
      }
    }
    return null;
  };
  let cur = startAt(0);
  if (!cur) return nals;
  let i = cur[0] + cur[1];
  while (i < n) {
    const next = startAt(i);
    const end = next ? next[0] : n;
    if (end > i) nals.push(buf.subarray(i, end));
    if (!next) break;
    i = next[0] + next[1];
  }
  return nals;
}

function toAvcc(nals) {
  let total = 0;
  for (const u of nals) total += 4 + u.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const u of nals) {
    out[o] = (u.length >>> 24) & 0xff;
    out[o + 1] = (u.length >>> 16) & 0xff;
    out[o + 2] = (u.length >>> 8) & 0xff;
    out[o + 3] = u.length & 0xff;
    out.set(u, o + 4);
    o += 4 + u.length;
  }
  return out;
}

function sameNal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buildAvcC(sps, pps) {
  if (!sps || !pps || sps.length < 4) return null;
  const profile = sps[1], compat = sps[2], level = sps[3];
  const b = new Uint8Array(7 + 2 + sps.length + 1 + 2 + pps.length);
  let o = 0;
  b[o++] = 1; b[o++] = profile; b[o++] = compat; b[o++] = level;
  b[o++] = 0xff;                       // lengthSizeMinusOne = 3
  b[o++] = 0xe1;                       // one SPS
  b[o++] = (sps.length >> 8) & 0xff; b[o++] = sps.length & 0xff;
  b.set(sps, o); o += sps.length;
  b[o++] = 1;                          // one PPS
  b[o++] = (pps.length >> 8) & 0xff; b[o++] = pps.length & 0xff;
  b.set(pps, o);
  const hex = (v) => v.toString(16).padStart(2, '0');
  return { description: b, codec: `avc1.${hex(profile)}${hex(compat)}${hex(level)}` };
}

/* ── fragmented MP4, just enough for one live video track ────────────── */

const TIMESCALE = 90000;

function box(type, ...parts) {
  let size = 8;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function bytes(...vals) {
  // vals: [value, byteWidth] pairs flattened, big-endian
  const out = [];
  for (let i = 0; i < vals.length; i += 2) {
    const v = vals[i], w = vals[i + 1];
    if (w === 8) {
      const hi = Math.floor(v / 2 ** 32), lo = v >>> 0;
      out.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
               (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    } else {
      for (let k = w - 1; k >= 0; k--) out.push((v >>> (k * 8)) & 255);
    }
  }
  return new Uint8Array(out);
}

const MATRIX = bytes(0x00010000, 4, 0, 4, 0, 4, 0, 4, 0x00010000, 4, 0, 4, 0, 4, 0, 4, 0x40000000, 4);

function initSegment(w, h, avcc) {
  const ftyp = box('ftyp', new TextEncoder().encode('isom'), bytes(0x200, 4),
    new TextEncoder().encode('isomiso6avc1mp41'));
  const mvhd = box('mvhd', bytes(0, 4, 0, 4, 0, 4, 1000, 4, 0, 4, 0x00010000, 4, 0x0100, 2, 0, 2, 0, 4, 0, 4),
    MATRIX, new Uint8Array(24), bytes(2, 4));
  const tkhd = box('tkhd', bytes(0x00000003, 4, 0, 4, 0, 4, 1, 4, 0, 4, 0, 4, 0, 8, 0, 2, 0, 2, 0, 2, 0, 2),
    MATRIX, bytes(w << 16 >>> 0, 4, h << 16 >>> 0, 4));
  const mdhd = box('mdhd', bytes(0, 4, 0, 4, 0, 4, TIMESCALE, 4, 0, 4, 0x55c4, 2, 0, 2));
  const hdlr = box('hdlr', bytes(0, 4, 0, 4), new TextEncoder().encode('vide'),
    new Uint8Array(12), new TextEncoder().encode('VideoHandler\0'));
  const vmhd = box('vmhd', bytes(1, 4, 0, 2, 0, 2, 0, 2, 0, 2));
  const dinf = box('dinf', box('dref', bytes(0, 4, 1, 4), box('url ', bytes(1, 4))));
  const avcC = box('avcC', avcc.description);
  const avc1 = box('avc1',
    new Uint8Array(6), bytes(1, 2),                // reserved, data_reference_index
    new Uint8Array(16),                            // pre_defined / reserved
    bytes(w, 2, h, 2, 0x00480000, 4, 0x00480000, 4, 0, 4, 1, 2),
    new Uint8Array(32),                            // compressorname
    bytes(0x0018, 2, 0xffff, 2),
    avcC);
  const stsd = box('stsd', bytes(0, 4, 1, 4), avc1);
  const empty = (t) => box(t, bytes(0, 4, 0, 4));
  const stbl = box('stbl', stsd, empty('stts'), empty('stsc'),
    box('stsz', bytes(0, 4, 0, 4, 0, 4)), empty('stco'));
  const minf = box('minf', vmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  const mvex = box('mvex', box('trex', bytes(0, 4, 1, 4, 1, 4, 0, 4, 0, 4, 0, 4)));
  const moov = box('moov', mvhd, trak, mvex);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp, 0); out.set(moov, ftyp.length);
  return out;
}

function mediaSegment(seq, decodeTime, duration, sample, key) {
  const mfhd = box('mfhd', bytes(0, 4, seq, 4));
  const tfhd = box('tfhd', bytes(0x00020000, 4, 1, 4));       // default-base-is-moof
  const tfdt = box('tfdt', bytes(0x01000000, 4, decodeTime, 8));
  const flags = key ? 0x02000000 : 0x01010000;
  // trun: data-offset, duration, size, flags present. The offset is patched in
  // once moof's size is known.
  const trun = box('trun', bytes(0x00000701, 4, 1, 4, 0, 4, duration, 4, sample.length, 4, flags, 4));
  const traf = box('traf', tfhd, tfdt, trun);
  const moof = box('moof', mfhd, traf);
  const offset = moof.length + 8;
  // trun lives at the very end of moof: header(8) + vf(4) + count(4) then offset
  const trunAt = moof.length - trun.length;
  new DataView(moof.buffer).setInt32(trunAt + 16, offset);
  const mdat = box('mdat', sample);
  const out = new Uint8Array(moof.length + mdat.length);
  out.set(moof, 0); out.set(mdat, moof.length);
  return out;
}

/* ── renderers ───────────────────────────────────────────────────────── */

function webCodecsRenderer({ onFailure }) {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { alpha: false, desynchronized: true });
  let decoder = null;
  let configured = null;
  let configuring = null, configuringFor = null;
  let waitingKey = true;
  let errors = 0;

  async function configure(codec, w, h, avcc) {
    try { decoder?.close(); } catch { /* already closed */ }
    decoder = null;
    waitingKey = true;
    canvas.width = w;
    canvas.height = h;
    const config = { codec, codedWidth: w, codedHeight: h, optimizeForLatency: true,
      description: avcc.description };
    let chosen = config;
    const ok = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!ok.supported) {
      const { optimizeForLatency: _drop, ...plain } = config;
      const alt = await VideoDecoder.isConfigSupported(plain).catch(() => ({ supported: false }));
      if (!alt.supported) { onFailure(`${codec} at ${w}x${h} is not supported here`); return; }
      chosen = plain;
    }
    decoder = new VideoDecoder({
      output: (frame) => {
        // drawImage then close, every frame: an unclosed VideoFrame holds a GPU
        // buffer and the pool runs dry within seconds.
        g.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
        errors = 0;
      },
      error: (e) => {
        errors += 1;
        waitingKey = true;
        if (errors === 3) onFailure(e.message || 'decoder error');
      },
    });
    decoder.configure(chosen);
    configured = `${codec}/${w}x${h}`;
  }

  return {
    el: canvas,
    needsKey: () => waitingKey,
    async push({ key, avcc, codecChanged, w, h, sample }) {
      // Frames keep arriving while a configure is awaited. They share the one
      // in flight rather than each starting another, and awaiting the same
      // promise keeps them in arrival order - the keyframe decodes first.
      const want = `${avcc.codec}/${w}x${h}`;
      if (codecChanged || !decoder || (configured !== want && !configuring)) {
        if (!configuring || configuringFor !== want) {
          configuringFor = want;
          configuring = configure(avcc.codec, w, h, avcc).finally(() => { configuring = null; });
        }
      }
      if (configuring) await configuring;
      if (!decoder || decoder.state !== 'configured') return false;
      if (waitingKey) { if (!key) return false; waitingKey = false; }
      // A decoder that has fallen behind is showing the past. Skip to the next
      // keyframe rather than letting the lag grow.
      if (decoder.decodeQueueSize > 4 && !key) { waitingKey = true; return 'want-key'; }
      decoder.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta', timestamp: performance.now() * 1000, data: sample,
      }));
      return true;
    },
    close() { try { decoder?.close(); } catch { /* already closed */ } },
  };
}

function mseRenderer({ fps, onFailure }) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.disableRemotePlayback = true;          // required by ManagedMediaSource
  video.setAttribute('playsinline', '');
  video.style.objectFit = 'fill';

  const MS = mediaSourceCtor();
  let ms = null, sb = null, url = null;
  let configured = null;
  let configuring = null, configuringFor = null;
  let seq = 1, decodeTime = 0;
  const queue = [];
  let waitingKey = true;
  const frameDuration = Math.round(TIMESCALE / fps);

  function reset() {
    try { if (ms && ms.readyState === 'open') ms.endOfStream(); } catch { /* closing */ }
    if (url) URL.revokeObjectURL(url);
    ms = null; sb = null; url = null; configured = null;
    queue.length = 0; seq = 1; decodeTime = 0; waitingKey = true;
  }

  function pump() {
    if (!sb || sb.updating || !queue.length) return;
    try {
      sb.appendBuffer(queue.shift());
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        // Drop what is behind the playhead and try the next one.
        try { sb.remove(0, Math.max(0, video.currentTime - 2)); } catch { /* busy */ }
        queue.length = 0; waitingKey = true;
      } else {
        onFailure(e.message || 'append failed');
      }
    }
  }

  function chase() {
    // Live edge: a <video> will happily play a growing buffer from the past.
    // Keep the playhead within a few frames of the newest data.
    const b = video.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    if (end - video.currentTime > 0.35) video.currentTime = Math.max(0, end - 0.05);
    if (video.paused) video.play().catch(() => { /* needs a gesture; the session tap was one */ });
    // Keep the buffer short so memory stays flat over hours.
    if (!sb.updating && video.currentTime - b.start(0) > 20) {
      try { sb.remove(b.start(0), video.currentTime - 5); } catch { /* busy */ }
    }
  }

  function configure(codec, w, h, avcc) {
    reset();
    return new Promise((resolve) => {
      ms = new MS();
      const opened = () => {
        try {
          sb = ms.addSourceBuffer(`video/mp4; codecs="${codec}"`);
          sb.mode = 'sequence';            // no gaps when a frame is dropped
          sb.addEventListener('updateend', () => { chase(); pump(); });
          sb.addEventListener('error', () => onFailure('source buffer error'));
          queue.push(initSegment(w, h, avcc));
          configured = `${codec}/${w}x${h}`;
          pump();
        } catch (e) {
          onFailure(e.message || 'cannot create source buffer');
        }
        resolve();
      };
      ms.addEventListener('sourceopen', opened, { once: true });
      if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) {
        try { video.srcObject = ms; } catch { url = URL.createObjectURL(ms); video.src = url; }
      } else {
        url = URL.createObjectURL(ms);
        video.src = url;
      }
    });
  }

  return {
    el: video,
    needsKey: () => waitingKey,
    async push({ key, avcc, codecChanged, w, h, sample }) {
      const want = `${avcc.codec}/${w}x${h}`;
      if ((codecChanged && configured !== want) || !sb || configured !== want) {
        if (!configuring || configuringFor !== want) {
          configuringFor = want;
          configuring = configure(avcc.codec, w, h, avcc).finally(() => { configuring = null; });
        }
      }
      if (configuring) await configuring;
      if (!sb) return false;
      if (waitingKey) { if (!key) return false; waitingKey = false; }
      if (queue.length > 6 && !key) { queue.length = 0; waitingKey = true; return 'want-key'; }
      queue.push(mediaSegment(seq++, decodeTime, frameDuration, sample, key));
      decodeTime += frameDuration;
      pump();
      return true;
    },
    close() { reset(); video.removeAttribute('src'); try { video.srcObject = null; } catch { /* n/a */ } },
  };
}

/* ── keyboard: browser codes → Linux keycodes (the agent speaks uinput) ─ */

export const LINUX_KEY = {
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
  IntlBackslash: 86, ContextMenu: 127,
};

// character → [keycode, shift], US layout. Soft keyboards report no usable
// KeyboardEvent.code (Android sends `Unidentified`), so phone typing arrives
// as text and has to be turned back into key presses.
const CHAR_KEY = (() => {
  const map = {};
  const rows = [
    ['`1234567890-=', '~!@#$%^&*()_+', [41, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]],
    ['qwertyuiop[]\\', 'QWERTYUIOP{}|', [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 43]],
    ["asdfghjkl;'", 'ASDFGHJKL:"', [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]],
    ['zxcvbnm,./', 'ZXCVBNM<>?', [44, 45, 46, 47, 48, 49, 50, 51, 52, 53]],
  ];
  for (const [plain, shifted, codes] of rows) {
    [...plain].forEach((ch, i) => { map[ch] = [codes[i], false]; });
    [...shifted].forEach((ch, i) => { map[ch] = [codes[i], true]; });
  }
  map[' '] = [57, false];
  map['\n'] = [28, false];
  return map;
})();

const SHIFT = 42;

/* ── the transport ───────────────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {string} o.url            WebSocket URL (the gateway attaches the agent token)
 * @param {'webcodecs'|'mse'} o.mode
 * @param {Function} o.onLayout     ({ active, desktop, monitors, frameW, frameH }) on ready/active/layout
 * @param {Function} o.onOpen
 * @param {Function} o.onClose      (reason) — the socket is gone
 * @param {Function} o.onFailure    (detail) — this browser cannot decode; try another path
 * @param {Function} o.onError      (detail) — the agent reported a problem
 * @param {Function} o.onClipboard  (text|null, detail) — the machine's clipboard
 *                                  came back, or could not be read
 */
export function connectAgent({ url, mode, onLayout, onOpen, onClose, onFailure, onError, onClipboard }) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  // A wrapper sized in DESKTOP pixels. The view code transforms this element;
  // the canvas or video inside it stretches the (scaled) frame to fill it.
  const view = document.createElement('div');
  view.className = 'rd-agent-view';
  const renderer = mode === 'mse'
    ? mseRenderer({ fps: 24, onFailure: (d) => fail(d) })
    : webCodecsRenderer({ onFailure: (d) => fail(d) });
  renderer.el.className = 'rd-agent-media';
  view.appendChild(renderer.el);

  let layout = { active: null, desktop: { w: 1920, h: 1080 }, monitors: [], frameW: 0, frameH: 0 };
  let fb = { w: 1920, h: 1080 };        // framebuffer = what the stream covers, desktop px
  let sps = null, pps = null, avcc = null;
  let coded = null;                     // {w, h} from the SPS — what the frames really are
  let closed = false, failed = false;

  function fail(detail) {
    if (failed || closed) return;
    failed = true;
    onFailure?.(detail);
  }

  function send(msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function applyLayout(msg) {
    const monitors = (msg.monitors || []).map((m) => ({ ...m }));
    const active = msg.active || msg.monitor || null;
    layout = {
      active,
      desktop: msg.desktop || layout.desktop,
      monitors,
      frameW: msg.w || layout.frameW,
      frameH: msg.h || layout.frameH,
    };
    if (active === 'desktop') {
      fb = { w: layout.desktop.w, h: layout.desktop.h };
    } else {
      const m = monitors.find((x) => x.name === active);
      fb = m ? { w: m.w, h: m.h } : { w: layout.frameW || 1920, h: layout.frameH || 1080 };
    }
    view.style.width = `${fb.w}px`;
    view.style.height = `${fb.h}px`;
    // New geometry means a new SPS; forget the old parameter sets.
    sps = pps = avcc = null;
    coded = null;
    onLayout?.(layout);
  }

  ws.onopen = () => onOpen?.();
  ws.onclose = (e) => {
    if (closed) return;
    closed = true;
    renderer.close();
    onClose?.(e.reason || 'stream closed');
  };
  ws.onerror = () => { /* onclose follows with the reason */ };

  ws.onmessage = async (ev) => {
    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'ping') return send({ t: 'pong', ts: msg.ts });
      if (msg.t === 'ready' || msg.t === 'active' || msg.t === 'layout') return applyLayout(msg);
      if (msg.t === 'error') return onError?.(msg.detail || 'agent error');
      // Clipboard, asked for rather than streamed — see agent/clipboard.py.
      if (msg.t === 'clip') return onClipboard?.(String(msg.text ?? ''), null);
      if (msg.t === 'clip-error') return onClipboard?.(null, msg.detail || 'clipboard failed');
      if (msg.t === 'clip-ok') return onClipboard?.(undefined, null);
      return;
    }
    if (failed) return;
    const buf = new Uint8Array(ev.data);
    const key = (buf[0] & 0x80) !== 0;
    if (renderer.needsKey() && !key) return;

    const nals = splitNals(buf.subarray(1));
    const picture = [];
    let codecChanged = false;
    for (const u of nals) {
      const t = u[0] & 0x1f;
      if (t === 7) { if (!sameNal(sps, u)) { sps = u; codecChanged = true; } }
      else if (t === 8) { if (!sameNal(pps, u)) { pps = u; codecChanged = true; } }
      // AUD (9) and filler (12) are legal Annex-B and illegal in an AVCC sample;
      // Safari's decoder rejects the whole sample over them.
      else if (t !== 9 && t !== 12) picture.push(u);
    }
    if (codecChanged && sps && pps) {
      avcc = buildAvcC(sps, pps);
      coded = spsSize(sps);
    }
    if (!avcc || !picture.length) return;

    try {
      const r = await renderer.push({
        // The SPS, not the announced layout: on a scaled monitor the agent
        // announces the logical size and encodes the physical one (see h264.js).
        key, avcc, codecChanged,
        w: coded?.w || layout.frameW, h: coded?.h || layout.frameH,
        sample: toAvcc(picture),
      });
      if (r === 'want-key') send({ t: 'keyframe' });
    } catch (e) {
      send({ t: 'keyframe' });
      console.warn('[remote] render:', e.message);
    }
  };

  /* ── input ─────────────────────────────────────────────────────────── */

  let lastMask = 0;
  let pendingMove = null;
  let moveScheduled = false;

  function flushMove() {
    moveScheduled = false;
    if (!pendingMove) return;
    send({ t: 'pointer', x: pendingMove.x, y: pendingMove.y });
    pendingMove = null;
  }

  function key(code, down) {
    if (code != null) send({ t: 'key', code, down });
  }

  return {
    kind: 'agent',
    el: view,
    get layout() { return layout; },
    fbSize: () => ({ ...fb }),

    sendMouseFb(x, y, mask) {
      // Aim at the pixel centre. Edge pixels otherwise round down through
      // fraction → uinput ABS → compositor pixel and land one pixel off-screen
      // (in a dead zone between monitors), where the compositor drops the move.
      const fx = fb.w ? (x + 0.5) / fb.w : 0;
      const fy = fb.h ? (y + 0.5) / fb.h : 0;
      if (mask === lastMask) {
        // Pure motion coalesces to one message per frame: a mouse fires far
        // faster than the wire needs, and a backlog of stale moves is lag.
        pendingMove = { x: fx, y: fy };
        if (!moveScheduled) { moveScheduled = true; requestAnimationFrame(flushMove); }
        return;
      }
      // A button change must land where the pointer IS, so position first.
      pendingMove = null;
      send({ t: 'pointer', x: fx, y: fy });
      const changed = mask ^ lastMask;
      for (const [bit, name] of [[0x01, 'left'], [0x02, 'middle'], [0x04, 'right']]) {
        if (changed & bit) send({ t: 'button', b: name, down: !!(mask & bit) });
      }
      // Wheel bits are momentary: act on the press only.
      if ((changed & 0x08) && (mask & 0x08)) send({ t: 'scroll', dy: 1 });
      if ((changed & 0x10) && (mask & 0x10)) send({ t: 'scroll', dy: -1 });
      lastMask = mask & ~(0x08 | 0x10);
    },

    sendKey(_keysym, code, down) {
      if (typeof code === 'string' && code.length === 1 && !(code in LINUX_KEY)) {
        const entry = CHAR_KEY[code];
        if (!entry) return;
        const [kc, shift] = entry;
        if (down) { if (shift) key(SHIFT, true); key(kc, true); }
        else { key(kc, false); if (shift) key(SHIFT, false); }
        return;
      }
      key(LINUX_KEY[code], down);
    },

    sendCtrlAltDel() {
      for (const [c, d] of [[29, true], [56, true], [111, true], [111, false], [56, false], [29, false]]) key(c, d);
    },

    select(monitor) { send({ t: 'select', monitor }); },
    keyframe() { send({ t: 'keyframe' }); },
    /** Ask the machine for its clipboard; the answer arrives via onClipboard. */
    readClipboard() { send({ t: 'clip-get' }); },
    /** Put text on the machine's clipboard. */
    writeClipboard(text) { send({ t: 'clip-set', text: String(text ?? '') }); },

    disconnect() {
      closed = true;
      try { ws.close(); } catch { /* already closed */ }
      renderer.close();
    },
  };
}
