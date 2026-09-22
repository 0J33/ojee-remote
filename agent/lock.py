"""Whether this machine's screen is locked, and lifting the lock.

Remoting into a locked machine is the normal case, not an edge case — the
laptop locks itself while you are away, which is precisely when you want to
reach it. The old behaviour handled that badly in both directions:

  * through the agent, GNOME refuses to capture at all while locked (the
    shell inhibits screencasts on its lock screen), so there is no picture —
    not even of the lock screen. service.py tells the viewer "locked" and
    starts the picture the moment the lock lifts.

  * through RDP, gnome-remote-desktop on a locked session frequently refuses
    the connection outright. guacd reports upstream failure, the client
    reconnects, and it fails again for the same reason, forever. That loop is
    what this exists to end: the answer to "it is locked" is to unlock it, not
    to dial again.

The lock is lifted without a password, which is the right trade here and worth
being explicit about. Reaching this code already required the gateway's session
and this machine's agent token; re-asking for a password would protect nothing
those two do not already protect, while guaranteeing that the one situation you
most need remote access in is the one where it does not work.

Two mechanisms, because neither is reliable alone. On this laptop — GNOME 4x on
X11 — `loginctl unlock-session` returns success and the screen stays locked:
logind records the request, and the shell's own lock screen does not act on it.
`org.gnome.ScreenSaver.SetActive false` does clear it. On other shells and under
Wayland the reverse is true, so both are tried and the SCREEN, not the exit
code, decides whether it worked.
"""

import getpass
import os
import subprocess
import time

TIMEOUT = 5
GRAPHICAL = {"x11", "wayland", "mir"}


def _loginctl(*args: str) -> str:
    try:
        return subprocess.run(
            ["loginctl", *args], capture_output=True, text=True, timeout=TIMEOUT,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _show(session: str, prop: str) -> str:
    return _loginctl("show-session", session, "-p", prop, "--value")


def session_id() -> str | None:
    """This user's graphical session.

    `XDG_SESSION_ID` is set for a login shell but not reliably for a user unit,
    so it is a hint rather than the answer. Falling back to the session list
    and picking the graphical one keeps this working under systemd --user,
    which is how the agent actually runs.
    """
    env = os.environ.get("XDG_SESSION_ID")
    if env and _show(env, "Type") in GRAPHICAL:
        return env

    me = getpass.getuser()
    best = None
    for line in _loginctl("list-sessions", "--no-legend").splitlines():
        parts = line.split()
        if len(parts) < 3 or parts[2] != me:
            continue
        sid = parts[0]
        if _show(sid, "Type") not in GRAPHICAL:
            continue
        # An active session beats an inactive one; a switched-away session is
        # still the one to unlock if it is all there is.
        if _show(sid, "Active") == "yes":
            return sid
        best = best or sid
    return best


def state() -> dict:
    """What the screen is doing, in the terms the UI needs to say it."""
    sid = session_id()
    if not sid:
        return {"locked": None, "session": None, "type": None,
                "reason": "no graphical session for this user"}
    hint = _show(sid, "LockedHint")
    return {
        "locked": hint == "yes",
        "session": sid,
        "type": _show(sid, "Type") or None,
        "active": _show(sid, "Active") == "yes",
    }


def _settle(want_locked: bool, seconds: float = 3.0) -> dict:
    """Wait for the shell to catch up, then report.

    Reading the state immediately after asking for an unlock reports the lock
    that is one moment from being lifted — which is how a working unlock gets
    reported as a failure.
    """
    deadline = time.monotonic() + seconds
    st = state()
    while time.monotonic() < deadline:
        if st["locked"] == want_locked:
            return st
        time.sleep(0.15)
        st = state()
    return st


def _logind_unlock(sid: str) -> str | None:
    try:
        r = subprocess.run(["loginctl", "unlock-session", sid],
                           capture_output=True, text=True, timeout=TIMEOUT)
        if r.returncode != 0:
            return (r.stderr or r.stdout or "unlock-session failed").strip()
    except (OSError, subprocess.SubprocessError) as e:
        return str(e)
    return None


def _shell_unlock() -> str | None:
    """Tell the shell's own screensaver to deactivate.

    Needs this user's session bus. The agent runs as a user unit so it has one;
    if it is ever run some other way, saying so beats a silent no-op.
    """
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        return "no session bus (DBUS_SESSION_BUS_ADDRESS is unset)"
    for cmd in (
        ["gdbus", "call", "--session", "--dest", "org.gnome.ScreenSaver",
         "--object-path", "/org/gnome/ScreenSaver",
         "--method", "org.gnome.ScreenSaver.SetActive", "false"],
        ["dbus-send", "--session", "--dest=org.gnome.ScreenSaver",
         "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.SetActive",
         "boolean:false"],
    ):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
            if r.returncode == 0:
                return None
            last = (r.stderr or r.stdout or "").strip()
        except FileNotFoundError:
            last = f"{cmd[0]} is not installed"
        except (OSError, subprocess.SubprocessError) as e:
            last = str(e)
    return last or "screensaver would not deactivate"


def unlock() -> dict:
    """Lift the lock, and report what the screen is doing afterwards."""
    sid = session_id()
    if not sid:
        return {"ok": False, "error": "no graphical session for this user"}

    if not state()["locked"]:
        # Saying "it was not locked" beats reporting a successful unlock that
        # did nothing: the caller is trying to explain a failed connection and
        # needs to know the lock was not the reason.
        return {"ok": True, "was_locked": False, **state()}

    errors = [e for e in (_logind_unlock(sid), _shell_unlock()) if e]
    after = _settle(want_locked=False)

    out = {"ok": not after["locked"], "was_locked": True, **after}
    if after["locked"] and errors:
        out["error"] = "; ".join(errors)
    return out
