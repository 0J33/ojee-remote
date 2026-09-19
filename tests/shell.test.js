/**
 * The SSH bridge's configuration layer.
 *
 * Everything here is what happens BEFORE a socket is opened, which is where
 * the failures a user actually hits live: a key file that isn't there, a
 * missing username, a device with no ssh block at all. Those have to fail with
 * a sentence naming the device, because the alternative is an ECONNREFUSED
 * from ssh2 with no idea which machine it came from.
 *
 * The dialling itself is exercised against a real sshd, not mocked — see the
 * end-to-end notes in README.md.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { connectOptions, expandHome, keyFingerprint } from '../src/shell.js';

const tmp = mkdtempSync(join(tmpdir(), 'ojee-shell-'));
const KEY = join(tmp, 'id_test');
writeFileSync(KEY, '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n');

const device = (ssh) => ({ id: 'box', ssh });

test('a key file is read, and the passphrase rides with it', () => {
  const o = connectOptions(device({ host: 'h', port: 22, username: 'me', keyFile: KEY, passphrase: 'pw' }));
  assert.equal(o.host, 'h');
  assert.equal(o.username, 'me');
  assert.match(o.privateKey.toString(), /OPENSSH PRIVATE KEY/);
  assert.equal(o.passphrase, 'pw');
  assert.equal(o.password, undefined);
});

test('a password also enables keyboard-interactive', () => {
  // sshd configurations that answer password auth only through
  // keyboard-interactive are common enough that not doing this reads as a
  // wrong password.
  const o = connectOptions(device({ host: 'h', port: 22, username: 'me', password: 's3cret' }));
  assert.equal(o.password, 's3cret');
  assert.equal(o.tryKeyboard, true);
  assert.equal(o.privateKey, undefined);
});

test('a key file beats a password when both are set', () => {
  const o = connectOptions(device({ host: 'h', port: 22, username: 'me', keyFile: KEY, password: 'ignored' }));
  assert.ok(o.privateKey);
  assert.equal(o.password, undefined);
});

test('with no credentials, the gateway\'s ssh-agent is used when there is one', () => {
  const had = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = '/run/agent.sock';
  try {
    const o = connectOptions(device({ host: 'h', port: 22, username: 'me' }));
    assert.equal(o.agent, '/run/agent.sock');
  } finally {
    if (had === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = had;
  }
});

test('the failures name the device and what is missing', () => {
  const had = process.env.SSH_AUTH_SOCK;
  delete process.env.SSH_AUTH_SOCK;
  try {
    assert.throws(() => connectOptions({ id: 'box' }), /box: no ssh block/);
    assert.throws(() => connectOptions(device({ host: 'h', port: 22 })), /box: ssh\.username is required/);
    assert.throws(
      () => connectOptions(device({ host: 'h', port: 22, username: 'me', keyFile: join(tmp, 'nope') })),
      /box: cannot read ssh\.keyFile .*nope — ENOENT/,
    );
    assert.throws(
      () => connectOptions(device({ host: 'h', port: 22, username: 'me' })),
      /box: ssh needs keyFile, password, or an ssh-agent/,
    );
  } finally {
    if (had !== undefined) process.env.SSH_AUTH_SOCK = had;
  }
});

test('keepalives are set, so a dead link is noticed rather than hung on', () => {
  const o = connectOptions(device({ host: 'h', port: 22, username: 'me', password: 'x' }));
  assert.ok(o.keepaliveInterval > 0);
  assert.ok(o.keepaliveCountMax >= 1);
  assert.ok(o.readyTimeout > 0);
});

test('~ expands, absolute paths are left alone', () => {
  assert.equal(expandHome('~/.ssh/id_ed25519'), join(homedir(), '.ssh/id_ed25519'));
  assert.equal(expandHome('~'), homedir());
  assert.equal(expandHome('/etc/keys/id'), '/etc/keys/id');
  assert.equal(expandHome(''), '');
});

test('the fingerprint is the one OpenSSH prints', () => {
  // `ssh-keygen -lf` prints base64 without padding, prefixed SHA256:.
  const fp = keyFingerprint(Buffer.from('ssh-ed25519 AAAA'));
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.ok(!fp.endsWith('='));
  assert.equal(fp, keyFingerprint(Buffer.from('ssh-ed25519 AAAA')));
  assert.notEqual(fp, keyFingerprint(Buffer.from('ssh-ed25519 BBBB')));
});
