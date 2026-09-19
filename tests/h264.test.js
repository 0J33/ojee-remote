/**
 * Reading the real frame size out of an SPS.
 *
 * Every sample below is a real SPS, captured from the encoders these agents
 * actually use — not hand-assembled — because the thing being tested is
 * agreement with what the encoders emit. 1080, 658 and 864 are the
 * interesting heights: 1080 and 658 are not multiples of 16, so they only come
 * out right if the frame-cropping arithmetic is right.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { spsSize } from '../ui/h264.js';

const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)));

const SAMPLES = [
  // x264, High profile — the software fallback
  ['x264 1920x1080', '67640028acd940780227e5c05a808080a0000003002000000791e30632c0', 1920, 1080],
  ['x264 1536x864', '67640028acd9406006db016a02020280000003008000001e478c18cb', 1536, 864],
  ['x264 1170x658 (phone-sized, cropped both ways)', '6764001facd9404a055e2223016a02020280000003008000001e478c18cb', 1170, 658],
  ['x264 1280x720', '6764001facd9405005bb016a02020280000003008000001e478c18cb', 1280, 720],
  // vaapih264enc — full mode on the laptop, low-power CQP on the HP box. The
  // HP one is the case that broke: a scaled 1536x864 monitor recorded at
  // 1920x1080.
  ['vaapi 1920x1080 (laptop full, HP low-power CQP)', '67640028ac5680780225e5ffc000400044000003000400000300f250', 1920, 1080],
];

for (const [name, sps, w, h] of SAMPLES) {
  test(`reads ${name}`, () => {
    assert.deepEqual(spsSize(hex(sps)), { w, h });
  });
}

test('the HP stream is NOT the size the agent announced', () => {
  // The whole bug in one assertion: the monitor is 1536x864 logical, the
  // frames are 1920x1080. A player sized from the announcement shows 80% of
  // each dimension on Safari.
  const coded = spsSize(hex(SAMPLES[4][1]));
  assert.notDeepEqual(coded, { w: 1536, h: 864 });
});

test('anything that is not an SPS is refused, not guessed at', () => {
  assert.equal(spsSize(null), null);
  assert.equal(spsSize(hex('68ee3c80')), null);          // a PPS
  assert.equal(spsSize(hex('6764')), null);              // truncated
  assert.equal(spsSize(hex('67640028')), null);          // ends before the size
});
