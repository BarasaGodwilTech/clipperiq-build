'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAnalysisTasks } = require('../src/services/analysisTasks');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs in the background, reports progress, then returns the result', async () => {
  const t = createAnalysisTasks({ run: async (id, p, { onProgress }) => { onProgress(0.3); await wait(30); onProgress(0.8); await wait(30); return { duration: 10, candidates: [1] }; } });
  const v = t.start('u1', { maxClips: 3 });
  assert.strictEqual(v.status, 'running');
  await wait(45);
  const mid = t.get(v.taskId); assert.ok(mid.progress >= 30 && mid.progress < 100, 'progress ' + mid.progress);
  await wait(60);
  const end = t.get(v.taskId); assert.strictEqual(end.status, 'done'); assert.strictEqual(end.progress, 100); assert.deepStrictEqual(end.result.candidates, [1]);
});

test('progress never goes backwards and is capped below 100 until done', async () => {
  const t = createAnalysisTasks({ run: async (id, p, { onProgress }) => { onProgress(0.9); onProgress(0.2); onProgress(5); await wait(40); return {}; } });
  const v = t.start('u', {}); await wait(10);
  assert.strictEqual(t.get(v.taskId).progress, 99);
});

test('a failure is reported with its message', async () => {
  const t = createAnalysisTasks({ run: async () => { throw Object.assign(new Error('Could not read this file as a video'), { status: 422 }); } });
  const v = t.start('u', {}); await wait(20);
  const r = t.get(v.taskId); assert.strictEqual(r.status, 'failed'); assert.match(r.error, /Could not read/); assert.strictEqual(r.errorCode, 422);
});

test('cancel stops the work', async () => {
  let aborted = false;
  const t = createAnalysisTasks({ run: (id, p, { signal }) => new Promise((res, rej) => signal.addEventListener('abort', () => { aborted = true; rej(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); })) });
  const v = t.start('u', {}); assert.strictEqual(t.cancel(v.taskId), true); await wait(20);
  assert.ok(aborted); assert.strictEqual(t.get(v.taskId).status, 'cancelled');
  assert.strictEqual(t.cancel('nope'), false);
});

test('asking twice for the same running analysis gives the same task', async () => {
  const t = createAnalysisTasks({ run: async () => { await wait(40); return {}; } });
  const a = t.start('u', { n: 1 }); const b = t.start('u', { n: 1 }); const c = t.start('u', { n: 2 });
  assert.strictEqual(a.taskId, b.taskId); assert.notStrictEqual(a.taskId, c.taskId);
});

test('unknown task ids return null and old finished tasks are forgotten', async () => {
  const t = createAnalysisTasks({ run: async () => ({}), keepMs: 5 });
  assert.strictEqual(t.get('x'), null);
  const v = t.start('u', {}); await wait(30); t.start('u2', {}); await wait(10);
  assert.strictEqual(t.get(v.taskId), null);
});
