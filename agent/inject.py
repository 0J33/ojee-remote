"""Input injection via /dev/uinput.

The portal's RemoteDesktop interface can do this too, but GNOME refuses to
persist an input grant — `Remote desktop sessions cannot persist` — so it would
pop a permission dialog on every single connection. A remote desktop that needs
somebody sitting at the machine to click Allow is not a remote desktop.

uinput sits below the compositor: the kernel presents a virtual input device and
Wayland treats it exactly like a real mouse and keyboard. No portal, no prompt,
no Wayland/X11 distinction.

Why not shell out to ydotool: it spawns a process per event. A remote desktop
emits tens of events a second while you drag something, and process spawn
latency shows up directly as lag. This opens the device once and writes packed
structs to it — the same thing ydotool does internally, minus the fork.

Permissions: /dev/uinput must be writable. On this system it already is, via an
ACL granting the desktop user (`user:ojee:rw-`). Elsewhere, adding the user to
`input` plus a udev rule does it:

    KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"

The device is ABSOLUTE, not relative. A remote view is a coordinate space — the
client knows where the pointer should be, not how far to nudge it — and relative
motion accumulates drift and is mangled by pointer acceleration.
"""

from __future__ import annotations

import fcntl
import os
import struct
import threading
import time

UINPUT = "/dev/uinput"

# ── ioctls (linux/uinput.h) ────────────────────────────────────────────────
UINPUT_IOCTL_BASE = ord("U")


def _IOW(nr: int, size: int) -> int:
    return (1 << 30) | (size << 16) | (UINPUT_IOCTL_BASE << 8) | nr


def _IO(nr: int) -> int:
    return (UINPUT_IOCTL_BASE << 8) | nr


UI_DEV_CREATE = _IO(1)
UI_DEV_DESTROY = _IO(2)
UI_SET_EVBIT = _IOW(100, 4)
UI_SET_KEYBIT = _IOW(101, 4)
UI_SET_RELBIT = _IOW(102, 4)
UI_SET_ABSBIT = _IOW(103, 4)

# ── event codes (linux/input-event-codes.h) ────────────────────────────────
EV_SYN, EV_KEY, EV_REL, EV_ABS = 0x00, 0x01, 0x02, 0x03
SYN_REPORT = 0
ABS_X, ABS_Y = 0x00, 0x01
REL_WHEEL, REL_HWHEEL = 0x08, 0x06
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112

# The virtual pointer reports 0..ABS_MAX on each axis regardless of the real
# desktop size. The caller sends a fraction of the monitor it is looking at, so
# nothing downstream has to know the pixel geometry — and a monitor that changes
# resolution needs no reconfiguration here.
ABS_MAX = 65535

BUTTONS = {"left": BTN_LEFT, "right": BTN_RIGHT, "middle": BTN_MIDDLE}


class VirtualInput:
    """One virtual absolute pointer + keyboard, held open for the process life."""

    def __init__(self, name: str = "ojee-remote virtual input"):
        self.name = name
        self.fd = None
        self._lock = threading.Lock()

    # ── setup ──────────────────────────────────────────────────────────
    def open(self) -> None:
        if self.fd is not None:
            return
        try:
            self.fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
        except PermissionError as e:
            raise PermissionError(
                f"cannot open {UINPUT} for writing ({e}). Add the user to the 'input' "
                f"group and install a udev rule, or grant an ACL: "
                f"setfacl -m u:$USER:rw {UINPUT}"
            ) from e
        except FileNotFoundError as e:
            raise FileNotFoundError(
                f"{UINPUT} does not exist — load the module with: sudo modprobe uinput"
            ) from e

        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_ABS)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_REL)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_SYN)

        for btn in (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, btn)
        # Every keyboard key. Declaring the whole range up front means the
        # device never has to be recreated for a key we did not anticipate —
        # and recreating it mid-session drops modifier state.
        for code in range(1, 249):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)

        fcntl.ioctl(self.fd, UI_SET_ABSBIT, ABS_X)
        fcntl.ioctl(self.fd, UI_SET_ABSBIT, ABS_Y)
        fcntl.ioctl(self.fd, UI_SET_RELBIT, REL_WHEEL)
        fcntl.ioctl(self.fd, UI_SET_RELBIT, REL_HWHEEL)

        # Legacy uinput_user_dev: name[80], input_id{bustype,vendor,product,
        # version}, ff_effects_max, then absmax/absmin/absfuzz/absflat[64].
        # Preferred over UI_DEV_SETUP because it is supported on every kernel
        # this is likely to meet, including older LTS.
        absmax = [0] * 64
        absmin = [0] * 64
        absmax[ABS_X] = ABS_MAX
        absmax[ABS_Y] = ABS_MAX

        payload = struct.pack(
            "80sHHHHi",
            self.name.encode()[:79],
            0x03,     # BUS_USB — some stacks ignore a device on an unknown bus
            0x1234, 0x5678, 1,
            0,        # ff_effects_max
        )
        payload += struct.pack("64i", *absmax)
        payload += struct.pack("64i", *absmin)
        payload += struct.pack("64i", *([0] * 64))   # absfuzz
        payload += struct.pack("64i", *([0] * 64))   # absflat
        os.write(self.fd, payload)

        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        # The compositor needs a moment to notice the new device. Writing
        # immediately means the first events land nowhere, which looks like the
        # first click of every session being swallowed.
        time.sleep(0.3)

    def close(self) -> None:
        if self.fd is None:
            return
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        except OSError:
            pass
        os.close(self.fd)
        self.fd = None

    # ── writing ────────────────────────────────────────────────────────
    def _emit(self, *events) -> None:
        """Write events plus a SYN_REPORT.

        The SYN matters: without it the kernel holds the events and nothing
        moves. Batching a move and a click into one report also makes them
        atomic, so a click cannot land at the previous position.
        """
        if self.fd is None:
            self.open()
        now = time.time()
        sec, usec = int(now), int((now % 1) * 1e6)
        buf = b"".join(
            struct.pack("llHHi", sec, usec, etype, code, value)
            for etype, code, value in (*events, (EV_SYN, SYN_REPORT, 0))
        )
        with self._lock:
            os.write(self.fd, buf)

    # ── public API ─────────────────────────────────────────────────────
    def move_fraction(self, fx: float, fy: float) -> None:
        """Move to a fraction (0..1) of the virtual desktop."""
        x = max(0, min(ABS_MAX, round(fx * ABS_MAX)))
        y = max(0, min(ABS_MAX, round(fy * ABS_MAX)))
        self._emit((EV_ABS, ABS_X, x), (EV_ABS, ABS_Y, y))

    def button(self, name: str, pressed: bool) -> None:
        code = BUTTONS.get(name)
        if code is None:
            raise ValueError(f"unknown button {name!r}")
        self._emit((EV_KEY, code, 1 if pressed else 0))

    def click(self, name: str = "left") -> None:
        self.button(name, True)
        self.button(name, False)

    def scroll(self, dy: int = 0, dx: int = 0) -> None:
        events = []
        if dy:
            events.append((EV_REL, REL_WHEEL, dy))
        if dx:
            events.append((EV_REL, REL_HWHEEL, dx))
        if events:
            self._emit(*events)

    def key(self, code: int, pressed: bool) -> None:
        """Press or release a LINUX KEY CODE (not a keysym, not a JS key)."""
        self._emit((EV_KEY, code, 1 if pressed else 0))

    def tap(self, code: int) -> None:
        self.key(code, True)
        self.key(code, False)

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *_):
        self.close()
