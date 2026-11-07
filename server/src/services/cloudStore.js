'use strict';
/**
 * Backs the /api/cloud/* endpoints the frontend already speaks (see ClipGenerator._cloud*
 * in js/core/clipGenerator.js). Two persistent collections:
 *
 *   uploads : one row per source video the browser has sent up, tracked by merged byte
 *             ranges so completeness is correct however chunks arrive (out of order,
 *             retried, parallel) — the previous backend used a bare high-water mark, which
 *             could report "done" while bytes were still missing.
 *   jobs    : one row per render job. Runs with bounded concurrency, persists progress after
 *             every clip so a crash/restart never loses finished work, and republishes
 *             partial results (job.clips grows as each clip finishes, exactly as before).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { newId } = require('../db');
const analyzer = require('../media/analyzer');
const { createAnalysisTasks } = require('./analysisTasks');
const { HttpError } = require('./errors');
const { explain, detailOf } = require('./explainError');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.wmv', '.flv', '.3gp']);
/** A small plain object from the browser (framing / lower third), or null. The renderer cleans the details. */
function plainObject(v, what) {
  if (v == null || v === false) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `Invalid ${what}`);
  if (JSON.stringify(v).length > 20000) throw new HttpError(400, `${what} is too large`);
  return JSON.parse(JSON.stringify(v));
}

const safeExt = (name) => { const e = path.extname(String(name || '')).toLowerCase(); return VIDEO_EXT.has(e) ? e : '.mp4'; };

function mergeRange(ranges, start, endExclusive) {
  const all = [...ranges, [start, endExclusive]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]);
  }
  return out;
}
const receivedBytes = (ranges) => ranges.reduce((n, r) => n + (r[1] - r[0]), 0);

