"""Monitor layout and primary-monitor switching, via mutter's DisplayConfig.

Why DBus and not xrandr: this has to work on Wayland, where xrandr sees
nothing. GetCurrentState is also session-type independent, so the same code
covers an Xorg session without a second path.

Why this matters at all: gnome-remote-desktop's screen share streams the
PRIMARY monitor and only the primary monitor. There is no `+multimon` on the
server side. So "switch to monitor 2" means "make monitor 2 primary", which
tears down and rebuilds the RDP session — and that teardown is the black
screen and the reconnect loop this project exists to fix.

The fix is not to avoid the teardown; it is to know exactly when it has
finished. `apply_primary()` therefore does not return until mutter confirms
the new primary is live, so the caller never has to guess.
"""

from __future__ import annotations

import os
import socket
import subprocess
import time

import dbus

BUS_NAME = "org.gnome.Mutter.DisplayConfig"
BUS_PATH = "/org/gnome/Mutter/DisplayConfig"

# Method 1 = "temporary": applies immediately, shows no confirmation dialog,
# and is not written to monitors.xml. Exactly right for a switch that should
# not survive a reboot — the desktop comes back the way the user left it.
METHOD_TEMPORARY = 1

# The systemd user unit serving RDP. Overridable for a distro that names it
# differently, or for a setup using a different remote-desktop server.
RDP_UNIT = os.environ.get("RDP_UNIT", "gnome-remote-desktop")


def _iface():
    bus = dbus.SessionBus()
    obj = bus.get_object(BUS_NAME, BUS_PATH)
    return dbus.Interface(obj, BUS_NAME)


def _state(iface):
    # (serial, monitors, logical_monitors, properties)
    return iface.GetCurrentState()


def list_monitors() -> list[dict]:
    """Current layout as plain dicts, in left-to-right order.

    Sorted by x so the numbering the UI shows ("1", "2", "3") matches the
    physical arrangement on the desk. Unsorted DBus order is arbitrary, which
    made the on-screen chips disagree with reality.
    """
    iface = _iface()
    _serial, monitors, logical, _props = _state(iface)

    out = []
    for x, y, scale, transform, primary, specs, _lprops in logical:
        for spec in specs:
            connector = str(spec[0])
            w = h = 0
            for mon in monitors:                     # (spec4, modes, props)
                if str(mon[0][0]) != connector:
                    continue
                for mode in mon[1]:                  # (id, w, h, rate, pref, scales, props)
                    if mode[6].get("is-current", False):
                        w, h = int(mode[1]), int(mode[2])
            # A 90/270 rotation swaps the logical dimensions. Without this a
            # portrait monitor reports landscape and the client crops wrong.
            if int(transform) % 2 == 1:
                w, h = h, w
            out.append({
                "name": connector,
                "x": int(x),
                "y": int(y),
                "w": round(w / float(scale)),
                "h": round(h / float(scale)),
                "scale": float(scale),
                "transform": int(transform),
                "primary": bool(primary),
            })

    out.sort(key=lambda m: (m["x"], m["y"]))
    return out


def current_primary() -> str | None:
    for m in list_monitors():
        if m["primary"]:
            return m["name"]
    return None


def _current_mode_id(monitors, connector: str) -> str:
    for mon in monitors:
        if str(mon[0][0]) == connector:
            for mode in mon[1]:
                if mode[6].get("is-current", False):
                    return str(mode[0])
    raise RuntimeError(f"no current mode for {connector}")


