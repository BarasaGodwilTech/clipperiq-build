'use strict';
/**
 * Framing (a 16:9 video inside a 9:16 frame) and animated lower thirds, end to end through the real
 * server: the clips are rendered by ffmpeg and then inspected frame by frame.
 *
 *  - the output has the expected size, and the default framing is unchanged from before
 *  - a lower third is absent before it starts, present while it shows, and gone after it leaves
 *  - a repeating lower third comes back on the next cycle (the looped layer works)
 *  - the shared drawing / timing / normalising code behaves
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SHARED = path.resolve(ROOT, '..', 'js', 'shared');
const PORT = 34577;
const ffmpeg = () => require(path.join(ROOT, 'node_modules', '@ffmpeg-installer/ffmpeg')).path;
const ffprobe = () => require(path.join(ROOT, 'node_modules', 'ffprobe-static')).path;

test('lower third: spec cleaning and timeline', async () => {
  const lt = await import(pathToFileURL(path.join(SHARED, 'lowerThird.js')).href);
  const clean = lt.normalizeLowerThird({ enabled: true, style: 'nope', title: 'Hi', accent: 'red', size: 99, hold: -5, repeat: 'x', y: 7 });
  assert.equal(clean.style, 'bar');
  assert.equal(clean.accent, '#ff2d55');
  assert.equal(clean.size, 1.8);
  assert.equal(clean.hold, 0.5);
  assert.equal(clean.repeat, 0);
  assert.equal(clean.y, 0.95);
  assert.equal(lt.normalizeLowerThird({ enabled: true }).enabled, false, 'nothing to show means off');

  const spec = lt.normalizeLowerThird({ enabled: true, title: 'A', in: 'slide', out: 'same', hold: 4, start: 2, repeat: 10 });
  const tl = lt.lowerThirdTimeline(spec, 35);
  assert.deepEqual(tl.starts, [2, 12, 22, 32]);
  assert.ok(Math.abs(tl.total - (0.55 + 4 + 0.45)) < 1e-9);
  assert.equal(lt.lowerThirdLayerPlan(spec, 1), null, 'starts after the clip ends: no layer');
  const once = lt.normalizeLowerThird({ enabled: true, title: 'A', start: 1, hold: 3 });
  assert.equal(lt.lowerThirdLayerPlan(once, 20).loop, false);
  assert.equal(lt.lowerThirdLayerPlan(spec, 20).loop, true);
});

test('framing: placement maths', async () => {
  const fr = await import(pathToFileURL(path.join(SHARED, 'framing.js')).href);
  const a = { r: 9 / 16, refW: 1080, refH: 1920 };
  assert.ok(fr.isDefaultFrame(null));
  // the default is the centre crop, as before
  assert.deepEqual(fr.frameOutputSize(1280, 720, a, fr.defaultFrame()), { outW: 406, outH: 720 });
  // 16:9 fitted into 9:16 uses the full width
  const fit = fr.normalizeFrame({ mode: 'fit' });
  const size = fr.frameOutputSize(1280, 720, a, fit);
  assert.deepEqual(size, { outW: 1080, outH: 1920 });
  const r = fr.videoRect(1280, 720, size.outW, size.outH, fit);
  assert.equal(r.w, 1080); assert.equal(r.h, 608); assert.equal(r.covers, false);
  assert.equal(r.y, 656);
  // the legacy "blur" job option still means fit + blurred background
  assert.equal(fr.normalizeFrame(null, 'blur').mode, 'fit');
  // fill never reveals an edge, even if dragged
  const dragged = fr.videoRect(1280, 720, 406, 720, fr.normalizeFrame({ mode: 'fill', zoom: 1.5, x: 5, y: 5 }));
  assert.ok(dragged.covers);
});

test('render: 16:9 in 9:16 with an animated lower third (once and repeating)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-lt-'));
  const dataDir = path.join(tmp, 'data');
  const srcFile = path.join(tmp, 'src.mp4');
  execFileSync(ffmpeg(), [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=14',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=14',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', srcFile,
  ], { stdio: 'ignore' });

  const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, LOG_LEVEL: 'error' }, stdio: 'ignore',
  });
  t.after(() => new Promise((resolve) => {
    const k = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(k); fs.rmSync(tmp, { recursive: true, force: true }); resolve(); });
    child.kill('SIGTERM');
  }));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* retry */ }
    if (i > 60) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 300));
  }
  const json = { 'Content-Type': 'application/json' };
  const data = fs.readFileSync(srcFile);
  const { uploadId } = await (await fetch(`${base}/api/cloud/upload/init`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'src.mp4', size: data.length, type: 'video/mp4' }) })).json();
  await fetch(`${base}/api/cloud/upload?uploadId=${uploadId}`, { method: 'PUT', headers: { 'Content-Range': `bytes 0-${data.length - 1}/${data.length}` }, body: data });
  await fetch(`${base}/api/cloud/info`, { method: 'POST', headers: json, body: JSON.stringify({ uploadId }) });

  async function render(extra) {
    const r = await fetch(`${base}/api/cloud/jobs`, { method: 'POST', headers: json, body: JSON.stringify({
      uploadId, candidates: [{ start: 0, duration: 10 }], reEncode: true, aspectRatio: '9:16', overlayFormat: 'none', seriesStartPart: 1, ...extra,
    }) });
    const j = await r.json();
    assert.ok(j.jobId, JSON.stringify(j));
    for (let i = 0; i < 250; i++) {
      const job = await (await fetch(`${base}/api/cloud/jobs/${j.jobId}`)).json();
      if (job.status === 'done') {
        const file = path.join(tmp, `${j.jobId}.mp4`);
        fs.writeFileSync(file, Buffer.from(await (await fetch(job.clips[0].url)).arrayBuffer()));
        return { job, file };
      }
      assert.notEqual(job.status, 'failed', job.error);
      await new Promise((r2) => setTimeout(r2, 400));
    }
    throw new Error('job did not finish');
  }
  const dims = (f) => execFileSync(ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim();
  /** The strip of the frame where the strap sits, as grey bytes. */
  const band = (f, sec) => execFileSync(ffmpeg(), ['-v', 'error', '-ss', String(sec), '-i', f, '-frames:v', '1', '-vf', 'crop=1080:300:0:1200,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

  // default framing is exactly what it always was
  const plain = await render({});
  assert.equal(dims(plain.file), '406,720');

  const frame = { mode: 'fit', bg: 'blur', zoom: 1, x: 0.5, y: 0.4 };
  const base0 = await render({ frame });
  assert.equal(dims(base0.file), '1080,1920');

  const strap = { enabled: true, style: 'banner', tag: 'SALE', title: 'UP TO 50% OFF', subtitle: 'This weekend only', cta: 'SHOP NOW', accent: '#ff3b30', bg: '#111827', in: 'slide', out: 'slide', loop: 'none', start: 2, hold: 4 };
  const once = await render({ frame, lowerThird: strap });
  assert.equal(dims(once.file), '1080,1920');
  assert.deepEqual(once.job.clips[0].warnings, []);
  assert.ok(diff(band(base0.file, 1.0), band(once.file, 1.0)) < 2, 'nothing before it starts');
  assert.ok(diff(band(base0.file, 4.0), band(once.file, 4.0)) > 10, 'visible while it shows');
  assert.ok(diff(band(base0.file, 8.5), band(once.file, 8.5)) < 2, 'gone after it leaves');

  const rep = await render({ frame, lowerThird: { ...strap, start: 1, hold: 2, repeat: 6 } });
  assert.ok(diff(band(base0.file, 2.5), band(rep.file, 2.5)) > 10, 'first appearance');
  assert.ok(diff(band(base0.file, 5.5), band(rep.file, 5.5)) < 2, 'off between repeats');
  assert.ok(diff(band(base0.file, 8.5), band(rep.file, 8.5)) > 10, 'comes back on the next cycle');

  // a damaged lower third never sinks the clip
  const odd = await render({ frame, lowerThird: { enabled: true, title: 'x'.repeat(500), style: 'zzz', in: 'zzz', accent: 'nope' } });
  assert.equal(odd.job.status, 'done');
  // and a bad request is refused up front
  const bad = await fetch(`${base}/api/cloud/jobs`, { method: 'POST', headers: json, body: JSON.stringify({ uploadId, candidates: [{ start: 0, duration: 3 }], lowerThird: 'nope' }) });
  assert.equal(bad.status, 400);
});
