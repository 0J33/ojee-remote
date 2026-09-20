"""The machine's clipboard, read and written on request.

Deliberately request/response rather than a watcher. `wl-paste --watch` would
push every local copy to the browser, which means: a loop to break (the value
we just set comes back as a change), a stream of other people's clipboards
arriving while they work at the machine, and a background process per session.
Asking is enough — a human presses a button when they want the exchange.

Wayland and X11 both, because the agent runs on whatever the desktop is:

    wl-copy / wl-paste   wayland (wl-clipboard)
    xclip                x11

No pure-Python path exists for Wayland: the protocol requires a client with a
surface and a data-device, which is exactly what wl-clipboard is. On X11 xclip
has to keep running to own the selection, so the copy is spawned detached and
left alone — killing it would clear the clipboard.

Only text. Images and files over the same channel are a bigger design (size
caps, formats, chunking); text is the case that comes up every day.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess

# A clipboard is for a paste, not a file transfer. Anything past this is
# refused with a reason rather than silently truncated.
MAX_BYTES = 256 * 1024


class ClipboardError(RuntimeError):
    """Something the user can act on: a missing tool, or too much text."""


def _wayland() -> bool:
    return bool(os.environ.get("WAYLAND_DISPLAY"))


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise ClipboardError(
            f"{name} is not installed on this machine "
            f"({'sudo apt install wl-clipboard' if name.startswith('wl-') else 'sudo apt install xclip'})"
        )
    return path


def _read_sync() -> str:
    if _wayland():
        cmd = [_tool("wl-paste"), "--no-newline", "--type", "text/plain"]
    else:
        cmd = [_tool("xclip"), "-selection", "clipboard", "-o"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=5)
    except subprocess.TimeoutExpired as e:
        raise ClipboardError("the clipboard did not answer in 5s") from e
    if out.returncode != 0:
        err = (out.stderr or b"").decode("utf-8", "replace").strip()
        # An empty clipboard is not an error; wl-paste says so on stderr.
        if "empty" in err.lower() or not err:
            return ""
        raise ClipboardError(err)
    return out.stdout.decode("utf-8", "replace")


def _write_sync(text: str) -> None:
    data = text.encode("utf-8")
    if len(data) > MAX_BYTES:
        raise ClipboardError(f"{len(data)} bytes is more than the {MAX_BYTES} byte limit")
    if _wayland():
        cmd = [_tool("wl-copy"), "--type", "text/plain"]
    else:
        cmd = [_tool("xclip"), "-selection", "clipboard"]
    # X11: xclip must keep running to own the selection, so it is started and
    # left. Wayland: wl-copy forks its own daemon and exits.
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        proc.stdin.write(data)
        proc.stdin.close()
    except BrokenPipeError as e:
        raise ClipboardError("the clipboard tool exited before taking the text") from e
    if _wayland():
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired as e:
            proc.kill()
            raise ClipboardError("wl-copy did not finish in 5s") from e


async def read_text() -> str:
    """The machine's clipboard, as text. Empty string when it holds nothing."""
    return await asyncio.get_running_loop().run_in_executor(None, _read_sync)


async def write_text(text: str) -> None:
    """Put text on the machine's clipboard."""
    await asyncio.get_running_loop().run_in_executor(None, _write_sync, text)


def available() -> tuple[bool, str]:
    """Whether this machine can do it, and what is missing when it cannot."""
    try:
        _tool("wl-paste" if _wayland() else "xclip")
        return True, ""
    except ClipboardError as e:
        return False, str(e)
