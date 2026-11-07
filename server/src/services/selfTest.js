'use strict';
/**
 * "Test processing": makes a short video of its own and runs it through the same steps a real video goes through
 * (upload, reading it, finding the best moments, cutting clips both ways), then reports each step in plain words.
 * If something is wrong on this computer (FFmpeg, a full disk, a folder that cannot be written), this says exactly what.
 * It leaves nothing behind.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { explain, detailOf } = require('./explainError');

function createSelfTest({ cloud, ff, config, logger }) {
  const runs = new Map();

  async function waitJob(id, ms, signal) {
    const t0 = Date.now();
    for (;;) {
      if (signal && signal.aborted) throw new Error('Stopped');
      const j = cloud.getJob(id);
      if (['done', 'failed', 'cancelled'].includes(j.status)) return j;
      if (Date.now() - t0 > ms) throw new Error(`Cutting did not finish within ${Math.round(ms / 1000)} seconds (${j.progress || 0}% done). This computer may be very slow or busy.`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function execute(run) {
    const steps = run.steps;
    const test = { file: null, uploadId: null, jobIds: [] };
    const step = async (name, fn) => {
      const s = { name, status: 'running', ms: 0, detail: '' };
      steps.push(s);
      const t0 = Date.now();
      try { const d = await fn(); s.status = 'ok'; s.detail = d || ''; }
      catch (e) {
        s.status = 'fail';
        const x = explain(e);
        s.detail = detailOf(e, config.rootDir);
        s.advice = x.code === 'unknown' ? '' : `${x.title} ${x.advice}`;
        throw Object.assign(new Error(s.detail), { reported: true });
      } finally { s.ms = Date.now() - t0; }
    };
    try {
      await step('FFmpeg (the video engine)', async () => {
        const caps = await ff.detectCapabilities();
        if (!caps.ok) throw new Error(`FFmpeg is not usable: ${caps.reason || 'not found'}. Run "npm install" in the server folder, or set FFMPEG_PATH.`);
        return `version ${caps.version}`;
      });
      await step('Disk space and write access', async () => {
        const probe = path.join(config.dirs.tmp, `.selftest-${process.pid}`);
        fs.mkdirSync(config.dirs.tmp, { recursive: true });
        fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
        const st = await fs.promises.statfs(config.dirs.data).catch(() => null);
        const free = st ? Number(st.bavail) * Number(st.bsize) : null;
        if (free != null && free < 1024 ** 3) throw new Error(`Only ${(free / 1024 ** 2).toFixed(0)} MB free where ClipperIQ keeps its files (${config.dirs.data}). Free up space or choose another drive in Settings > Storage location.`);
        return free == null ? 'writable' : `${(free / 1024 ** 3).toFixed(1)} GB free, folder writable`;
      });
      await step('Making a short test video', async () => {
        test.file = path.join(config.dirs.tmp, `selftest_${crypto.randomBytes(4).toString('hex')}.mp4`);
        await ff.runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=d=40:s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=frequency=440:d=40',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', test.file], { timeoutMs: 120000, signal: run.signal });
        return `${(fs.statSync(test.file).size / 1048576).toFixed(1)} MB, 40 s`;
      });
      await step('Sending it to the server (upload)', async () => {
        const buf = fs.readFileSync(test.file);
        test.uploadId = await cloud.initUpload({ name: 'clipperiq-selftest.mp4', size: buf.length, type: 'video/mp4' });
        const req = Readable.from([buf]); req.header = (n) => ({ 'content-range': `bytes 0-${buf.length - 1}/${buf.length}` })[String(n).toLowerCase()];
        const r = await cloud.writeChunk(test.uploadId, req);
        if (!r.done) throw new Error('The upload did not complete');
        return 'complete';
      });
      let info;
      await step('Reading the video', async () => { info = await cloud.ensureReady(test.uploadId); return `${Math.round(info.duration)} s, ${info.width}x${info.height}, ${info.hasAudio ? 'with' : 'no'} sound`; });

      let candidates;
      await step('Best moments: finding them', async () => {
        const an = await cloud.analyze(test.uploadId, { maxClips: 2, targetDuration: 15 }, { signal: run.signal });
        candidates = an.candidates;
        if (!candidates.length) throw new Error('The analysis returned no clips');
        for (const c of candidates) if (!(c.start >= 0) || c.start + c.duration > info.duration + 0.5) throw new Error(`The analysis proposed a clip outside the video (${c.start}+${c.duration})`);
        return `${candidates.length} clip${candidates.length === 1 ? '' : 's'} proposed`;
      });
      const cut = async (cands, opts) => {
        const r = cloud.createJob({ uploadId: test.uploadId, candidates: cands, seriesStartPart: 1, ...opts });
        const id = typeof r === 'string' ? r : (r.jobId || r.id);
        test.jobIds.push(id);
        const j = await waitJob(id, 150000, run.signal);
        if (j.status !== 'done') throw new Error(j.error || `The job ended as "${j.status}"`);
        if (j.clips.length !== cands.length) throw new Error(`Expected ${cands.length} clips but ${j.clips.length} were made`);
        const first = path.join(cloud.jobsRoot, id, 'clips', 'clip_01.mp4');
        const p = await ff.probe(first);
        const want = cands[0].duration; const got = Number(p.duration || (p.format && p.format.duration) || 0);
        if (Math.abs(got - want) > 3) throw new Error(`A clip should be ${want} s but is ${got.toFixed(1)} s long`);
        return `${j.clips.length} clips, first one ${got.toFixed(1)} s`;
      };
      await step('Best moments: cutting (fast mode)', () => cut(candidates, { reEncode: false, aspectRatio: 'original', overlayFormat: 'none' }));
      const series = []; const len = 15; const ov = 3;
      for (let s = 0; s < info.duration; s += len - ov) { const d = Math.min(len, info.duration - s); if (d < 1) break; series.push({ start: s, duration: d, totalScore: 0, sources: ['series'] }); if (s + d >= info.duration) break; }
      await step(`Series: cutting ${series.length} parts (9:16 with PART label)`, () => cut(series, { reEncode: true, aspectRatio: '9:16', overlayFormat: 'part-text' }));
      run.ok = true;
    } catch (e) {
      run.ok = false;
      if (!e.reported) steps.push({ name: 'Unexpected problem', status: 'fail', ms: 0, detail: String(e && e.message || e) });
      logger.warn(`self-test failed: ${e && e.message}`);
    } finally {
      try { if (test.file) fs.unlinkSync(test.file); } catch { /* gone */ }
      try { await cloud.purge({ uploadId: test.uploadId, jobIds: test.jobIds }); } catch { /* best effort */ }
      run.status = 'finished'; run.finishedAt = Date.now();
    }
  }

  function start() {
    for (const r of runs.values()) if (r.status === 'running') return view(r); // one at a time
    for (const [id, r] of runs) if (r.status !== 'running' && Date.now() - r.finishedAt > 600000) runs.delete(id);
    if (cloud.isBusy()) {
      const err = new Error('Videos are being processed right now. Run the test when they are finished.'); err.status = 409; throw err;
    }
    const ac = new AbortController();
    const run = { id: 'st_' + crypto.randomBytes(5).toString('hex'), status: 'running', ok: null, steps: [], signal: ac.signal, ac, startedAt: Date.now(), finishedAt: 0 };
    runs.set(run.id, run);
    execute(run);
    return view(run);
  }
  const view = (r) => ({ testId: r.id, status: r.status, ok: r.ok, steps: r.steps, elapsedMs: (r.finishedAt || Date.now()) - r.startedAt });
  const get = (id) => { const r = runs.get(String(id)); return r ? view(r) : null; };
  const stop = (id) => { const r = runs.get(String(id)); if (r && r.status === 'running') r.ac.abort(); return !!r; };
  return { start, get, stop };
}

module.exports = { createSelfTest };
