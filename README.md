# ojee-remote

Browser remote desktop over a tailnet. Multi-monitor, presence-aware, and — the part that took
the longest — **it never moves your primary display**.

Runs standalone or as an [ojee-console](../ojee-console) module.

> **Status: the agent works end to end; the gateway is mid-migration.**
> `agent/` is complete and verified. `src/` still contains the older
> Guacamole/gnome-remote-desktop gateway and is being rewritten to proxy to agents instead.
> See [Status](#status).

---

## Why this exists

`gnome-remote-desktop` streams the **primary monitor and only the primary monitor**. There is no
`+multimon` on the server side. So "show me my other screen" can only mean "make that screen
primary" — which moves the GNOME top bar, the dock, and where new windows open. It rearranges the
desk of whoever is sitting at the machine.

That is not an acceptable price for changing a remote view.

It turns out g-r-d's limit is **g-r-d's choice, not Wayland's**. The desktop portal — the same one
OBS and Discord use when they ask which screen you want to share — will hand over any monitor, or
all of them, and never touches the primary flag:

```
org.freedesktop.portal.ScreenCast     v5, AvailableSourceTypes = 7
    MONITOR | WINDOW | VIRTUAL          any output, several at once
```

So this replaces gnome-remote-desktop rather than working around it.

---

## How it works

```
   browser                    gateway (always-on box)         agent (the machine with screens)
  ┌────────┐                 ┌─────────────────────┐         ┌──────────────────────────────┐
  │WebCodec│◀── H.264 ───────│  auth + presence    │◀── WS ──│ portal → PipeWire → VAAPI    │
  │ canvas │                 │  proxy per device   │         │ /dev/uinput ← input          │
  └────────┘── input ───────▶└─────────────────────┘────────▶└──────────────────────────────┘
```

**The gateway runs on the always-on box, not the laptop.** The previous build ran *on* the machine
being controlled, so it was unreachable in exactly the situations you wanted it: laptop asleep, or
booted into the other OS. Each machine is now a source the gateway dials over the tailnet, and a
dual-boot pair correctly shows exactly one of the two as online.

**Capture** is the portal + PipeWire, encoded with `vaapih264enc` on the Intel iGPU — deliberately
not the discrete GPU, so streaming never competes with a game or a CUDA job.

**Input** is `/dev/uinput`, not the portal. GNOME refuses to persist an input grant
(`Remote desktop sessions cannot persist`), so the portal would prompt on every single connection.
uinput sits below the compositor, so Wayland is irrelevant and there is no prompt, ever.

**Transport** is H.264 over one WebSocket, decoded with WebCodecs. Chosen over WebRTC because it
reuses the console's already-authenticated proxy — no second auth path, no ICE, no TURN, which is
where "works at home, fails on cellular" usually comes from. Bitrate adapts from measured RTT and
how far behind the client is.

---

## Setup

### 1. On each Linux machine you want to reach

```bash
sudo apt install python3-gi python3-dbus gstreamer1.0-vaapi gstreamer1.0-plugins-{good,bad} python3-websockets
cd agent
python3 grant.py          # ONCE, sitting at the machine — approve the dialog,
                          # select every monitor you want reachable
```

The grant is saved as a restore token, and every start after that is silent — measured at 0.05 s
with no dialog. That is what lets it run unattended.

Then run it:

```bash
AGENT_TOKEN=$(openssl rand -hex 32) \
PRIMARY_PREFERENCE=DP-1,eDP-1 \
python3 service.py
```

| Variable | Meaning |
|---|---|
| `AGENT_TOKEN` | **required.** Bearer token. The tailnet is the real boundary; this stops another peer on it watching your screen. |
| `PRIMARY_PREFERENCE` | Ordered list of connectors that should be primary — first one connected wins. `DP-1,eDP-1` means "the external monitor, or the built-in panel when it is unplugged". Leave unset to never touch the primary at all. |
| `AGENT_BIND` / `AGENT_PORT` | default `0.0.0.0:8210`. Bind to the tailnet address in production. |
| `AGENT_FPS` | default 30. |

`/dev/uinput` must be writable. Many systems already grant this by ACL; otherwise:

```bash
sudo usermod -aG input "$USER"
echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/60-uinput.rules
```

### 2. On the always-on box

```bash
npm install
cp .env.example .env && cp devices.example.json devices.json
# fill in GUAC_KEY (Windows/VNC devices) and each device's agent url + token
npm start
```

`devices.json` holds credentials and is gitignored. Keep it that way.

---

## The primary display is pinned, not moved

`PRIMARY_PREFERENCE` is enforced by a watcher in the agent: if anything moves the primary — a
hotplug, another app, a stray script — it is put back within one check interval (verified: moved
deliberately to `eDP-1`, restored to `DP-1` in 5 s).

Switching the *streamed* monitor no longer touches the primary at all, because capture no longer
depends on it. The old primary-switching path still exists behind `ALLOW_PRIMARY_SWITCH=1` for
setups where nobody sits at the machine, and refuses with an explanation otherwise.

---

## Windows

Windows RDP supports multi-monitor natively, so a Windows source needs no agent: point a device at
it with `"monitors": "multimon"` and guacd streams every screen in one canvas. Windows 11 **Pro**
or better (Home cannot host RDP). See `windows/`.

---

## Things that cost real debugging time

Written down because none of them announce themselves:

- **`security: 'any'` cannot work against gnome-remote-desktop.** It requires NLA and rejects
  plain TLS with `HYBRID_REQUIRED_BY_SERVER`. Guacamole's `any` lets negotiation pick, and when it
  picks TLS the session dies before a single frame. The previous build shipped `'any'`.
- **g-r-d wedges under session churn.** It completes the handshake — NLA succeeds, keymaps load,
  audio negotiates — and then sends no graphics, logging `BIO_should_retry retries exceeded` and
  `SSL routines::bad length`. Every client-visible signal says "connected". Only a restart clears
  it. This is a large part of why the old build sat on a black screen and retried forever.
- **PipeWire node IDs change every session** (observed 100/105/126 → 126/127/124 → 102/90/105).
  Match monitors by position and size.
- **One PipeWire fd per GStreamer pipeline.** `pipewiresrc` takes ownership and closes it on
  teardown; a shared fd makes every later pipeline silently produce nothing, which is
  indistinguishable from a dead monitor.
- **`xdg-desktop-portal-gnome` 46.2 segfaults** when a screencast client disconnects mid-request,
  leaving orphaned dialogs on screen whose process is already dead — clicking them does nothing.
- **`nvh264enc` is unusable on recent NVIDIA drivers** — every preset fails with
  "Selected preset not supported", because the plugin predates the driver dropping the legacy
  preset enums. VAAPI on the iGPU is better here anyway.
- **`asyncio.gather` does not cancel its siblings.** One disconnect leaked the sender, pinger and
  adapt loops and kept the encoder alive. Use `TaskGroup`.

---

## Status

| Piece | State |
|---|---|
| `agent/portal.py` — persistent multi-monitor grant | done, verified silent |
| `agent/capture.py` — PipeWire → H.264, live bitrate, encoder fallback | done, verified |
| `agent/inject.py` — absolute pointer + keyboard via uinput | done, verified |
| `agent/pin.py` — primary-display pinning | done, verified restoring |
| `agent/service.py` — WebSocket stream + input | done, verified in a browser |
| `src/` — gateway | **being rewritten** to proxy to agents; currently the older guacd path |
| `ui/` — module UI | **being rewritten** for WebCodecs; currently the older Guacamole client |
| `windows/` | not started |

Verified end to end on GNOME 46 / Wayland: three monitors granted in one dialog, silent restore,
1071 frames decoded in-browser with zero errors, switching to a portrait 1080×1920 monitor, primary
untouched throughout, and the encoder stopping when nobody is watching.

---

## Licence

MIT.

## Typing from a phone

Tap **KEYBOARD** in the controls bar to raise your phone's on-screen keyboard.

This needs more than it sounds like. A phone only shows its keyboard when a
real text field takes focus, and this screen had none — the stage is a canvas,
and tapping it sends a remote click. So the module carries an invisible (but
genuinely focusable) `<textarea>`: focusing it is what raises the keyboard,
everything typed into it is translated and forwarded, and its value is cleared
on every keystroke so it never accumulates.

Soft keyboards also cannot be read the way a physical one can. Android reports
`KeyboardEvent.code` as `Unidentified` and `keyCode` as 229 for every letter,
so key events alone tell you nothing — the text has to be read from
`beforeinput` and mapped back to keycodes. Both paths are wired at once, so a
phone with a Bluetooth keyboard attached still works normally.

The strip above the keyboard carries what no phone keyboard offers: Ctrl, Alt,
Shift, Super, Esc, Tab, arrows and Delete. The modifiers **latch** — you cannot
hold Ctrl and tap C at the same time on a touchscreen — and release themselves
after the next key, so Ctrl+C is one gesture rather than a mode you have to
remember to leave.

