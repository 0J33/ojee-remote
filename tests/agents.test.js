/**
 * The host-agent client, and specifically the lock path.
 *
 * "Is that machine locked" is the question that decides whether retrying is
 * worth anything, so its failure modes have to be distinguishable: a locked
 * host, an unreachable host and a host with no agent all used to arrive as the
 * same 502 and the UI could only say "cannot connect".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HostAgents, AgentError } from '../src/agents.js';

const DEVICE = {
  id: 'loq-linux',
  name: 'LOQ · Linux',
  agent: { url: 'http://host:8210', token: 'tok' },
};

/** A fetch that answers one request with `body` and records what it was asked. */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  impl.calls = calls;
  return impl;
}

test('lockState reports a locked screen', async () => {
  const fetchImpl = stubFetch({ locked: true, session: '86', type: 'x11' });
  const agents = new HostAgents({ fetchImpl });

  const state = await agents.lockState(DEVICE);

  assert.equal(state.locked, true);
  assert.equal(fetchImpl.calls[0].url, 'http://host:8210/lock');
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer tok');
});

test('lockState reports an unlocked screen as false, not as missing', async () => {
  // `undefined` and `false` mean different things to the caller: one is "not
  // locked", the other is "could not tell", and only the second justifies
  // staying quiet about the reason.
  const agents = new HostAgents({ fetchImpl: stubFetch({ locked: false, session: '86' }) });
  assert.equal((await agents.lockState(DEVICE)).locked, false);
});

test('unlock passes the agent result through', async () => {
  const fetchImpl = stubFetch({ ok: true, was_locked: true, locked: false });
  const agents = new HostAgents({ fetchImpl });

  const r = await agents.unlock(DEVICE);

  assert.equal(r.ok, true);
  assert.equal(r.was_locked, true);
  assert.equal(fetchImpl.calls[0].url, 'http://host:8210/unlock');
});

test('unlock is a GET, because the agent refuses a POST before routing it', async () => {
  // The agent is a WebSocket server with an HTTP side door; its handshake
  // layer rejects a POST with 400 before process_request sees the path. This
  // pins the convention so a future "tidy-up" to POST fails here rather than
  // in production.
  const fetchImpl = stubFetch({ ok: true });
  await new HostAgents({ fetchImpl }).unlock(DEVICE);
  assert.equal(fetchImpl.calls[0].opts.method, 'GET');
});

test('a device with no agent is told apart from a device that is down', async () => {
  const agents = new HostAgents({ fetchImpl: stubFetch({}) });
  await assert.rejects(
    () => agents.lockState({ id: 'rdp-only', name: 'Box', agent: null }),
    (e) => e instanceof AgentError && e.code === 'no_agent' && e.status === 501,
  );
});

test('an agent that refuses the unlock surfaces its reason', async () => {
  const agents = new HostAgents({
    fetchImpl: stubFetch({ ok: false, error: 'the screen stayed locked' }, { status: 409 }),
  });
  await assert.rejects(
    () => agents.unlock(DEVICE),
    (e) => e instanceof AgentError && /stayed locked/.test(e.message),
  );
});

test('an unreachable agent is an agent_unreachable, not a crash', async () => {
  const agents = new HostAgents({
    fetchImpl: async () => { throw Object.assign(new Error('connect'), { cause: { code: 'EHOSTUNREACH' } }); },
  });
  await assert.rejects(
    () => agents.lockState(DEVICE),
    (e) => e.code === 'agent_unreachable' && /EHOSTUNREACH/.test(e.message),
  );
});
