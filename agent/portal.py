"""Capture ANY monitor (or all of them) via the desktop portal, and inject input.

This is the piece that makes monitor switching possible without touching the
primary display.

gnome-remote-desktop streams the primary monitor and nothing else — but that is
g-r-d's choice, not a limitation of Wayland. The platform exposes two portal
interfaces that together are a complete remote desktop:

    org.freedesktop.portal.ScreenCast     v5, AvailableSourceTypes = 7
        MONITOR | WINDOW | VIRTUAL — pick any output, or several at once

    org.freedesktop.portal.RemoteDesktop  v2, AvailableDeviceTypes = 7
        KEYBOARD | POINTER | TOUCHSCREEN — full input injection

This is the same path OBS and Discord use to let you choose a screen. Frames
arrive over PipeWire; input goes back through the portal. The primary flag is
never involved, so the local desktop is never rearranged.

Two portal details that are easy to get wrong and are the difference between
"works" and "prompts every time":

  * Create the session on RemoteDesktop, then call ScreenCast.SelectSources on
    the SAME session handle. A combined session gives capture and input
    together; two separate sessions give you a picker twice and no input.

  * persist_mode=2 plus a restore_token makes the grant survive restarts. The
    portal returns a NEW token each time — it must be saved on every Start or
    the next run prompts again.
"""

from __future__ import annotations

import json
import os
import random
import string
from pathlib import Path

import dbus
import dbus.mainloop.glib
from gi.repository import GLib

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE_DESKTOP = "org.freedesktop.portal.RemoteDesktop"
SCREEN_CAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"

# SelectSources types
MONITOR, WINDOW, VIRTUAL = 1, 2, 4
# SelectDevices types
KEYBOARD, POINTER, TOUCHSCREEN = 1, 2, 4
# cursor_mode: 1 HIDDEN, 2 EMBEDDED (drawn into the frames), 4 METADATA
CURSOR_EMBEDDED = 2
# persist_mode: 0 none, 1 while the app runs, 2 until explicitly revoked
PERSIST_UNTIL_REVOKED = 2

STATE_FILE = Path(os.environ.get(
    "PORTAL_STATE",
    Path.home() / ".config" / "ojee-remote" / "portal.json",
))


def _token() -> str:
    return "ojee" + "".join(random.choices(string.ascii_lowercase + string.digits, k=12))


class PortalError(RuntimeError):
    pass


