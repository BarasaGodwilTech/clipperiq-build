'use strict';
/**
 * End-to-end smoke test: spawns the real server, generates a tiny synthetic video with
 * ffmpeg, and drives it through the exact HTTP calls the frontend makes — chunked upload
 * (deliberately out of order, to guard against the range-tracking regressing), analyze,
 * render a job, then fetch the rendered clip back and sanity-check it.
 *
 * Run with: npm test   (needs network access the first time, to fetch ffmpeg via npm if it
 * isn't already installed — everything after that is fully local).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 34519; // unlikely to collide with a dev server on 3000
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Terminates a spawned server and waits for it to actually exit before returning — not just
 * for the signal to be sent. The server has a graceful-shutdown window (it finishes flushing
 * its database and log file before exiting), so deleting its temp directory immediately after
 * calling .kill() races that shutdown and intermittently fails with ENOTEMPTY. Falls back to
 * SIGKILL if graceful shutdown takes too long.
 */
function killAndWait(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(`${BASE}/healthz`).then((r) => (r.ok ? resolve() : retry())).catch(retry);
      function retry() {
        if (Date.now() > deadline) return reject(new Error('server did not become healthy in time'));
        setTimeout(poll, 300);
      }
    })();
  });
}

test('cloud pipeline: upload -> analyze -> render -> fetch', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-test-'));
  const dataDir = path.join(tmp, 'data');
  const srcFile = path.join(tmp, 'src.mp4');

  await t.test('build a synthetic source video', () => {
    const ffmpeg = require(path.join(ROOT, 'node_modules', '@ffmpeg-installer/ffmpeg')).path;
    execFileSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', srcFile,
    ], { stdio: 'ignore' });
    assert.ok(fs.existsSync(srcFile));
  });

  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'error' },
    stdio: 'ignore',
  });
  t.after(async () => { await killAndWait(child); fs.rmSync(tmp, { recursive: true, force: true }); });

  await t.test('server becomes healthy', () => waitForHealth());

  let uploadId;
  await t.test('chunked upload (reverse order, exercises range merging)', async () => {
    const data = fs.readFileSync(srcFile);
    const size = data.length;
    const r = await fetch(`${BASE}/api/cloud/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'src.mp4', size, type: 'video/mp4' }),
    });
    assert.equal(r.status, 200);
    ({ uploadId } = await r.json());
    assert.ok(uploadId);

    const chunkSize = 512 * 1024;
    const ranges = [];
    for (let off = 0; off < size; off += chunkSize) ranges.push([off, Math.min(size, off + chunkSize) - 1]);
    for (const [start, end] of ranges.reverse()) {
      const rr = await fetch(`${BASE}/api/cloud/upload?uploadId=${uploadId}`, {
        method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end}/${size}` }, body: data.subarray(start, end + 1),
      });
      assert.equal(rr.status, 200, await rr.text());
    }
  });

  await t.test('info reports the correct duration once complete', async () => {
    const r = await fetch(`${BASE}/api/cloud/info`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId }),
    });
    assert.equal(r.status, 200);
    const { duration } = await r.json();
    assert.ok(Math.abs(duration - 20) < 1, `expected ~20s, got ${duration}`);
  });

  let candidates;
  await t.test('analyze returns scored candidates', async () => {
    const r = await fetch(`${BASE}/api/cloud/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, maxClips: 3, targetDuration: 5 }),
    });
    assert.equal(r.status, 200);
    ({ candidates } = await r.json());
    assert.ok(candidates.length > 0);
  });

  let jobId;
  await t.test('a render job starts', async () => {
    const r = await fetch(`${BASE}/api/cloud/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, candidates: candidates.slice(0, 2), reEncode: true, aspectRatio: '9:16', overlayFormat: 'part-text', seriesStartPart: 1 }),
    });
    assert.equal(r.status, 200);
    ({ jobId } = await r.json());
    assert.ok(jobId);
  });

  await t.test('the job finishes and clips are fetchable', async () => {
    const deadline = Date.now() + 60000;
    let job;
    do {
      const r = await fetch(`${BASE}/api/cloud/jobs/${jobId}`);
      job = await r.json();
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 400));
    } while (Date.now() < deadline);

    assert.equal(job.status, 'done', job.error || 'job did not finish in time');
    assert.equal(job.clips.length, 2);
    for (const clip of job.clips) {
      const r = await fetch(clip.url);
      assert.equal(r.status, 200);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.ok(buf.length > 1000, 'rendered clip is unexpectedly small');
    }
  });
});

