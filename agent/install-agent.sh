#!/usr/bin/env bash
# Install the ojee-remote HOST AGENT — the thing that captures this machine's
# screens and injects input, so the gateway can stream it.
#
#   ./install-agent.sh          install, enable, start
#   ./install-agent.sh --undo   remove everything it installed
#
# Run as YOUR user. NOT with sudo, and NOT as a system service.
#
# That is not a style preference. The agent captures through the desktop
# portal and PipeWire, and injects through /dev/uinput. The portal is a
# per-session service reached over the session D-Bus; a system unit has no
# session, so the capture grant cannot be requested, restored, or held. A
# --user unit inherits WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS and
# XDG_RUNTIME_DIR from the graphical session, which is the only context where
# any of this works.

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/ojee-remote-agent.service"
ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ojee-remote"
ENV_FILE="$ENV_DIR/agent.env"

ok()   { printf '  \033[32m+\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31mx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run this as your own user, not with sudo — see the comment at the top"

if [ "${1:-}" = "--undo" ]; then
  echo
  echo "Removing the ojee-remote agent"
  systemctl --user disable --now ojee-remote-agent.service 2>/dev/null || true
  rm -f "$UNIT"; ok "unit removed"
  systemctl --user daemon-reload
  [ -d "$ENV_DIR" ] && warn "$ENV_DIR kept — it holds your token. Remove it by hand if you want it gone."
  echo
  exit 0
fi

echo
echo "ojee-remote agent"
echo

# ── 1. requirements, checked rather than assumed ───────────────────────
command -v python3 >/dev/null || die "python3 is required"
[ -f "$SRC/service.py" ] || die "run this from the agent/ directory"

python3 - <<'PY' || die "missing Python modules — see the message above"
import sys
need = {
    "websockets": "python3-websockets",
    "gi":         "python3-gi",
    "dbus":       "python3-dbus",
}
missing = []
for mod, pkg in need.items():
    try:
        __import__(mod)
    except ImportError:
        missing.append(pkg)
if missing:
    print("  missing: " + ", ".join(missing))
    print("  install with: sudo apt install " + " ".join(missing))
    sys.exit(1)

# Present is not the same as usable. Ubuntu 22.04 ships websockets 9.1 for
# Python 3.10, and 9.1 predates 3.10: every incoming connection dies inside
# the library with "the *loop* parameter was removed from Lock()", silently,
# and the agent looks up while resetting every request. 10.0 is the release
# that added 3.10 support.
import websockets
major = int(websockets.__version__.split(".")[0])
if major < 10 and sys.version_info >= (3, 10):
    print(f"  websockets {websockets.__version__} cannot serve on Python "
          f"{sys.version_info.major}.{sys.version_info.minor} — it needs 10 or newer.")
    print("  install with:  sudo apt install python3-pip && "
          "python3 -m pip install --user 'websockets==10.4'")
    print("  (and `sudo apt remove python3-websockets` so the old one is not picked up)")
    sys.exit(1)
PY
ok "python modules present"

if ! gst-inspect-1.0 pipewiresrc >/dev/null 2>&1; then
  die "gstreamer's pipewiresrc is missing — sudo apt install gstreamer1.0-pipewire"
fi

# Every stream goes through h264parse, whichever encoder made it. It lives in
# plugins-bad, which a desktop install does not always have — and without it
# the agent starts, reports healthy, and fails every connection.
if ! gst-inspect-1.0 h264parse >/dev/null 2>&1; then
  die "gstreamer's h264parse is missing — sudo apt install gstreamer1.0-plugins-bad"
fi
ok "h264parse present"
ok "pipewiresrc present"

# Encoders are a fallback chain, so a missing hardware encoder is a warning.
if gst-inspect-1.0 vaapih264enc >/dev/null 2>&1; then
  ok "vaapih264enc present (hardware encoding)"
elif gst-inspect-1.0 x264enc >/dev/null 2>&1; then
  warn "no VAAPI encoder — falling back to x264enc (software, more CPU)"
  # Software encoding is where the lag comes from on a laptop CPU: it cost the
  # HP box ~180% CPU for an idle desktop. With an Intel iGPU, this is the fix.
  warn "  with an Intel GPU: sudo apt install gstreamer1.0-vaapi   (then restart the agent)"
else
  die "no H.264 encoder — sudo apt install gstreamer1.0-vaapi gstreamer1.0-plugins-ugly"
fi

# ── 2. /dev/uinput ─────────────────────────────────────────────────────
# Input injection writes here directly. Without access the stream still
# works and the desktop is simply not controllable, which is a confusing
# half-failure — so check it now and say exactly how to fix it.
if [ ! -w /dev/uinput ]; then
  warn "/dev/uinput is not writable by you — input injection will not work."
  warn "Fix with:"
  warn "  echo 'KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", OPTIONS+=\"static_node=uinput\"' \\"
  warn "    | sudo tee /etc/udev/rules.d/99-uinput.rules"
  warn "  sudo usermod -aG input $USER    # then log out and back in"
else
  ok "/dev/uinput writable"
fi

# ── 3. token ───────────────────────────────────────────────────────────
mkdir -p "$ENV_DIR" "$UNIT_DIR"
chmod 700 "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
  ok "keeping the existing token in $ENV_FILE"
else
  cat > "$ENV_FILE" <<EOF
# ojee-remote agent configuration.
AGENT_TOKEN=$(openssl rand -hex 32)

# Bind address. Defaults to this machine's Tailscale IP, falling back to
# loopback — never 0.0.0.0. This endpoint can see your screen and type on
# your behalf; it has no business on a café wifi.
#AGENT_BIND=
AGENT_PORT=8210
AGENT_FPS=30
EOF
  chmod 600 "$ENV_FILE"
  ok "generated a token in $ENV_FILE (mode 0600)"
fi

# ── 4. unit ────────────────────────────────────────────────────────────
cat > "$UNIT" <<EOF
[Unit]
Description=ojee-remote host agent
Documentation=https://github.com/0J33/ojee-remote
# graphical-session, not default.target: the portal and PipeWire only exist
# once the desktop session does, and starting earlier just fails.
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
WorkingDirectory=$SRC
ExecStart=/usr/bin/python3 -u $SRC/service.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
EOF
ok "unit written to $UNIT"

systemctl --user daemon-reload
systemctl --user enable --now ojee-remote-agent.service

echo
sleep 3
if systemctl --user is-active --quiet ojee-remote-agent.service; then
  ok "ojee-remote-agent is running"
  echo
  printf '  token:  grep AGENT_TOKEN %s\n' "$ENV_FILE"
  printf '  logs:   journalctl --user -u ojee-remote-agent -f\n'
  echo
  echo "  Add this device to the gateway's devices.json:"
  echo
  cat <<EOF
    {
      "id": "$(hostname | tr '[:upper:]' '[:lower:]')",
      "name": "$(hostname)",
      "transport": "agent",
      "host": "$(tailscale ip -4 2>/dev/null || echo '<tailnet-ip>')",
      "port": 8210,
      "monitors": "portal",
      "agent": {
        "url": "http://$(tailscale ip -4 2>/dev/null || echo '<tailnet-ip>'):8210",
        "token": "<the AGENT_TOKEN above>"
      },
      "presence": { "intervalMs": 5000 }
    }
EOF
else
  warn "the service did not come up:"
  systemctl --user status ojee-remote-agent.service --no-pager -l | tail -20 || true
fi
echo
