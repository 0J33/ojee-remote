#!/usr/bin/env python3
"""One-time portal grant. Run this once, sitting at the machine.

    python3 agent/grant.py

Approve the dialog and select every monitor you want reachable. The restore
token is saved, and every start after this is silent — no dialog, ever, which
is what lets the agent run unattended.

Re-run it to change which monitors are shared, or after revoking the permission
in Settings → Privacy → Screen Sharing.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import portal

print("Requesting screen-capture permission.")
print("A dialog will appear — SELECT ALL THE MONITORS you want reachable, then Share.\n")
try:
    session, streams = portal.open_screencast(multiple=True)
except portal.PortalError as e:
    sys.exit(f"failed: {e}")

print(f"granted {len(streams)} monitor(s):")
for s in streams:
    print(f"  {s['w']}x{s['h']} @ {s['x']},{s['y']}  (node {s['node_id']} this session)")
print(f"\nrestore token saved to {portal.STATE_FILE}")
print("Future starts are silent. Start the agent with: python3 agent/service.py")
portal.close_session(session)
