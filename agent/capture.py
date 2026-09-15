"""PipeWire capture → H.264: one monitor, or the whole desktop at once.

Sits between portal.py (which owns the grant) and the WebSocket server (which
ships bytes to the browser).

Design notes that are not obvious:

* **Encode on the iGPU, not the discrete card.** `vaapih264enc` on the Intel
  graphics is essentially free and, more importantly, leaves the RTX alone —
  streaming should never compete with a game or a CUDA job. The discrete
  encoder is unusable here anyway; see `_encoder_candidates()`. x264enc is the
  fallback at roughly 190% of one core for 1080p30, where `tune=zerolatency`
  matters more than any other setting: the default lookahead adds hundreds of
  milliseconds that feel like a broken connection rather than like latency.

* **SPS/PPS with every keyframe** (`h264parse config-interval=-1`). The browser
  can attach at any moment — on reconnect, on a monitor switch, after a tab
  wakes up — and a stream whose parameter sets appeared once at the start is
  undecodable to everyone who arrives late.

* **Byte-stream / AU alignment.** WebCodecs wants whole access units. Handing it
  arbitrary buffer boundaries produces a decoder that works on Chrome and
  silently fails on Safari.

* **Bitrate is a live property.** Both encoders accept a bitrate change while
  playing, which is what makes adaptation possible without rebuilding the
  pipeline (a rebuild drops frames and forces a new keyframe — visible as a
  stutter every time the network hiccups).

* **One pipeline at a time.** Either a single monitor (MonitorStream) or the
  whole desktop composited into one frame (DesktopStream). The desktop stream
  is what makes the merged canvas possible: the browser gets one picture laid
  out exactly as mutter arranges the monitors, focusing a monitor is a crop on
  the client, and the pointer can cross from one screen to the next.
"""

from __future__ import annotations

import threading
import time

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

Gst.init(None)

# Bitrate bounds in kbps. The floor still has to be watchable on a phone over
# cellular; the ceiling is where more bits stop buying visible quality at 1080p.
BITRATE_MIN = 400
BITRATE_MAX = 8000
BITRATE_START = 2500


def _encoder_candidates(bitrate: int = BITRATE_START) -> list[tuple[str, str]]:
    """Encoders to try, best first, as (name, launch fragment).

    Ordered by measured behaviour on the reference machine, not by reputation:

      vaapih264enc  Intel iGPU. Essentially free, and deliberately preferred
                    over the discrete GPU so streaming never competes with
                    whatever is using the RTX (a game, CUDA, the other half of
                    this project). Verified working here.

      x264enc       Software. Works everywhere. Measured ~190% of one core
                    sustained at 1080p30 with veryfast/zerolatency — usable,
                    but not something to run all day if hardware exists.

    nvh264enc is deliberately ABSENT despite the box having an RTX 5060 and the
    plugin being installed. Every configuration of it fails on this driver with
    "Selected preset not supported" — the nvcodec plugin in
    gstreamer1.0-plugins-bad predates the driver's removal of the legacy preset
    enums. Tested with preset=default, preset=low-latency, rc-mode=cbr alone,
    and no options at all; all four fail. Listing it here would just mean every
    stream pays a failed-pipeline round trip before falling back.
    """
    out = []
    if Gst.ElementFactory.find("vaapih264enc"):
        out.append(("vaapih264enc", (
            f"vaapih264enc name=enc rate-control=cbr bitrate={bitrate} "
            f"keyframe-period=60 max-bframes=0"
        )))
    out.append(("x264enc", (
        # tune=zerolatency disables B-frames and lookahead. Without it x264
        # buffers several frames ahead, which reads as a broken connection
        # rather than as latency.
        "x264enc name=enc tune=zerolatency speed-preset=veryfast "
        f"bitrate={bitrate} key-int-max=60 bframes=0"
    )))
    return out


