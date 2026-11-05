'use strict';
/** Lower third text that follows each clip's part number ("Follow for Part {next}") and "near the end" timing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const REPO = path.resolve(__dirname, '..', '..');
const lt = () => import(pathToFileURL(path.join(REPO, 'js', 'shared', 'lowerThird.js')).href);

test('{part} and {next} become the clip\'s own part numbers', async () => {
  const m = await lt();
  const spec = { enabled: true, title: 'Follow for Part {next}', subtitle: 'You are watching part {PART}', tag: 'P{part}', cta: '' };
  for (const [part, next] of [[1, 2], [3, 4], [12, 13]]) {
    const r = m.resolveLowerThird(spec, { part, clipDuration: 30 });
    assert.equal(r.title, `Follow for Part ${next}`);
    assert.equal(r.subtitle, `You are watching part ${part}`);
    assert.equal(r.tag, `P${part}`);
  }
  assert.equal(m.resolveLowerThird(spec, {}).title, 'Follow for Part 2', 'no part given: the first part');
  assert.equal(m.resolveLowerThird({ enabled: true, title: 'Plain text' }, { part: 5 }).title, 'Plain text', 'text without tokens is left alone');
  assert.equal(m.hasPartTokens(spec), true);
  assert.equal(m.hasPartTokens({ title: 'Hello' }), false);
});

test('the old built-in "Follow for Part 2" text stops repeating itself on every clip', async () => {
  const m = await lt();
  const old = { enabled: true, style: 'pill', title: 'Follow for Part 2', hold: 4, repeat: 20 };
  assert.equal(m.normalizeLowerThirds([old])[0].title, 'Follow for Part {next}', 'loaded from stored data');
  assert.equal(m.resolveLowerThird(old, { part: 3 }).title, 'Follow for Part 4');
  assert.equal(m.resolveLowerThird(old, { part: 1 }).title, 'Follow for Part 2');
  // regression: what a part-1 clip shows ("Follow for Part 2") must NOT be turned back into the token when it is drawn
  const shown = m.resolveLowerThird({ enabled: true, title: 'Follow for Part {next}' }, { part: 1 });
  assert.equal(shown.title, 'Follow for Part 2');
  assert.equal(m.normalizeLowerThird(shown).title, 'Follow for Part 2', 're-normalising the resolved text keeps it');
  assert.equal(m.normalizeLowerThird({ enabled: true, title: 'Follow for Part 2 now!' }).title, 'Follow for Part 2 now!', 'only that exact text is converted');
  const preset = m.LT_PRESETS.find((p) => p.id === 'follow').spec;
  assert.equal(preset.title, 'Follow for Part {next}'); assert.equal(preset.atEnd, true);
});

test('"near the end" works out its start from the finished clip length', async () => {
  const m = await lt();
  const spec = { enabled: true, title: 'Follow for Part {next}', hold: 4, in: 'zoom', out: 'zoom', repeat: 20, atEnd: true };
  for (const len of [20, 45, 600]) {
    const r = m.resolveLowerThird(spec, { part: 2, clipDuration: len });
    const tl = m.lowerThirdTimeline(r, len);
    assert.equal(r.repeat, 0, 'shown once');
    assert.ok(Math.abs((r.start + tl.total) - (len - 0.5)) < 0.02, `ends half a second before the clip does (${len}s)`);
    assert.equal(tl.starts.length, 1);
    assert.ok(m.lowerThirdLayerPlan(r, len), 'it shows inside the clip');
  }
  const tiny = m.resolveLowerThird(spec, { part: 1, clipDuration: 3 });
  assert.equal(tiny.start, 0, 'a very short clip: it simply starts at the beginning');
  const off = m.resolveLowerThird({ ...spec, atEnd: false, start: 2, repeat: 0 }, { part: 1, clipDuration: 30 });
  assert.equal(off.start, 2, 'without the option the start time is used as before');
});
