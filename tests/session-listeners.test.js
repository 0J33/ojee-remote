/**
 * Global listeners the session adds must be removed by its teardown.
 *
 * This is not a style rule — it is the bug that made scrolling die app-wide.
 * startSession puts touch handlers on `document` with capture so the remote
 * screen owns every finger; teardown that does not take them off leaves a
 * touchstart calling preventDefault() on every touch in the console, on every
 * touch, until the page is reloaded. Anonymous handlers cannot be removed at
 * all, so an unnamed one is already a leak waiting to happen.
 *
 * The check is on the source, not a live DOM: startSession cannot be run
 * under `node --test`, and the pairing is a property of the code anyway.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'session.js'), 'utf8',
);

/**
 * Walk from the opening bracket to its match, skipping strings and comments —
 * a `'` in a comment (") : the page's scrolling") opens a string to a naive
 * scanner and the body never appears to end.
 */
function scanBalanced(src, start, open, close) {
  let depth = 0, inStr = null, esc = false;
  for (let j = start; j < src.length; j++) {
    const ch = src[j];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (ch === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Split on top-level commas only — options objects are themselves braced. */
function splitArgs(text) {
  const parts = [];
  let depth = 0, cur = '', inStr = null, esc = false;
  for (const ch of text) {
    if (inStr) {
      cur += ch;
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Every `X.addEventListener(...)` with the receiver it was called on. */
function addCalls(name) {
  const out = [];
  const needle = `.${name}(`;
  let i = 0;
  while ((i = SRC.indexOf(needle, i)) !== -1) {
    const paren = i + needle.length - 1;          // the '(' itself
    const end = scanBalanced(SRC, paren, '(', ')');
    const receiver = (/([A-Za-z_$][\w$]*)\s*$/).exec(SRC.slice(0, i))?.[1] || '?';
    out.push({
      receiver,
      args: splitArgs(SRC.slice(paren + 1, end)),
      line: SRC.slice(0, i).split('\n').length,
    });
    i = end + 1;
  }
  return out;
}

/** Body of `return function teardown() { … }`, or null. */
function teardownBody() {
  const at = SRC.indexOf('return function teardown()');
  assert.notEqual(at, -1, 'session.js has no teardown function at all');
  const open = SRC.indexOf('{', at + 6);
  const end = scanBalanced(SRC, open, '{', '}');
  return end === -1 ? null : SRC.slice(open, end + 1);
}

/** `'touchstart'` → `touchstart`; splitArgs keeps the quotes. */
const unquote = (s) => String(s).replace(/^['"]|['"]$/g, '');

const teardown = teardownBody();
assert.ok(teardown, 'teardown body could not be parsed');

const GLOBALS = new Set(['document', 'window']);
const adds = addCalls('addEventListener')
  .filter((c) => GLOBALS.has(c.receiver))
  .map((c) => ({ ...c, type: unquote(c.args[0]), handler: c.args[1] }));

test('the session attaches at least the listeners this test is about', () => {
  const types = adds.map((c) => c.type);
  for (const want of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.ok(types.includes(want), `session no longer listens for ${want} — this test's premise changed`);
  }
});

test('every document/window listener is a name that can be removed', () => {
  for (const c of adds) {
    assert.match(
      c.handler, /^[A-Za-z_$][\w$]*$/,
      `line ${c.line}: ${c.receiver}.addEventListener('${c.type}', …) takes an inline function. `
      + 'Anonymous handlers cannot be removed, so teardown cannot take it off again — '
      + 'name it and remove it.',
    );
  }
});

test('teardown removes every document/window listener, in the same capture state', () => {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const c of adds) {
    const one = new RegExp(
      `${c.receiver}\\.removeEventListener\\(\\s*['"]${esc(c.type)}['"]\\s*,\\s*${c.handler}`
      + '(?:\\s*,\\s*([^)]*))?\\s*\\)\\s*;',
    ).exec(teardown);
    assert.ok(
      one,
      `teardown does not remove the ${c.receiver} '${c.type}' listener (${c.handler}) `
      + `added at line ${c.line} — it survives the session.`,
    );

    // The options must agree: a capture listener removed without capture:true
    // is not removed at all.
    const addCapture = /\bcapture:\s*true\b/.test(c.args[2] || '') || c.args[2] === 'true';
    const opts = one[1] ?? '';
    const rmCapture = /\bcapture:\s*true\b/.test(opts) || opts.trim() === 'true';
    assert.equal(
      addCapture, rmCapture,
      `teardown removes ${c.receiver} '${c.type}' with different capture than it was added `
      + 'with — the listener stays attached.',
    );
  }
});
