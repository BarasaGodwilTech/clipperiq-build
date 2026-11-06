'use strict';
/**
 * Jobs: one folder per job with its clips inside, re-renders filed inside the job that made the clip, and retry / resume
 * (finished clips are kept; a job left running by a crash or power cut continues; a stuck job can be forced).
 * The renderer is replaced by a stub so these run anywhere (no ffmpeg, no Express).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const DAY = 86400000;
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStore(dataDir, { render, probe } = {}) {
  const { load } = require(path.join(ROOT, 'src', 'config'));
  const { Store } = require(path.join(ROOT, 'src', 'db'));
  const { createCloudStore } = require(path.join(ROOT, 'src', 'services', 'cloudStore'));
  const config = load({ ...process.env, DATA_DIR: dataDir });
  fs.mkdirSync(config.dirs.data, { recursive: true });
  const db = new Store(config.dbFile, { logger: silent });
  const calls = [];
  const renderer = {
    prepareBgm: async () => ({ bgm: null, cleanup: async () => {} }),
    render: render || (async (spec) => { calls.push(path.basename(spec.outFile)); fs.writeFileSync(spec.outFile, Buffer.alloc(4096, 7)); return { duration: spec.duration, size: 4096, mode: 'encode', width: 720, height: 1280, warnings: [] }; }),
  };
  const cloud = createCloudStore({
    db, config, logger: silent, ff: { probe: probe || (async (f) => ({ duration: 10, size: fs.statSync(f).size })) }, renderer,
    bgmStore: { cleanup: async () => 0, get() { throw new Error('no music'); } }, overlayStore: null,
  });
  db.collection('cloud_uploads').upsert({ id: 'u1', filePath: path.join(dataDir, 'src.mp4'), name: 'My Podcast.mp4', size: 100, ranges: [[0, 100]], probed: true, duration: 600, width: 1920, height: 1080, hasAudio: true, createdAt: Date.now(), updatedAt: Date.now() });
  return { db, cloud, config, calls };
}
const cands = (n) => Array.from({ length: n }, (_, i) => ({ start: i * 30, duration: 20 }));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error('timed out waiting');
}
const tmpdir = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return path.join(d, 'data'); };
const jobsDir = (cloud, id) => path.join(cloud.jobsRoot, id);

test('a job gets its own folder with its clips inside and a job.json', async (t) => {
  const dataDir = tmpdir(t, 'jobs-layout-');
  const { cloud } = makeStore(dataDir);
  const id = cloud.createJob({ uploadId: 'u1', candidates: cands(3), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' }, 'http://x');
  const job = await until(() => { const j = cloud.getJob(id); return j.status === 'done' && j; });

  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads', 'cloud')).sort(), ['jobs'], 'only the jobs folder, no shared clips folder and no per-render folders');
  assert.deepEqual(fs.readdirSync(jobsDir(cloud, id)).sort(), ['clips', 'job.json']);
  assert.deepEqual(fs.readdirSync(path.join(jobsDir(cloud, id), 'clips')).sort(), ['clip_01.mp4', 'clip_02.mp4', 'clip_03.mp4']);
  assert.equal(job.clips[1].url, `http://x/uploads/cloud/jobs/${id}/clips/clip_02.mp4`);
  assert.equal(job.clips[0].sourceDuration, 20, 'a clip says how much of the source it was cut from (its finished length can differ)');

  const m = JSON.parse(fs.readFileSync(path.join(jobsDir(cloud, id), 'job.json'), 'utf8'));
  assert.equal(m.jobId, id); assert.equal(m.status, 'done'); assert.equal(m.source.name, 'My Podcast.mp4');
  assert.deepEqual(m.clips.map((c) => c.file), ['clip_01.mp4', 'clip_02.mp4', 'clip_03.mp4']);
  assert.equal(m.settings.aspectRatio, '9:16');

  const chunk = await cloud.readClipChunk(id, 2, 0, 16);
  assert.equal(chunk.data.length, 16);
});

test('re-rendering one clip files it inside the job that made the clip', async (t) => {
  const dataDir = tmpdir(t, 'jobs-rev-');
  const { cloud, db } = makeStore(dataDir);
  const id = cloud.createJob({ uploadId: 'u1', candidates: cands(3), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' }, 'http://x');
  await until(() => cloud.getJob(id).status === 'done');
  const before = db.collection('cloud_jobs').get(id).updatedAt;
  await sleep(15);

  const edit1 = cloud.createJob({ uploadId: 'u1', candidates: [{ start: 31, duration: 15 }], parentJobId: id, clipIndex: 1 }, 'http://x');
  const edit2 = cloud.createJob({ uploadId: 'u1', candidates: [{ start: 32, duration: 15 }], parentJobId: id, clipIndex: 1 }, 'http://x');
  await until(() => cloud.getJob(edit1).status === 'done' && cloud.getJob(edit2).status === 'done');

  assert.deepEqual(fs.readdirSync(cloud.jobsRoot), [id], 'no extra job folder was made');
  assert.deepEqual(fs.readdirSync(path.join(jobsDir(cloud, id), 'clips')).sort(), ['clip_01.mp4', 'clip_02.mp4', 'clip_02.r2.mp4', 'clip_02.r3.mp4', 'clip_03.mp4']);
  assert.equal(cloud.getJob(edit1).clips[0].url, `http://x/uploads/cloud/jobs/${id}/clips/clip_02.r2.mp4`);
  assert.equal(cloud.getJob(edit2).clips[0].url, `http://x/uploads/cloud/jobs/${id}/clips/clip_02.r3.mp4`);
  assert.ok(db.collection('cloud_jobs').get(id).updatedAt > before, 'the parent job is kept alive by its re-renders');
  assert.equal((await cloud.readClipChunk(edit2, 0, 0, 8)).data.length, 8);

  const m = JSON.parse(fs.readFileSync(path.join(jobsDir(cloud, id), 'job.json'), 'utf8'));
  assert.deepEqual(m.revisions.map((r) => [r.clip, r.revision, r.file]), [[2, 2, 'clip_02.r2.mp4'], [2, 3, 'clip_02.r3.mp4']]);

  // not a real parent (different video, bad index, several clips): it just becomes a job of its own
  const own = cloud.createJob({ uploadId: 'u1', candidates: cands(2), parentJobId: id, clipIndex: 0 }, 'http://x');
  const own2 = cloud.createJob({ uploadId: 'u1', candidates: [{ start: 0, duration: 5 }], parentJobId: id, clipIndex: 9 }, 'http://x');
  await until(() => cloud.getJob(own).status === 'done' && cloud.getJob(own2).status === 'done');
  assert.ok(fs.existsSync(jobsDir(cloud, own)) && fs.existsSync(jobsDir(cloud, own2)));
});

test('retry (resume) keeps the clips that finished and renders only the rest', async (t) => {
  const dataDir = tmpdir(t, 'jobs-resume-');
  let failOnce = true;
  const calls = [];
  const render = async (spec) => {
    const name = path.basename(spec.outFile);
    calls.push(name);
    if (/clip_03/.test(name) && failOnce) { failOnce = false; throw new Error('ffmpeg exploded'); }
    fs.writeFileSync(spec.outFile, Buffer.alloc(4096, 1));
    return { duration: spec.duration, size: 4096, mode: 'encode', warnings: [] };
  };
  const { cloud } = makeStore(dataDir, { render });
  const id = cloud.createJob({ uploadId: 'u1', candidates: cands(4), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' }, 'http://x');
  const failed = await until(() => { const j = cloud.getJob(id); return j.status === 'failed' && j; });
  assert.match(failed.error, /Clip 3\/4 failed/);
  assert.equal(failed.clips.length, 2, 'the two clips before the failure are kept');

  calls.length = 0;
  const v = await cloud.retryJob(id, { mode: 'resume' });
  assert.equal(v.status, 'queued'); assert.equal(v.attempts, 1);
  const done = await until(() => { const j = cloud.getJob(id); return j.status === 'done' && j; });
  assert.deepEqual(calls.map((n) => n.replace(/\.tmp\d+/, '')).sort(), ['clip_03.mp4', 'clip_04.mp4'], 'finished clips were not rendered again');
  assert.deepEqual(done.clips.map((c) => c.index), [0, 1, 2, 3]);
  assert.equal(done.error, null);

  // nothing is missing: resume is a no-op, restart really starts over
  calls.length = 0;
  assert.equal((await cloud.retryJob(id)).status, 'done');
  assert.equal(calls.length, 0);
  await cloud.retryJob(id, { mode: 'restart' });
  await until(() => cloud.getJob(id).status === 'done' && calls.length === 4);
  assert.equal(cloud.getJob(id).clips.length, 4);
});

test('a clip file that went missing is rendered again on resume', async (t) => {
  const dataDir = tmpdir(t, 'jobs-missing-');
  const { cloud, calls } = makeStore(dataDir);
  const id = cloud.createJob({ uploadId: 'u1', candidates: cands(3), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' }, 'http://x');
  await until(() => cloud.getJob(id).status === 'done');
  fs.unlinkSync(path.join(jobsDir(cloud, id), 'clips', 'clip_02.mp4'));
  calls.length = 0;
  await cloud.retryJob(id);
  await until(() => cloud.getJob(id).status === 'done' && calls.length === 1);
  assert.match(calls[0], /^clip_02/);
  assert.ok(fs.existsSync(path.join(jobsDir(cloud, id), 'clips', 'clip_02.mp4')));
  assert.deepEqual(cloud.getJob(id).clips.map((c) => c.index), [0, 1, 2]);
});

test('after a crash or power cut the job continues where it stopped', async (t) => {
  const dataDir = tmpdir(t, 'jobs-crash-');
  const clipsDir = path.join(dataDir, 'uploads', 'cloud', 'jobs', 'job_crash', 'clips');
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(path.join(clipsDir, 'clip_01.mp4'), Buffer.alloc(4096, 1));      // finished, and the saved state knows it
  fs.writeFileSync(path.join(clipsDir, 'clip_02.tmp1.mp4'), Buffer.alloc(900, 2));  // half written when the power went
  fs.writeFileSync(path.join(clipsDir, 'clip_04.mp4'), Buffer.alloc(4096, 4));      // finished, but the state was lost before it was saved
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    cloud_jobs: {
      job_crash: {
        id: 'job_crash', uploadId: 'u1', status: 'running', progress: 20, error: null, layout: 'job', rootId: 'job_crash', outDir: clipsDir, baseUrl: 'http://x',
        candidates: cands(4), reEncode: true, aspectRatio: '9:16', fit: 'crop', overlayFormat: 'none', seriesStartPart: 1, bgm: null, originalVolume: 1,
        clips: [{ url: 'http://x/old', startTime: 0, duration: 20, index: 0, size: 4096, mode: 'encode', warnings: [] }],
        createdAt: Date.now() - 5000, updatedAt: Date.now() - 5000,
      },
    },
  }));
  const { cloud, calls } = makeStore(dataDir);
  cloud.recover();
  const done = await until(() => { const j = cloud.getJob('job_crash'); return j.status === 'done' && j; });

  assert.deepEqual(calls.map((n) => n.replace(/\.tmp\d+/, '')).sort(), ['clip_02.mp4', 'clip_03.mp4'], 'only the two missing clips were rendered');
  assert.deepEqual(done.clips.map((c) => c.index), [0, 1, 2, 3]);
  assert.deepEqual(fs.readdirSync(clipsDir).sort(), ['clip_01.mp4', 'clip_02.mp4', 'clip_03.mp4', 'clip_04.mp4'], 'the half-written file is gone');
});

test('a job that is stuck can be taken over with force, and the old run can no longer change it', async (t) => {
  const dataDir = tmpdir(t, 'jobs-force-');
  let n = 0;
  let releaseOld;
  const render = async (spec, { signal } = {}) => {
    n++;
    if (n === 1) { // hangs, and ignores being told to stop until released (a stuck ffmpeg)
      await new Promise((r) => { releaseOld = r; });
      fs.writeFileSync(spec.outFile, Buffer.alloc(4096, 9));
      return { duration: spec.duration, size: 4096, mode: 'encode', warnings: [] };
    }
    fs.writeFileSync(spec.outFile, Buffer.alloc(4096, 1));
    return { duration: spec.duration, size: 4096, mode: 'encode', warnings: [] };
  };
  const { cloud } = makeStore(dataDir, { render });
  const id = cloud.createJob({ uploadId: 'u1', candidates: cands(2), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' }, 'http://x');
  await until(() => n === 1);
  await assert.rejects(() => cloud.retryJob(id), (e) => e.status === 409, 'without force a working job is left alone');

  await cloud.retryJob(id, { force: true });
  const done = await until(() => { const j = cloud.getJob(id); return j.status === 'done' && j; });
  assert.equal(done.clips.length, 2);
  assert.equal(done.attempts, 1);

  releaseOld(); // the stuck run wakes up long after: it must not touch the finished job
  await sleep(150);
  const after = cloud.getJob(id);
  assert.equal(after.status, 'done'); assert.equal(after.error, null); assert.equal(after.clips.length, 2);
  assert.ok(!fs.readdirSync(path.join(jobsDir(cloud, id), 'clips')).some((f) => /\.tmp/.test(f)), 'no temporary files left behind');
});

test('a job whose source video is gone from the server says so', async (t) => {
  const dataDir = tmpdir(t, 'jobs-nosource-');
  const { cloud, db } = makeStore(dataDir);
  const id = cloud.createJob({ uploadId: 'u1', candidates: cands(2), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' }, 'http://x');
  await until(() => cloud.getJob(id).status === 'done');
  db.collection('cloud_uploads').remove('u1');
  await cloud.retryJob(id, { mode: 'restart' });
  const failed = await until(() => { const j = cloud.getJob(id); return j.status === 'failed' && j; });
  assert.equal(failed.errorCode, 'source-missing');
  assert.match(failed.error, /no longer on the server/);
});

test('older layouts are moved into job folders on startup and keep working', async (t) => {
  const dataDir = tmpdir(t, 'jobs-migrate-');
  const cloudDir = path.join(dataDir, 'uploads', 'cloud');
  const flat = path.join(cloudDir, 'clips');
  const legacy = path.join(cloudDir, 'job_old');
  fs.mkdirSync(flat, { recursive: true }); fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(flat, 'job_flat_01.mp4'), 'one'); fs.writeFileSync(path.join(flat, 'job_flat_02.mp4'), 'two');
  fs.writeFileSync(path.join(legacy, 'clip_01.mp4'), 'old');
  const job = (id, extra) => ({ id, uploadId: 'u1', status: 'done', baseUrl: 'http://x', candidates: [{}, {}], clips: [{ index: 0, url: 'u' }, { index: 1, url: 'u' }], createdAt: Date.now(), updatedAt: Date.now(), ...extra });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ cloud_jobs: {
    job_flat: job('job_flat', { layout: 'flat', outDir: flat }),
    job_old: job('job_old', { outDir: legacy, clips: [{ index: 0, url: 'u' }] }),
  } }));
  const { cloud, db } = makeStore(dataDir);

  assert.ok(!fs.existsSync(flat), 'the shared folder is gone once empty');
  assert.ok(!fs.existsSync(legacy), 'the old per-render folder is gone');
  assert.deepEqual(fs.readdirSync(path.join(cloud.jobsRoot, 'job_flat', 'clips')).sort(), ['clip_01.mp4', 'clip_02.mp4']);
  assert.deepEqual(fs.readdirSync(path.join(cloud.jobsRoot, 'job_old', 'clips')), ['clip_01.mp4']);
  const rec = db.collection('cloud_jobs').get('job_flat');
  assert.equal(rec.layout, 'job'); assert.equal(rec.clips[1].url, 'http://x/uploads/cloud/jobs/job_flat/clips/clip_02.mp4');
  assert.equal((await cloud.readClipChunk('job_flat', 1, 0, 10)).data.toString(), 'two');
  assert.ok(fs.existsSync(path.join(cloud.jobsRoot, 'job_flat', 'job.json')));
});

test('cleanup removes a whole expired job with its re-renders and never another job', async (t) => {
  const dataDir = tmpdir(t, 'jobs-clean-');
  const { cloud, db } = makeStore(dataDir);
  const a = cloud.createJob({ uploadId: 'u1', candidates: cands(2), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none' }, 'http://x');
  const b = cloud.createJob({ uploadId: 'u1', candidates: cands(2), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none', seriesStartPart: 5 }, 'http://x'); // (identical settings would be treated as the same request)
  await until(() => cloud.getJob(a).status === 'done' && cloud.getJob(b).status === 'done');
  const edit = cloud.createJob({ uploadId: 'u1', candidates: [{ start: 1, duration: 5 }], parentJobId: a, clipIndex: 0 }, 'http://x');
  await until(() => cloud.getJob(edit).status === 'done');

  const old = Date.now() - 40 * DAY;
  db.collection('cloud_jobs').update(a, { updatedAt: old });
  db.collection('cloud_jobs').update(edit, { updatedAt: old });
  await cloud.cleanup();
  assert.ok(!fs.existsSync(jobsDir(cloud, a)), 'the expired job folder is gone, with its re-render');
  assert.equal(db.collection('cloud_jobs').get(edit), null);
  assert.ok(fs.existsSync(path.join(jobsDir(cloud, b), 'clips', 'clip_02.mp4')), 'the other job is untouched');
  assert.ok(fs.existsSync(cloud.jobsRoot), 'the jobs folder itself survives');
});

test('every clip is told its own part number (lower thirds say Follow for Part {next} per clip)', async (t) => {
  const dataDir = tmpdir(t, 'jobs-part-');
  const seen = [];
  const render = async (spec) => { seen.push([path.basename(spec.outFile).replace(/\.tmp\d+/, ''), spec.partNumber]); fs.writeFileSync(spec.outFile, Buffer.alloc(4096, 1)); return { duration: spec.duration, size: 4096, mode: 'encode', warnings: [] }; };
  const { cloud } = makeStore(dataDir, { render });
  // a series that starts at part 3, with the overlay switched off (the part number still has to reach the lower third)
  const id = cloud.createJob({ uploadId: 'u1', candidates: cands(3), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none', seriesStartPart: 3, lowerThird: { enabled: true, title: 'Follow for Part {next}' } }, 'http://x');
  await until(() => cloud.getJob(id).status === 'done');
  assert.deepEqual(seen.sort().map((x) => x[1]), [3, 4, 5]);
  // a re-render of the second clip (part 4) is told part 4, not part 1
  seen.length = 0;
  const edit = cloud.createJob({ uploadId: 'u1', candidates: [{ start: 31, duration: 15 }], parentJobId: id, clipIndex: 1, seriesStartPart: 4, lowerThird: { enabled: true, title: 'Follow for Part {next}' } }, 'http://x');
  await until(() => cloud.getJob(edit).status === 'done');
  assert.deepEqual(seen.map((x) => x[1]), [4]);
});

// ── duplicates, cancelling, empty folders ──────────────────────────────────────────────────
const spec = (extra = {}) => ({ uploadId: 'u1', candidates: cands(2), reEncode: true, aspectRatio: '9:16', overlayFormat: 'none', ...extra });
const hangingRender = (started) => async (s, { signal } = {}) => {
  started.push(path.basename(s.outFile));
  await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
};

test('the same request never becomes two jobs (retries, double clicks, a second tab)', async (t) => {
  const started = [];
  const { cloud } = makeStore(tmpdir(t, 'jobs-dup-'), { render: hangingRender(started) });
  const a = cloud.createJob(spec({ requestId: 'req-1' }), 'http://x');
  assert.equal(cloud.createJob(spec({ requestId: 'req-1' }), 'http://x'), a, 'the same request id gives back the same job');
  assert.equal(cloud.createJob(spec({ requestId: 'req-2' }), 'http://x'), a, 'an identical request while it works gives back the same job');
  assert.equal(cloud.createJob(spec(), 'http://x'), a, 'also without any request id');
  const other = cloud.createJob(spec({ candidates: cands(3) }), 'http://x');
  assert.notEqual(other, a, 'a different request is a different job');
  assert.deepEqual(fs.readdirSync(cloud.jobsRoot).sort(), [a, other].sort(), 'two jobs, two folders, nothing else');
  await cloud.cancelJob(a); await cloud.cancelJob(other);
  // after a job was stopped, asking again is allowed to make a new one
  assert.notEqual(cloud.createJob(spec({ requestId: 'req-3' }), 'http://x'), a);
  await until(() => started.length >= 1);
});

test('cancelling a queued job and a running job; finished clips are kept, an empty job leaves no folder', async (t) => {
  const calls = [];
  let hangFor = null; let hung = false;
  const render = async (s, { signal } = {}) => {
    const name = path.basename(s.outFile).replace(/\.tmp\d+/, '');
    const jobId = path.basename(path.dirname(path.dirname(s.outFile)));
    if (jobId === hangFor) calls.push(name);
    if (jobId === hangFor && /clip_02/.test(name) && !hung) { // the first time the running job renders clip 2 it hangs until stopped
      hung = true;
      await new Promise((res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }); });
    }
    fs.writeFileSync(s.outFile, Buffer.alloc(4096, 5));
    return { duration: s.duration, size: 4096, mode: 'encode', warnings: [] };
  };
  const { cloud } = makeStore(tmpdir(t, 'jobs-cancel-'), { render });
  const running = cloud.createJob(spec({ candidates: cands(3) }), 'http://x'); hangFor = running;
  const queued = cloud.createJob(spec({ candidates: cands(2), seriesStartPart: 9 }), 'http://x');
  await until(() => cloud.getJob(running).clips.length === 1 && calls.includes('clip_02.mp4'));

  // stop the one waiting in line: it never starts, and it leaves nothing behind
  assert.equal((await cloud.cancelJob(queued)).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(cloud.jobsRoot, queued)), false, 'no folder for a job that made nothing');

  // stop the running one: clip 1 stays
  assert.equal((await cloud.cancelJob(running)).status, 'cancelled');
  await sleep(100);
  assert.deepEqual(fs.readdirSync(path.join(cloud.jobsRoot, running, 'clips')), ['clip_01.mp4']);
  assert.equal(cloud.getJob(running).status, 'cancelled', 'a late report from the stopped render does not change it');
  assert.equal((await cloud.cancelJob(running)).status, 'cancelled', 'cancelling twice is harmless');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cloud.jobsRoot, running, 'job.json'), 'utf8')).status, 'cancelled');

  // and it can be picked up again: only the rest is made
  calls.length = 0;
  await cloud.retryJob(running);
  const done = await until(() => { const j = cloud.getJob(running); return j.status === 'done' && j; });
  assert.deepEqual(done.clips.map((c) => c.index), [0, 1, 2]);
  assert.ok(!calls.includes('clip_01.mp4'), 'clip 1 was not made again');
});

test('a finished job cannot be "cancelled" into losing its clips', async (t) => {
  const { cloud } = makeStore(tmpdir(t, 'jobs-cancel-done-'));
  const id = cloud.createJob(spec(), 'http://x');
  await until(() => cloud.getJob(id).status === 'done');
  assert.equal((await cloud.cancelJob(id)).status, 'done');
  assert.equal(fs.readdirSync(path.join(cloud.jobsRoot, id, 'clips')).length, 2);
});

test('a half-sent upload is thrown away on cancel; a complete one is kept for reuse', async (t) => {
  const dataDir = tmpdir(t, 'jobs-upload-');
  const { cloud, db } = makeStore(dataDir);
  const file = path.join(dataDir, 'half.mp4'); fs.writeFileSync(file, 'x'.repeat(40));
  db.collection('cloud_uploads').upsert({ id: 'half', filePath: file, name: 'h.mp4', size: 100, ranges: [[0, 40]], createdAt: Date.now(), updatedAt: Date.now() });
  assert.deepEqual(await cloud.discardUpload('half'), { removed: true });
  assert.equal(fs.existsSync(file), false); assert.equal(db.collection('cloud_uploads').get('half'), null);
  assert.deepEqual(await cloud.discardUpload('u1'), { removed: false, kept: true }, 'the complete upload stays');
  assert.deepEqual(await cloud.discardUpload('nope'), { removed: false });
});

test('empty job folders are tidied away; folders with clips are never touched', async (t) => {
  const dataDir = tmpdir(t, 'jobs-tidy-');
  const root = path.join(dataDir, 'uploads', 'cloud', 'jobs');
  const mkdir = (n, files = []) => { fs.mkdirSync(path.join(root, n, 'clips'), { recursive: true }); for (const f of files) fs.writeFileSync(path.join(root, n, 'clips', f), 'x'); fs.writeFileSync(path.join(root, n, 'job.json'), '{}'); };
  mkdir('job_failed_empty'); mkdir('job_orphan_empty'); mkdir('job_has_clips', ['clip_01.mp4']); mkdir('job_queued_empty');
  const rec = (id, status, clips = []) => ({ id, uploadId: 'u1', status, layout: 'job', rootId: id, outDir: path.join(root, id, 'clips'), baseUrl: 'http://x', candidates: [{}], clips, createdAt: Date.now(), updatedAt: Date.now() });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ cloud_jobs: { job_failed_empty: rec('job_failed_empty', 'failed'), job_has_clips: rec('job_has_clips', 'done', [{ index: 0 }]), job_queued_empty: rec('job_queued_empty', 'queued') } }));
  const { cloud } = makeStore(dataDir, { render: hangingRender([]) });
  cloud.recover();
  assert.deepEqual(fs.readdirSync(root).sort(), ['job_has_clips', 'job_queued_empty']);
  await cloud.cancelJob('job_queued_empty');
});

test('stopped jobs that made nothing are removed after a few hours, ones with clips are not', async (t) => {
  const { cloud, db } = makeStore(tmpdir(t, 'jobs-old-'));
  const a = cloud.createJob(spec(), 'http://x'); await until(() => cloud.getJob(a).status === 'done');
  const col = db.collection('cloud_jobs');
  col.insert({ id: 'job_stale', uploadId: 'u1', status: 'failed', layout: 'job', rootId: 'job_stale', outDir: path.join(cloud.jobsRoot, 'job_stale', 'clips'), clips: [], candidates: [{}], createdAt: 1, updatedAt: Date.now() - 7 * 3600000 });
  col.insert({ id: 'job_recent', uploadId: 'u1', status: 'cancelled', layout: 'job', rootId: 'job_recent', outDir: path.join(cloud.jobsRoot, 'job_recent', 'clips'), clips: [], candidates: [{}], createdAt: 1, updatedAt: Date.now() - 3600000 });
  await cloud.cleanup();
  assert.equal(col.get('job_stale'), null); assert.ok(col.get('job_recent')); assert.ok(col.get(a));
});

// ── reusing a video that is already on the server ─────────────────────────────────────────────
const FP = 'a'.repeat(64);
function seedUpload(db, dataDir, id, extra = {}) {
  const file = path.join(dataDir, `${id}.mp4`); fs.writeFileSync(file, Buffer.alloc(4096, 3));
  db.collection('cloud_uploads').upsert({ id, filePath: file, name: `${id}.mp4`, size: 4096, ranges: [[0, 4096]], probed: true, duration: 321, width: 1920, height: 1080, hasAudio: true, fingerprint: FP, createdAt: Date.now() - 5000, updatedAt: Date.now() - 5000, ...extra });
  return file;
}

test('a video that is already on the server is found, not sent again', async (t) => {
  const dataDir = tmpdir(t, 'jobs-reuse-');
  const { cloud, db } = makeStore(dataDir);
  seedUpload(db, dataDir, 'u_old');
  const found = await cloud.findUpload({ fingerprint: FP, size: 4096 });
  assert.deepEqual(found, { found: true, uploadId: 'u_old', name: 'u_old.mp4', duration: 321 });
  assert.ok(db.collection('cloud_uploads').get('u_old').updatedAt > Date.now() - 2000, 'a reused video does not expire while in use');
  assert.deepEqual(await cloud.findUpload({ fingerprint: FP, size: 999 }), { found: false }, 'same fingerprint but another size');
  assert.deepEqual(await cloud.findUpload({ fingerprint: 'b'.repeat(64), size: 4096 }), { found: false });
  assert.deepEqual(await cloud.findUpload({ fingerprint: 'nonsense', size: 4096 }), { found: false });
  assert.deepEqual(await cloud.findUpload({}), { found: false });
  // a new upload records its fingerprint so it can be found next time
  const id = await cloud.initUpload({ name: 'x.mp4', size: 100, type: 'video/mp4', fingerprint: 'C'.repeat(64) });
  assert.equal(db.collection('cloud_uploads').get(id).fingerprint, 'c'.repeat(64));
  assert.deepEqual(await cloud.findUpload({ fingerprint: 'c'.repeat(64), size: 100 }), { found: false }, 'still being sent: not a copy to reuse');
});

test('a copy with a problem is never reused: it is dropped so the video is uploaded afresh', async (t) => {
  const dataDir = tmpdir(t, 'jobs-reuse-bad-');
  const { cloud, db } = makeStore(dataDir, { probe: async () => ({ duration: 0 }) });
  const file = seedUpload(db, dataDir, 'u_unreadable');
  assert.deepEqual(await cloud.findUpload({ fingerprint: FP, size: 4096 }), { found: false });
  assert.equal(db.collection('cloud_uploads').get('u_unreadable'), null); assert.equal(fs.existsSync(file), false);

  const { cloud: c2, db: db2 } = makeStore(tmpdir(t, 'jobs-reuse-gone-'));
  const f2 = seedUpload(db2, path.dirname(c2.jobsRoot).replace(/uploads.cloud$/, ''), 'u_gone'); // (any folder that exists)
  fs.unlinkSync(f2);
  assert.deepEqual(await c2.findUpload({ fingerprint: FP, size: 4096 }), { found: false }, 'the file is missing');
  assert.equal(db2.collection('cloud_uploads').get('u_gone'), null);

  const { cloud: c3, db: db3 } = makeStore(tmpdir(t, 'jobs-reuse-tiny-'));
  const f3 = seedUpload(db3, path.join(path.dirname(c3.jobsRoot), '..', '..'), 'u_tiny'); fs.writeFileSync(f3, 'x');
  assert.deepEqual(await c3.findUpload({ fingerprint: FP, size: 4096 }), { found: false }, 'an empty file');
});

test('a copy that a running job is using is not deleted even if it looks bad', async (t) => {
  const dataDir = tmpdir(t, 'jobs-reuse-busy-');
  const started = [];
  const { cloud, db } = makeStore(dataDir, { render: hangingRender(started), probe: async () => ({ duration: 0 }) });
  seedUpload(db, dataDir, 'u1', { fingerprint: FP });
  const id = cloud.createJob(spec(), 'http://x');
  await until(() => started.length >= 1);
  assert.deepEqual(await cloud.findUpload({ fingerprint: FP, size: 4096 }), { found: false });
  assert.ok(db.collection('cloud_uploads').get('u1'), 'still there for the job that is using it');
  await cloud.cancelJob(id);
});