class MonitorStream:
    """Encodes one PipeWire node to H.264 and hands access units to a callback."""

    def __init__(self, *, fd: int, node_id: int, on_unit, on_error=None,
                 fps: int = 30, max_width: int = 1920):
        self.fd = fd
        self.node_id = node_id
        self.on_unit = on_unit
        self.on_error = on_error
        self.fps = fps
        self.max_width = max_width

        self.pipeline = None
        self.encoder = None
        self.bitrate = BITRATE_START
        self.encoder_name = None
        self.started_at = None
        self.units = 0
        self.bytes = 0
        self._lock = threading.Lock()

    # ── lifecycle ──────────────────────────────────────────────────────
    def start(self) -> None:
        """Build and run the pipeline, falling back through the encoder list.

        The fallback is not defensive padding: a hardware encoder that is
        present, advertises the right properties and still refuses at
        set_format is exactly what happened here with nvh264enc. Failing over
        automatically means a driver update that breaks VAAPI degrades to
        software instead of taking the whole service down.
        """
        errors = []
        for name, enc in _encoder_candidates(self.bitrate):
            try:
                self._build(name, enc)
                return
            except RuntimeError as e:
                errors.append(f"{name}: {e}")
                self.stop()
        raise RuntimeError("no usable H.264 encoder — " + "; ".join(errors))

    def _build(self, encoder_name: str, enc: str) -> None:
        self.encoder_name = encoder_name

        # videorate + videoscale before the encoder so the GPU is not asked to
        # encode 4K at 120fps when the client is a phone. `! video/x-raw` caps
        # after each converter are what actually forces the negotiation.
        head, extra = self._front()
        desc = (
            f"{head}"
            f"videoconvert ! "
            f"{enc} ! "
            # config-interval=-1 repeats SPS/PPS on every keyframe so a client
            # attaching mid-stream can decode immediately.
            f"h264parse config-interval=-1 ! "
            f"video/x-h264,stream-format=byte-stream,alignment=au ! "
            f"appsink name=out emit-signals=true sync=false max-buffers=2 drop=true"
            f"{extra}"
        )

        self.pipeline = Gst.parse_launch(desc)
        self.encoder = self.pipeline.get_by_name("enc")
        sink = self.pipeline.get_by_name("out")
        sink.connect("new-sample", self._on_sample)

        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_bus_error)

        # Block until the pipeline actually reaches PLAYING. parse_launch and
        # set_state both succeed lazily, so without this a broken encoder is
        # only discovered later as silence on the wire — which is
        # indistinguishable from a black screen.
        ret = self.pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            raise RuntimeError("pipeline refused to start")
        ret, _state, _pending = self.pipeline.get_state(4 * Gst.SECOND)
        if ret != Gst.StateChangeReturn.SUCCESS:
            msg = self.pipeline.get_bus().poll(Gst.MessageType.ERROR, 0)
            detail = msg.parse_error()[0].message if msg else f"state change {ret.value_nick}"
            raise RuntimeError(detail)

        self.started_at = time.monotonic()

    def _front(self) -> tuple[str, str]:
        """The source half of the pipeline, ending in raw video, plus any
        extra source chains that feed it (none for a single monitor)."""
        return (
            f"pipewiresrc {_pw_target(self.fd, self.node_id)} do-timestamp=true keepalive-time=1000 ! "
            f"videorate ! video/x-raw,framerate={self.fps}/1 ! "
            f"videoconvert ! videoscale ! "
            f"video/x-raw,width=[16,{self.max_width}],pixel-aspect-ratio=1/1 ! ",
            "",
        )

    def stop(self) -> None:
        if not self.pipeline:
            return
        self.pipeline.set_state(Gst.State.NULL)
        self.pipeline = None
        self.encoder = None

    # ── callbacks ──────────────────────────────────────────────────────
    def _on_sample(self, sink):
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK
        buf = sample.get_buffer()
        ok, info = buf.map(Gst.MapFlags.READ)
        if not ok:
            return Gst.FlowReturn.OK
        try:
            data = bytes(info.data)
            # DELTA_UNIT unset means this is a keyframe — the client needs to
            # know, so it can wait for one before feeding its decoder rather
            # than showing a corrupt first image.
            key = not buf.has_flags(Gst.BufferFlags.DELTA_UNIT)
            self.units += 1
            self.bytes += len(data)
            self.on_unit(data, key)
        finally:
            buf.unmap(info)
        return Gst.FlowReturn.OK

    def _on_bus_error(self, _bus, msg):
        err, debug = msg.parse_error()
        if self.on_error:
            self.on_error(f"{err.message} ({debug})")

    # ── adaptation ─────────────────────────────────────────────────────
    def set_bitrate(self, kbps: int) -> int:
        """Change bitrate live. Returns what was actually applied."""
        kbps = max(BITRATE_MIN, min(BITRATE_MAX, int(kbps)))
        with self._lock:
            if not self.encoder or kbps == self.bitrate:
                return self.bitrate
            # x264enc and nvh264enc both take kbps; vaapi takes kbps too.
            self.encoder.set_property("bitrate", kbps)
            self.bitrate = kbps
        return kbps

    def force_keyframe(self) -> None:
        """Request an immediate IDR — used when a client (re)attaches."""
        if not self.encoder:
            return
        self.encoder.send_event(
            Gst.Event.new_custom(
                Gst.EventType.CUSTOM_DOWNSTREAM,
                Gst.Structure.new_empty("GstForceKeyUnit"),
            )
        )

    def stats(self) -> dict:
        elapsed = max(0.001, time.monotonic() - (self.started_at or time.monotonic()))
        return {
            "encoder": self.encoder_name,
            "bitrateKbps": self.bitrate,
            "units": self.units,
            "kbps": round(self.bytes * 8 / elapsed / 1000),
            "fps": round(self.units / elapsed, 1),
        }


