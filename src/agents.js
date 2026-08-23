/**
 * Client for the host agents (see agent/).
 *
 * A source machine's monitor layout lives on its own session bus, so the
 * gateway — which deliberately runs somewhere else — cannot read or change it
 * directly. Each Linux source runs a small agent; this talks to it.
 *
 * Errors carry a `status` and a `code` so the route above can pass a useful
 * one through instead of flattening everything to 500. "The agent is not
 * installed" and "that monitor does not exist" want different responses from
 * the person reading them.
 */

const DEFAULT_TIMEOUT_MS = 5000;
// A switch waits for the compositor to finish. Measured at 95-334ms on a
// three-monitor setup, but a machine under load is slower, and timing out
// early would report failure for a switch that then succeeds.
const SWITCH_TIMEOUT_MS = 20000;

class AgentError extends Error {
  constructor(message, { status = 502, code = 'agent_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class HostAgents {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetch = fetchImpl;
  }

  async #call(device, path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!device.agent?.url) {
      throw new AgentError(
        `${device.name} has no host agent configured — install agent/ on that machine and set agent.url in devices.json`,
        { status: 501, code: 'no_agent' },
      );
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${device.agent.url}${path}`, {
        method,
        signal: ac.signal,
        headers: {
          authorization: `Bearer ${device.agent.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new AgentError(payload.detail || payload.error || `agent returned HTTP ${res.status}`, {
          status: res.status === 401 ? 502 : res.status,
          code: payload.error || 'agent_error',
        });
      }
      return payload;
    } catch (e) {
      if (e instanceof AgentError) throw e;
      if (e.name === 'AbortError') {
        throw new AgentError(`host agent did not answer within ${timeoutMs}ms`, { status: 504, code: 'agent_timeout' });
      }
      throw new AgentError(`cannot reach host agent at ${device.agent.url} — ${e.cause?.code || e.message}`,
        { status: 502, code: 'agent_unreachable' });
    } finally {
      clearTimeout(timer);
    }
  }

  async health(device) {
    return this.#call(device, '/health');
  }

  async monitors(device) {
    const { monitors } = await this.#call(device, '/monitors');
    return monitors || [];
  }

  /**
   * Ask the agent to discard its saved grant and request a new one.
   *
   * A portal grant covers exactly the displays ticked in the dialog, and there
   * is no API to widen one — so a monitor attached afterwards is visible to
   * the agent and permanently uncapturable. This is the only way to include
   * it, and it raises a prompt ON that machine, which is the consent the
   * portal exists to collect.
   */
  async regrant(device) {
    return this.#call(device, '/regrant', { timeoutMs: 120_000 });
  }

  /**
   * Ask the agent to make `monitor` primary. Resolves only once the agent has
   * confirmed the compositor applied it — the client can then reconnect
   * knowing the session is rebuilt, rather than guessing on a timer.
   */
  async setPrimary(device, monitor) {
    return this.#call(device, '/primary', {
      method: 'POST',
      body: { monitor },
      timeoutMs: SWITCH_TIMEOUT_MS,
    });
  }
}

export { AgentError, SWITCH_TIMEOUT_MS };