class PortalSession:
    """A combined RemoteDesktop + ScreenCast session.

    Usage:
        s = PortalSession()
        streams = s.start()          # prompts ONCE, then restores silently
        s.move_pointer(stream, x, y)
        s.click(stream, button, pressed)
    """

    def __init__(self, bus: dbus.SessionBus | None = None):
        self.bus = bus or dbus.SessionBus()
        self.obj = self.bus.get_object(PORTAL, PORTAL_PATH)
        self.rd = dbus.Interface(self.obj, REMOTE_DESKTOP)
        self.sc = dbus.Interface(self.obj, SCREEN_CAST)
        self.session = None
        self.streams: list[dict] = []
        self._sender = self.bus.get_unique_name()[1:].replace(".", "_")

    # ── request plumbing ────────────────────────────────────────────────
    def _await_request(self, call, options: dict, timeout_ms: int = 120_000):
        """Make a portal call and block on its Response signal.

        Every portal method returns a Request object path and answers later on
        a signal. The handle_token must be computed the same way the portal
        does, or we subscribe to a path that never fires and hang forever.
        """
        token = _token()
        options = dict(options)
        options["handle_token"] = token
        path = f"/org/freedesktop/portal/desktop/request/{self._sender}/{token}"

        loop = GLib.MainLoop()
        result: dict = {}

        def on_response(code, results):
            result["code"] = int(code)
            result["results"] = results
            loop.quit()

        match = self.bus.add_signal_receiver(
            on_response, signal_name="Response", dbus_interface=REQUEST, path=path,
        )

        def on_timeout():
            result["code"] = -1
            result["results"] = {}
            loop.quit()
            return False

        timer = GLib.timeout_add(timeout_ms, on_timeout)

        try:
            call(options)
            loop.run()
        finally:
            match.remove()
            GLib.source_remove(timer)

        if result.get("code") == -1:
            raise PortalError("portal did not respond — was the dialog dismissed?")
        if result.get("code") != 0:
            # 1 = cancelled by the user, 2 = ended some other way.
            raise PortalError(f"portal request refused (code {result.get('code')})")
        return result["results"]

    # ── persistence ─────────────────────────────────────────────────────
    def _load_tokens(self) -> dict:
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:                       # noqa: BLE001
            return {}

    def _save_tokens(self, data: dict) -> None:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(data, indent=2))
        STATE_FILE.chmod(0o600)

    # ── lifecycle ───────────────────────────────────────────────────────
    def start(self, *, multiple: bool = True) -> list[dict]:
        """Open the session and begin capture.

        Prompts the first time. After that the restore token makes it silent —
        which matters, because a remote-desktop service that needs someone
        sitting at the machine to click Allow is not a remote-desktop service.
        """
        saved = self._load_tokens()

        session_token = _token()
        res = self._await_request(
            lambda o: self.rd.CreateSession(o),
            {"session_handle_token": session_token},
        )
        self.session = res["session_handle"]

        # Input devices. Requested on the RemoteDesktop session so that the
        # same grant covers pointer and keyboard.
        self._await_request(
            lambda o: self.rd.SelectDevices(self.session, o),
            {
                "types": dbus.UInt32(KEYBOARD | POINTER),
                "persist_mode": dbus.UInt32(PERSIST_UNTIL_REVOKED),
                **({"restore_token": saved["devices"]} if saved.get("devices") else {}),
            },
        )

        # Sources — on the SAME session handle. `multiple` asks for every
        # monitor at once; if the shell only grants one, we still get a usable
        # session with that one, which is why this is not fatal either way.
        self._await_request(
            lambda o: self.sc.SelectSources(self.session, o),
            {
                "types": dbus.UInt32(MONITOR),
                "multiple": multiple,
                "cursor_mode": dbus.UInt32(CURSOR_EMBEDDED),
                "persist_mode": dbus.UInt32(PERSIST_UNTIL_REVOKED),
                **({"restore_token": saved["sources"]} if saved.get("sources") else {}),
            },
        )

        started = self._await_request(
            lambda o: self.rd.Start(self.session, "", o),
            {},
        )

        # The portal hands back a NEW restore token on every Start. Saving it
        # each time is what keeps the grant alive; reusing the old one after a
        # restart re-prompts.
        tokens = dict(saved)
        if "restore_token" in started:
            tokens["devices"] = str(started["restore_token"])
            tokens["sources"] = str(started["restore_token"])
        self._save_tokens(tokens)

        self.streams = []
        for node_id, props in started.get("streams", []):
            pos = tuple(props.get("position", (0, 0)))
            size = tuple(props.get("size", (0, 0)))
            self.streams.append({
                "node_id": int(node_id),
                "x": int(pos[0]), "y": int(pos[1]),
                "w": int(size[0]), "h": int(size[1]),
                "source_type": int(props.get("source_type", MONITOR)),
                "id": str(props.get("id", node_id)),
            })
        # Left-to-right, so the numbering a user sees matches the desk.
        self.streams.sort(key=lambda s: (s["x"], s["y"]))
        return self.streams

    def close(self) -> None:
        if not self.session:
            return
        try:
            dbus.Interface(
                self.bus.get_object(PORTAL, self.session),
                "org.freedesktop.portal.Session",
            ).Close()
        except dbus.DBusException:
            pass
        self.session = None

    # ── input ───────────────────────────────────────────────────────────
    # Coordinates are per-stream, so a click lands on the monitor the user is
    # actually looking at without any global-coordinate arithmetic.
    def move_pointer(self, stream_node_id: int, x: float, y: float) -> None:
        self.rd.NotifyPointerMotionAbsolute(
            self.session, {}, dbus.UInt32(stream_node_id), float(x), float(y))

    def button(self, code: int, pressed: bool) -> None:
        # evdev button codes: BTN_LEFT 0x110, BTN_RIGHT 0x111, BTN_MIDDLE 0x112
        self.rd.NotifyPointerButton(self.session, {}, dbus.Int32(code), dbus.UInt32(1 if pressed else 0))

    def scroll(self, dx: float, dy: float) -> None:
        self.rd.NotifyPointerAxis(self.session, {}, float(dx), float(dy))

    def key(self, keysym: int, pressed: bool) -> None:
        self.rd.NotifyKeyboardKeysym(self.session, {}, dbus.Int32(keysym), dbus.UInt32(1 if pressed else 0))


BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112


