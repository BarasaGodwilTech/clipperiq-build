'use strict';
/**
 * Clip storage layout: every job has ONE folder (uploads/cloud/jobs/<jobId>) with its clips inside, a re-render of a clip
 * (edit, remix, design) is filed inside the job that made the clip, cleanup must only ever delete the files of the job
 * being cleaned, and installs with older layouts must be tidied into job folders on startup.
 * (More cases that need no ffmpeg or Express: jobs.test.js.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 34540;
const DAY = 86400000;

function silentLogger() {
  const n = () => {};
  return { debug: n, info: n, warn: n, error: n };
}

/** A cloud store wired to a temp data folder, with the render/audio dependencies stubbed out. */
function makeStore(dataDir) {
  const { load } = require(path.join(ROOT, 'src', 'config'));
  const { Store } = require(path.join(ROOT, 'src', 'db'));
  const { createCloudStore } = require(path.join(ROOT, 'src', 'services', 'cloudStore'));
  const config = load({ ...process.env, DATA_DIR: dataDir });
  fs.mkdirSync(config.dirs.data, { recursive: true });
  const db = new Store(config.dbFile, { logger: silentLogger() });
  const cloud = createCloudStore({
    db, config, logger: silentLogger(), ff: {}, renderer: {},
    bgmStore: { cleanup: async () => 0 }, overlayStore: null,
  });
  return { db, cloud, config };
}

function killAndWait(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

test('cleanup removes only the expired job\'s folder', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-clean-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');

  const jobsRoot = path.join(dataDir, 'uploads', 'cloud', 'jobs');
  const mk = (id, updatedAt) => ({
    id, uploadId: 'u_none', status: 'done', layout: 'job', rootId: id, outDir: path.join(jobsRoot, id, 'clips'), baseUrl: 'http://x',
    clips: [{ index: 0 }, { index: 1 }], updatedAt, createdAt: updatedAt,
  });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    cloud_jobs: { job_old: mk('job_old', Date.now() - 40 * DAY), job_new: mk('job_new', Date.now()) },
  }));
  for (const id of ['job_old', 'job_new']) {
    fs.mkdirSync(path.join(jobsRoot, id, 'clips'), { recursive: true });
    for (const f of ['clip_01.mp4', 'clip_02.mp4']) fs.writeFileSync(path.join(jobsRoot, id, 'clips', f), 'x');
  }

  const { cloud } = makeStore(dataDir);
  await cloud.cleanup();

  assert.deepEqual(fs.readdirSync(jobsRoot).sort(), ['job_new'], 'only the expired job\'s folder should be gone');
  assert.deepEqual(fs.readdirSync(path.join(jobsRoot, 'job_new', 'clips')).sort(), ['clip_01.mp4', 'clip_02.mp4']);
});

test('per-job folders from older versions are moved into job folders', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-migrate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');

  const cloudDir = path.join(dataDir, 'uploads', 'cloud');
  const legacyDir = path.join(cloudDir, 'job_legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'clip_01.mp4'), 'first');
  fs.writeFileSync(path.join(legacyDir, 'clip_02.mp4'), 'second');
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    cloud_jobs: { job_legacy: { id: 'job_legacy', uploadId: 'u_none', status: 'done', outDir: legacyDir, baseUrl: 'http://x', clips: [{ index: 0 }, { index: 1 }], updatedAt: Date.now() } },
  }));

  const { cloud, db } = makeStore(dataDir);

  assert.ok(!fs.existsSync(legacyDir), 'the old per-render folder should be gone');
  const clipsDir = path.join(cloudDir, 'jobs', 'job_legacy', 'clips');
  assert.deepEqual(fs.readdirSync(clipsDir).sort(), ['clip_01.mp4', 'clip_02.mp4']);
  assert.equal(db.collection('cloud_jobs').get('job_legacy').layout, 'job');

  const chunk = await cloud.readClipChunk('job_legacy', 1, 0, 100);
  assert.equal(chunk.data.toString(), 'second');
});

