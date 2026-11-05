'use strict';
/** Things going wrong: a damaged cached animation (the failure that kept failing Retry), locked files, a full disk, unknown errors. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const { explain, detailOf } = require(path.join(ROOT, 'src', 'services', 'explainError.js'));
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpdir = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return path.join(d, 'data'); };
async function until(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); } throw new Error('timed out waiting'); }

const LOG_ERROR = 'Clip 12/15 failed: D:\\clipperIQ\\server\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe exited with code 1: [mov,mp4,m4a,3gp,3g2,mj2 @ 000002263929a080] moov atom not found | D:\\clipperIQ\\server\\data\\tmp\\lt_c24759fda82fb241.mov: Invalid data found when processing input';

test('every kind of failure is explained in plain words, and the exact one from the log is recognised', () => {
  const x = explain(LOG_ERROR);
  assert.equal(x.code, 'layer-damaged'); assert.equal(x.healable, true);
  assert.match(x.title, /lower-third animation file was damaged/);
  const table = [
    ['moov atom not found | D:\\v\\source_upload.mp4: Invalid data found', 'source-damaged', false],
    ['ENOSPC: no space left on device, write', 'disk-full', false],
    ["EBUSY: resource busy or locked, rename 'a' -> 'b'", 'file-locked', true],
    ['EPERM: operation not permitted', 'file-locked', true],
    ['Cannot allocate memory', 'out-of-memory', false],
    ['Unknown encoder h264_nvenc', 'encoder-problem', false],
    ['the canvas module is not installed on the server', 'canvas-missing', false],
    ['ENOENT: no such file or directory, open x', 'file-missing', true],
    ['ffmpeg exited with code 3221225477', 'process-crashed', true],
    ['Invalid uploadId', 'source-missing', false],
    ['something nobody planned for', 'unknown', false],
  ];
  for (const [msg, code, healable] of table) { const r = explain(msg); assert.equal(r.code, code, msg); assert.equal(r.healable, healable, msg); assert.ok(r.title.length > 10); }
  assert.ok(!detailOf(LOG_ERROR, 'D:\\clipperIQ').includes('D:\\clipperIQ'), 'the install folder is shortened in the details');
  assert.ok(detailOf('x'.repeat(5000)).length <= 700);
});

function makeStore(dataDir, render, extra = {}) {
  const { load } = require(path.join(ROOT, 'src', 'config'));
  const { Store } = require(path.join(ROOT, 'src', 'db'));
  const { createCloudStore } = require(path.join(ROOT, 'src', 'services', 'cloudStore'));
  const config = load({ ...process.env, DATA_DIR: dataDir }); config.rootDir = REPO;
  fs.mkdirSync(config.dirs.data, { recursive: true });
  const db = new Store(config.dbFile, { logger: silent });
  const purged = [];
  const renderer = {
    prepareBgm: async () => ({ bgm: null, cleanup: async () => {} }),
    purgeBrokenInputs: async (m) => { purged.push(m); return 1; },
    render,
  };
  const cloud = createCloudStore({ db, config, logger: silent, ff: { probe: async () => ({ duration: 10 }) }, renderer, bgmStore: { cleanup: async () => 0, get() { throw new Error('none'); } }, overlayStore: null, ...extra });
  db.collection('cloud_uploads').upsert({ id: 'u1', filePath: path.join(dataDir, 'src.mp4'), name: 'a.mp4', size: 100, ranges: [[0, 100]], probed: true, duration: 600, width: 1920, height: 1080, hasAudio: true, createdAt: Date.now(), updatedAt: Date.now() });
  return { cloud, db, purged };
}
const ok = (s) => { fs.writeFileSync(s.outFile, Buffer.alloc(4096, 1)); return { duration: s.duration, size: 4096, mode: 'encode', warnings: [] }; };
const job = (n = 3) => ({ uploadId: 'u1', candidates: Array.from({ length: n }, (_, i) => ({ start: i * 30, duration: 20 })), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' });

test('a damaged cached animation is deleted and the clip is simply made again (no failed job, no Retry needed)', async (t) => {
  let hits = 0;
  const { cloud, purged } = makeStore(tmpdir(t, 'heal-layer-'), async (s) => {
    if (/clip_02/.test(s.outFile) && hits++ < 1) throw new Error(LOG_ERROR); // the first try of clip 2 meets the damaged file
    return ok(s);
  });
  const id = cloud.createJob(job(), 'http://x');
  const done = await until(() => { const j = cloud.getJob(id); return ['done', 'failed'].includes(j.status) && j; });
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.clips.length, 3);
  assert.equal(purged.length, 1); assert.match(purged[0], /lt_c24759fda82fb241\.mov/, 'the damaged file named in the error was purged');
});

test('a file that is locked for a moment is retried; a repair that never works ends in a clear message, with the finished clips kept', async (t) => {
  let tries = 0;
  const a = makeStore(tmpdir(t, 'heal-busy-'), async (s) => { if (/clip_01/.test(s.outFile) && tries++ < 2) throw new Error("EBUSY: resource busy or locked, rename 'x' -> 'y'"); return ok(s); });
  const idA = a.cloud.createJob(job(2), 'http://x');
  assert.equal((await until(() => { const j = a.cloud.getJob(idA); return ['done', 'failed'].includes(j.status) && j; })).status, 'done', 'two locked tries, then it works');

  const b = makeStore(tmpdir(t, 'heal-never-'), async (s) => { if (/clip_03/.test(s.outFile)) throw new Error('EBUSY: resource busy or locked'); return ok(s); });
  const idB = b.cloud.createJob(job(3), 'http://x');
  const failed = await until(() => { const j = b.cloud.getJob(idB); return j.status === 'failed' && j; });
  assert.equal(failed.errorCode, 'file-locked'); assert.match(failed.error, /Clip 3 of 3 could not be made/); assert.match(failed.error, /antivirus/);
  assert.match(failed.errorDetail, /EBUSY/); assert.equal(failed.clips.length, 2, 'the clips before it are kept');
});

test('what cannot be repaired is reported with what to do, not as a wall of ffmpeg text', async (t) => {
  const d = makeStore(tmpdir(t, 'heal-disk-'), async (s) => { if (/clip_02/.test(s.outFile)) throw new Error('ENOSPC: no space left on device, write'); return ok(s); });
  const id = d.cloud.createJob(job(2), 'http://x');
  const f = await until(() => { const j = d.cloud.getJob(id); return j.status === 'failed' && j; });
  assert.equal(f.errorCode, 'disk-full'); assert.match(f.error, /Free some space/); assert.ok(f.error.length < 400);

  const u = makeStore(tmpdir(t, 'heal-unk-'), async (s) => { if (/clip_01/.test(s.outFile)) throw new Error('flux capacitor overloaded'); return ok(s); });
  const id2 = u.cloud.createJob(job(1), 'http://x');
  const f2 = await until(() => { const j = u.cloud.getJob(id2); return j.status === 'failed' && j; });
  assert.equal(f2.errorCode, null); assert.match(f2.error, /unexpected/); assert.match(f2.error, /flux capacitor/, 'an unknown error still shows its own words');
  // and Retry afterwards clears the error
  await u.cloud.retryJob(id2);
  assert.equal(u.cloud.getJob(id2).error, null); assert.equal(u.cloud.getJob(id2).errorDetail, null);
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('the layer cache never serves a damaged file: a truncated animation is detected and purged', { skip: !haveFfmpeg, timeout: 60000 }, async (t) => {
  const dir = tmpdir(t, 'heal-cache-'); fs.mkdirSync(dir, { recursive: true });
  const { createFfmpeg } = require(path.join(ROOT, 'src', 'media', 'ffmpeg.js'));
  const { createLowerThirdRenderer } = require(path.join(ROOT, 'src', 'media', 'lowerThird.js'));
  const { load } = require(path.join(ROOT, 'src', 'config'));
  const config = load({ ...process.env, DATA_DIR: dir }); config.rootDir = REPO;
  fs.mkdirSync(config.dirs.tmp, { recursive: true });
  const ff = createFfmpeg(config, null);
  const good = path.join(config.dirs.tmp, 'lt_aaaaaaaaaaaaaaaa.mov');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x60:d=2:r=30', '-vf', 'format=argb', '-c:v', 'png', good]).status, 0);
  const lt = createLowerThirdRenderer({ ff, config, logger: silent });
  assert.equal(await lt.isValidLayer(good), true, 'a complete animation is accepted');
  const bad = path.join(config.dirs.tmp, 'lt_bbbbbbbbbbbbbbbb.mov');
  fs.writeFileSync(bad, fs.readFileSync(good).subarray(0, Math.floor(fs.statSync(good).size / 2))); // cut in half, as a killed ffmpeg leaves it
  assert.equal(await lt.isValidLayer(bad), false, 'a truncated one is refused');
  assert.equal(await lt.isValidLayer(path.join(config.dirs.tmp, 'nope.mov')), false);
  fs.writeFileSync(path.join(config.dirs.tmp, 'lt_bbbbbbbbbbbbbbbb.mov.1234.abcd.part'), 'half');
  assert.ok((await lt.purge(bad)) >= 2, 'the damaged file and its half-drawn leftovers are removed');
  assert.deepEqual(fs.readdirSync(config.dirs.tmp).filter((n) => n.includes('bbbb')), []);
  assert.ok(fs.existsSync(good), 'the good one is untouched');
  // a start-up sweep removes half-drawn leftovers from a crash
  fs.writeFileSync(path.join(config.dirs.tmp, 'lt_cccccccccccccccc.mov.part'), 'x');
  createLowerThirdRenderer({ ff, config, logger: silent });
  assert.ok(!fs.existsSync(path.join(config.dirs.tmp, 'lt_cccccccccccccccc.mov.part')));
});
