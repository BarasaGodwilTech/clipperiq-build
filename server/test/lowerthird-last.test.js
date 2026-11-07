'use strict';
// The last part of a run can show different text, or nothing (a "Follow for Part {next}" strap has no next part there).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const SHARED = pathToFileURL(path.join(__dirname, '..', '..', 'js', 'shared', 'lowerThird.js')).href;
const load = () => import(SHARED);
const follow = async () => { const lt = await load(); return { lt, spec: lt.normalizeLowerThird({ ...lt.LT_PRESETS.find((p) => p.id === 'follow').spec, enabled: true }) }; };

test('the Follow preset closes with a thank-you on the last part and points forward on the others', async () => {
  const { lt, spec } = await follow();
  assert.strictEqual(lt.resolveLowerThird(spec, { part: 3, clipDuration: 30 }).title, 'Follow for Part 4');
  assert.strictEqual(lt.resolveLowerThird(spec, { part: 6, clipDuration: 30, isLast: true }).title, 'Thanks for watching!');
});

test('"same" keeps the old behaviour, so existing designs do not change', async () => {
  const { lt, spec } = await follow();
  assert.strictEqual(lt.resolveLowerThird({ ...spec, last: 'same' }, { part: 6, isLast: true }).title, 'Follow for Part 7');
  assert.strictEqual(lt.resolveLowerThird({ enabled: true, style: 'pill', title: 'Follow for Part {next}' }, { part: 6, isLast: true }).title, 'Follow for Part 7');
});

test('"hide" removes it on the last part only', async () => {
  const { lt, spec } = await follow();
  assert.strictEqual(lt.resolveLowerThird({ ...spec, last: 'hide' }, { part: 6, isLast: true }).enabled, false);
  assert.strictEqual(lt.resolveLowerThird({ ...spec, last: 'hide' }, { part: 5, isLast: false }).enabled, true);
});

test('the closing text can use {part}, and an empty closing text shows nothing', async () => {
  const { lt, spec } = await follow();
  assert.strictEqual(lt.resolveLowerThird({ ...spec, last: 'text', lastTitle: 'The end of part {part}' }, { part: 6, isLast: true }).title, 'The end of part 6');
  assert.strictEqual(lt.resolveLowerThird({ ...spec, last: 'text', lastTitle: '' }, { part: 6, isLast: true }).enabled, false);
});

test('the look and timing do not change on the last part, and bad values are repaired', async () => {
  const { lt, spec } = await follow();
  const a = lt.resolveLowerThird(spec, { part: 3, clipDuration: 30 }); const b = lt.resolveLowerThird(spec, { part: 6, clipDuration: 30, isLast: true });
  for (const k of ['style', 'accent', 'bg', 'font', 'in', 'out', 'hold', 'start']) assert.strictEqual(b[k], a[k], k);
  assert.strictEqual(lt.normalizeLowerThird({ enabled: true, title: 'x', last: 'bogus' }).last, 'same');
});
