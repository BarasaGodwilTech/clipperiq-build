'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlots } = require('../src/services/slots');

const tick = () => new Promise((r) => setImmediate(r));

test('never more than the limit at once, and the rest wait in order', async () => {
  const s = createSlots(2); const order = [];
  const a = await s.acquire(); const b = await s.acquire();
  const c = s.acquire().then((rel) => { order.push('c'); return rel; });
  const d = s.acquire().then((rel) => { order.push('d'); return rel; });
  await tick(); assert.deepEqual(s.stats(), { capacity: 2, running: 2, waiting: 2 }); assert.deepEqual(order, []);
  a(); await tick(); assert.deepEqual(order, ['c']);
  b(); await tick(); assert.deepEqual(order, ['c', 'd']);
  (await c)(); (await d)(); assert.deepEqual(s.stats(), { capacity: 2, running: 0, waiting: 0 });
});

test('releasing twice does not hand out an extra slot', async () => {
  const s = createSlots(1); const rel = await s.acquire(); rel(); rel();
  const x = await s.acquire(); const y = s.acquire(); await tick();
  assert.equal(s.stats().running, 1); assert.equal(s.stats().waiting, 1); x(); (await y)();
});

test('a waiter can be cancelled while it waits, and an already-cancelled one never starts', async () => {
  const s = createSlots(1); const hold = await s.acquire();
  const ac = new AbortController(); const w = s.acquire(ac.signal);
  await tick(); ac.abort();
  await assert.rejects(w, (e) => e.code === 'ABORT_ERR'); assert.equal(s.stats().waiting, 0);
  const done = new AbortController(); done.abort();
  await assert.rejects(s.acquire(done.signal), (e) => e.code === 'ABORT_ERR');
  hold(); assert.equal(s.stats().running, 0);
});

test('two jobs sharing the slots take turns instead of one starving the other', async () => {
  const s = createSlots(1); const log = [];
  const job = (name, n) => (async () => { for (let i = 0; i < n; i++) { const rel = await s.acquire(); log.push(name); await tick(); rel(); } })();
  await Promise.all([job('A', 4), job('B', 4)]);
  assert.deepEqual(log, ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
});

test('the limit can be changed while running', async () => {
  const s = createSlots(1); const a = await s.acquire(); const w = s.acquire(); await tick(); assert.equal(s.stats().waiting, 1);
  s.resize(2); const b = await w; assert.equal(s.stats().running, 2); a(); b();
});