def _port_accepts(host: str, port: int, timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def apply_primary(target: str, *, rdp_port: int = 3390, rdp_host: str = "127.0.0.1",
                  timeout: float = 25.0, restart_rdp: bool = True) -> dict:
    """Make `target` the primary monitor and wait until the switch has landed.

    Every logical monitor keeps its position, mode, scale and transform — only
    the primary flag moves. Rebuilding the layout from GetCurrentState rather
    than sending a partial config is deliberate: ApplyMonitorsConfig replaces
    the WHOLE configuration, so anything omitted is silently dropped.

    Returns timings so the caller can tell a fast switch from a slow one
    instead of applying one fixed guess to both.
    """
    started = time.monotonic()

    iface = _iface()
    serial, monitors, logical, _props = _state(iface)

    connectors: list[str] = []
    new_logical = []
    for x, y, scale, transform, _primary, specs, _lprops in logical:
        conns = [str(spec[0]) for spec in specs]
        connectors.extend(conns)
        assigns = dbus.Array(
            [dbus.Struct((c, _current_mode_id(monitors, c), dbus.Dictionary({}, signature="sv")))
             for c in conns],
            signature="(ssa{sv})")
        new_logical.append(dbus.Struct((
            dbus.Int32(x), dbus.Int32(y), dbus.Double(scale), dbus.UInt32(transform),
            dbus.Boolean(target in conns), assigns)))

    if target not in connectors:
        raise ValueError(f"unknown connector {target!r}; have {connectors}")

    if current_primary() == target:
        # Already there. Returning early keeps a double-tap from tearing down a
        # perfectly good session for no reason.
        return {"ok": True, "primary": target, "changed": False, "waitedMs": 0}

    iface.ApplyMonitorsConfig(
        serial, dbus.UInt32(METHOD_TEMPORARY),
        dbus.Array(new_logical, signature="(iiduba(ssa{sv}))"),
        dbus.Dictionary({}, signature="sv"))

    # ── wait for it to actually land ────────────────────────────────────
    # ApplyMonitorsConfig returns as soon as the request is accepted, not when
    # the compositor has finished. Returning here is what made the old client
    # reconnect into a half-rebuilt session and get a black frame.
    deadline = started + timeout
    confirmed_at = None
    while time.monotonic() < deadline:
        try:
            if current_primary() == target:
                confirmed_at = time.monotonic()
                break
        except dbus.DBusException:
            # The compositor can be briefly unavailable mid-reconfigure. That
            # is expected, not an error — keep polling.
            pass
        time.sleep(0.15)

    if confirmed_at is None:
        raise TimeoutError(f"mutter did not report {target} as primary within {timeout}s")

    # ── restart gnome-remote-desktop ────────────────────────────────────
    # This is the part that took the longest to find, and it is not optional.
    #
    # After the primary monitor changes, g-r-d keeps its TCP listener open and
    # keeps completing the RDP handshake — NLA succeeds, guacd loads its
    # keymaps, the audio format is negotiated — and then no graphics ever
    # arrive. From the client's side it is indistinguishable from a slow
    # network, which is exactly why the previous build sat on a black screen
    # and retried forever: every signal it could see said "connected".
    #
    # Reproduced deliberately: switch primary, connect, get a session with no
    # frames; restart g-r-d, connect again, get a working session immediately.
    #
    # So the switch is not "move the flag"; it is "move the flag and rebuild
    # the server". ~2-3s, and it turns an unreliable operation into a
    # deterministic one. A user service, so no sudo is involved.
    restarted = False
    if restart_rdp:
        try:
            subprocess.run(
                ["systemctl", "--user", "restart", RDP_UNIT],
                check=True, capture_output=True, timeout=15,
            )
            restarted = True
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
            # Do not fail the switch. The primary DID move; a client that
            # reconnects may still get lucky, and reporting the restart failure
            # is more useful than pretending the whole thing failed.
            restarted = False
            restart_error = getattr(e, "stderr", b"") or str(e).encode()
            print(f"[warn] could not restart {RDP_UNIT}: {restart_error[:200]!r}", flush=True)

    # Then wait for it to be accepting again. Reconnecting into the window
    # where the listener is down is a guaranteed failed handshake.
    port_ok = False
    while time.monotonic() < deadline:
        if _port_accepts(rdp_host, rdp_port):
            port_ok = True
            break
        time.sleep(0.15)

    return {
        "ok": True,
        "primary": target,
        "changed": True,
        "confirmedMs": round((confirmed_at - started) * 1000),
        "waitedMs": round((time.monotonic() - started) * 1000),
        "rdpAccepting": port_ok,
        "rdpRestarted": restarted,
    }
