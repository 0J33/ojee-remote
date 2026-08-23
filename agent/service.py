#!/usr/bin/env python3
"""ojee-remote host agent — capture, stream and input for one machine.

Replaces gnome-remote-desktop entirely on the Linux side. Runs on the machine
with the screens; the gateway proxies to it.

    GET  /health                  session, monitors, encoder, active stream
    GET  /monitors                the layout
    WS   /stream                  H.264 out, input events in

Why this exists rather than using g-r-d: g-r-d streams the PRIMARY monitor and
only the primary, so "show me another screen" meant moving the primary flag and
rearranging the physical desktop. The desktop portal will hand over ANY monitor —
or all of them — without touching the primary, which is what this uses.

The wire protocol is deliberately small.

    client → server (JSON text)
        {"t":"select","monitor":"DP-1"}     switch which monitor is encoded
        {"t":"pointer","x":0.5,"y":0.5}     fraction OF THE VIEWED MONITOR
        {"t":"button","b":"left","down":true}
        {"t":"scroll","dy":1,"dx":0}
        {"t":"key","code":30,"down":true}   linux keycode, not a keysym
        {"t":"keyframe"}                    please send an IDR now
        {"t":"stat","rttMs":42,"queued":0}  client feedback for adaptation

    server → client
        JSON text for control, BINARY for video.
        Binary frame = 1 byte type + payload; type 1 = H.264 access unit,
        high bit set means keyframe.

Coordinates are per-monitor fractions rather than desktop pixels. The client
knows which monitor it is looking at and where in it the user tapped; it should
not have to know the desktop layout, and a monitor that changes resolution then
needs no client change at all.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from http import HTTPStatus  # noqa: E402

import websockets  # noqa: E402
from websockets.server import serve  # noqa: E402

import capture  # noqa: E402
import display  # noqa: E402
import inject  # noqa: E402
import pin  # noqa: E402
import portal  # noqa: E402

def _default_bind() -> str:
    """This machine's Tailscale address, or loopback — never 0.0.0.0.

    0.0.0.0 puts a screen-capture and input-injection endpoint on every
    interface the machine has. On a laptop that means whatever wifi it is
    joined to, with a bearer token as the only thing in the way. Defaulting
    to the tailnet address means the port does not exist off the tailnet.

    Falling back to loopback rather than 0.0.0.0 keeps the failure SAFE: with
    Tailscale down the agent starts unreachable instead of starting wide open.
    """
    try:
        r = subprocess.run(["tailscale", "ip", "-4"],
                           capture_output=True, text=True, timeout=5)
        addr = (r.stdout or "").strip().splitlines()
        if r.returncode == 0 and addr and addr[0].strip():
            return addr[0].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return "127.0.0.1"


HOST = os.environ.get("AGENT_BIND") or _default_bind()
PORT = int(os.environ.get("AGENT_PORT", "8210"))
TOKEN = os.environ.get("AGENT_TOKEN", "")
NAME = os.environ.get("AGENT_NAME", socket.gethostname())
FPS = int(os.environ.get("AGENT_FPS", "30"))

if not TOKEN:
    sys.exit("AGENT_TOKEN is required. Generate one with: openssl rand -hex 32")

# Video frames are large and bursty. If the socket cannot drain them we must
# drop rather than buffer: a queue that grows is latency that never comes back,
# and the user would rather lose a frame than watch the past.
MAX_QUEUED_UNITS = 3


class Agent:
    """Owns the portal session, the encoder and the virtual input device."""

    def __init__(self):
        self.session = None          # portal ScreenCast session handle
        self.streams = []            # [{node_id,x,y,w,h}] from the portal
        self.monitors = []           # [{name,x,y,w,h,primary}] from mutter
        self.stream = None           # active capture.MonitorStream
        self.active = None           # monitor name being encoded
        self.input = inject.VirtualInput()
        self.glib = capture.GLibLoop()
        self.clients = set()
        self.loop = None             # asyncio loop, set in main()
        self._lock = threading.Lock()
        # Set when a pipeline reports a stale node id; the next start re-opens
        # the grant instead of reusing a session we know is dead.
        self.session_stale = False

    # ── setup ──────────────────────────────────────────────────────────
    def open_portal(self):
        """Restore the saved grant. Silent — no dialog — once approved once."""
        self.session, self.streams = portal.open_screencast()
        self.refresh_monitors()

    def regrant_portal(self):
        """Discard the saved grant and ask again, so newly attached monitors
        can be included.

        This DOES show the portal dialog — that is the point, and it is the
        only mechanism the portal offers: a grant cannot be widened in place.
        Tick every display you want reachable, including ones you may unplug
        and plug back later; the new token then restores that whole set
        silently from here on.
        """
        portal.forget_token()
        self.reacquire_portal()
        return {
            "monitors": self.monitors,
            "granted": sum(1 for m in self.monitors if m.get("capturable")),
        }

    def reacquire_portal(self):
        """Throw away a dead ScreenCast session and restore a fresh one.

        A portal session does NOT last forever. Clicking "Stop Streaming" in
        the shell's screen-share indicator revokes it outright, and the
        compositor can drop it on its own. After that the session handle
        answers every call with

            org.freedesktop.DBus.Error.AccessDenied: Invalid session

        and the PipeWire node ids captured with it are gone, which surfaces
        one layer down as

            gstpipewiresrc: target not found

        The agent used to open exactly one session at startup and keep it for
        the life of the process, so the first revocation ended streaming until
        someone restarted the service — and nothing said why. Re-opening uses
        the saved restore_token, so it is silent in the normal case; it only
        prompts if the token itself was invalidated, which is correct, because
        that is the user having genuinely withdrawn consent.
        """
        print("[portal] session is dead — restoring a fresh grant", flush=True)
        try:
            portal.close_session(self.session)
        except Exception:                                  # noqa: BLE001
            pass                                            # it is already gone
        self.session = None
        self.streams = []
        self.session, self.streams = portal.open_screencast()
        self.refresh_monitors()

    def refresh_monitors(self):
        """Match portal streams to mutter's monitors by geometry.

        NOT by node id: PipeWire renumbers nodes on every session (observed
        100/105/126 → 126/127/124 → 102/90/105). Position and size are stable
        and are what both sides agree on.
        """
        try:
            self.monitors = display.list_monitors()
        except Exception:                                  # noqa: BLE001
            self.monitors = []

        for m in self.monitors:
            match = next(
                (s for s in self.streams
                 if s["x"] == m["x"] and s["y"] == m["y"]
                 and s["w"] == m["w"] and s["h"] == m["h"]),
                None,
            )
            # Fall back to size alone: a portal stream can report position
            # (0,0) for a single-monitor grant even when mutter places it
            # elsewhere.
            if match is None:
                match = next((s for s in self.streams
                              if s["w"] == m["w"] and s["h"] == m["h"]), None)
            m["node_id"] = match["node_id"] if match else None
            m["capturable"] = match is not None

    def monitor(self, name):
        return next((m for m in self.monitors if m["name"] == name), None)

    def default_monitor(self):
        """Prefer the pinned primary — it is the screen the user actually uses."""
        want = pin.preferred_primary(self.monitors) if self.monitors else None
        for pick in (want, next((m["name"] for m in self.monitors if m["primary"]), None)):
            m = self.monitor(pick) if pick else None
            if m and m.get("capturable"):
                return m["name"]
        cap = next((m for m in self.monitors if m.get("capturable")), None)
        return cap["name"] if cap else None

    # ── capture ────────────────────────────────────────────────────────
    def select(self, name: str) -> dict:
        """Encode a different monitor. Rebuilds the pipeline (~200ms)."""
        m = self.monitor(name)
        if not m:
            raise ValueError(f"unknown monitor {name!r}")
        if not m.get("capturable"):
            raise ValueError(f"{name} was not included in the portal grant")

        with self._lock:
            if self.stream:
                self.stream.stop()
                self.stream = None

            if self.session_stale:
                self.session_stale = False
                self.reacquire_portal()
                m = self.monitor(name) or m

            # A FRESH pipewire fd per pipeline. pipewiresrc takes ownership and
            # closes it on teardown, so reusing one leaves every later pipeline
            # reading a closed descriptor and silently producing nothing.
            #
            # Retried ONCE through a fresh grant: the common failure here is a
            # session that was revoked while nobody was streaming, and the only
            # way to find out is to try. A second failure is real and is raised.
            try:
                fd = portal.open_pipewire_fd(self.session)
            except Exception as first:                     # noqa: BLE001
                print(f"[portal] {first}", flush=True)
                self.reacquire_portal()
                m = self.monitor(name) or m                # node ids changed
                fd = portal.open_pipewire_fd(self.session)

            self.stream = capture.MonitorStream(
                fd=fd, node_id=m["node_id"], fps=FPS,
                on_unit=self._on_unit,
                on_error=self._on_capture_error,
            )
            self.stream.start()
            self.active = name

        return {"monitor": name, "w": m["w"], "h": m["h"], "encoder": self.stream.encoder_name}

    def _on_capture_error(self, err):
        """GStreamer errors arrive here, from its own thread.

        "target not found" means the node id is stale — the session died and
        we only learn it when the pipeline tries to attach. Mark the session so
        the next start re-acquires rather than failing the same way forever.
        """
        print(f"[capture] {err}", flush=True)
        if "target not found" in str(err).lower():
            self.session_stale = True

    def _on_unit(self, data: bytes, keyframe: bool):
        """Called from the GStreamer thread — hop to the asyncio loop."""
        if not self.loop or not self.clients:
            return
        header = bytes([0x81 if keyframe else 0x01])
        self.loop.call_soon_threadsafe(self._fanout, header + data)

    def _fanout(self, payload: bytes):
        for client in list(self.clients):
            client.push(payload)

    # ── input ──────────────────────────────────────────────────────────
    def desktop_bounds(self):
        """Union of all monitors, so a per-monitor fraction maps to the whole."""
        if not self.monitors:
            return (0, 0, 1920, 1080)
        x0 = min(m["x"] for m in self.monitors)
        y0 = min(m["y"] for m in self.monitors)
        x1 = max(m["x"] + m["w"] for m in self.monitors)
        y1 = max(m["y"] + m["h"] for m in self.monitors)
        return (x0, y0, x1 - x0, y1 - y0)

    def point_at(self, fx: float, fy: float):
        """Map a fraction of the ACTIVE monitor to a fraction of the desktop."""
        m = self.monitor(self.active)
        if not m:
            return
        dx, dy, dw, dh = self.desktop_bounds()
        gx = (m["x"] + fx * m["w"] - dx) / dw
        gy = (m["y"] + fy * m["h"] - dy) / dh
        self.input.move_fraction(gx, gy)

    # ── teardown ───────────────────────────────────────────────────────
    def shutdown(self):
        if self.stream:
            self.stream.stop()
        self.input.close()
        portal.close_session(self.session)
        self.glib.stop()


class Client:
    """One connected browser."""

    def __init__(self, ws, agent: Agent):
        self.ws = ws
        self.agent = agent
        self.queue = asyncio.Queue(maxsize=MAX_QUEUED_UNITS)
        self.dropped = 0
        self.sent = 0
        self.rtt_ms = None
        self.seen_keyframe = False

    def push(self, payload: bytes):
        """Enqueue a unit, dropping the oldest if the client is behind.

        Dropping is the point. Buffering video for a slow client converts a
        transient network dip into permanent lag, and for a remote desktop
        stale frames are worse than missing ones.
        """
        try:
            self.queue.put_nowait(payload)
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
                self.queue.put_nowait(payload)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass
            self.dropped += 1

    async def sender(self):
        while True:
            payload = await self.queue.get()
            await self.ws.send(payload)
            self.sent += 1

    async def adapt(self):
        """Adjust bitrate from what the client reports and how far behind it is.

        Deliberately coarse and slow-moving. A tight loop chasing every hiccup
        oscillates, and an oscillating bitrate looks far worse than a steady
        slightly-too-low one.
        """
        while True:
            await asyncio.sleep(3)
            s = self.agent.stream
            if not s:
                continue
            behind = self.dropped
            self.dropped = 0
            rtt = self.rtt_ms or 0

            if behind > 5 or rtt > 400:
                s.set_bitrate(int(s.bitrate * 0.6))       # back off hard
            elif behind > 1 or rtt > 200:
                s.set_bitrate(int(s.bitrate * 0.85))
            elif behind == 0 and rtt and rtt < 120:
                s.set_bitrate(int(s.bitrate * 1.15))      # creep back up
            await self.ws.send(json.dumps({
                "t": "stats", **s.stats(), "dropped": behind, "rttMs": rtt,
            }))

    async def pinger(self):
        """Measure round-trip time. This is the adaptation's main input, and it
        doubles as a liveness check — a socket that stops answering is dead
        long before TCP notices."""
        while True:
            await asyncio.sleep(2)
            sent = time.monotonic()
            await self.ws.send(json.dumps({"t": "ping", "ts": sent}))
            self._ping_sent = sent

    async def receiver(self):
        async for raw in self.ws:
            if isinstance(raw, bytes):
                continue                      # client never sends binary
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await self.handle(msg)

    async def handle(self, msg: dict):
        agent = self.agent
        t = msg.get("t")

        if t == "pointer":
            agent.point_at(float(msg.get("x", 0)), float(msg.get("y", 0)))

        elif t == "button":
            agent.input.button(str(msg.get("b", "left")), bool(msg.get("down")))

        elif t == "scroll":
            agent.input.scroll(dy=int(msg.get("dy", 0)), dx=int(msg.get("dx", 0)))

        elif t == "key":
            agent.input.key(int(msg.get("code", 0)), bool(msg.get("down")))

        elif t == "select":
            name = str(msg.get("monitor", ""))
            try:
                info = await asyncio.get_running_loop().run_in_executor(
                    None, agent.select, name)
            except ValueError as e:
                await self.ws.send(json.dumps({"t": "error", "detail": str(e)}))
                return
            self.seen_keyframe = False
            await self.ws.send(json.dumps({"t": "active", **info}))

        elif t == "keyframe":
            if agent.stream:
                agent.stream.force_keyframe()

        elif t == "pong":
            sent = msg.get("ts")
            if isinstance(sent, (int, float)):
                self.rtt_ms = round((time.monotonic() - sent) * 1000)


def _supplied_token(path: str, headers) -> str:
    """Token from the Authorization header, falling back to ?token=.

    The header is the right way and is what the gateway uses when it proxies.
    The query parameter exists because a BROWSER cannot set headers on a
    WebSocket handshake — there is no API for it — so a directly-connected
    client has no other option. It is second-best (URLs end up in logs and
    history), which is why the gateway path never uses it.
    """
    auth = headers.get("authorization", "") if headers else ""
    if auth.startswith("Bearer "):
        return auth[7:]
    if "?" in path:
        from urllib.parse import parse_qs, urlparse
        return (parse_qs(urlparse(path).query).get("token") or [""])[0]
    return ""


async def ws_handler(ws, agent: Agent):
    # Auth. The tailnet is the real boundary, but a token stops any other peer
    # on it — a phone, a CI runner, a housemate's laptop — from watching the
    # screen or moving the mouse.
    supplied = _supplied_token(ws.path, ws.request_headers)
    if not hmac.compare_digest(supplied, TOKEN):
        await ws.close(4401, "unauthorized")
        return

    client = Client(ws, agent)
    agent.clients.add(client)
    try:
        if not agent.active:
            default = agent.default_monitor()
            if default:
                await asyncio.get_running_loop().run_in_executor(None, agent.select, default)

        m = agent.monitor(agent.active) if agent.active else None
        await ws.send(json.dumps({
            "t": "ready",
            "name": NAME,
            "codec": "avc1.42E01E",       # baseline 3.0 — decodes everywhere
            "format": "annexb",
            "active": agent.active,
            "w": m["w"] if m else 0,
            "h": m["h"] if m else 0,
            "encoder": agent.stream.encoder_name if agent.stream else None,
            "monitors": [
                {"name": x["name"], "w": x["w"], "h": x["h"],
                 "x": x["x"], "y": x["y"], "primary": x["primary"],
                 "capturable": x.get("capturable", False)}
                for x in agent.monitors
            ],
        }))

        # A newly-attached client cannot decode until an IDR arrives, and the
        # next scheduled one may be two seconds away — which reads as a frozen
        # black rectangle on every connect.
        if agent.stream:
            agent.stream.force_keyframe()

        # TaskGroup, not gather(). gather() does NOT cancel its siblings when
        # one task raises, so on every disconnect the sender (blocked on the
        # queue), the pinger and the adapt loop would all survive as orphans —
        # a leak that grows with every connection and keeps the encoder alive
        # because the client is never removed from the set.
        async with asyncio.TaskGroup() as tg:
            tg.create_task(client.sender())
            tg.create_task(client.receiver())
            tg.create_task(client.pinger())
            tg.create_task(client.adapt())
    except* websockets.exceptions.ConnectionClosed:
        pass
    except* Exception as eg:
        for e in eg.exceptions:
            print(f"[client] {type(e).__name__}: {e}", flush=True)
    finally:
        agent.clients.discard(client)
        # Stop encoding when nobody is watching. This is the difference between
        # a service that idles at zero and one that pins a GPU forever because
        # a phone locked its screen three hours ago.
        if not agent.clients and agent.stream:
            agent.stream.stop()
            agent.stream = None
            agent.active = None


async def http_handler(path, request_headers, agent: Agent):
    """Plain HTTP alongside the WebSocket, for health and discovery.

    Returning None lets the request continue to the WebSocket handler.
    """
    if path.split("?")[0] == "/stream":
        return None   # hand off to the WebSocket handler

    if not hmac.compare_digest(_supplied_token(path, request_headers), TOKEN):
        return (HTTPStatus.UNAUTHORIZED, [("content-type", "application/json")],
                b'{"error":"unauthorized"}\n')

    if path == "/health":
        body = {
            "ok": bool(agent.monitors) and any(m.get("capturable") for m in agent.monitors),
            "name": NAME,
            "session": bool(agent.session),
            "monitors": len(agent.monitors),
            "capturable": sum(1 for m in agent.monitors if m.get("capturable")),
            "primary": next((m["name"] for m in agent.monitors if m["primary"]), None),
            "pinnedTo": pin.preferred_primary(agent.monitors) if agent.monitors else None,
            "active": agent.active,
            "clients": len(agent.clients),
            "encoder": agent.stream.encoder_name if agent.stream else None,
            # Says plainly that this no longer depends on g-r-d, and therefore
            # never moves the primary display.
            "capture": "portal-pipewire",
        }
        if not body["ok"]:
            body["reason"] = ("no capturable monitor — the portal grant may be missing; "
                              "run `python3 agent/grant.py` once at the machine")
        return (HTTPStatus.OK, [("content-type", "application/json")],
                (json.dumps(body) + "\n").encode())

    if path == "/monitors":
        agent.refresh_monitors()
        return (HTTPStatus.OK, [("content-type", "application/json")],
                (json.dumps({"monitors": agent.monitors}) + "\n").encode())

    if path.split("?")[0] == "/regrant":
        # Deliberately reachable over the network even though it raises a
        # dialog ON the machine: the whole point is that you are somewhere
        # else, notice a monitor is unreachable, and need a way to fix it that
        # does not require walking over. Someone does have to accept the
        # prompt, which is exactly the consent the portal is there to collect.
        try:
            result = await asyncio.get_running_loop().run_in_executor(
                None, agent.regrant_portal)
        except Exception as e:                                   # noqa: BLE001
            return (HTTPStatus.INTERNAL_SERVER_ERROR,
                    [("content-type", "application/json")],
                    (json.dumps({"error": str(e)}) + "\n").encode())
        return (HTTPStatus.OK, [("content-type", "application/json")],
                (json.dumps(result) + "\n").encode())

    return (HTTPStatus.NOT_FOUND, [("content-type", "application/json")],
            b'{"error":"not_found"}\n')


async def main():
    agent = Agent()
    agent.loop = asyncio.get_running_loop()
    agent.glib.start()

    try:
        agent.input.open()
    except Exception as e:                                 # noqa: BLE001
        print(f"[input] DISABLED — {e}", flush=True)

    try:
        agent.open_portal()
    except portal.PortalError as e:
        # Fatal, but say exactly what to do about it. The overwhelmingly likely
        # cause is that nobody has approved the one-time grant yet.
        sys.exit(f"portal session failed: {e}\n"
                 f"Run `python3 {os.path.dirname(os.path.abspath(__file__))}/grant.py` "
                 f"once while sitting at this machine.")

    if pin.PREFERENCE:
        threading.Thread(target=pin.watch, daemon=True).start()

    print(f"ojee-remote-agent  {NAME}  ws://{HOST}:{PORT}/stream", flush=True)
    print(f"  capture   portal + pipewire ({len(agent.streams)} monitor(s) granted)", flush=True)
    for m in agent.monitors:
        mark = "*" if m["primary"] else " "
        ok = "capturable" if m.get("capturable") else "NOT in grant"
        print(f"    {mark} {m['name']:<8} {m['w']}x{m['h']} @ {m['x']},{m['y']}  {ok}", flush=True)
    if pin.PREFERENCE:
        print(f"  primary   pinned to {' > '.join(pin.PREFERENCE)}", flush=True)
    print("  input     /dev/uinput (no portal prompt)", flush=True)

    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        agent.loop.add_signal_handler(sig, stop.set)

    async with serve(
        lambda ws: ws_handler(ws, agent),
        HOST, PORT,
        process_request=lambda p, h: http_handler(p, h, agent),
        max_size=64 * 1024,          # client messages are tiny JSON
        ping_interval=None,          # we run our own, to measure RTT
        compression=None,            # H.264 is already compressed
    ):
        await stop.wait()

    agent.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
