'use strict';
/**
 * Desktop app: a video is used where it is on disk (no upload, no copy), the original is never deleted, and the
 * server only answers the app's own window (secret cookie + loopback Host).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCloudStore } = require('../src/services/cloudStore');
const { Store } = require('../src/db');
const { createDesktopGuard } = require('../src/middleware/desktopGuard');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ciq-link-'));
  const dirs = { data: path.join(root, 'data'), uploads: path.join(root, 'data', 'uploads-src'), tmp: path.join(root, 'tmp'), logs: path.join(root, 'logs'), bgm: path.join(root, 'bgm') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const config = { dirs, dbFile: path.join(root, 'db.json'), limits: { maxUploadBytes: 1 << 30, maxClipsPerJob: 50 }, retention: { sourceDays: 1 },
    ffmpeg: { clipConcurrency: 1, maxConcurrentRenders: 1, videoEncoder: 'libx264', crf: 20, preset: 'veryfast' }, port: 1 };
  const db = new Store(config.dbFile, { logger: quiet });
  const ff = {
    probe: async () => ({ hasVideo: true, hasAudio: true, duration: 120, headerDuration: 120, measuredDuration: 120, width: 1920, height: 1080,
      videoSpan: 120, audioSpan: 120, videoCodec: 'h264', audioCodec: 'aac', nominalFps: 30, fps: 30 }),
  };
  const cloud = createCloudStore({ db, config, logger: quiet, ff, renderer: {}, bgmStore: { cleanup: async () => 0 }, overlayStore: { cleanup: async () => 0 } });
  return { root, cloud, db };
}

test('linking uses the file in place: no copy, same file links to the same entry', async () => {
  const { root, cloud, db } = setup();
  const video = path.join(root, 'My Movie.mp4');
  fs.writeFileSync(video, Buffer.alloc(5000, 1));
  const a = await cloud.linkUpload({ path: video });
  assert.ok(a.uploadId); assert.equal(a.reused, false);
  const ready = await cloud.ensureReady(a.uploadId);
  assert.equal(ready.filePath, video);          // read where it is
  assert.equal(ready.duration, 120);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'uploads-src')), []); // nothing was copied
  const b = await cloud.linkUpload({ path: video });
  assert.equal(b.uploadId, a.uploadId); assert.equal(b.reused, true);
  const c = await cloud.linkUpload({ path: video, fresh: true });
  assert.notEqual(c.uploadId, a.uploadId);
  db.close();
});

test('the person\'s original is never deleted by discard / cleanup / purge', async () => {
  const { root, cloud, db } = setup();
  const video = path.join(root, 'keep.mkv');
  fs.writeFileSync(video, Buffer.alloc(5000, 2));
  const { uploadId } = await cloud.linkUpload({ path: video });
  await cloud.discardUpload(uploadId);
  db.collection('cloud_uploads').update(uploadId, { updatedAt: 1 }); // long unused: the housekeeping removes the record
  await cloud.cleanup();
  assert.ok(!db.collection('cloud_uploads').get(uploadId), 'the record is cleaned up');
  await cloud.purge({ uploadId });
  assert.ok(fs.existsSync(video), 'the original file must still exist');
  db.close();
});

test('bad requests are refused clearly', async () => {
  const { root, cloud, db } = setup();
  await assert.rejects(cloud.linkUpload({ path: 'relative/video.mp4' }), /full path/);
  await assert.rejects(cloud.linkUpload({ path: path.join(root, 'nope.mp4') }), /Cannot find/);
  const txt = path.join(root, 'notes.txt'); fs.writeFileSync(txt, 'x'.repeat(3000));
  await assert.rejects(cloud.linkUpload({ path: txt }), /video file/);
  const tiny = path.join(root, 'tiny.mp4'); fs.writeFileSync(tiny, 'x');
  await assert.rejects(cloud.linkUpload({ path: tiny }), /too small/);
  db.close();
});

test('a linked video that was moved gives a clear message', async () => {
  const { root, cloud, db } = setup();
  const video = path.join(root, 'gone.mp4'); fs.writeFileSync(video, Buffer.alloc(4000, 3));
  const { uploadId } = await cloud.linkUpload({ path: video });
  fs.unlinkSync(video);
  await assert.rejects(cloud.ensureReady(uploadId), /moved, renamed or deleted/);
  db.close();
});

test('desktop guard: only the app window (secret cookie) and loopback Host get through', () => {
  const guard = createDesktopGuard({ desktop: { enabled: true, token: 'sekret' }, port: 38417 });
  const run = (headers, p = '/api/cloud/health') => { let out = 'next'; guard({ headers, path: p }, { status: (c) => ({ send: () => { out = c; } }) }, () => { out = 'next'; }); return out; };
  assert.equal(run({ host: '127.0.0.1:38417', cookie: 'a=b; ciq_token=sekret' }), 'next');
  assert.equal(run({ host: '127.0.0.1:38417' }), 403);                                        // a web page in a browser: no secret
  assert.equal(run({ host: '127.0.0.1:38417', cookie: 'ciq_token=wrong' }), 403);
  assert.equal(run({ host: 'evil.example:38417', cookie: 'ciq_token=sekret' }), 403);          // DNS rebinding
  assert.equal(run({ host: '127.0.0.1:38417' }, '/healthz'), 'next');                          // health check stays open
  const off = createDesktopGuard({ desktop: { enabled: false, token: '' }, port: 3000 });
  let ok = false; off({ headers: {}, path: '/x' }, {}, () => { ok = true; }); assert.ok(ok);   // browser / server use: unchanged
});
