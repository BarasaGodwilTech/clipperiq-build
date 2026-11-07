'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSelfTest } = require('../src/services/selfTest');

function setup({ failAt = '', busy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-st-'));
  const config = { rootDir: root, dirs: { tmp: path.join(root, 'tmp'), data: root } };
  const purged = [];
  const jobs = {};
  const cloud = {
    jobsRoot: path.join(root, 'jobs'),
    isBusy: () => busy,
    initUpload: async () => 'u1',
    writeChunk: async (id, req) => { await new Promise((r) => { req.on('data', () => {}); req.on('end', r); }); return { done: true }; },
    ensureReady: async () => ({ duration: 40, width: 640, height: 360, hasAudio: true }),
    analyze: async () => ({ candidates: failAt === 'analyze' ? [] : [{ start: 0, duration: 15 }, { start: 20, duration: 15 }] }),
    createJob: ({ candidates }) => { const id = 'j' + Object.keys(jobs).length; jobs[id] = candidates; return id; },
    getJob: (id) => ({ status: failAt === 'job' ? 'failed' : 'done', error: failAt === 'job' ? 'Unknown encoder libx264' : '', progress: 100, clips: jobs[id].map(() => ({})) }),
    purge: async (a) => { purged.push(a); },
  };
  const ff = {
    detectCapabilities: async () => ({ ok: failAt !== 'ffmpeg', version: '6.0', reason: 'blocked' }),
    runFfmpeg: async (args) => { fs.mkdirSync(config.dirs.tmp, { recursive: true }); fs.writeFileSync(args[args.length - 1], Buffer.alloc(2048)); },
    probe: async () => ({ duration: 15 }),
  };
  const logger = { info() {}, warn() {} };
  return { st: createSelfTest({ cloud, ff, config, logger }), purged, config };
}
const finish = async (st, v) => { let r; do { await new Promise((x) => setTimeout(x, 20)); r = st.get(v.testId); } while (r.status === 'running'); return r; };

test('a healthy machine passes every step and cleans up', async () => {
  const { st, purged, config } = setup();
  const r = await finish(st, st.start());
  assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
  assert.ok(r.steps.length >= 8 && r.steps.every((s) => s.status === 'ok'));
  assert.deepStrictEqual(purged[0].jobIds.length, 2); assert.strictEqual(purged[0].uploadId, 'u1');
  assert.strictEqual(fs.readdirSync(config.dirs.tmp).filter((f) => f.startsWith('selftest')).length, 0, 'test video removed');
});

test('a blocked FFmpeg stops at step one with the reason', async () => {
  const { st } = setup({ failAt: 'ffmpeg' });
  const r = await finish(st, st.start());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.steps.length, 1); assert.match(r.steps[0].detail, /blocked/);
});

test('an empty analysis is reported, later steps are not run, and it still cleans up', async () => {
  const { st, purged } = setup({ failAt: 'analyze' });
  const r = await finish(st, st.start());
  assert.strictEqual(r.ok, false); assert.strictEqual(r.steps[r.steps.length - 1].status, 'fail'); assert.match(r.steps[r.steps.length - 1].detail, /no clips/);
  assert.strictEqual(purged.length, 1);
});

test('a failed cutting job shows its message and advice', async () => {
  const { st } = setup({ failAt: 'job' });
  const r = await finish(st, st.start());
  const bad = r.steps.find((s) => s.status === 'fail'); assert.match(bad.detail, /libx264/); assert.ok(bad.advice);
});

test('refuses to run while videos are processing, and only one test runs at a time', async () => {
  assert.throws(() => setup({ busy: true }).st.start(), /being processed/);
  const { st } = setup(); const a = st.start(); const b = st.start();
  assert.strictEqual(a.testId, b.testId); await finish(st, a);
});