function createCloudStore({ db, config, logger, ff, renderer, bgmStore, overlayStore, transcriber = null }) {
  const uploadsCol = db.collection('cloud_uploads');
  const jobsCol = db.collection('cloud_jobs');
  fs.mkdirSync(config.dirs.uploads, { recursive: true });
  const jobsOutDir = path.join(config.dirs.data, 'uploads', 'cloud');
  fs.mkdirSync(jobsOutDir, { recursive: true });

  // Where the clips live: ONE FOLDER PER JOB (everything generated from one video in one go), clips inside it:
  //
  //   uploads/cloud/jobs/<jobId>/job.json             what the job is: source video, settings, clips, re-renders
  //   uploads/cloud/jobs/<jobId>/clips/clip_01.mp4    the clips, in order
  //   uploads/cloud/jobs/<jobId>/clips/clip_03.r2.mp4 a later re-render of clip 3 (Edit / Mix Audio / Design)
  //
  // A clip is only ever given its real name once it is complete (it is written under a temporary name and renamed),
  // so a power cut can never leave a half-written "clip_03.mp4" behind. Older layouts (a folder per render, then the
  // single shared folder of Update 9) are folded into this one on startup by migrateLegacyLayout().
  const jobsRoot = path.join(jobsOutDir, 'jobs');
  fs.mkdirSync(jobsRoot, { recursive: true });
  const clipsDir = path.join(jobsOutDir, 'clips'); // Update 9's shared folder: only read, to move its clips into their jobs

  const pad2 = (n) => String(n).padStart(2, '0');
  const rootIdOf = (job) => String(job.rootId || job.id);
  /** Folder of a whole job (holds job.json and the clips folder). */
  const jobDirOf = (rootId) => path.join(jobsRoot, String(rootId));
  /** File name of clip number `idx` (0-based) of a job, in whichever layout the job uses. */
  const clipFileName = (job, idx) => {
    if (job.layout === 'job') return job.parentJobId ? `clip_${pad2((Number(job.clipIndex) || 0) + 1)}.r${Number(job.rev) || 2}.mp4` : `clip_${pad2(idx + 1)}.mp4`;
    return job.layout === 'flat' ? `${job.id}_${pad2(idx + 1)}.mp4` : `clip_${pad2(idx + 1)}.mp4`;
  };
  /** Folder that holds a job's clip files. */
  const clipDirOf = (job) => (job.layout === 'job' ? path.join(jobDirOf(rootIdOf(job)), 'clips') : (job.layout === 'flat' ? clipsDir : job.outDir));
  /** Public URL path (no host) of a job's clip file. */
  const clipUrlPath = (job, name) => {
    if (job.layout === 'job') return `/uploads/cloud/jobs/${encodeURIComponent(rootIdOf(job))}/clips/${encodeURIComponent(name)}`;
    return job.layout === 'flat'
      ? `/uploads/cloud/clips/${encodeURIComponent(name)}`
      : `/uploads/cloud/${encodeURIComponent(job.id)}/${encodeURIComponent(name)}`;
  };

  /** True only for an old-style "<cloud>/<jobId>" folder: never the clips folder, the jobs folder or their parent. */
  const isLegacyJobDir = (dir) => {
    if (!dir) return false;
    const d = path.resolve(dir);
    return path.dirname(d) === path.resolve(jobsOutDir) && d !== path.resolve(clipsDir) && d !== path.resolve(jobsRoot);
  };
  /** True only for "<cloud>/jobs/<name>": the one kind of folder that is ever deleted as a whole. */
  const isJobFolder = (dir, rootId) => {
    const d = path.resolve(dir);
    return path.dirname(d) === path.resolve(jobsRoot) && path.basename(d) === String(rootId) && !!rootId;
  };

  /** Deletes the clip files that belong to one job. Never touches another job's files. */
  async function removeJobFiles(job) {
    if (job.layout === 'job') {
      if (job.parentJobId) { // a re-render lives inside its parent's folder: only its own file goes
        await fs.promises.unlink(path.join(clipDirOf(job), clipFileName(job, 0))).catch(() => {});
      } else if (isJobFolder(jobDirOf(job.id), job.id)) {
        await fs.promises.rm(jobDirOf(job.id), { recursive: true, force: true }).catch(() => {});
      }
    } else if (job.layout === 'flat') {
      const prefix = `${job.id}_`;
      let names = [];
      try { names = await fs.promises.readdir(clipsDir); } catch { return; }
      await Promise.all(names.filter((n) => n.startsWith(prefix) && n.endsWith('.mp4'))
        .map((n) => fs.promises.unlink(path.join(clipsDir, n)).catch(() => {})));
    } else if (isLegacyJobDir(job.outDir)) {
      await fs.promises.rm(job.outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Deletes just the clip files of a job (not its folder), e.g. before rendering it again from scratch. */
  async function removeClipFiles(job) {
    let names = [];
    try { names = await fs.promises.readdir(clipDirOf(job)); } catch { return; }
    const mine = job.parentJobId ? new Set([clipFileName(job, 0)]) : null;
    await Promise.all(names.filter((n) => n.endsWith('.mp4') && (mine ? mine.has(n) : /^clip_\d+\.mp4$/.test(n) || /^clip_\d+\.tmp\d*\.mp4$/.test(n)))
      .map((n) => fs.promises.unlink(path.join(clipDirOf(job), n)).catch(() => {})));
  }

  /**
   * One-time tidy-up for installs that have the older layouts: every job's clips move into jobs/<jobId>/clips/ under
   * their new names and the job records are updated, so clips already in the app keep playing. Anything that cannot be
   * moved is left exactly where it is and keeps working through the old-layout branches above.
   */
  function migrateLegacyLayout() {
    let moved = 0;
    for (const job of jobsCol.all()) {
      if (job.layout === 'job') continue;
      const from = job.layout === 'flat' ? clipsDir : job.outDir;
      if (!from) continue;
      let names;
      try { names = fs.readdirSync(from); } catch { continue; } // folder already gone: nothing to move
      const re = job.layout === 'flat' ? new RegExp(`^${job.id.replace(/[^a-zA-Z0-9_]/g, '')}_(\\d+)\\.mp4$`) : /^clip_(\d+)\.mp4$/;
      const dest = path.join(jobDirOf(job.id), 'clips');
      let ok = true;
      for (const n of names) {
        const m = re.exec(n);
        if (!m) continue;
        try {
          fs.mkdirSync(dest, { recursive: true });
          fs.renameSync(path.join(from, n), path.join(dest, `clip_${pad2(Number(m[1]))}.mp4`));
          moved++;
        } catch { ok = false; }
      }
      if (!ok) continue;
      if (job.layout !== 'flat' && isLegacyJobDir(from)) { try { fs.rmSync(from, { recursive: true, force: true }); } catch { /* an empty leftover folder is harmless */ } }
      job.layout = 'job'; job.rootId = job.id; job.outDir = dest;
      // the links stored with the finished clips point at the new place now
      job.clips = (job.clips || []).map((c) => (c && Number.isInteger(c.index) && c.url ? { ...c, url: `${job.baseUrl || ''}${clipUrlPath(job, clipFileName(job, c.index))}` } : c));
      db.markDirty();
    }
    try { if (fs.readdirSync(clipsDir).length === 0) fs.rmdirSync(clipsDir); } catch { /* still has files that could not be moved, or already gone */ }
    if (moved) logger.info(`cloud: moved ${moved} clip file(s) into their job folders`);
    for (const job of jobsCol.all()) if (job.layout === 'job' && !job.parentJobId) writeManifest(job.id);
  }

  /** job.json: a plain-text record of the job beside its clips (what it is made from, with which settings, what it holds). */
  function writeManifest(rootId) {
    try {
      const root = jobsCol.get(String(rootId));
      if (!root || root.layout !== 'job') return;
      const dir = jobDirOf(rootId);
      // a job that stopped (failed / cancelled) before making any clip has nothing to keep a folder for
      if ((root.status === 'failed' || root.status === 'cancelled') && !(root.clips || []).length && !jobsCol.all().some((j) => j.parentJobId === root.id)) {
        if (isJobFolder(dir, rootId)) fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
      const u = uploadsCol.get(root.uploadId) || {};
      const revisions = jobsCol.all().filter((j) => j.parentJobId === root.id)
        .map((j) => ({ jobId: j.id, clip: (Number(j.clipIndex) || 0) + 1, revision: j.rev, status: j.status, file: clipFileName(j, 0), createdAt: new Date(j.createdAt).toISOString() }))
        .sort((x, y) => x.clip - y.clip || x.revision - y.revision);
      const manifest = {
        jobId: root.id, origin: root.origin || 'generate', status: root.status, error: root.error || null, attempts: root.attempts || 0,
        createdAt: new Date(root.createdAt).toISOString(), updatedAt: new Date(root.updatedAt || Date.now()).toISOString(),
        source: { name: u.name || '', durationSec: u.duration || null, uploadId: root.uploadId },
        settings: {
          aspectRatio: root.aspectRatio, overlayFormat: root.overlayFormat, seriesStartPart: root.seriesStartPart, reEncode: !!root.reEncode,
          speedProfile: root.speedProfile, framing: !!root.frame, lowerThird: !!(root.lowerThird || (root.lowerThirds && root.lowerThirds.length)), lowerThirds: (root.lowerThirds || []).length || (root.lowerThird ? 1 : 0), adjustments: !!root.adjust, captions: !!(root.captions && root.captions.enabled), music: !!root.bgm,
        },
        plannedClips: (root.candidates || []).length,
        clips: (root.clips || []).filter(Boolean).map((c) => ({ clip: c.index + 1, file: clipFileName(root, c.index), startSec: c.startTime, durationSec: c.duration, sizeBytes: c.size })),
        revisions,
      };
      const file = path.join(dir, 'job.json');
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(manifest, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { logger.warn(`cloud: could not write job.json for ${rootId} (${e.message})`); }
  }

  // ── uploads ──────────────────────────────────────────────────────────────
  async function initUpload({ name, size, type, fingerprint }) {
    const total = Number(size);
    if (!Number.isFinite(total) || total <= 0) throw new HttpError(400, 'Missing or invalid size');
    if (total > config.limits.maxUploadBytes) {
      throw new HttpError(413, `File is larger than the ${(config.limits.maxUploadBytes / 1024 ** 3).toFixed(1)} GB server limit (set MAX_UPLOAD_GB in .env to raise it)`);
    }
    try {
      const st = await fs.promises.statfs(config.dirs.uploads);
      if (Number(st.bavail) * Number(st.bsize) < total * 1.05) throw new HttpError(507, 'Not enough free disk space on the server for this upload');
    } catch (e) { if (e instanceof HttpError) throw e; /* statfs unsupported: skip the check */ }

    const id = newId('u');
    const filePath = path.join(config.dirs.uploads, `${id}${safeExt(name)}`);
    const fh = await fs.promises.open(filePath, 'w');
    try { await fh.truncate(total); } finally { await fh.close(); }
    uploadsCol.insert({
      id, filePath, name: String(name || 'video.mp4').slice(0, 255), size: total, type: String(type || ''),
      ranges: [], probed: false, duration: 0, width: 0, height: 0, hasAudio: false,
      fingerprint: /^[a-f0-9]{32,128}$/i.test(String(fingerprint || '')) ? String(fingerprint).toLowerCase() : null, // lets the same video be recognised next time
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    return id;
  }

  /**
   * Is this exact video already on the server (complete, and still healthy)? Then it need not be sent again.
   * A copy that is missing, empty or cannot be read any more counts as having an issue: it is dropped, and the caller uploads afresh.
   */
  async function findUpload({ fingerprint, size } = {}) {
    const fp = String(fingerprint || '').toLowerCase();
    if (!/^[a-f0-9]{32,128}$/.test(fp)) return { found: false };
    const cands = uploadsCol.all().filter((u) => u.fingerprint === fp && u.size === Number(size)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const u of cands) {
      if (receivedBytes(u.ranges) < u.size) continue; // an unfinished upload resumes by itself; it is not a copy to reuse
      try {
        const st = await fs.promises.stat(u.filePath);
        if (!st.isFile() || st.size < 1024) throw new Error('the file is missing or empty');
        await ensureReady(u.id);                       // verified (and, if needed, repaired) like a fresh upload
        const info = await ff.probe(u.filePath);       // and still readable right now
        if (!(info && info.duration > 0)) throw new Error('the file can no longer be read as a video');
      } catch (e) {
        logger.warn(`cloud upload ${u.id}: not reused (${e.message}); it will be uploaded again`);
        if (!jobsCol.all().some((j) => j.uploadId === u.id && (j.status === 'queued' || j.status === 'running'))) {
          await fs.promises.unlink(u.filePath).catch(() => {});
          uploadsCol.remove(u.id);
        }
        continue;
      }
      uploadsCol.update(u.id, { updatedAt: Date.now() }); // in use again: keeps it from expiring
      logger.info(`cloud upload ${u.id}: reused for a new request (${u.name})`);
      const fresh = uploadsCol.get(u.id);
      return { found: true, uploadId: u.id, name: u.name, duration: fresh.duration || 0 };
    }
    return { found: false };
  }

  function getUpload(id) {
    const u = uploadsCol.get(String(id || ''));
    if (!u) throw new HttpError(400, 'Invalid uploadId');
    return u;
  }

  /** Streams one chunk straight into the pre-sized file at its byte offset. */
  async function writeChunk(id, req) {
    const u = getUpload(id);
    const range = String(req.header('content-range') || '');
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(range);
    if (!m) throw new HttpError(400, 'Missing or invalid Content-Range');
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!(end >= start) || start < 0 || end >= u.size) throw new HttpError(400, 'Chunk range is outside the file');
    const expected = end - start + 1;

    let seen = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(u.filePath, { flags: 'r+', start });
      req.on('data', (chunk) => {
        seen += chunk.length;
        if (seen > expected) { req.destroy(); out.destroy(); reject(new HttpError(400, 'Chunk is larger than its Content-Range')); }
      });
      req.on('aborted', () => { out.destroy(); reject(new HttpError(400, 'Upload interrupted')); });
      req.on('error', (e) => { out.destroy(); reject(new HttpError(400, `Upload interrupted: ${e.message}`)); });
      out.on('error', reject);
      // Wait for 'close' (the file descriptor is actually released), not just 'finish' (data
      // flushed but the handle may still be closing). On Windows, re-opening the same file
      // for the next chunk before the previous handle is fully released can fail with a
      // sharing-violation error — 'finish' alone isn't a strong enough guarantee there.
      out.on('close', resolve);
      req.pipe(out);
    });
    if (seen !== expected) throw new HttpError(400, `Chunk incomplete (${seen}/${expected} bytes)`);

    u.ranges = mergeRange(u.ranges, start, end + 1);
    u.updatedAt = Date.now();
    db.markDirty();
    const received = receivedBytes(u.ranges);
    return { uploadId: u.id, received, size: u.size, done: received >= u.size };
  }

  /** Confirms full coverage, probes with ffprobe once, and caches the result. */
  async function ensureReady(id) {
    const u = getUpload(id);
    if (receivedBytes(u.ranges) < u.size) throw new HttpError(409, 'Upload incomplete');
    if (!u.probed) {
      let info;
      try { info = await ff.probe(u.filePath, { verify: true }); } catch (e) { throw new HttpError(422, `Could not read this file as a video: ${e.message}`); }
      if (!info.hasVideo) {
        throw new HttpError(422, info.hasAudio
          ? 'This file is audio only (no video picture). Choose a video file here; background music goes in the Background Music box.'
          : 'No video stream was found in this file. Try a different file (MP4, MOV, MKV or WebM).');
      }
      if (!(info.duration > 0)) throw new HttpError(422, 'The video loads but its length could not be determined; the file may be damaged or incomplete. Try re-exporting it as MP4.');
      // A broken clock (restarts, forward jumps, squashed timestamps) makes time-based cutting
      // land in the wrong place or in empty space, and makes the file look shorter or far longer
      // than it really is. Re-wrap the file once without re-encoding; if that doesn't recover the
      // real length, rebuild the timestamps with a one-off encode. A repair is only kept if the
      // result is actually healthy, otherwise the original stays and the warning is shown.
      if (info.timelineIssue) {
        const footage = Math.max(info.videoPacketSum, info.nominalFps ? info.videoFrames / info.nominalFps : 0);
        const healthy = (fx) => fx.hasVideo && !fx.timelineIssue && (info.timelineIssue === 'gap'
          ? fx.duration < info.duration * 0.9 && fx.duration >= footage * 0.9
          : fx.duration >= footage * 0.9);
        const attempts = [
          ['re-wrapped', (out) => ff.remuxClean(u.filePath, out)],
          ['rebuilt (re-encoded once)', (out) => ff.rebuildTimestamps(u.filePath, out, { fps: info.nominalFps || info.fps || 25, hasAudio: info.hasAudio })],
        ];
        for (const [label, make] of attempts) {
          const fixedPath = path.join(config.dirs.uploads, `${id}_fixed.mp4`);
          try {
            await make(fixedPath);
            const fixed = await ff.probe(fixedPath, { verify: true });
            if (healthy(fixed)) {
              logger.info(`cloud upload ${id}: repaired ${info.timelineIssue} timestamps, file ${label} (${info.duration.toFixed(1)}s -> ${fixed.duration.toFixed(1)}s)`);
              await fs.promises.unlink(u.filePath).catch(() => {});
              u.filePath = fixedPath;
              info = { ...fixed, headerDuration: info.headerDuration, repaired: label };
              break;
            }
            await fs.promises.unlink(fixedPath).catch(() => {});
          } catch (e) {
            logger.warn(`cloud upload ${id}: timestamp repair (${label}) failed (${e.message})`);
            await fs.promises.unlink(fixedPath).catch(() => {});
          }
        }
      }
      Object.assign(u, {
        probed: true, duration: info.duration, headerDuration: info.headerDuration, measuredDuration: info.measuredDuration,
        warning: info.warning || '', width: info.width, height: info.height, hasAudio: info.hasAudio,
        videoCodec: info.videoCodec, audioCodec: info.audioCodec, maxKeyframeGap: info.maxKeyframeGap || 0, fps: info.nominalFps || info.fps || 0,
        repaired: info.repaired || '',
      });
      db.markDirty();
      logger.info(`cloud upload ${id} ready: ${u.name} ${info.width}x${info.height} ${info.duration.toFixed(1)}s (header ${info.headerDuration.toFixed(1)}s, scanned ${info.measuredDuration.toFixed(1)}s, picture ${info.videoSpan.toFixed(1)}s, audio ${info.audioSpan.toFixed(1)}s, ${(u.size / 1048576).toFixed(0)} MB)`);
      if (info.warning) logger.warn(`cloud upload ${id}: ${info.warning}`);
    }
    return u;
  }

  // ── analysis ─────────────────────────────────────────────────────────────
  async function analyze(id, { maxClips = 8, targetDuration = 30, rangeStart = 0, rangeEnd = 0 } = {}, { signal, onProgress } = {}) {
    const u = await ensureReady(id);
    // the app asks for (finished clip length x playback speed) seconds of source: up to 10 min at 2x
    const dur = Math.max(3, Math.min(1800, Number(targetDuration) || 30));
    const clips = Math.max(1, Math.min(50, Number(maxClips) || 8));
    const result = await analyzer.analyze(ff, u.filePath, { duration: u.duration, clipDuration: dur, maxClips: clips, rangeStart, rangeEnd, signal, onProgress, maxKeyframeGap: u.maxKeyframeGap || 0 });
    return { duration: u.duration, candidates: result.candidates };
  }

  // The same analysis as a background task: start it, ask how far it is, stop it (see services/analysisTasks.js).
  const analysisTasks = createAnalysisTasks({ run: (id, opts, ctx) => analyze(id, opts, ctx) });
  function startAnalysis(id, opts = {}) {
    getUpload(id); // an unknown or discarded upload fails now, with the usual clear message
    return analysisTasks.start(String(id), {
      maxClips: Number(opts.maxClips) || 8, targetDuration: Number(opts.targetDuration) || 30,
      rangeStart: Number(opts.rangeStart) || 0, rangeEnd: Number(opts.rangeEnd) || 0,
    });
  }
  function getAnalysis(taskId) {
    const v = analysisTasks.get(taskId);
    if (!v) throw new HttpError(404, 'That analysis is no longer known to the server (it may have been restarted). Start it again.');
    return v;
  }
  function cancelAnalysis(taskId) { analysisTasks.cancel(taskId); return { ok: true }; }

  /**
   * One still picture from an uploaded source, for the "choose where to start" preview. Works for any
   * format ffmpeg can read, including ones a browser cannot play (.ts, .mkv with odd codecs, ...).
   */
  async function frame(id, atSec, width) {
    const u = await ensureReady(id);
    const w = Math.max(120, Math.min(1280, Math.round(Number(width) || 480)));
    const at = Math.max(0, Math.min(Number(atSec) || 0, Math.max(0, (u.duration || 0) - 0.1)));
    const chunks = [];
    try {
      await ff.streamFfmpeg(['-ss', String(at), '-i', u.filePath, '-an', '-map', '0:v:0', '-frames:v', '1',
        '-vf', `scale=${w}:-2:flags=bicubic,format=yuvj420p`, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', '-'],
      { timeoutMs: 30000, onData: (d) => chunks.push(Buffer.from(d)) });
    } catch (e) { throw new HttpError(422, `Could not read a picture at that time: ${e.message}`); }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new HttpError(422, 'Could not read a picture at that time');
    return buf;
  }

  // ── jobs ─────────────────────────────────────────────────────────────────
  const queue = [];
  let running = 0;

  function view(j) {
    return {
      jobId: j.id, status: j.status, progress: j.progress, error: j.error, clips: j.clips, total: (j.candidates || []).length, skipped: j.skipped || 0,
      attempts: j.attempts || 0, parentJobId: j.parentJobId || null, errorCode: j.errorCode || null, errorDetail: j.errorDetail || null,
    };
  }

  function createJob({ uploadId, candidates, reEncode, aspectRatio, overlayFormat, seriesStartPart, bgm, originalVolume, fit, frame, lowerThird, lowerThirds, adjust, captions, customOverlayId, speedProfile, parentJobId, clipIndex, requestId, origin }, baseUrl) {
    const frameSpec = plainObject(frame, 'framing');
    // several lower thirds per clip (a list); `lowerThird` (a single one) is still accepted
    if (lowerThirds != null && !Array.isArray(lowerThirds)) throw new HttpError(400, 'Invalid lower thirds');
    const lowerThirdsSpec = Array.isArray(lowerThirds) && lowerThirds.length ? lowerThirds.slice(0, 6).map((x) => plainObject(x, 'lower third')).filter(Boolean) : null;
    const adjustSpec = plainObject(adjust, 'clip adjustments');
    const captionsSpec = plainObject(captions, 'captions'); // { enabled, template, style }; the words are kept next to the video (see readCaptions) // cleaned (and held inside the configured limits) by the renderer
    const lowerThirdSpec = plainObject(lowerThird, 'lower third');
    const u = getUpload(uploadId);
    if (receivedBytes(u.ranges) < u.size) throw new HttpError(409, 'Upload incomplete');
    const all = Array.isArray(candidates) ? candidates : [];
    if (!all.length) throw new HttpError(400, 'No candidates supplied');
    // Never silently drop clips: if the request is bigger than the cap, say so and say how to fix it.
    if (all.length > config.limits.maxClipsPerJob) {
      throw new HttpError(400, `That would make ${all.length} clips, but the limit is ${config.limits.maxClipsPerJob} per job. Choose a longer clip length, or raise MAX_CLIPS_PER_JOB in .env and restart.`);
    }
    const list = all;

    const id = newId('job');
    let bgmSpec = null;
    if (bgm && bgm.bgmId) {
      bgmStore.get(bgm.bgmId); // throws a clear error now if the track has expired, rather than failing mid-render
      bgmSpec = {
        bgmId: String(bgm.bgmId),
        volume: Math.max(0, Math.min(1.5, Number(bgm.volume) || 0.25)),
        duck: bgm.duck !== false,
        restart: bgm.restart !== false,
      };
    }

    let customOverlay = null;
    if (customOverlayId) {
      if (!overlayStore) throw new HttpError(400, 'Custom overlays are not available on this server');
      overlayStore.get(customOverlayId); // throws a clear error now if the layer has expired, not mid-render
      customOverlay = String(customOverlayId);
    }

    // A re-render of ONE clip (Edit / Mix Audio / Design) is filed inside the job that made the clip, next to it, instead
    // of becoming a job of its own. Anything that does not clearly belong to an existing job gets a job folder of its own.
    let parent = null; let ci = null; let rev = 0;
    if (parentJobId && list.length === 1) {
      const pj = jobsCol.get(String(parentJobId));
      const n = Number(clipIndex);
      if (pj && pj.layout === 'job' && !pj.parentJobId && pj.uploadId === uploadId && Number.isInteger(n) && n >= 0 && n < (pj.candidates || []).length) {
        parent = pj; ci = n;
        rev = 1 + Math.max(1, ...jobsCol.all().filter((j) => j.parentJobId === pj.id && j.clipIndex === n).map((j) => Number(j.rev) || 1));
      }
    }
    const rootId = parent ? parent.id : id;

    // The same request must never become two jobs (a retry after a network hiccup, a second tab, a double click):
    //  - the same requestId from the same upload gives back the job it already made;
    //  - an identical request (same video, same clips, same settings) while that job is still working, or was made a
    //    moment ago, gives back that job instead of a second one.
    const fingerprint = crypto.createHash('sha1').update(JSON.stringify([
      uploadId, list.map((c) => [Math.round((Number(c.start) || 0) * 100), Math.round((Number(c.duration) || 0) * 100)]), String(aspectRatio || ''), String(overlayFormat || ''),
      Number(seriesStartPart) || 1, !!reEncode, fit, originalVolume, bgmSpec, customOverlay, frameSpec, lowerThirdSpec, lowerThirdsSpec, adjustSpec, captionsSpec, speedProfile, parent ? [parent.id, ci] : null,
    ])).digest('hex');
    const reqKey = requestId ? String(requestId).slice(0, 80) : null;
    const known = reqKey ? jobsCol.all().find((j) => j.requestId === reqKey && j.uploadId === uploadId) : null;
    if (known) { logger.info(`cloud job ${known.id}: the same request arrived again (${reqKey}); not making another job`); return known.id; }
    const twin = jobsCol.all().find((j) => j.fingerprint === fingerprint && j.uploadId === uploadId && !['failed', 'cancelled'].includes(j.status)
      && (j.status === 'queued' || j.status === 'running' || Date.now() - j.createdAt < 90000));
    if (twin) { logger.info(`cloud job ${twin.id}: an identical request arrived while it is ${twin.status}; not making another job`); return twin.id; }

    const job = {
      id, uploadId, status: 'queued', progress: 0, error: null, clips: [], attempts: 0,
      layout: 'job', rootId, parentJobId: parent ? parent.id : null, clipIndex: ci, rev,
      outDir: path.join(jobDirOf(rootId), 'clips'), baseUrl,
      candidates: list, reEncode: !!reEncode,
      aspectRatio: String(aspectRatio || 'original'), fit: fit === 'blur' ? 'blur' : 'crop',
      overlayFormat: String(overlayFormat || 'none'), seriesStartPart: Number(seriesStartPart) || 1,
      bgm: bgmSpec, originalVolume: Math.max(0, Math.min(1, Number(originalVolume ?? 1))),
      customOverlayId: customOverlay, frame: frameSpec, lowerThird: lowerThirdSpec, lowerThirds: lowerThirdsSpec, adjust: adjustSpec, captions: captionsSpec,
      speedProfile: ['balanced', 'fast', 'turbo'].includes(speedProfile) ? speedProfile : 'balanced',
      requestId: reqKey, fingerprint, origin: ['generate', 'retry', 'recreate', 'rerender'].includes(origin) ? origin : (parent ? 'rerender' : 'generate'),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    fs.mkdirSync(job.outDir, { recursive: true });
    jobsCol.insert(job);
    if (parent) jobsCol.update(parent.id, { updatedAt: Date.now() }); // the job is still in use: keeps it from expiring under its newest re-render
    writeManifest(rootId);
    logger.info(`cloud job ${id} created (${job.origin}): ${list.length} clip(s) from upload ${uploadId}${parent ? `, a re-render of clip ${ci + 1} of ${parent.id}` : ''}`);
    queue.push(id);
    setImmediate(pump);
    return id;
  }

  function getJob(id) {
    const j = jobsCol.get(String(id || ''));
    if (!j) throw new HttpError(404, 'Job not found');
    return j;
  }

  // Which run of a job may still change it, and which runs hold a render slot. A job that is forced to start again gets
  // a new run number, so anything the old (stuck) run reports late is ignored and its slot is given back at once.
  const runs = new Map();       // jobId -> the run number that is current
  const aborts = new Map();     // jobId -> AbortController of the run that is rendering
  const activeRuns = new Set(); // "jobId#run" of every run that holds a render slot

  function pump() {
    while (activeRuns.size < config.ffmpeg.maxConcurrentRenders && queue.length) {
      const id = queue.shift();
      const job = jobsCol.get(id);
      if (!job || job.status !== 'queued') continue;
      runJob(job).catch((e) => logger.error(`cloud job ${id} crashed`, e)).finally(() => setImmediate(pump));
    }
  }

  function patch(id, p) { jobsCol.update(id, { ...p, updatedAt: Date.now() }); db.markDirty(); }

  function resolveBgmFile(job) {
    if (!job.bgm) return null;
    try {
      const rec = bgmStore.get(job.bgm.bgmId);
      return { file: rec.file, volume: job.bgm.volume, duck: job.bgm.duck, restart: job.bgm.restart, duration: rec.duration };
    } catch (e) {
      logger.warn(`cloud job ${job.id}: background music track unavailable (${e.message}); rendering without it`);
      return null;
    }
  }

  /** Is the finished clip `idx` of this job really there (and, when we know its size, the same size)? */
  async function clipFileOk(job, idx, size = 0) {
    try {
      const st = await fs.promises.stat(path.join(clipDirOf(job), clipFileName(job, idx)));
      return st.isFile() && st.size > 1024 && (!size || st.size === size);
    } catch { return false; }
  }

  /**
   * A finished clip file that the saved state does not know about (the machine lost power before the state was written).
   * A clip only has its real name once it is complete, so such a file is trusted after a quick look with ffprobe.
   */
  async function adoptFromDisk(job, i, u) {
    if (!(await clipFileOk(job, i))) return null;
    const c = job.candidates[i] || {};
    const file = path.join(clipDirOf(job), clipFileName(job, i));
    let info = null;
    if (typeof ff.probe === 'function') {
      try { info = await ff.probe(file); } catch { return null; } // unreadable: render it again
      if (!info || !(info.duration > 0.3)) return null;
    }
    const st = await fs.promises.stat(file);
    const start = Math.max(0, Number(c.start) || 0);
    return {
      url: `${job.baseUrl}${clipUrlPath(job, clipFileName(job, i))}`,
      startTime: start, duration: info ? info.duration : Math.max(0.25, Number(c.duration) || 0), sourceDuration: Math.max(0.25, Number(c.duration) || 0), index: i, size: st.size,
      score: Number(c.totalScore) || 0, audioScore: Number(c.audioScore) || 0, sceneScore: Number(c.sceneScore) || 0,
      sources: Array.isArray(c.sources) ? c.sources : (c.sources ? [c.sources] : []), mode: 'resumed', warnings: [],
    };
  }

  /** Temporary clip files a crashed or stopped run left behind. */
  function removeStaleTemps(dir) {
    try { for (const n of fs.readdirSync(dir)) if (/\.tmp\d*\.mp4$/.test(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* still open: harmless */ } } } catch { /* no folder yet */ }
  }

  async function runJob(job) {
    const myRun = (runs.get(job.id) || 0) + 1;
    runs.set(job.id, myRun);
    const token = `${job.id}#${myRun}`;
    activeRuns.add(token);
    const current = () => runs.get(job.id) === myRun;
    const upd = (p) => { if (current()) patch(job.id, p); };
    const ac = new AbortController();
    aborts.set(job.id, ac);
    upd({ status: 'running' });
    let cleanupBgm = async () => {};
    try {
      const dir = clipDirOf(job);
      fs.mkdirSync(dir, { recursive: true }); // a job re-queued after a restart may have lost its folder
      removeStaleTemps(dir);
      const u = getUpload(job.uploadId);
      const src = { width: u.width, height: u.height, hasAudio: u.hasAudio, videoCodec: u.videoCodec, audioCodec: u.audioCodec, duration: u.duration, maxKeyframeGap: u.maxKeyframeGap || 0 };
      let customOverlayFile = null;
      if (job.customOverlayId && overlayStore) {
        try { customOverlayFile = overlayStore.get(job.customOverlayId).file; } catch (e) {
          logger.warn(`cloud job ${job.id}: custom overlay unavailable (${e.message}); rendering without it`);
        }
      }
      let bgmResolved = resolveBgmFile(job);
      if (bgmResolved) {
        const prepared = await renderer.prepareBgm(bgmResolved, { workDir: config.dirs.tmp, key: job.id });
        bgmResolved = prepared.bgm;
        cleanupBgm = prepared.cleanup;
      }
      // Captions: the words live next to the source video; each clip gets the ones inside its own stretch.
      let capLib = null; let capCues = null; let capStyle = null;
      if (job.captions && job.captions.enabled) {
        capLib = await loadCaptionsLib();
        capCues = capLib.normalizeCues((await readCaptions(job.uploadId)).cues);
        capStyle = capLib.normalizeCaptionStyle(job.captions.style);
        if (!capCues.length) logger.warn(`cloud job ${job.id}: captions are on but this video has no caption text yet; rendering without them`);
      }
      const total = job.candidates.length;

      // What is already finished? (A retry, or a restart of the server, must not throw finished clips away.)
      // Clips the saved state lists are kept when their file is still there with the size it had; a finished file the
      // state never heard about is adopted after a quick check. Everything else is rendered (again).
      const prior = new Map();
      for (const e of (jobsCol.get(job.id).clips || [])) {
        if (e && Number.isInteger(e.index) && e.index < total && await clipFileOk(job, e.index, Number(e.size) || 0)) prior.set(e.index, e);
      }
      for (let i = 0; i < total; i++) {
        if (prior.has(i)) continue;
        const adopted = await adoptFromDisk(job, i, u);
        if (adopted) prior.set(i, adopted);
      }
      if (prior.size) logger.info(`cloud job ${job.id}: ${prior.size} of ${total} clip(s) already finished, rendering the rest`);

      // Clips render in a small pool (CLIP_CONCURRENCY at a time). They can finish out of order, but
      // are published to the job strictly in order: the app saves clips by position, so it must only
      // ever see a clip once every clip before it is available.
      const finishedAt = new Map(); // index -> clip entry, or null when skipped
      let published = 0;
      let finished = 0;
      let firstError = null;
      for (const [i, e] of prior) { finishedAt.set(i, e); finished++; }
      // Progress of the clips being rendered right now (0..1 each), so the overall bar moves
      // while a long clip renders instead of sitting still until the whole clip is done.
      const partial = new Map();
      let lastPct = -1;
      let lastPatchAt = 0;
      const overallPct = () => {
        let sum = finished;
        for (const f of partial.values()) sum += Math.max(0, Math.min(0.99, f));
        return Math.min(99, Math.round((sum / total) * 100));
      };
      const reportProgress = () => {
        const pct = Math.max(lastPct, overallPct()); // never let the bar go backwards
        const now = Date.now();
        if (pct === lastPct || now - lastPatchAt < 600) return;
        lastPct = pct; lastPatchAt = now;
        upd({ progress: pct });
      };

      const publish = () => {
        const cur = jobsCol.get(job.id);
        while (finishedAt.has(published)) {
          const entry = finishedAt.get(published);
          finishedAt.delete(published);
          if (entry) cur.clips.push(entry);
          published++;
        }
        lastPct = Math.max(lastPct, overallPct()); lastPatchAt = Date.now();
        upd({ clips: cur.clips, progress: lastPct });
        if (!job.parentJobId) writeManifest(rootIdOf(job));
      };
      upd({ clips: [], skipped: 0, error: null, progress: 0 }); // the finished prefix is published again, in order, just below
      jobsCol.get(job.id).clips = [];
      publish();

      const renderOne = async (i) => {
        const c = job.candidates[i];
        const start = Math.max(0, Number(c.start) || 0);
        const duration = Math.max(0.25, Math.min(Number(c.duration) || 0, Math.max(0.25, u.duration - start)));
        if (start >= u.duration - 0.25) {
          // Starts past the end of the source: nothing to cut. Counted so the app can say so.
          logger.warn(`cloud job ${job.id}: clip ${i + 1} starts at ${start.toFixed(1)}s, past the end of the source (${u.duration.toFixed(1)}s); skipped`);
          upd({ skipped: (jobsCol.get(job.id).skipped || 0) + 1 });
          finishedAt.set(i, null); finished++; publish();
          return;
        }
        const outName = clipFileName(job, i);
        const finalFile = path.join(dir, outName);
        const tmpFile = path.join(dir, outName.replace(/\.mp4$/, `.tmp${myRun}.mp4`));
        const partNumber = job.overlayFormat !== 'none' ? job.seriesStartPart + i : null;

        const spec = {
          src, inputFile: u.filePath, start, duration, outFile: tmpFile,
          captions: capCues && capCues.length ? { style: capStyle, cues: capLib.cuesInWindow(capCues, start, start + duration) } : null,
          partNumber: (Number(job.seriesStartPart) || 1) + i, // this clip's part number: what {part} / {next} in a lower third mean
          aspectRatio: job.aspectRatio, fit: job.fit, frame: job.frame || null, lowerThird: job.lowerThird || null, lowerThirds: job.lowerThirds || null, adjust: job.adjust || null, reEncode: job.reEncode,
          profile: job.speedProfile || 'balanced',
          customOverlay: customOverlayFile ? { file: customOverlayFile } : null,
          overlay: { format: job.overlayFormat, partNumber, startSec: Math.max(0, Math.min(Number(c.overlayStartSec) || 0, Math.max(0, duration - 1))) },
          audio: {
            originalVolume: job.originalVolume, normalize: true,
            bgm: bgmResolved ? {
              file: bgmResolved.file, volume: bgmResolved.volume, duck: bgmResolved.duck, preNormalized: !!bgmResolved.preNormalized,
              // "restart music at clip start" off = the music keeps playing along the source timeline
              offsetSec: bgmResolved.restart ? 0 : start % Math.max(1, bgmResolved.duration || 1),
            } : null,
          },
        };
        let res;
        const MAX_TRIES = 3;
        try {
          for (let attempt = 1; ; attempt++) {
            try {
              res = await renderer.render(spec, {
                workDir: config.dirs.tmp, signal: ac.signal,
                onProgress: (f) => { partial.set(i, f); reportProgress(); },
              });
              if (!current()) throw new Error('stopped'); // this run was replaced while it was rendering
              await fs.promises.rename(tmpFile, finalFile); // only a complete clip ever gets its real name
              if (attempt > 1) logger.info(`cloud job ${job.id}: clip ${i + 1} was made after repairing the problem (try ${attempt})`);
              break;
            } catch (e) {
              await fs.promises.unlink(tmpFile).catch(() => {});
              if (!current() || ac.signal.aborted || /^stopped$/i.test(String(e.message))) throw e;
              // A problem the server can put right (a damaged temporary file, a file another program held for a moment) is repaired and the
              // clip is tried again, instead of failing the whole job and leaving the person to press Retry.
              const x = explain(e);
              if (x.healable && attempt < MAX_TRIES) {
                logger.warn(`cloud job ${job.id}: clip ${i + 1} hit a problem (${x.code}); repairing and trying again (${attempt}/${MAX_TRIES - 1}): ${detailOf(e, config.rootDir).slice(0, 220)}`);
                if (x.code === 'layer-damaged') { const n = await renderer.purgeBrokenInputs(e.message).catch(() => 0); logger.info(`cloud job ${job.id}: removed ${n} damaged file(s)`); }
                await new Promise((r) => setTimeout(r, 400 * attempt));
                continue;
              }
              e.explained = x;
              throw e;
            }
          }
        } finally { partial.delete(i); }
        finishedAt.set(i, {
          url: `${job.baseUrl}${clipUrlPath(job, outName)}`,
          startTime: start, duration: res.duration, sourceDuration: duration, index: i, size: res.size,
          score: Number(c.totalScore) || 0, audioScore: Number(c.audioScore) || 0, sceneScore: Number(c.sceneScore) || 0,
          sources: Array.isArray(c.sources) ? c.sources : (c.sources ? [c.sources] : []),
          mode: res.mode, warnings: res.warnings || [],
        });
        finished++;
        publish();
      };

      let nextIndex = 0;
      const worker = async () => {
        while (!firstError && current()) {
          const i = nextIndex++;
          if (i >= total) return;
          if (prior.has(i)) continue;
          try {
            await renderOne(i);
          } catch (e) {
            if (!firstError) {
              firstError = new Error(`Clip ${i + 1}/${total} failed: ${e.message}`);
              firstError.explained = e.explained || explain(e);
              firstError.clipNo = i + 1; firstError.rawDetail = detailOf(e, config.rootDir);
              ac.abort(); // stop the other renders; the job has failed
            }
            return;
          }
        }
      };
      const poolSize = Math.max(1, Math.min(Number(config.ffmpeg.clipConcurrency) || 1, total));
      await Promise.all(Array.from({ length: poolSize }, worker));
      if (!current()) return; // replaced by a newer run: it owns the job now
      if (firstError) throw firstError;
      upd({ status: 'done', progress: 100 });
      writeManifest(rootIdOf(job));
      logger.info(`cloud job ${job.id} done (${jobsCol.get(job.id).clips.length} clips)`);
    } catch (e) {
      if (current()) {
        logger.error(`cloud job ${job.id} failed: ${e.message}`);
        // What went wrong, in plain words and with what to do about it; the raw message stays available as "technical details".
        // (A video that is gone from the server has its own code: the app can send it again.)
        const x = e.explained || explain(e);
        const friendly = `${e.clipNo ? `Clip ${e.clipNo} of ${job.candidates.length} could not be made. ` : ''}${x.title}${x.advice ? ` ${x.advice}` : ''}`;
        upd({
          status: 'failed', errorCode: x.code === 'unknown' ? null : x.code,
          error: (x.code === 'unknown' ? `${friendly} (${detailOf(e, config.rootDir).slice(0, 160)})` : friendly).slice(0, 600),
          errorDetail: e.rawDetail || detailOf(e, config.rootDir),
        });
        writeManifest(rootIdOf(job));
      }
    } finally {
      activeRuns.delete(token);
      if (aborts.get(job.id) === ac) aborts.delete(job.id);
      await cleanupBgm().catch(() => {});
    }
  }

  /**
   * Starts a failed, interrupted or stuck job again.
   *   mode "resume"  (default): keeps every clip that is already finished and renders only the rest
   *   mode "restart": throws the finished clips away and renders the whole job again
   *   force: also takes over a job that is marked running / queued (for a render that is really stuck)
   */
  async function retryJob(id, { mode = 'resume', force = false } = {}) {
    const job = getJob(id);
    const busy = (job.status === 'running' && aborts.has(job.id)) || (job.status === 'queued' && queue.includes(job.id));
    if (busy && !force) throw new HttpError(409, 'That job is still working. If it is really stuck, use Force resume.');
    if (job.status === 'done' && mode !== 'restart' && !force) {
      let all = (job.clips || []).length + (job.skipped || 0) >= (job.candidates || []).length;
      for (const c of job.clips || []) if (c && !(await clipFileOk(job, c.index, Number(c.size) || 0))) all = false;
      if (all) return view(job); // nothing is missing
    }
    // stop whatever may still be running for it; whatever that old run reports from now on is ignored
    runs.set(job.id, (runs.get(job.id) || 0) + 1);
    const ac = aborts.get(job.id);
    if (ac) { try { ac.abort(); } catch { /* already stopped */ } aborts.delete(job.id); }
    for (const t of Array.from(activeRuns)) if (t.startsWith(`${job.id}#`)) activeRuns.delete(t); // gives its render slot back
    const qi = queue.indexOf(job.id);
    if (qi >= 0) queue.splice(qi, 1);
    if (mode === 'restart') {
      await removeClipFiles(job);
      patch(job.id, { clips: [], skipped: 0, progress: 0 });
    }
    patch(job.id, { status: 'queued', error: null, errorCode: null, errorDetail: null, attempts: (job.attempts || 0) + 1 });
    logger.info(`cloud job ${job.id}: ${mode === 'restart' ? 'restarting' : 'resuming'}${force ? ' (forced)' : ''}, attempt ${jobsCol.get(job.id).attempts}`);
    queue.push(job.id);
    setImmediate(pump);
    return view(jobsCol.get(job.id));
  }

  /** Housekeeping: drop abandoned/incomplete uploads and old finished jobs (frees disk). */
  async function cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const u of uploadsCol.all()) {
      const stale = now - u.updatedAt > 24 * 3600 * 1000;
      const finishedElsewhere = receivedBytes(u.ranges) >= u.size && now - u.updatedAt > config.retention.sourceDays * 86400000 && config.retention.sourceDays > 0;
      if (stale && receivedBytes(u.ranges) < u.size) { await fs.promises.unlink(u.filePath).catch(() => {}); fs.promises.unlink(captionsFileOf(u.id)).catch(() => {}); uploadsCol.remove(u.id); removed++; }
      else if (finishedElsewhere) { await fs.promises.unlink(u.filePath).catch(() => {}); fs.promises.unlink(captionsFileOf(u.id)).catch(() => {}); uploadsCol.remove(u.id); removed++; }
    }
    const liveBgmIds = new Set(jobsCol.all().filter((j) => j.bgm).map((j) => j.bgm.bgmId));
    const clipMs = (Number(config.retention.clipDays) || 0) * 86400000;
    // a job that stopped without making any clip has nothing worth keeping beyond a few hours (long enough to retry it)
    for (const j of jobsCol.all()) {
      if ((j.status === 'failed' || j.status === 'cancelled') && !(j.clips || []).length && !j.parentJobId && now - (j.updatedAt || 0) > 6 * 3600000
        && !jobsCol.all().some((k) => k.parentJobId === j.id)) { await removeJobFiles(j); jobsCol.remove(j.id); removed++; }
    }
    if (clipMs > 0) {
      const expired = (j) => ['done', 'failed', 'cancelled'].includes(j.status) && now - j.updatedAt > clipMs;
      for (const j of jobsCol.all()) {
        if (!jobsCol.get(j.id) || !expired(j)) continue;
        if (!j.parentJobId) {
          // a whole job goes with everything filed inside it, unless one of its re-renders is still working
          const kids = jobsCol.all().filter((k) => k.parentJobId === j.id);
          if (kids.some((k) => !['done', 'failed', 'cancelled'].includes(k.status))) continue;
          for (const k of kids) { jobsCol.remove(k.id); removed++; }
        }
        await removeJobFiles(j);
        jobsCol.remove(j.id);
        removed++;
      }
    }
    // temp files (animation layers, normalised music) that a crash or restart left behind
    try {
      const tmpMs = config.retention.tmpHours * 3600000;
      for (const n of await fs.promises.readdir(config.dirs.tmp)) {
        const f = path.join(config.dirs.tmp, n);
        const st = await fs.promises.stat(f).catch(() => null);
        if (st && st.isFile() && now - st.mtimeMs > tmpMs) { await fs.promises.unlink(f).catch(() => {}); removed++; }
      }
    } catch { /* no temp folder yet */ }
    removed += await bgmStore.cleanup((id) => liveBgmIds.has(id));
    if (overlayStore) {
      const liveOverlayIds = new Set(jobsCol.all().filter((j) => j.customOverlayId).map((j) => j.customOverlayId));
      removed += await overlayStore.cleanup((id) => liveOverlayIds.has(id));
    }
    if (removed) logger.info(`cloud cleanup: removed ${removed} old item(s)`);
    return removed;
  }

  // ── captions: the words of a video, kept next to it, and the work of finding them ───────────────────────────────
  // data/captions/<uploadId>.json = { cues: [{ s, e, text, words? }], language, engine, updatedAt }. The cues are on the
  // source video's timeline, so every clip (and every later re-render) takes the part it needs from the same words.
  let capLibP = null;
  const loadCaptionsLib = () => (capLibP || (capLibP = import(pathToFileURL(path.join(config.rootDir, 'js', 'shared', 'captions.js')).href)));
  const captionsFileOf = (uploadId) => path.join(config.dirs.data, 'captions', `${String(uploadId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

  async function readCaptions(uploadId) {
    try { return JSON.parse(await fs.promises.readFile(captionsFileOf(uploadId), 'utf8')); } catch { return { cues: [], language: '', engine: '', updatedAt: 0 }; }
  }
  async function saveCaptions(uploadId, { cues, language = '', engine = '' } = {}) {
    getUpload(uploadId);
    const lib = await loadCaptionsLib();
    const clean = lib.normalizeCues(cues);
    const prev = await readCaptions(uploadId);
    const data = { cues: clean, language: String(language || prev.language || '').slice(0, 12), engine: String(engine || prev.engine || '').slice(0, 30), updatedAt: Date.now() };
    const file = captionsFileOf(uploadId);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(data));
    await fs.promises.rename(`${file}.tmp`, file);
    return data;
  }
  async function captionEngine() {
    if (!transcriber) return { engine: 'none', ready: false, hint: 'Speech to text is not available on this server.' };
    return transcriber.status();
  }

  const capTasks = new Map(); // taskId -> { id, uploadId, status, progress, error, errorCode, words, createdAt, ac }
  const capQueue = [];
  let capBusy = false;
  const capView = (t) => ({ taskId: t.id, uploadId: t.uploadId, status: t.status, progress: t.progress, error: t.error, errorCode: t.errorCode || null, cueCount: t.cueCount || 0 });

  /** Starts finding the words of a video (or of part of it). Returns the task; poll getTranscription(). */
  async function startTranscription(uploadId, { language = 'auto', rangeStart = 0, rangeEnd = 0 } = {}) {
    if (!transcriber) throw new HttpError(503, 'Speech to text is not available on this server.');
    await ensureReady(uploadId);
    const u = getUpload(uploadId);
    for (const [id, t] of capTasks) if (Date.now() - t.createdAt > 3600000 && t.status !== 'running') capTasks.delete(id); // forget old results
    for (const t of capTasks.values()) if (t.uploadId === String(uploadId) && (t.status === 'queued' || t.status === 'running')) return capView(t); // already on it
    const task = {
      id: newId('cap'), uploadId: String(uploadId), status: 'queued', progress: 0, error: null, createdAt: Date.now(), ac: new AbortController(),
      language: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/.test(String(language)) ? String(language) : 'auto',
      rangeStart: Math.max(0, Number(rangeStart) || 0), rangeEnd: Math.max(0, Math.min(Number(rangeEnd) || 0, u.duration || Infinity)),
    };
    capTasks.set(task.id, task);
    capQueue.push(task.id);
    setImmediate(pumpCaptions);
    return capView(task);
  }
  function pumpCaptions() {
    if (capBusy) return;
    const id = capQueue.shift();
    const t = id && capTasks.get(id);
    if (!t) return;
    if (t.status !== 'queued') { setImmediate(pumpCaptions); return; }
    capBusy = true;
    runTranscription(t).catch((e) => logger.error('captions task crashed', e)).finally(() => { capBusy = false; setImmediate(pumpCaptions); });
  }
  async function runTranscription(t) {
    t.status = 'running';
    try {
      const u = getUpload(t.uploadId);
      const lib = await loadCaptionsLib();
      const r = await transcriber.transcribe(u.filePath, { rangeStart: t.rangeStart, rangeEnd: t.rangeEnd, language: t.language, signal: t.ac.signal, onProgress: (f) => { t.progress = Math.round(f * 100); } });
      let cues = lib.groupWordsIntoCues(r.words);
      const prev = await readCaptions(t.uploadId);
      if (t.rangeEnd > t.rangeStart) { // only part of the video was done: keep the words outside it
        const keep = prev.cues.filter((c) => c.e <= t.rangeStart || c.s >= t.rangeEnd);
        cues = lib.normalizeCues([...keep, ...cues.filter((c) => c.e > t.rangeStart && c.s < t.rangeEnd)]);
      }
      await saveCaptions(t.uploadId, { cues, language: r.language, engine: r.engine });
      t.cueCount = cues.length; t.progress = 100; t.status = 'done';
      logger.info(`captions: ${cues.length} caption lines for ${t.uploadId} (${r.engine})`);
    } catch (e) {
      t.status = 'failed';
      t.errorCode = e.code === 'engine-missing' ? 'engine-missing' : (t.ac.signal.aborted ? 'cancelled' : null);
      t.error = t.ac.signal.aborted ? 'Stopped.' : String(e.message || e).slice(0, 400);
      logger.warn(`captions: transcription failed (${t.error})`);
    }
  }
  function getTranscription(taskId) {
    const t = capTasks.get(String(taskId));
    if (!t) throw new HttpError(404, 'That transcription is no longer known (the server may have restarted). Start it again.');
    return capView(t);
  }
  function cancelTranscription(taskId) {
    const t = capTasks.get(String(taskId));
    if (!t) throw new HttpError(404, 'That transcription is no longer known.');
    if (t.status === 'queued' || t.status === 'running') { t.ac.abort(); if (t.status === 'queued') { t.status = 'failed'; t.error = 'Stopped.'; t.errorCode = 'cancelled'; } }
    return capView(t);
  }

  /**
   * Stops a job for good (it can still be resumed later). A queued job is simply taken out of the line; a running one has its
   * renders stopped. Clips that already finished are kept; a job that made none leaves no folder behind.
   */
  async function cancelJob(id) {
    const job = getJob(id);
    if (['done', 'failed', 'cancelled'].includes(job.status)) return view(job); // nothing left to stop
    runs.set(job.id, (runs.get(job.id) || 0) + 1); // whatever the running render reports from now on is ignored
    const ac = aborts.get(job.id);
    if (ac) { try { ac.abort(); } catch { /* already stopped */ } aborts.delete(job.id); }
    for (const t of Array.from(activeRuns)) if (t.startsWith(`${job.id}#`)) activeRuns.delete(t); // frees its render slot at once
    const qi = queue.indexOf(job.id);
    if (qi >= 0) queue.splice(qi, 1);
    patch(job.id, { status: 'cancelled', error: null, errorCode: null, cancelledAt: Date.now() });
    logger.info(`cloud job ${job.id} cancelled (${(jobsCol.get(job.id).clips || []).length} clip(s) were finished)`);
    // stopped renders leave their temporary files for a moment; tidy up now and once more shortly after
    const tidy = () => { removeStaleTemps(clipDirOf(job)); writeManifest(rootIdOf(job)); };
    tidy(); setTimeout(tidy, 4000).unref?.();
    setImmediate(pump);
    return view(jobsCol.get(job.id));
  }

  /** Throws away an upload that was never completed (the person cancelled while sending). A complete upload is kept: it can be reused. */
  async function discardUpload(uploadId) {
    const u = uploadsCol.get(String(uploadId));
    if (!u) return { removed: false };
    if (receivedBytes(u.ranges) >= u.size || jobsCol.all().some((j) => j.uploadId === u.id && (j.status === 'queued' || j.status === 'running'))) return { removed: false, kept: true };
    await fs.promises.unlink(u.filePath).catch(() => {});
    uploadsCol.remove(u.id);
    logger.info(`cloud upload ${u.id} discarded (cancelled while sending)`);
    return { removed: true };
  }

  /** Removes the files and records of named jobs and one upload (used by the self-test so it leaves nothing behind). */
  async function purge({ uploadId, jobIds = [] } = {}) {
    for (const jid of jobIds) {
      const j = jobsCol.get(String(jid));
      if (j) { try { await removeJobFiles(j); } catch { /* best effort */ } jobsCol.remove(j.id); }
    }
    const u = uploadId ? uploadsCol.get(String(uploadId)) : null;
    if (u) { await fs.promises.unlink(u.filePath).catch(() => {}); uploadsCol.remove(u.id); }
    db.markDirty();
  }

  /**
   * One-off tidy at start-up: job folders with nothing in them (jobs that failed or were stopped before making a clip, and
   * folders whose job is gone) are removed. A job that is still queued or running is left alone.
   */
  function tidyEmptyJobFolders() {
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(jobsRoot); } catch { return; }
    for (const name of names) {
      const dir = path.join(jobsRoot, name);
      if (!isJobFolder(dir, name)) continue;
      const job = jobsCol.get(name);
      if (job && (job.status === 'queued' || job.status === 'running' || (job.clips || []).length)) continue;
      let hasClips = false;
      try { hasClips = fs.readdirSync(path.join(dir, 'clips')).some((n) => /\.mp4$/.test(n)); } catch { /* no clips folder */ }
      if (hasClips) continue;
      if (jobsCol.all().some((j) => j.parentJobId === name)) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch { /* in use: next time */ }
    }
    if (removed) logger.info(`cloud: removed ${removed} empty job folder(s)`);
  }

  /**
   * Picks up jobs the server was working on when it stopped (a restart, a crash, the machine switched off). They go back
   * in the queue and continue: clips that were already finished are kept, only the rest is rendered.
   */
  function recover() {
    tidyEmptyJobFolders();
    for (const j of jobsCol.all()) {
      if (j.status === 'running' || j.status === 'queued') {
        patch(j.id, { status: 'queued', error: null, attempts: (j.attempts || 0) + 1 });
        queue.push(j.id);
        logger.warn(`cloud job ${j.id} was interrupted by a restart; continuing it (finished clips are kept)`);
      }
    }
    setImmediate(pump);
  }

  const MAX_CLIP_CHUNK = 8 * 1024 * 1024;

  /**
   * Returns one byte range of a finished clip. The app downloads clips through this (a small POST
   * answered with a few MB at a time) rather than a plain file URL: download managers such as IDM
   * grab any request for an .mp4 URL and hold it until the user answers a dialog, which left the
   * app waiting forever on the first clip.
   */
  async function readClipChunk(jobId, index, offset, length) {
    const job = jobsCol.get(String(jobId || ''));
    if (!job) throw new HttpError(404, 'Unknown job');
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || !(job.clips || []).some((c) => c.index === idx)) throw new HttpError(404, 'That clip is not ready yet');
    const file = path.join(clipDirOf(job), clipFileName(job, idx));
    let st;
    try { st = await fs.promises.stat(file); } catch { throw new HttpError(404, 'The clip file is no longer on the server'); }
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const len = Math.max(1, Math.min(MAX_CLIP_CHUNK, Math.floor(Number(length) || MAX_CLIP_CHUNK)));
    if (off >= st.size) return { data: Buffer.alloc(0), size: st.size };
    const n = Math.min(len, st.size - off);
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(n);
      const { bytesRead } = await fh.read(buf, 0, n, off);
      return { data: buf.subarray(0, bytesRead), size: st.size };
    } finally {
      await fh.close();
    }
  }

  migrateLegacyLayout();

  /** True while anything is being uploaded or rendered (used to refuse a change of storage folder). */
  function isBusy() {
    return jobsCol.all().some((j) => j.status === 'queued' || j.status === 'running');
  }

  return { isBusy, initUpload, writeChunk, ensureReady, analyze, startAnalysis, getAnalysis, cancelAnalysis, frame, createJob, getJob: (id) => view(getJob(id)), retryJob, cancelJob, discardUpload, purge, findUpload, readClipChunk, cleanup, recover, clipsDir, jobsRoot,
    captionEngine, readCaptions, saveCaptions, startTranscription, getTranscription, cancelTranscription };
}

module.exports = { createCloudStore, mergeRange, receivedBytes };
