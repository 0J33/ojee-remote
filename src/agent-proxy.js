/**
 * WebSocket proxy: browser ⇄ gateway ⇄ host agent.
 *
 * The browser never talks to an agent directly, for two reasons that both
 * matter:
 *
 *   1. **Browsers cannot set headers on a WebSocket handshake.** There is no
 *      API for it. So a browser connecting straight to an agent would have to
 *      put the bearer token in the query string, where it lands in logs, in
 *      history and in any Referer. Proxying lets the gateway attach a proper
 *      Authorization header that the browser never sees.
 *
 *   2. **The agent lives on the tailnet, the browser may not.** Mounted in the
 *      console, the request has already passed three auth gates and arrives
 *      here over one authenticated origin; the gateway then reaches the agent
 *      over the tailnet. One public surface instead of one per machine.
 *
 * The proxy is deliberately dumb: it forwards frames both ways and gets out of
 * the way. Video is latency-sensitive, so both legs disable Nagle — buffering
 * a few milliseconds to pack frames is exactly the wrong trade for something a
 * human is dragging a mouse in.
 */

import { WebSocketServer, WebSocket } from 'ws';

/** How long to wait for the agent to accept the upgrade before giving up. */
const CONNECT_TIMEOUT_MS = 8000;

export function createAgentProxy({ devices }) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (client, req, device) => {
    const url = `${device.agent.url.replace(/^http/, 'ws')}/stream`;

    const upstream = new WebSocket(url, {
      headers: { authorization: `Bearer ${device.agent.token}` },
      // The agent may be on a slow link; the default has no ceiling.
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      // H.264 is already compressed. permessage-deflate would burn CPU on both
      // ends to make the payload very slightly larger.
      perMessageDeflate: false,
    });

    let closed = false;
    const closeBoth = (code, reason) => {
      if (closed) return;
      closed = true;
      try { upstream.close(); } catch { /* already gone */ }
      try { client.close(code, reason); } catch { /* already gone */ }
    };

    // Frames that arrive before the upstream is open would otherwise be
    // dropped silently — which for the first `select` message means the user
    // sees the wrong monitor and no error.
    const pending = [];

    upstream.on('open', () => {
      upstream._socket?.setNoDelay?.(true);
      client._socket?.setNoDelay?.(true);
      for (const m of pending.splice(0)) upstream.send(m);
    });

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });

    upstream.on('unexpected-response', (_req, res) => {
      // A 401 here means the gateway's token for this device is wrong — a
      // configuration error worth naming rather than a generic disconnect.
      const why = res.statusCode === 401
        ? `agent rejected the gateway's token for ${device.id}`
        : `agent returned HTTP ${res.statusCode}`;
      console.warn(`[agent-proxy] ${why}`);
      closeBoth(4502, why);
    });

    upstream.on('error', (e) => {
      console.warn(`[agent-proxy] ${device.id}: ${e.code || e.message}`);
      closeBoth(4502, `cannot reach ${device.name}`);
    });
    upstream.on('close', () => closeBoth(1001, 'agent closed'));

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
    });
    client.on('error', () => closeBoth(1011, 'client error'));
    client.on('close', () => closeBoth(1000, 'client closed'));
  });

  /**
   * Claim an upgrade for `/stream?device=<id>`.
   * @returns {boolean} true if this proxy handled it
   */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/stream') return false;

    const id = url.searchParams.get('device');
    const device = devices.get(id);

    const deny = (code, msg) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      socket.destroy();
      return true;
    };

    if (!device) return deny(404, 'Unknown device');
    if (device.transport !== 'agent') return deny(400, 'Device is not agent-backed');
    if (!device.agent?.url) return deny(503, 'Device has no agent configured');

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, device));
    return true;
  }

  return { handleUpgrade, wss };
}