# ── the capture-only path, which is the one actually used ─────────────────
#
# PortalSession above asks for input as well, which GNOME refuses to persist
# ("Remote desktop sessions cannot persist"). It is kept because it documents
# that dead end. Everything below is capture-only, which DOES persist — the
# input half is handled by inject.py through /dev/uinput instead.

def _bus_and_iface():
    bus = dbus.SessionBus()
    obj = bus.get_object(PORTAL, PORTAL_PATH)
    return bus, dbus.Interface(obj, SCREEN_CAST)


def _request(bus, iface_call, options: dict, timeout_ms: int = 300_000):
    """Portal call + block on its Response signal."""
    sender = bus.get_unique_name()[1:].replace(".", "_")
    token = _token()
    options = dict(options)
    options["handle_token"] = token
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"

    loop = GLib.MainLoop()
    out: dict = {}

    def on_response(code, results):
        out["code"] = int(code)
        out["results"] = results
        loop.quit()

    match = bus.add_signal_receiver(
        on_response, signal_name="Response", dbus_interface=REQUEST, path=path)

    def on_timeout():
        out["code"] = -1
        out["results"] = {}
        loop.quit()
        return False

    timer = GLib.timeout_add(timeout_ms, on_timeout)
    try:
        iface_call(options)
        loop.run()
    finally:
        match.remove()
        GLib.source_remove(timer)

    code = out.get("code")
    if code == -1:
        raise PortalError("portal did not respond in time")
    if code == 1:
        raise PortalError("permission dialog was cancelled")
    if code != 0:
        raise PortalError(f"portal refused the request (code {code})")
    return out["results"]


def open_screencast(multiple: bool = True):
    """Open a persistent capture session.

    Prompts once, ever. After that the saved restore_token makes it silent —
    measured at 0.05s with no dialog — which is what allows this to run as an
    unattended service.

    @returns (session_handle, [{node_id, x, y, w, h}])
    """
    bus, sc = _bus_and_iface()
    saved = {}
    try:
        saved = json.loads(STATE_FILE.read_text())
    except Exception:                                     # noqa: BLE001
        pass

    res = _request(bus, lambda o: sc.CreateSession(o),
                   {"session_handle_token": _token()})
    session = res["session_handle"]

    opts = {
        "types": dbus.UInt32(MONITOR),
        "multiple": multiple,
        "cursor_mode": dbus.UInt32(CURSOR_EMBEDDED),
        "persist_mode": dbus.UInt32(PERSIST_UNTIL_REVOKED),
    }
    if saved.get("sources"):
        opts["restore_token"] = saved["sources"]
    _request(bus, lambda o: sc.SelectSources(session, o), opts)

    started = _request(bus, lambda o: sc.Start(session, "", o), {})

    # The portal issues a NEW token on every Start. Saving it every time is
    # what keeps the grant alive; reusing a stale one re-prompts.
    if "restore_token" in started:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"sources": str(started["restore_token"])}, indent=2))
        STATE_FILE.chmod(0o600)

    streams = []
    for node_id, props in started.get("streams", []):
        pos = tuple(props.get("position", (0, 0)))
        size = tuple(props.get("size", (0, 0)))
        streams.append({
            "node_id": int(node_id),
            "x": int(pos[0]), "y": int(pos[1]),
            "w": int(size[0]), "h": int(size[1]),
        })
    streams.sort(key=lambda s: (s["x"], s["y"]))

    # Stash the bus so open_pipewire_fd can reuse the same connection — the
    # session handle is only valid on the connection that created it.
    _SESSIONS[session] = (bus, sc)
    return session, streams


_SESSIONS: dict = {}


def open_pipewire_fd(session: str) -> int:
    """A fresh PipeWire fd for one pipeline.

    One per pipeline, never shared: `pipewiresrc` takes ownership and closes it
    on teardown, so a second pipeline handed the same fd silently produces no
    frames at all — which looks exactly like a dead monitor.
    """
    entry = _SESSIONS.get(session)
    if not entry:
        raise PortalError("unknown session — call open_screencast() first")
    _bus, sc = entry
    return sc.OpenPipeWireRemote(session, {}, dbus_interface=SCREEN_CAST).take()


def close_session(session: str | None) -> None:
    if not session:
        return
    entry = _SESSIONS.pop(session, None)
    if not entry:
        return
    bus, _sc = entry
    try:
        dbus.Interface(bus.get_object(PORTAL, session),
                       "org.freedesktop.portal.Session").Close()
    except dbus.DBusException:
        pass
