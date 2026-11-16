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

test('a missing captions engine is reported as a warning and does not fail the test', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-st3-'));
  const config = { rootDir: dir, dirs: { tmp: path.join(dir, 'tmp'), data: dir }, captions: { bundled: false } };
  const jobs = {};
  const cloud = {
    jobsRoot: path.join(dir, 'jobs'), isBusy: () => false, initUpload: async () => 'u1',
    writeChunk: async (id, req) => { await new Promise((r) => { req.on('data', () => {}); req.on('end', r); }); return { done: true }; },
    ensureReady: async () => ({ duration: 40, width: 640, height: 360, hasAudio: true }), analyze: async () => ({ candidates: [{ start: 0, duration: 15 }, { start: 20, duration: 15 }] }),
    createJob: ({ candidates }) => { const id = `j${Object.keys(jobs).length}`; jobs[id] = candidates; return id; },
    getJob: (id) => ({ status: 'done', progress: 100, clips: jobs[id].map(() => ({})) }), purge: async () => {},
  };
  const ff = { detectCapabilities: async () => ({ ok: true, version: '6' }), runFfmpeg: async (a) => { fs.mkdirSync(config.dirs.tmp, { recursive: true }); fs.writeFileSync(a[a.length - 1], Buffer.alloc(100)); }, probe: async () => ({ duration: 15 }) };
  const { createSelfTest } = require('../src/services/selfTest');
  const missing = createSelfTest({ cloud, ff, config, logger: { info() {}, warn() {} }, transcriber: { status: async () => ({ ready: false, engine: 'none', hint: 'No speech-to-text engine is set up yet.' }) } });
  const v = missing.start(); let r; do { await new Promise((x) => setTimeout(x, 20)); r = missing.get(v.testId); } while (r.status === 'running');
  const cap = r.steps.find((x) => /Captions/.test(x.name));
  assert.equal(cap.status, 'warn'); assert.match(cap.detail, /not set up/);
  assert.equal(r.ok, true, `the rest of the test still passes: ${JSON.stringify(r.steps.filter((x) => x.status === 'fail'))}`);
  const ready = createSelfTest({ cloud, ff, config: { ...config, captions: { bundled: true } }, logger: { info() {}, warn() {} }, transcriber: { status: async () => ({ ready: true, engine: 'whisper-cpp' }) } });
  const v2 = ready.start(); let r2; do { await new Promise((x) => setTimeout(x, 20)); r2 = ready.get(v2.testId); } while (r2.status === 'running');
  assert.match(r2.steps.find((x) => /Captions/.test(x.name)).detail, /ready: whisper-cpp \(built in\)/);
});