test('background music: registered track is genuinely mixed into a render', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-bgm-test-'));
  const dataDir = path.join(tmp, 'data');
  const srcFile = path.join(tmp, 'src.mp4');
  const bgmFile = path.join(tmp, 'bgm.mp3');

  await t.test('build synthetic source (440Hz) + bgm (330Hz) audio', () => {
    const ffmpeg = require(path.join(ROOT, 'node_modules', '@ffmpeg-installer/ffmpeg')).path;
    execFileSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'color=c=gray:size=320x240:rate=15:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', srcFile,
    ], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', bgmFile], { stdio: 'ignore' });
    assert.ok(fs.existsSync(srcFile) && fs.existsSync(bgmFile));
  });

  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT + 1), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'error' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT + 1}`;
  t.after(async () => { await killAndWait(child); fs.rmSync(tmp, { recursive: true, force: true }); });

  await t.test('server becomes healthy', async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* retry */ }
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  let uploadId;
  await t.test('upload source', async () => {
    const data = fs.readFileSync(srcFile);
    const r = await fetch(`${base}/api/cloud/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'src.mp4', size: data.length, type: 'video/mp4' }),
    });
    ({ uploadId } = await r.json());
    const rr = await fetch(`${base}/api/cloud/upload?uploadId=${uploadId}`, {
      method: 'PUT', headers: { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` }, body: data,
    });
    assert.equal(rr.status, 200);
    const info = await (await fetch(`${base}/api/cloud/info`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId }),
    })).json();
    assert.ok(Math.abs(info.duration - 12) < 1);
  });

  let bgmId;
  await t.test('register background music', async () => {
    const data = fs.readFileSync(bgmFile);
    const r = await fetch(`${base}/api/cloud/bgm/upload?filename=bgm.mp3`, {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: data,
    });
    assert.equal(r.status, 200);
    ({ bgmId } = await r.json());
    assert.ok(bgmId);
  });

  let clipUrl;
  await t.test('render a job that references the bgm', async () => {
    const r = await fetch(`${base}/api/cloud/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId, candidates: [{ start: 1, duration: 8, totalScore: 90 }],
        reEncode: true, aspectRatio: 'original', overlayFormat: 'none', seriesStartPart: 1,
        originalVolume: 0.8, bgm: { bgmId, volume: 0.6, duck: false, restart: true },
      }),
    });
    const { jobId } = await r.json();
    const deadline = Date.now() + 60000;
    let job;
    do {
      job = await (await fetch(`${base}/api/cloud/jobs/${jobId}`)).json();
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 400));
    } while (Date.now() < deadline);
    assert.equal(job.status, 'done', job.error);
    clipUrl = job.clips[0].url;
  });

  await t.test('rendered clip contains both the original tone and the bgm tone', async () => {
    const buf = Buffer.from(await (await fetch(clipUrl)).arrayBuffer());
    const outFile = path.join(tmp, 'out.mp4');
    fs.writeFileSync(outFile, buf);
    const ffmpeg = require(path.join(ROOT, 'node_modules', '@ffmpeg-installer/ffmpeg')).path;
    const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', outFile, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1024 * 1024 * 64 });
    const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    const n = samples.length;
    const windowed = new Float64Array(n);
    for (let i = 0; i < n; i++) windowed[i] = (samples[i] / 32768) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    // Goertzel-style magnitude at a target frequency (no FFT dependency needed for two bins).
    const magnitudeAt = (freq) => {
      const k = Math.round((freq * n) / 8000);
      let re = 0; let im = 0;
      for (let i = 0; i < n; i++) { const ang = (2 * Math.PI * k * i) / n; re += windowed[i] * Math.cos(ang); im -= windowed[i] * Math.sin(ang); }
      return Math.hypot(re, im);
    };
    const a440 = magnitudeAt(440);
    const a330 = magnitudeAt(330);
    const baseline = magnitudeAt(1000);
    assert.ok(a440 > baseline * 5, `original 440Hz tone not detected (got ${a440} vs baseline ${baseline})`);
    assert.ok(a330 > baseline * 5, `background-music 330Hz tone not detected (got ${a330} vs baseline ${baseline}) -- BGM mixing regressed`);
  });
});

test('styled-number overlay renders without aborting the clip (regression: was uncaught)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-overlay-test-'));
  const dataDir = path.join(tmp, 'data');
  const srcFile = path.join(tmp, 'src.mp4');

  await t.test('build a synthetic source video', () => {
    const ffmpeg = require(path.join(ROOT, 'node_modules', '@ffmpeg-installer/ffmpeg')).path;
    execFileSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=15',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=15',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', srcFile,
    ], { stdio: 'ignore' });
    assert.ok(fs.existsSync(srcFile));
  });

  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT + 2), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'error' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT + 2}`;
  t.after(async () => { await killAndWait(child); fs.rmSync(tmp, { recursive: true, force: true }); });

  await t.test('server becomes healthy', async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* retry */ }
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  let uploadId;
  await t.test('upload source', async () => {
    const data = fs.readFileSync(srcFile);
    const r = await fetch(`${base}/api/cloud/upload/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'src.mp4', size: data.length, type: 'video/mp4' }),
    });
    ({ uploadId } = await r.json());
    const rr = await fetch(`${base}/api/cloud/upload?uploadId=${uploadId}`, {
      method: 'PUT', headers: { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` }, body: data,
    });
    assert.equal(rr.status, 200);
    await fetch(`${base}/api/cloud/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId }) });
  });

  await t.test('render with styled-number overlay, 9:16, Fast Mode (reEncode=false)', async () => {
    const r = await fetch(`${base}/api/cloud/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId, candidates: [{ start: 1, duration: 8, totalScore: 80 }],
        reEncode: false, aspectRatio: '9:16', overlayFormat: 'styled-number', seriesStartPart: 7,
      }),
    });
    const { jobId } = await r.json();
    const deadline = Date.now() + 60000;
    let job;
    do {
      job = await (await fetch(`${base}/api/cloud/jobs/${jobId}`)).json();
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 400));
    } while (Date.now() < deadline);
    assert.equal(job.status, 'done', job.error);
    const buf = Buffer.from(await (await fetch(job.clips[0].url)).arrayBuffer());
    assert.ok(buf.length > 1000, 'rendered clip is unexpectedly small');
  });
});
