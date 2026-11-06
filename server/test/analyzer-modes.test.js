'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pickSceneMode, buildCandidates } = require('../src/media/analyzer');

test('short videos are scanned frame by frame', () => {
  assert.strictEqual(pickSceneMode({ duration: 300, maxKeyframeGap: 2 }), 'full');
});
test('long videos with close keyframes are sampled by keyframes', () => {
  assert.strictEqual(pickSceneMode({ duration: 3600, maxKeyframeGap: 2 }), 'keyframes');
});
test('long videos with sparse or unknown keyframes skip unneeded frames only', () => {
  assert.strictEqual(pickSceneMode({ duration: 3600, maxKeyframeGap: 30 }), 'noref');
  assert.strictEqual(pickSceneMode({ duration: 3600, maxKeyframeGap: 0 }), 'noref');
});
test('films with a keyframe about every 10 s still use keyframes', () => {
  assert.strictEqual(pickSceneMode({ duration: 7200, maxKeyframeGap: 10.4 }), 'keyframes');
});
test('the mode can be forced', () => {
  assert.strictEqual(pickSceneMode({ duration: 3600, maxKeyframeGap: 2, mode: 'full' }), 'full');
});
test('highlight candidates always have the requested length and stay inside the video', () => {
  const out = buildCandidates({ duration: 100, audio: { peaks: [{ timestamp: 95, normalizedScore: 1 }] }, scene: { sceneChanges: [] }, clipDuration: 30, maxClips: 3 });
  assert.ok(out.length >= 1);
  for (const c of out) { assert.strictEqual(c.duration, 30); assert.ok(c.start >= 0 && c.start + c.duration <= 100 + 1e-6); }
});