# The merged desktop is capped here. 4920x1920 is refused by the iGPU's H.264
# encoder outright (verified), and 3840 wide is also what phones decode in
# hardware; the browser scales the picture back to desktop coordinates anyway.
DESKTOP_MAX_W = 3840
DESKTOP_MAX_H = 2160
DESKTOP_BITRATE_START = 4500
DESKTOP_BITRATE_MAX = 14000


class DesktopStream(MonitorStream):
    """Every captured monitor composited into one frame, placed where mutter
    places it, so the browser sees the desk the way the person sitting at it
    does.

    Each monitor is scaled BEFORE compositing, so the software compositor
    handles the output size rather than the full 4920x1920 canvas, and every
    input keeps resending its last frame (keepalive-time) so a monitor that is
    not changing never stalls the whole picture waiting for a buffer.
    """

    def __init__(self, *, sources, bounds, on_unit, on_error=None, fps: int = 24):
        super().__init__(fd=-1, node_id=0, on_unit=on_unit, on_error=on_error, fps=fps)
        # sources: [{fd, node_id, x, y, w, h}] with x/y relative to bounds
        self.sources = sources
        _bx, _by, bw, bh = bounds
        self.canvas_w, self.canvas_h = int(bw), int(bh)
        self.scale = min(1.0, DESKTOP_MAX_W / bw, DESKTOP_MAX_H / bh)
        self.out_w = max(2, int(bw * self.scale) // 2 * 2)
        self.out_h = max(2, int(bh * self.scale) // 2 * 2)
        self.bitrate = DESKTOP_BITRATE_START

    def _front(self) -> tuple[str, str]:
        s = self.scale
        pads = []
        chains = []
        for i, src in enumerate(self.sources):
            x, y = round(src["x"] * s), round(src["y"] * s)
            w, h = max(2, round(src["w"] * s)), max(2, round(src["h"] * s))
            pads.append(f"sink_{i}::xpos={x} sink_{i}::ypos={y} "
                        f"sink_{i}::width={w} sink_{i}::height={h}")
            chains.append(
                f" pipewiresrc {_pw_target(src['fd'], src['node_id'])} do-timestamp=true "
                f"keepalive-time=100 ! "
                f"videoconvert ! videoscale ! "
                f"video/x-raw,width={w},height={h},pixel-aspect-ratio=1/1 ! "
                f"videorate ! video/x-raw,framerate={self.fps}/1 ! "
                f"queue max-size-buffers=2 leaky=downstream ! mix.sink_{i}"
            )
        head = (
            f"compositor name=mix background=black ignore-inactive-pads=true "
            f"{' '.join(pads)} ! "
            f"video/x-raw,width={self.out_w},height={self.out_h},"
            f"framerate={self.fps}/1,pixel-aspect-ratio=1/1 ! "
        )
        return head, "".join(chains)

    def set_bitrate(self, kbps: int) -> int:
        """Same live adaptation, with a ceiling that fits a whole desk."""
        kbps = max(BITRATE_MIN, min(DESKTOP_BITRATE_MAX, int(kbps)))
        with self._lock:
            if not self.encoder or kbps == self.bitrate:
                return self.bitrate
            self.encoder.set_property("bitrate", kbps)
            self.bitrate = kbps
        return kbps


def _pw_target(fd, node_id) -> str:
    """pipewiresrc's connection. A portal hands over a restricted remote as an
    fd; mutter's own nodes sit on the user's default PipeWire daemon, reached
    with no fd at all."""
    return f"fd={fd} path={node_id}" if fd is not None and fd >= 0 else f"path={node_id}"


class GLibLoop:
    """GStreamer needs a GLib main loop for bus messages and signals.

    Run it on its own thread so the asyncio WebSocket server owns the main
    thread. Mixing the two loops is possible but every bug it produces is a
    heisenbug, and this is a service that has to survive unattended.
    """

    def __init__(self):
        self.loop = GLib.MainLoop()
        self.thread = threading.Thread(target=self.loop.run, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.loop.quit()
