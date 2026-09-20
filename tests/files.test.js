/**
 * The file service's pure parts: paths, entries, and how an SFTP failure
 * becomes an HTTP one.
 *
 * Path handling is tested hardest because it is where a file browser breaks
 * in ways that look like the device's fault: a doubled slash that makes a
 * second empty directory, a `..` that walks somewhere surprising, a name with
 * a NUL in it. The transfers themselves are exercised against a real sshd —
 * see README.md.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanPath, entryOf, sftpError } from '../src/files.js';

test('paths normalise to one absolute form', () => {
  assert.equal(cleanPath('/home//ojee///notes.txt'), '/home/ojee/notes.txt');
  assert.equal(cleanPath('/home/ojee/'), '/home/ojee');
  assert.equal(cleanPath('/home/ojee/./docs'), '/home/ojee/docs');
  assert.equal(cleanPath('/home/ojee/docs/../pics'), '/home/ojee/pics');
  assert.equal(cleanPath('/'), '/');
});

test('a relative path resolves against the base it is given', () => {
  assert.equal(cleanPath('docs/report.pdf', { base: '/home/ojee' }), '/home/ojee/docs/report.pdf');
  assert.equal(cleanPath('../ojee2', { base: '/home/ojee' }), '/home/ojee2');
});

test('..  cannot walk above the root', () => {
  // Not a confinement boundary — the whole machine is the point — but the
  // result still has to be a real path rather than `/../..`.
  assert.equal(cleanPath('/../../etc/passwd'), '/etc/passwd');
  assert.equal(cleanPath('/..'), '/');
});

test('a NUL in a name is stripped rather than passed to the device', () => {
  assert.equal(cleanPath('/home/ojee/ev\u0000il'), '/home/ojee/evil');
});

test('an empty path falls back to the base', () => {
  assert.equal(cleanPath(''), '/');
  assert.equal(cleanPath(null), '/');
  assert.equal(cleanPath(undefined, { base: '/home' }), '/home');
});

test('entries carry type, size and a millisecond mtime', () => {
  const dir = entryOf('Documents', { mode: 0o040755, size: 4096, mtime: 1700000000 });
  assert.equal(dir.type, 'dir');
  assert.equal(dir.mode, 0o755);
  assert.equal(dir.mtime, 1700000000 * 1000, 'seconds on the wire, ms in the browser');

  const file = entryOf('notes.txt', { mode: 0o100644, size: 12, mtime: 1700000001 });
  assert.equal(file.type, 'file');
  assert.equal(file.size, 12);

  const link = entryOf('latest', { mode: 0o120777, size: 7, mtime: 0 });
  assert.equal(link.type, 'link');
  assert.equal(link.mtime, 0);
});

test('an entry with no attrs is still an entry', () => {
  // readdir on some servers omits attrs for an entry it cannot stat; the row
  // should render rather than throw.
  const e = entryOf('mystery', undefined);
  assert.equal(e.type, 'file');
  assert.equal(e.size, 0);
  assert.equal(e.mtime, 0);
});

test('SFTP status codes become the HTTP answer a browser can act on', () => {
  assert.deepEqual(sftpError({ code: 2, message: 'No such file' }),
    { http: 404, code: 'not_found', detail: 'No such file' });
  assert.equal(sftpError({ code: 3, message: 'Permission denied' }).http, 403);
  assert.equal(sftpError({ code: 10, message: 'Failure' }).code, 'not_empty');
  assert.equal(sftpError({ code: 11 }).code, 'exists');
});

test('an unknown failure is a 500 that still says what happened', () => {
  const e = sftpError(new Error('socket hang up'));
  assert.equal(e.http, 500);
  assert.equal(e.code, 'sftp_error');
  assert.equal(e.detail, 'socket hang up');
});
