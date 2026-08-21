# Windows device setup

Windows hosts RDP natively and — unlike gnome-remote-desktop — streams **every monitor in one
session**. So the Windows side needs no capture agent: guacd talks straight to it and the client
gets the merged canvas for free.

That asymmetry is worth stating plainly, because it is the opposite of what you would guess:
the *Linux* side needed a whole portal-capture agent to do what Windows does out of the box.

## Run it

In an **elevated** PowerShell on the Windows machine:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\setup-windows.ps1
```

It prints the `devices.json` entry to paste into the gateway. To reverse everything:
`.\setup-windows.ps1 -Undo`.

## What it changes

| | Why |
|---|---|
| Enables the RDP host, requires NLA | NLA also means the box will not spin up a session for an unauthenticated caller |
| Restricts inbound 3389 to `100.64.0.0/10` | the built-in rules allow the whole local subnet; on a laptop that means the café wifi can see the port |
| Narrows the built-in Remote Desktop rules too | otherwise they quietly re-open it to the local subnet |
| Sets the Tailscale adapter profile to Private | **Windows silently blocks inbound RDP on a Public profile.** The port shows as open and still refuses connections — a genuinely confusing failure |
| Disables sleep/hibernate on AC | a device that sleeps is offline exactly when you reach for it. Battery behaviour is left alone |

## Requirements

- **Windows 11 Pro / Enterprise / Education.** Home cannot *host* RDP — it can only connect out.
  The script checks the edition and stops with an explanation rather than leaving you with an
  open port that never answers.
- Tailscale installed and signed into the same tailnet.

## Dual boot

Only the OS currently running answers, so on a dual-boot machine exactly one of the two devices
is ever reachable. That is not a bug and the UI does not pretend otherwise: the gateway probes
both and the picker shows one online and one struck through with the reason.
