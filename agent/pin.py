"""Keep the primary monitor where the *human* wants it.

The primary monitor is not a remote-desktop implementation detail. It decides
where GNOME puts the top bar, where the dock lives, where new windows open and
where full-screen apps land. Moving it rearranges the physical desk.

gnome-remote-desktop streams the primary monitor and only the primary monitor,
which makes "move the primary" a tempting way to implement "show me a different
screen". It is the wrong trade: it fixes the remote view by breaking the local
desk, and it breaks it for whoever is sitting at the machine.

So this module does the opposite. It enforces a PREFERRED primary — a priority
list of connectors — and puts it back if anything moves it:

    PRIMARY_PREFERENCE=DP-1,eDP-1

means "the external monitor when it is plugged in, the built-in panel when it
is not". Docking and undocking a laptop then does the right thing on its own,
which is the case that motivated this in the first place.
"""

from __future__ import annotations

import os
import time

import display

# Ordered most-preferred first. The first one currently connected wins.
PREFERENCE = [
    c.strip() for c in os.environ.get("PRIMARY_PREFERENCE", "").split(",") if c.strip()
]
# How often to re-check. Hotplug is the event that matters and it is rare, so
# this is deliberately lazy — it is a safety net, not a control loop.
CHECK_SECONDS = int(os.environ.get("PRIMARY_CHECK_SECONDS", "20"))


def preferred_primary(monitors: list[dict]) -> str | None:
    """The connector that SHOULD be primary right now, or None if unset."""
    if not PREFERENCE:
        return None
    connected = {m["name"] for m in monitors}
    for name in PREFERENCE:
        if name in connected:
            return name
    # Every preferred connector is unplugged. Leave whatever is primary alone
    # rather than picking arbitrarily — a guess here moves the user's desktop
    # for no reason.
    return None


def enforce_once() -> dict:
    """Put the primary back if it has drifted. Returns what it did."""
    monitors = display.list_monitors()
    want = preferred_primary(monitors)
    have = next((m["name"] for m in monitors if m["primary"]), None)

    if not want:
        return {"enforced": False, "reason": "no PRIMARY_PREFERENCE connected", "primary": have}
    if want == have:
        return {"enforced": False, "reason": "already correct", "primary": have}

    # Restoring the primary must NOT restart the RDP server. A restart here
    # would drop a live remote session every time the user docked a monitor,
    # which is the opposite of helpful.
    display.apply_primary(want, restart_rdp=False)
    return {"enforced": True, "from": have, "primary": want}


def watch(stop=None) -> None:
    """Background loop. Runs inside the agent so there is one service, not two."""
    if not PREFERENCE:
        return
    while stop is None or not stop.is_set():
        try:
            result = enforce_once()
            if result.get("enforced"):
                print(f"[pin] primary {result['from']} -> {result['primary']}", flush=True)
        except Exception as e:                       # noqa: BLE001
            # A transient DBus failure during a hotplug is expected. Never let
            # this loop take the agent down.
            print(f"[pin] check failed: {type(e).__name__}: {e}", flush=True)
        time.sleep(CHECK_SECONDS)