test('a job recorded against the parent folder is never deleted as a folder', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-legacy-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dataDir = path.join(tmp, 'data');
  const cloudDir = path.join(dataDir, 'uploads', 'cloud');
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(path.join(cloudDir, 'keep.txt'), 'important');
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    cloud_jobs: { job_odd: { id: 'job_odd', uploadId: 'u', status: 'done', outDir: cloudDir, baseUrl: 'http://x', clips: [], updatedAt: Date.now() - 40 * DAY } },
  }));
  const { cloud } = makeStore(dataDir);
  await cloud.cleanup();
  assert.ok(fs.existsSync(path.join(cloudDir, 'keep.txt')), 'cleanup must not delete the parent folder');
});

test('an edit/re-render is filed inside the job that made the clip', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-onefolder-'));
  const dataDir = path.join(tmp, 'data');
  const srcFile = path.join(tmp, 'src.mp4');
  const ffmpeg = require(path.join(ROOT, 'node_modules', '@ffmpeg-installer/ffmpeg')).path;
  execFileSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', srcFile,
  ], { stdio: 'ignore' });

  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'error' }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  t.after(async () => { await killAndWait(child); fs.rmSync(tmp, { recursive: true, force: true }); });

  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 300));
  }

  const json = { 'Content-Type': 'application/json' };
  const data = fs.readFileSync(srcFile);
  const { uploadId } = await (await fetch(`${base}/api/cloud/upload/init`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'src.mp4', size: data.length, type: 'video/mp4' }) })).json();
  await fetch(`${base}/api/cloud/upload?uploadId=${uploadId}`, { method: 'PUT', headers: { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` }, body: data });
  await fetch(`${base}/api/cloud/info`, { method: 'POST', headers: json, body: JSON.stringify({ uploadId }) });

  async function render(candidates, extra = {}) {
    const { jobId } = await (await fetch(`${base}/api/cloud/jobs`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ uploadId, candidates, reEncode: true, aspectRatio: '9:16', overlayFormat: 'none', seriesStartPart: 1, ...extra }),
    })).json();
    for (let i = 0; i < 150; i++) {
      const job = await (await fetch(`${base}/api/cloud/jobs/${jobId}`)).json();
      if (job.status === 'done') return job;
      assert.notEqual(job.status, 'failed', job.error);
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('job did not finish');
  }

  const first = await render([{ start: 0, duration: 4 }, { start: 4, duration: 4 }]);
  const edit = await render([{ start: 1, duration: 3 }], { parentJobId: first.jobId, clipIndex: 1 }); // "an edit" of clip 2

  const cloudDir = path.join(dataDir, 'uploads', 'cloud');
  assert.deepEqual(fs.readdirSync(cloudDir), ['jobs'], 'there must be exactly one jobs folder');
  assert.deepEqual(fs.readdirSync(path.join(cloudDir, 'jobs')), [first.jobId], 'the edit does not get a folder of its own');
  const files = fs.readdirSync(path.join(cloudDir, 'jobs', first.jobId, 'clips')).sort();
  assert.deepEqual(files, ['clip_01.mp4', 'clip_02.mp4', 'clip_02.r2.mp4']);

  for (const clip of [...first.clips, ...edit.clips]) {
    assert.match(clip.url, new RegExp(`/uploads/cloud/jobs/${first.jobId}/clips/clip_\\d\\d(\\.r\\d)?\\.mp4$`));
    const res = await fetch(clip.url);
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  }

  const r = await fetch(`${base}/api/cloud/clip-chunk`, { method: 'POST', headers: json, body: JSON.stringify({ jobId: edit.jobId, index: 0, offset: 0, length: 1024 }) });
  assert.equal(r.status, 200);

  // the retry endpoint: a finished job with all its clips has nothing to redo
  const again = await (await fetch(`${base}/api/cloud/jobs/${first.jobId}/retry`, { method: 'POST', headers: json, body: '{}' })).json();
  assert.equal(again.status, 'done');
});
