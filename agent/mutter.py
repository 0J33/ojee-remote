"""Capture every monitor through mutter's own ScreenCast API. No dialog, ever.

The desktop portal (portal.py) is built around consent: a person ticks the
monitors to share, and a restore token replays exactly that selection. It
cannot replay anything else. Plug in a monitor, unplug one, boot with the lid
closed - the saved selection no longer matches the desk, the restore fails,
and GNOME puts the picker back on the screen. For a machine that is meant to be
reached from somewhere else, a dialog nobody is there to answer (behind the
lock screen, at that) is an outage.

The portal is a front end. Underneath it, xdg-desktop-portal-gnome calls

    org.gnome.Mutter.ScreenCast            CreateSession
    org.gnome.Mutter.ScreenCast.Session    RecordMonitor(connector) / Start
    org.gnome.Mutter.ScreenCast.Stream     PipeWireStreamAdded(node_id)

on the session bus, and so does gnome-remote-desktop. Calling it directly
records a monitor BY CONNECTOR NAME, so "all monitors" is simply every connector
mutter reports right now, re-read on each hotplug. Frames arrive on the user's
own PipeWire daemon, so no portal fd is involved either.

The shell still shows its screen-sharing indicator while this runs; that stays
visible on purpose.

Same surface as the capture half of portal.py, so the service can use either:
open_screencast(), open_pipewire_fd(), close_session(), forget_token().
"""

from __future__ import annotations

import threading
import time

import dbus
import dbus.mainloop.glib

import display

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

BUS_NAME = "org.gnome.Mutter.ScreenCast"
BUS_PATH = "/org/gnome/Mutter/ScreenCast"
IFACE = "org.gnome.Mutter.ScreenCast"
SESSION_IFACE = IFACE + ".Session"
STREAM_IFACE = IFACE + ".Stream"

# cursor-mode: 0 hidden, 1 embedded, 2 metadata. Hidden: the browser draws the
# pointer itself (an X11 session never embeds it), and embedding it as well
# would show two on a Wayland session.
CURSOR_HIDDEN = 0

STREAM_WAIT_S = 8.0


class MutterError(RuntimeError):
    pass


def available(wait_s: float = 0.0) -> bool:
    """Whether mutter's ScreenCast service is on the bus.

    At login the agent can start a moment before gnome-shell has claimed the
    name, so the caller may wait for it rather than falling back early."""
    bus = dbus.SessionBus()
    deadline = time.monotonic() + wait_s
    while True:
        try:
            if bus.name_has_owner(BUS_NAME):
                return True
        except dbus.DBusException:
            pass
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.5)


_SESSIONS: dict = {}


def open_screencast(on_closed=None):
    """Record every monitor mutter currently reports.

    Needs a GLib main loop already running on another thread (the agent's
    capture.GLibLoop): PipeWireStreamAdded is delivered there.

    @returns (session_path, [{node_id, name, x, y, w, h}])
    """
    bus = dbus.SessionBus()
    try:
        monitors = display.list_monitors()
    except dbus.DBusException as e:
        raise MutterError(f"cannot read the monitor layout: {e}") from e
    if not monitors:
        raise MutterError("mutter reports no monitors")

    try:
        sc = dbus.Interface(bus.get_object(BUS_NAME, BUS_PATH), IFACE)
        session_path = str(sc.CreateSession(dbus.Dictionary({}, signature="sv")))
    except dbus.DBusException as e:
        raise MutterError(f"mutter refused a screencast session: {e}") from e
    session = dbus.Interface(bus.get_object(BUS_NAME, session_path), SESSION_IFACE)

    pending: dict[str, dict] = {}      # stream object path -> monitor
    nodes: dict[str, int] = {}
    all_added = threading.Event()

    def on_stream_added(node_id, path=None):
        path = str(path)
        if path in pending and path not in nodes:
            nodes[path] = int(node_id)
            if len(nodes) == len(pending):
                all_added.set()

    # Subscribed BEFORE Start: the node ids are announced once, immediately.
    added_match = bus.add_signal_receiver(
        on_stream_added, signal_name="PipeWireStreamAdded",
        dbus_interface=STREAM_IFACE, path_keyword="path")

    def on_session_closed():
        entry = _SESSIONS.get(session_path)
        if entry and not entry["closing"] and on_closed:
            on_closed(session_path)

    closed_match = bus.add_signal_receiver(
        on_session_closed, signal_name="Closed",
        dbus_interface=SESSION_IFACE, path=session_path)

    _SESSIONS[session_path] = {"session": session, "matches": [added_match, closed_match],
                               "closing": False}

    try:
        for m in monitors:
            # A connector can vanish between reading the layout and recording
            # it (a cable mid-unplug). Skip it; the layout watcher sees the
            # change on its next poll and rebuilds.
            try:
                stream_path = session.RecordMonitor(
                    m["name"],
                    dbus.Dictionary({"cursor-mode": dbus.UInt32(CURSOR_HIDDEN)}, signature="sv"))
                pending[str(stream_path)] = m
            except dbus.DBusException as e:
                print(f"[mutter] cannot record {m['name']}: {e.get_dbus_message()}", flush=True)
        if not pending:
            raise MutterError("mutter would not record any monitor")

        session.Start()
        if not all_added.wait(STREAM_WAIT_S) and not nodes:
            raise MutterError("mutter started the session but announced no PipeWire streams")
    except Exception:
        close_session(session_path)
        raise
    finally:
        try:
            added_match.remove()   # close_session may already have removed it
        except Exception:                                  # noqa: BLE001
            pass

    streams = []
    for path, m in pending.items():
        if path not in nodes:
            print(f"[mutter] {m['name']} never announced a stream", flush=True)
            continue
        streams.append({"node_id": nodes[path], "name": m["name"],
                        "x": m["x"], "y": m["y"], "w": m["w"], "h": m["h"]})
    streams.sort(key=lambda s: (s["x"], s["y"]))
    return session_path, streams


def open_pipewire_fd(_session: str):
    """None: mutter's nodes live on the user's own PipeWire daemon, which
    pipewiresrc reaches without being handed a descriptor."""
    return None


def close_session(session_path: str | None) -> None:
    entry = _SESSIONS.pop(session_path, None) if session_path else None
    if not entry:
        return
    entry["closing"] = True
    for match in entry["matches"]:
        try:
            match.remove()
        except Exception:                                  # noqa: BLE001
            pass
    try:
        entry["session"].Stop()
    except dbus.DBusException:
        pass                                               # already gone


def forget_token() -> bool:
    """Nothing to forget: there is no grant. Kept for the portal's interface."""
    return False
