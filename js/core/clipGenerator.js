import { audioAnalyzer } from './audioAnalyzer.js';
import { sceneDetector } from './sceneDetector.js';
import { videoProcessor } from './videoProcessor.js';
import { videoStore } from '../storage/videoStore.js';
import { db, STORES } from '../storage/db.js';
import { getBackendBaseUrl } from './config.js';
import { designStore } from './designStore.js';

// ── Series mode planning ────────────────────────────────────────────────────────────────
// Each part starts a few seconds BEFORE the previous part ended, so viewers get a short recap of
// what they just watched (this is how the original browser-only version worked:
// 30s clips with a 3s overlap -> Part 1: 0-30, Part 2: 27-57, Part 3: 54-84, ...).
export const SERIES_OVERLAP_SEC = 3;

export function buildSeriesCandidates(duration, targetDuration, { minClipSec = 1, overlapSec = SERIES_OVERLAP_SEC } = {}) {
  const out = [];
  if (!(duration > 0) || !(targetDuration > 0)) return out;
  // The overlap can never eat more than a quarter of a clip, so very short clip lengths still move forward.
  const overlap = Math.max(0, Math.min(Number(overlapSec) || 0, targetDuration * 0.25));
  let start = 0;
  for (let guard = 0; guard < 100000 && start < duration; guard++) {
    const clipDur = Math.min(targetDuration, duration - start);
    // Only the part of a clip after the overlap is new to the viewer; a tail with less than
    // minClipSec of NEW video isn't worth a part of its own.
    const freshSec = out.length === 0 ? clipDur : clipDur - overlap;
    if (clipDur < minClipSec || freshSec < minClipSec) break;
    out.push({
      start,
      duration: clipDur,
      totalScore: 100,
      audioScore: 0,
      sceneScore: 0,
      posScore: 1,
      sources: ['series'],
    });
    if (start + clipDur >= duration - 1e-6) break;
    start += targetDuration - overlap;
  }
  return out;
}

// ── Backend (cloud) request helpers ─────────────────────────────────────────────────────
// A fetch() that fails at the network level only says "Failed to fetch", which tells the
// person nothing. This wraps it so the failure names the server that couldn't be reached,
// and skips ngrok's browser-warning interstitial (which has no CORS headers) if a tunnel
// address is ever used.
async function cloudFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (/ngrok/i.test(String(url))) headers['ngrok-skip-browser-warning'] = 'true';
  try {
    return await fetch(url, { ...options, headers });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e; // stopped on purpose (Cancel): that is not a network problem and must not be retried
    let where = String(url);
    try { where = new URL(url, window.location.href).origin; } catch {}
    const err = new Error(`Can't reach the ClipperIQ server at ${where}. Make sure start.bat is running and its server window is still open.`);
    err.cause = e;
    err.network = true;
    throw err;
  }
}

// Turns a failed HTTP response into an Error carrying the server's own message.
async function cloudHttpError(res, fallback) {
  let detail = '';
  try { const j = await res.clone().json(); detail = j && (j.error || j.message) || ''; } catch {}
  const err = new Error(detail ? `${fallback}: ${detail}` : `${fallback} (HTTP ${res.status})`);
  err.status = res.status;
  return err;
}


export class ClipGenerator {
  constructor() {
    this.CLIP_DURATIONS = [15, 30, 45, 60];
    this.MAX_CLIPS = 8;
    this._reused = new Set();   // uploads whose video was found on the server instead of being sent
    this._ctl = new Map();      // uploadId -> AbortController of the generation running in this tab (what Cancel stops)
    this._watching = new Map(); // uploadId -> how many things in this tab are following that upload's server job right now
  }

  /** The error a stopped generation ends with. */
  _cancelled() { return Object.assign(new Error('Stopped.'), { name: 'AbortError', cancelled: true }); }

  /** True while this tab is following the server job of that upload (so nobody starts a second watcher). */
  isWatching(uploadId) { return (this._watching.get(String(uploadId)) || 0) > 0; }

  /** Marks an upload as being followed; returns the function that lets go again. */
  _claim(uploadId) {
    const k = String(uploadId);
    this._watching.set(k, (this._watching.get(k) || 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const n = (this._watching.get(k) || 1) - 1;
      if (n > 0) this._watching.set(k, n); else this._watching.delete(k);
    };
  }

  async analyze(videoBlob, onProgress = null) {
    if (onProgress) onProgress({ phase: 'audio', pct: 0 });

    const [audioResult, sceneResult] = await Promise.all([
      audioAnalyzer.detectAudioPeaks(videoBlob, { windowSizeSec: 1.0, peakThreshold: 0.6 }).catch(() => ({ peaks: [], duration: 0 })),
      sceneDetector.detectSceneChanges(videoBlob, {
        sampleInterval: 0.5,
        diffThreshold: 18,
        onProgress: (p) => { if (onProgress) onProgress({ phase: 'scene', pct: p * 100 }); },
      }).catch(() => ({ sceneChanges: [], duration: 0 })),
    ]);

    if (onProgress) onProgress({ phase: 'scoring', pct: 90 });

    const duration = audioResult.duration || sceneResult.duration || 0;
    const candidates = this.generateCandidates(duration, audioResult, sceneResult);
    const scored = this.scoreCandidates(candidates, audioResult, sceneResult, duration);

    if (onProgress) onProgress({ phase: 'done', pct: 100 });
    return { candidates: scored, duration };
  }

  generateCandidates(duration, audioResult, sceneResult) {
    const candidates = new Map();
    const add = (start, dur, source) => {
      const key = `${Math.round(start * 2) / 2}_${dur}`;
      if (!candidates.has(key)) {
        candidates.set(key, { start, duration: dur, sources: new Set() });
      }
      candidates.get(key).sources.add(source);
    };

    for (const peak of audioResult.peaks) {
      for (const dur of this.CLIP_DURATIONS) {
        const start = Math.max(0, peak.timestamp - dur * 0.25);
        if (start + dur <= duration) add(start, dur, 'audio');
      }
    }

    for (const scene of sceneResult.sceneChanges) {
      for (const dur of this.CLIP_DURATIONS) {
        const start = Math.max(0, scene.timestamp - 1.5);
        if (start + dur <= duration) add(start, dur, 'scene');
      }
    }

    const step = Math.max(30, duration / (this.MAX_CLIPS * 2));
    for (let t = 0; t + 30 <= duration; t += step) {
      add(t, 30, 'uniform');
    }

    return Array.from(candidates.values());
  }

  scoreCandidates(candidates, audioResult, sceneResult, duration) {
    const scored = candidates.map((c) => {
      let audioScore = 0;
      let sceneScore = 0;

      for (const peak of audioResult.peaks) {
        if (peak.timestamp >= c.start && peak.timestamp <= c.start + c.duration) {
          audioScore = Math.max(audioScore, peak.normalizedScore);
        }
      }

      for (const sc of sceneResult.sceneChanges) {
        if (sc.timestamp >= c.start && sc.timestamp <= c.start + c.duration) {
          sceneScore = Math.min(sceneScore + sc.normalizedDiff * 0.3, 1);
        }
      }

      const posScore = 1 - Math.abs((c.start + c.duration / 2) / duration - 0.5) * 0.3;
      const durationScore = c.duration === 30 ? 1 : c.duration === 60 ? 0.85 : 0.75;

      const totalScore = Math.round(
        (audioScore * 0.4 + sceneScore * 0.3 + posScore * 0.2 + durationScore * 0.1) * 100
      );

      return { ...c, audioScore, sceneScore, posScore, totalScore, sources: Array.from(c.sources) };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);

    const deduped = [];
    for (const c of scored) {
      const overlaps = deduped.some(
        (d) => Math.abs(d.start - c.start) < 10 && d.duration === c.duration
      );
      if (!overlaps) deduped.push(c);
      if (deduped.length >= this.MAX_CLIPS) break;
    }

    return deduped;
  }

  async generateClips(uploadId, videoBlob, candidates, options = {}) {
    const { onProgress = null, reEncode = false, overlayOptions = {}, aspectRatio = 'original', bgm = null, originalVolume = 1 } = options;
    const results = [];
    const total = candidates.length;

    console.log('[ClipGenerator] generateClips start', { uploadId, total, reEncode });

    if (reEncode) {
      for (let i = 0; i < total; i++) {
        const c = candidates[i];
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 0 });
        videoProcessor.onProgress = (pct) => {
          if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct });
        };
        const clipBlob = await videoProcessor.extractClipWithReencode(videoBlob, c.start, c.duration);
        const perClipOverlay = (overlayOptions && overlayOptions.partNumber != null)
          ? { ...overlayOptions, partNumber: overlayOptions.partNumber + i }
          : { ...overlayOptions };
        await this._saveClip(uploadId, clipBlob, c, i, results, perClipOverlay, null, aspectRatio);
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 100 });
      }
      videoProcessor.onProgress = null;
    } else {
      if (onProgress) onProgress({ phase: 'extracting', clipIndex: 0, total, pct: 0 });

      let currentClipIndex = 0;
      videoProcessor.onProgress = (pct) => {
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: currentClipIndex, total, pct });
      };

      const segs = candidates.map((c, idx) => ({
        start: c.start,
        duration: c.duration,
        outputDuration: c.outputDuration || null,
        overlayOptions: { ...overlayOptions, partNumber: overlayOptions.partNumber + idx },
        aspectRatio,
        audioOptions: bgm ? { bgm, originalVolume, restartAtClipStart: true, bindSliders: false } : null,
      }));

      await videoProcessor.extractClipsBatch(
        videoBlob,
        segs,
        async (i, blob) => {
          currentClipIndex = i + 1;
          if (blob) {
            const c = candidates[i];
            const segOv = segs[i]?.overlayOptions || overlayOptions;
            const mix = bgm ? { bgm, originalVolume, restartAtClipStart: true } : null;
            // Save each clip immediately upon completion
            await this._saveClip(uploadId, blob, c, i, results, segOv, mix, aspectRatio);
          }
          if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 100 });
        }
      );
      videoProcessor.onProgress = null;
    }

    console.log('[ClipGenerator] generateClips done', { uploadId, total, saved: results.length });
    return results;
  }

  async _saveClip(uploadId, clipBlob, c, i, results, overlayOptions = {}, audioMix = null, aspectRatio = 'original') {
    try {
      const blobId = videoStore.generateId('clip');
      console.log('[ClipGenerator] _saveClip start', { uploadId, index: i, start: c.start, duration: c.duration, hasBlob: !!clipBlob, blobSize: clipBlob ? clipBlob.size : 0 });
      await videoStore.saveBlob(blobId, clipBlob, { clipIndex: i });

      const record = {
        uploadId,
        blobId,
        jobClipIndex: i, // the clip's position in its server job (lets a later re-render be filed next to it)
        startTime: c.start,
        duration: c.duration,
        score: c.totalScore,
        audioScore: c.audioScore,
        sceneScore: c.sceneScore,
        sources: c.sources,
        status: 'ready',
        createdAt: new Date().toISOString(),
        title: (overlayOptions.format !== 'none' && overlayOptions.partNumber != null)
          ? `Part ${overlayOptions.partNumber} (${formatTime(c.start)} \u2013 ${formatTime(c.start + c.duration)})`
          : `Clip ${i + 1} (${formatTime(c.start)} \u2013 ${formatTime(c.start + c.duration)})`,
        partNumber: (overlayOptions.partNumber != null) ? overlayOptions.partNumber : null,
        overlayFormat: overlayOptions.format || 'none',
        overlayStartSec: typeof overlayOptions.overlayStartSec === 'number' ? overlayOptions.overlayStartSec : 0,
        aspectRatio,
        // Audio mix metadata (optional)
        bgmEnabled: !!(audioMix && audioMix.bgm),
        bgmSource: audioMix?.bgm ? (audioMix.bgm.type === 'blob' ? { type: 'blob', blobId: audioMix.bgm.blobId } : { type: 'url', url: audioMix.bgm.url }) : null,
        originalVolume: typeof audioMix?.originalVolume === 'number' ? audioMix.originalVolume : undefined,
        bgmVolume: typeof audioMix?.bgm?.volume === 'number' ? audioMix.bgm.volume : undefined,
        bgmRestart: !!audioMix?.restartAtClipStart,
      };

      const clipId = await db.put(STORES.CLIPS, record);
      const saved = { id: clipId, blobId, ...record };
      results.push(saved);
      console.log('[ClipGenerator] _saveClip done', { uploadId, index: i, clipId, blobId });
      try {
        if (window.clipsUI && Array.isArray(window.clipsUI.clips)) {
          window.clipsUI.clips.push(saved);
          if (typeof window.clipsUI.renderGrid === 'function') {
            window.clipsUI.renderGrid();
          }
        }
      } catch (uiErr) {
        console.warn('[ClipGenerator] UI update after save failed', uiErr);
      }
      try {
        window.dispatchEvent(new CustomEvent('clip:saved', { detail: saved }));
      } catch (evtErr) {
        console.error('[ClipGenerator] clip:saved dispatch failed', evtErr);
      }
      return saved;
    } catch (err) {
      console.error('[ClipGenerator] Failed to save clip', { uploadId, index: i, error: err });
      return null;
    }
  }

  /**
   * Makes the clips of one upload. Everything it does (sending the video, analysing it, the server job, saving the clips)
   * can be stopped with cancelUpload(); it then ends with an error whose `cancelled` is true.
   */
  async processUpload(uploadId, onProgress = null, options = {}) {
    const key = String(uploadId);
    if (this._ctl.has(key)) throw new Error('This video is already being processed.');
    const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `r${Date.now()}${Math.random().toString(36).slice(2)}`;
    let opts = options;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      this._ctl.set(key, ctl);
      try {
        return await this._processUploadCore(uploadId, onProgress, { ...opts, _signal: ctl.signal, _requestId: attempt ? `${requestId}-fresh` : requestId });
      } catch (e) {
        if (ctl.signal.aborted || (e && e.cancelled)) throw this._cancelled(); // a fetch that was aborted reports an AbortError: that is simply "stopped"
        // The copy found on the server could not be used after all (it has a problem): send the video again, once.
        if (attempt === 0 && this._reused.has(key) && e && !e.network && (e.status === 400 || e.status === 404 || e.status === 409 || e.status === 422 || /Invalid uploadId|Upload incomplete|Could not read/i.test(e.message || ''))) {
          this._reused.delete(key);
          opts = { ...opts, _noReuse: true, preUploadId: null };
          try { window.dispatchEvent(new CustomEvent('clip:notify', { detail: { type: 'warn', message: 'The copy of this video on the server could not be used, so it is being uploaded again.' } })); } catch { /* ignore */ }
          continue;
        }
        throw e;
      } finally {
        this._ctl.delete(key);
        this._reused.delete(key);
      }
    }
  }

  async _processUploadCore(uploadId, onProgress = null, options = {}) {
    const {
      maxClips = 8,
      targetDuration = 30,
      reEncode = false,
      seriesMode = false,
      seriesStartPart = 1,
      overlayFormat = 'part-text',
      aspectRatio = 'original',
      bgm = null,
      originalVolume = 1,
      cloudProcessing = false,
      speedProfile = 'balanced',
      videoBlob: videoBlobOverride = null,
      // Optional: only generate clips from this part of the video (seconds; 0 / 0 = the whole video).
      rangeStart: rangeStartOpt = 0,
      rangeEnd: rangeEndOpt = 0,
      // Optional: the person's own text / sticker / image layer (a transparent PNG) and a source that was
      // already sent to the server while they were choosing the start point.
      customOverlayBlob = null,
      design: designOpt = null,   // { data, aspect }: the design the layer was drawn from (kept so it can be edited later)
      preUploadId = null,
      captionCues = null,            // the caption words (source timeline) when captions are on
      _signal: signal = null,        // stops everything (cancelUpload)
      _requestId: requestId = null,  // lets the server recognise the same request if it arrives twice
      _noReuse: noReuse = false,     // send the video again even if the server says it has it (set after a reused copy proved unusable)
      look = null,                // { frame, lowerThird, adjust }: framing of the video in the frame and an animated lower third (server renders both)
    } = options;
    const rangeStart = Math.max(0, Number(rangeStartOpt) || 0);
    const rangeEnd = Number(rangeEndOpt) > rangeStart + 1 ? Number(rangeEndOpt) : 0;
    // Window of the video to use, clamped to its real length once that is known.
    const windowOf = (total) => {
      const rs = Math.min(rangeStart, Math.max(0, total - 1));
      const re = rangeEnd > 0 ? Math.min(rangeEnd, total) : total;
      return { rs, re: Math.max(rs + 1, re), active: rs > 0.01 || re < total - 0.5 };
    };

    this.MAX_CLIPS = maxClips;
    if (targetDuration && !this.CLIP_DURATIONS.includes(targetDuration)) {
      this.CLIP_DURATIONS = [targetDuration, ...this.CLIP_DURATIONS.filter(d => Math.abs(d - targetDuration) > 5)].slice(0, 4);
    }

    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);

    const videoBlob = videoBlobOverride || (upload.blobId ? await videoStore.getBlob(upload.blobId) : null);
    if (!videoBlob) throw new Error(`Video blob not found for upload ${uploadId}`);

    // What is needed to run this upload again if it fails before a server job exists (kept small and plain: no files).
    const processOptions = {
      maxClips, targetDuration, reEncode, seriesMode, seriesStartPart, overlayFormat, aspectRatio, originalVolume, cloudProcessing, speedProfile,
      rangeStart: rangeStartOpt, rangeEnd: rangeEndOpt, look: look || null,
      bgm: bgm && bgm.type === 'url' ? bgm : null, // a music FILE is not kept; a link is
      captionCues: look && look.captions && look.captions.enabled ? captionCues : null,
    };
    await db.put(STORES.UPLOADS, { ...upload, status: 'processing', error: null, processOptions, updatedAt: new Date().toISOString() });

    let candidates;
    let duration;

    if (cloudProcessing) {
      const base = (await getBackendBaseUrl()) || '';
      if (!base) {
        throw new Error("Couldn't reach the server. Please refresh the page and try again.");
      }

      // "Clip length" is the length of the FINISHED clip. With a playback-speed adjustment a clip is shorter than the stretch of
      // video it is cut from, so each clip is planned to cover (length x speed) seconds of the source: 4:10 at 1.34x
      // is cut from 5:35 of video and comes out 4:10 long.
      const speedF = look && look.adjust && Number(look.adjust.speed) > 0 ? Math.max(0.5, Math.min(2, Number(look.adjust.speed))) : 1;
      const spanDuration = Math.round(targetDuration * speedF * 100) / 100;

      // The source may already be on the server (sent while the person was choosing where to start).
      let cloudUploadId = preUploadId;
      if (cloudUploadId) { if (onProgress) onProgress({ phase: 'uploading', pct: 100 }); }
      else {
        cloudUploadId = await this._cloudUploadVideo(base, videoBlob, onProgress, signal, { noReuse: !!noReuse });
        if (this._lastUploadReused) this._reused.add(String(uploadId)); // if the reused copy turns out to be unusable, one fresh upload is tried
      }
      if (signal && signal.aborted) throw this._cancelled();

      if (seriesMode) {
        if (onProgress) onProgress({ phase: 'series-skip', pct: 60 });
        duration = await this._cloudGetDuration(base, cloudUploadId);
        if (!(duration > 0)) throw new Error('The server could not work out how long this video is. Try re-exporting it as MP4 and uploading again.');
        // Each part starts SERIES_OVERLAP_SEC before the previous one ended (sub-second leftovers are dropped).
        // With a chosen start/end only that window is split; the parts are then moved onto the real timeline.
        const win = windowOf(duration);
        const span = win.re - win.rs;
        const series = buildSeriesCandidates(span, spanDuration, { minClipSec: 1 });
        if (win.rs > 0) for (const c of series) c.start += win.rs;
        candidates = series;
        if (onProgress) onProgress({ phase: 'series-plan', pct: 60, duration: span, parts: series.length });
        try {
          const fmt = (t) => {
            const s = Math.round(t); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
            return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
          };
          const short = series.length <= 1 && span < spanDuration * 0.9;
          const info = this._lastCloudInfo || {};
          window.dispatchEvent(new CustomEvent('clip:notify', { detail: {
            type: short ? 'warn' : 'info',
            message: short
              ? `The server reads this video as only ${fmt(duration)} long, which is shorter than your ${fmt(targetDuration)} clip length, so just 1 part was made. If the real video is longer, the file may be incomplete.`
              : (win.active
                ? `Using ${fmt(win.rs)} to ${fmt(win.re)} of the video → ${series.length} parts of ${fmt(targetDuration)}.`
                : `Video length ${fmt(duration)} → ${series.length} parts of ${fmt(targetDuration)}.`),
          } }));
          if (info.warning) {
            window.dispatchEvent(new CustomEvent('clip:notify', { detail: { type: 'warn', message: info.warning } }));
          }
        } catch {}
      } else {
        if (onProgress) onProgress({ phase: 'analyzing', pct: 0 });
        if (signal && signal.aborted) throw this._cancelled();
        const analyzed = await this._cloudAnalyze(base, cloudUploadId, { maxClips, targetDuration: spanDuration, rangeStart, rangeEnd }, (p) => {
          if (onProgress) onProgress({ phase: 'analyzing', pct: p * 0.6 });
        }, signal);
        candidates = (analyzed.candidates || []).slice(0, maxClips);
        duration = analyzed.duration || 0;
      }

      const bgmCloudRef = bgm
        ? await this._cloudRegisterBgm(base, bgm, () => {
            try { window.dispatchEvent(new CustomEvent('clip:notify', { detail: { type: 'warn', message: 'Background music could not be loaded — continuing without it.' } })); } catch {}
          })
        : null;

      // The person's own text / stickers / images, drawn in the editor as one transparent picture. If it
      // can't be sent, stop now with a clear message instead of making every clip without it.
      const customOverlayId = customOverlayBlob ? await this._cloudRegisterOverlay(base, customOverlayBlob) : null;
      // Keep the design (and the picture drawn from it) in this browser, so a clip can be edited and
      // re-rendered later with exactly this look, even after the server has forgotten the layer.
      let designRef = null;
      if (customOverlayBlob && designOpt) {
        try {
          const rec = await designStore.save({ data: designOpt.data, aspect: designOpt.aspect, layerBlob: customOverlayBlob });
          designRef = { id: rec.id, customOverlayId };
        } catch (e) { console.warn('[ClipGenerator] could not save the design for later editing:', e); }
      }

      const jobOptions = {
        reEncode,
        aspectRatio,
        overlayFormat,
        seriesStartPart,
        originalVolume,
        speedProfile,
        frame: look && look.frame,
        lowerThird: look && look.lowerThird,
        lowerThirds: look && look.lowerThirds,
        adjust: look && look.adjust,
        captions: look && look.captions,
      };
      // the caption words go to the server before the job starts: it cuts each clip's captions from them
      if (look && look.captions && look.captions.enabled && Array.isArray(captionCues) && captionCues.length) {
        await this._cloudSaveCaptions(base, cloudUploadId, captionCues);
      }
      if (signal && signal.aborted) throw this._cancelled(); // stopped before the server was asked to start anything
      const jobId = await this._cloudStartJob(base, cloudUploadId, candidates, { ...jobOptions, bgm: bgmCloudRef, customOverlayId, requestId, origin: 'generate' });
      // Only claim music was applied if the server really accepted the track.
      const audioMix = (bgmCloudRef && bgm)
        ? { bgm, originalVolume, restartAtClipStart: bgm.loop !== false }
        : (originalVolume !== 1 ? { bgm: null, originalVolume, restartAtClipStart: false } : null);

      // The render itself runs on the server, independent of this browser tab. Record the
      // job right away — before waiting for it — so that if this tab is closed or reloaded
      // partway through, resumeInterruptedUploads() can find it again and pick up exactly
      // where it left off instead of losing track of clips that finished on the server.
      await db.put(STORES.UPLOADS, {
        ...upload,
        status: 'processing',
        cloudUploadId,
        cloudJobId: jobId,
        cloudJobStartedAt: Date.now(),
        captionCues: look && look.captions && look.captions.enabled && Array.isArray(captionCues) ? captionCues : null, // kept to start the job again if the server loses the video
        // everything needed to start the same job again if the server loses it (see retryUpload)
        cloudJobRequest: { candidates, job: jobOptions, bgmInput: bgm && bgm.type === 'url' ? bgm : null },
        design: designRef,
        look: look || null, // kept so every clip can be re-rendered with the same framing / lower third (see clips.js)
        cloudJobParams: { overlayFormat, seriesStartPart, aspectRatio, targetDuration, audioMix, design: designRef },
        updatedAt: new Date().toISOString(),
      });

      const results = await this._finishCloudJob(await db.get(STORES.UPLOADS, uploadId), base, jobId, {
        overlayFormat, seriesStartPart, aspectRatio, targetDuration, audioMix, onProgress, signal,
      });
      if (onProgress) onProgress({ phase: 'done', pct: 100, clips: results });
      return results;
    }

    if (seriesMode) {
      if (onProgress) onProgress({ phase: 'series-skip', pct: 60 });
      duration = await this._getVideoDuration(videoBlob);

      // Sequential parts; each one starts SERIES_OVERLAP_SEC before the previous one ended.
      const lwin = windowOf(duration);
      const series = buildSeriesCandidates(lwin.re - lwin.rs, targetDuration, { minClipSec: 0.25 });
      if (lwin.rs > 0) for (const c of series) c.start += lwin.rs;
      candidates = series;
    } else {
      if (onProgress) onProgress({ phase: 'analyzing', pct: 0 });
      const result = await this.analyze(videoBlob, (p) => {
        if (onProgress) onProgress({ phase: 'analyzing', pct: p.pct * 0.6 });
      });
      candidates = result.candidates;
      duration = result.duration;
      const lwin = windowOf(duration);
      if (lwin.active) candidates = candidates.filter((c) => c.start >= lwin.rs - 0.01 && c.start + c.duration <= lwin.re + 0.01);
    }

    const overlayOptions = { format: overlayFormat, partNumber: seriesStartPart };

    if (onProgress) onProgress({ phase: 'generating', pct: 0, clipIndex: 0, total: candidates.length });
    const clips = await this.generateClips(uploadId, videoBlob, candidates, {
      reEncode,
      overlayOptions,
      aspectRatio,
      bgm,
      originalVolume,
      onProgress: (p) => {
        const total = candidates.length || 1;
        const clipsDone = (p.clipIndex || 0) + Math.min((p.pct || 0) / 100, 1);
        const normalizedPct = Math.min((clipsDone / total) * 100, 100);
        if (onProgress) onProgress({ phase: 'generating', pct: normalizedPct, clipIndex: p.clipIndex || 0, total });
      },
    });

    await db.put(STORES.UPLOADS, {
      ...upload,
      status: 'done',
      clipCount: clips.length,
      duration,
      updatedAt: new Date().toISOString(),
    });

    if (onProgress) onProgress({ phase: 'done', pct: 100, clips });
    return clips;
  }

  /** A fingerprint of a video file (size and three 1 MB samples, SHA-256): quick even for a huge file, and the same file always gives the same one. */
  async _fingerprintBlob(blob) {
    try {
      if (!(typeof crypto !== 'undefined' && crypto.subtle)) return null; // needs a secure page (https or localhost)
      const SAMPLE = 1024 * 1024; const size = blob.size; const mid = Math.floor(size / 2);
      const parts = [blob.slice(0, SAMPLE), blob.slice(Math.max(0, mid - SAMPLE / 2), mid + SAMPLE / 2), blob.slice(Math.max(0, size - SAMPLE), size)];
      const bufs = await Promise.all(parts.map((x) => x.arrayBuffer()));
      const head = new TextEncoder().encode(`size:${size}|`);
      const all = new Uint8Array(head.length + bufs.reduce((n, b) => n + b.byteLength, 0));
      all.set(head, 0); let at = head.length;
      for (const b of bufs) { all.set(new Uint8Array(b), at); at += b.byteLength; }
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
      return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }

  async _cloudUploadVideo(baseUrl, videoBlob, onProgress, signal = null, { noReuse = false } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    this._lastUploadReused = false;
    // Is this exact video already on the server? Then it is not sent again (a copy with any problem is never reused).
    const fingerprint = await this._fingerprintBlob(videoBlob);
    if (fingerprint && !noReuse) {
      try {
        const fr = await cloudFetch(`${base}/api/cloud/upload/find`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint, size: videoBlob.size }), signal,
        });
        if (fr.ok) {
          const found = await fr.json().catch(() => ({}));
          if (found && found.found && found.uploadId) {
            this._lastUploadReused = true;
            if (onProgress) onProgress({ phase: 'uploading', pct: 100, reused: true });
            try { window.dispatchEvent(new CustomEvent('clip:notify', { detail: { type: 'info', message: 'This video is already on the server, so it was not uploaded again.' } })); } catch { /* ignore */ }
            return found.uploadId;
          }
        }
      } catch (e) { if (e && (e.name === 'AbortError' || e.cancelled)) throw e; /* an older server without this feature: upload as usual */ }
    }
    const initRes = await cloudFetch(`${base}/api/cloud/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: videoBlob?.name || 'video.mp4',
        size: videoBlob?.size || 0,
        type: videoBlob?.type || 'video/mp4',
        fingerprint: fingerprint || undefined,
      }),
      signal,
    });
    if (!initRes.ok) throw await cloudHttpError(initRes, 'Cloud upload init failed');
    const init = await initRes.json().catch(() => ({}));
    const uploadId = init.uploadId;
    if (!uploadId) throw new Error('Cloud upload init returned no uploadId');

    // Several chunks are in flight at once: over a real network (a remote server) one chunk at a
    // time leaves the connection idle between round trips. Chunks are independent byte ranges on
    // the server, so they can arrive in any order.
    const chunkSize = 8 * 1024 * 1024;
    const PARALLEL = 3;
    const total = videoBlob.size || 0;
    const chunks = [];
    for (let off = 0; off < total; off += chunkSize) chunks.push({ start: off, end: Math.min(total, off + chunkSize) - 1 });
    let nextChunk = 0;
    let uploadedBytes = 0;
    let failure = null;

    const sendChunk = async ({ start, end }) => {
      const buf = await videoBlob.slice(start, end + 1).arrayBuffer();
      let putRes;
      for (let attempt = 1; ; attempt++) {
        try {
          putRes = await cloudFetch(`${base}/api/cloud/upload?uploadId=${encodeURIComponent(uploadId)}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Range': `bytes ${start}-${end}/${total}`,
            },
            body: buf,
            signal,
          });
          if (putRes.ok || putRes.status < 500 || attempt >= 3) break;
        } catch (e) {
          if (signal && signal.aborted) throw this._cancelled();
          if (attempt >= 3) throw e;
        }
        await new Promise((r) => setTimeout(r, 800 * attempt)); // transient hiccup: retry this chunk
      }
      if (!putRes.ok) throw await cloudHttpError(putRes, 'Cloud upload chunk failed');
      uploadedBytes += end - start + 1;
      if (onProgress) onProgress({ phase: 'uploading', pct: (uploadedBytes / total) * 100 });
    };

    const uploadWorker = async () => {
      while (!failure) {
        if (signal && signal.aborted) return;
        const i = nextChunk++;
        if (i >= chunks.length) return;
        try { await sendChunk(chunks[i]); } catch (e) { failure = failure || e; return; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, uploadWorker));
    if (signal && signal.aborted) { // stopped while sending: the half-sent copy on the server is thrown away
      cloudFetch(`${base}/api/cloud/upload/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {});
      throw this._cancelled();
    }
    if (failure) throw failure;
    return uploadId;
  }

  async _cloudGetDuration(baseUrl, uploadId) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const r = await cloudFetch(`${base}/api/cloud/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    if (!r.ok) throw await cloudHttpError(r, 'Cloud duration lookup failed');
    const data = await r.json().catch(() => ({}));
    this._lastCloudInfo = data;
    return Number(data.duration) || 0;
  }

  async _cloudAnalyze(baseUrl, uploadId, options = {}, onPct = null, signal = null) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const r = await cloudFetch(`${base}/api/cloud/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        maxClips: options.maxClips,
        targetDuration: options.targetDuration,
        rangeStart: options.rangeStart || 0,
        rangeEnd: options.rangeEnd || 0,
      }),
      signal,
    });
    if (!r.ok) throw await cloudHttpError(r, 'Cloud analyze failed');
    if (onPct) onPct(100);
    return r.json().catch(() => ({ duration: 0, candidates: [] }));
  }

  async _cloudStartJob(baseUrl, uploadId, candidates, options = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const r = await cloudFetch(`${base}/api/cloud/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        candidates,
        reEncode: !!options.reEncode,
        aspectRatio: options.aspectRatio,
        overlayFormat: options.overlayFormat,
        seriesStartPart: options.seriesStartPart,
        originalVolume: options.originalVolume,
        fit: options.fit,
        bgm: options.bgm || null,
        customOverlayId: options.customOverlayId || null,
        speedProfile: options.speedProfile || 'balanced',
        frame: options.frame || undefined,
        lowerThird: options.lowerThird || undefined,
        adjust: options.adjust || undefined,
        lowerThirds: options.lowerThirds || undefined,
        captions: options.captions || undefined,
        requestId: options.requestId || undefined,   // the server makes ONE job however often this request arrives
        origin: options.origin || undefined,         // why the job was made (it is written in the job's job.json and the server log)
        // a re-render of one clip is filed inside the job that made it (the server keeps one folder per job)
        parentJobId: options.parentJobId || undefined,
        clipIndex: Number.isInteger(options.clipIndex) ? options.clipIndex : undefined,
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      const err = new Error(data.error || 'Cloud job start failed');
      err.status = r.status;
      throw err;
    }
    const data = await r.json().catch(() => ({}));
    if (!data.jobId) throw new Error('Cloud job start returned no jobId');
    return data.jobId;
  }

  /** Sends the stored picture of a saved design to the server and returns the layer id (null if there is none). */
  async registerDesignLayer(baseUrl, designId) {
    if (!designId) return null;
    // One upload per design for a whole batch of clips (the server keeps a layer for at least a day).
    this._layerCache = this._layerCache || new Map();
    const hit = this._layerCache.get(designId);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.promise;
    const promise = (async () => {
      const blob = await designStore.getLayerBlob(designId);
      if (!blob) return null;
      return this._cloudRegisterOverlay(String(baseUrl || '').replace(/\/+$/, ''), blob);
    })();
    // the promise is cached right away, so clips rendered in parallel share ONE upload
    this._layerCache.set(designId, { promise, at: Date.now() });
    promise.then((id) => { if (!id) this._layerCache.delete(designId); }, () => this._layerCache.delete(designId));
    return promise;
  }

  /** Sends the custom overlay layer (a transparent PNG) to the server and returns its id. */
  async _cloudRegisterOverlay(baseUrl, blob) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    let data = {};
    try {
      const r = await cloudFetch(`${base}/api/cloud/overlay/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      });
      data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    } catch (e) {
      throw new Error(`Your custom overlay couldn't be sent to the server: ${(e && e.message) || e}`);
    }
    if (!data.overlayId) throw new Error('Your custom overlay couldn\'t be saved on the server.');
    return data.overlayId;
  }

  /**
   * Sends the source video to the server ahead of time, while the person is still choosing where to start,
   * so the preview can be built from the server and generation doesn't upload it a second time.
   * Resolves { uploadId, duration }. A second call for the same file reuses the first.
   */
  preUpload(file, onProgress = null) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (this._pre && this._pre.key === key) {
      if (onProgress) this._pre.listeners.add(onProgress);
      return this._pre.promise;
    }
    const entry = { key, listeners: new Set(onProgress ? [onProgress] : []), uploadId: null, duration: 0 };
    entry.promise = (async () => {
      const base = (await getBackendBaseUrl()) || '';
      if (!base) throw new Error("Couldn't reach the server.");
      const id = await this._cloudUploadVideo(base, file, (p) => entry.listeners.forEach((fn) => { try { fn(p); } catch {} }));
      const duration = await this._cloudGetDuration(base, id);
      entry.uploadId = id; entry.duration = duration;
      return { uploadId: id, duration, base };
    })();
    entry.promise.catch(() => { if (this._pre === entry) this._pre = null; });
    this._pre = entry;
    return entry.promise;
  }

  /** The pre-uploaded server copy of this exact file, if it finished uploading. */
  getPreUploadId(file) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    return this._pre && this._pre.key === key ? this._pre.uploadId : null;
  }

  /** Waits for an in-flight pre-upload of this file (used when Generate is pressed early). */
  async waitPreUpload(file, onProgress = null) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (!this._pre || this._pre.key !== key) return null;
    if (onProgress) this._pre.listeners.add(onProgress);
    try { const r = await this._pre.promise; return r.uploadId; } catch { return null; }
  }

  /** One still picture of the pre-uploaded source at `t` seconds (a Blob), for the preview. */
  async previewFrame(uploadId, t, width = 480, signal = undefined) {
    const base = (await getBackendBaseUrl()) || '';
    const r = await cloudFetch(`${String(base).replace(/\/+$/, '')}/api/cloud/frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, t, width }),
      signal,
    });
    if (!r.ok) throw await cloudHttpError(r, 'Preview failed');
    return r.blob();
  }

  /**
   * Registers a local BGM selection (a blob picked from disk, or a link) with the backend so
   * a cloud render job can mix it in server-side, and returns the {bgmId, volume, duck,
   * restart} reference _cloudStartJob expects. Never throws — background music is a nice-to-
   * have, so a failure here (e.g. a dead link) just means the clips render without it.
   */
  async _cloudRegisterBgm(baseUrl, bgm, onWarn = null) {
    if (!bgm) return null;
    const base = String(baseUrl || '').replace(/\/+$/, '');
    try {
      let bgmId;
      if (bgm.type === 'blob' && bgm.blobId) {
        const blob = await videoStore.getBlob(bgm.blobId);
        if (!blob) throw new Error('Background music file was not found in local storage');
        const filename = (blob.name || 'bgm.audio');
        const r = await cloudFetch(`${base}/api/cloud/bgm/upload?filename=${encodeURIComponent(filename)}`, {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'application/octet-stream' },
          body: blob,
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'Background music upload failed');
        bgmId = data.bgmId;
      } else if (bgm.type === 'url' && bgm.url) {
        const r = await cloudFetch(`${base}/api/cloud/bgm/from-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: bgm.url }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'Fetching audio from that link failed');
        bgmId = data.bgmId;
      } else {
        return null;
      }
      if (!bgmId) throw new Error('Backend did not return a background-music id');
      return { bgmId, volume: bgm.volume, duck: true, restart: bgm.restart !== undefined ? !!bgm.restart : bgm.loop !== false };
    } catch (e) {
      console.warn('[ClipGenerator] Background music registration failed, continuing without it:', e);
      if (onWarn) onWarn(e);
      return null;
    }
  }

  /**
   * Renders one clip on the backend from an already-cloud-uploaded source, without touching
   * the local Clips library — used to re-render a single existing clip (e.g. the Audio Mix
   * editor) against the original source that's still sitting on the server. `candidate` is
   * {start, duration, totalScore?, audioScore?, sceneScore?, sources?}.
   */
  async renderCloudClip(baseUrl, cloudUploadId, candidate, options = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    // A track registered once by the caller (bgmRef) is reused as-is, so applying one mix to many
    // clips doesn't re-upload or re-download the music for each of them.
    let bgmCloudRef = options.bgmRef || null;
    if (!bgmCloudRef && options.bgm) {
      bgmCloudRef = await this._cloudRegisterBgm(base, options.bgm);
      if (!bgmCloudRef) throw new Error('The background music could not be loaded, so nothing was changed. Check the file or link and try again.');
    }
    if (options.overlayStartSec != null) candidate = { ...candidate, overlayStartSec: options.overlayStartSec };
    // The clip's custom design (text / stickers / images) must be part of every re-render, or editing or
    // remixing a clip would quietly drop it. A layer registered once by the caller (customOverlayRef) is
    // reused for a whole batch; otherwise the stored picture of the design is sent now.
    let customOverlayId = options.customOverlayRef || null;
    if (!customOverlayId && options.customOverlayBlob) customOverlayId = await this._cloudRegisterOverlay(base, options.customOverlayBlob);
    if (!customOverlayId && options.designId) {
      customOverlayId = await this.registerDesignLayer(base, options.designId);
      if (!customOverlayId) throw new Error('This clip\'s custom design could not be loaded from this browser, so nothing was changed. Open Design and apply it again.');
    }
    const jobId = await this._cloudStartJob(base, cloudUploadId, [candidate], {
      reEncode: true,
      aspectRatio: options.aspectRatio,
      overlayFormat: options.overlayFormat,
      seriesStartPart: options.partNumber || 1,
      originalVolume: options.originalVolume,
      bgm: bgmCloudRef,
      customOverlayId,
      frame: options.look && options.look.frame,
      lowerThird: options.look && options.look.lowerThird,
      adjust: options.look && options.look.adjust,
      lowerThirds: options.look && options.look.lowerThirds,
      captions: options.look && options.look.captions,
      requestId: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : undefined,
      origin: 'rerender',
      parentJobId: options.parentJobId || null,
      clipIndex: options.clipIndex,
    });

    const start = Date.now();
    while (true) {
      const r = await cloudFetch(`${base}/api/cloud/jobs/${encodeURIComponent(jobId)}`);
      if (!r.ok) throw await cloudHttpError(r, 'Cloud job status failed');
      const data = await r.json().catch(() => ({}));
      if (data.status === 'done') {
        const clipInfo = (data.clips || [])[0];
        if (!clipInfo) throw new Error('Cloud job returned no clip');
        // Same piecewise download as the main pipeline (a plain .mp4 URL gets held up by download managers).
        const blob = await this._downloadClipBlob({ base, jobId, index: Number.isInteger(clipInfo.index) ? clipInfo.index : 0, size: Number(clipInfo.size) || 0, url: clipInfo.url }, 'the re-rendered clip');
        return { blob, info: clipInfo, jobId };
      }
      if (data.status === 'failed') throw new Error(data.error || 'Cloud render failed');
      if (Date.now() - start > 30 * 60 * 1000) throw new Error('Cloud render timed out');
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  /**
   * Polls a cloud render job and, as soon as any new entry appears in its `clips` array,
   * downloads and saves it into the library immediately — rather than waiting for the whole
   * job to finish. This is what powers the live preview and the "clips appear as they
   * complete" library behaviour for cloud processing.
   *
   * `startIndex`/`results` let a resumed job (see resumeInterruptedUploads) pick up after
   * whatever was already saved before this tab was closed or reloaded, instead of
   * re-downloading and duplicating clips that are already in the library.
   */
  /**
   * One request with a stall timer covering both the response headers and the body. If nothing
   * arrives in time the request is aborted and reported as `stalled`, so a request that is being
   * held up (typically by a download manager) can never leave the app waiting forever.
   */
  async _timedRequest(url, init, stallMs, readBody) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), stallMs);
    try {
      const r = await cloudFetch(url, { ...init, cache: 'no-store', signal: ac.signal });
      if (!r.ok) throw await cloudHttpError(r, 'Clip download failed');
      return await readBody(r);
    } catch (e) {
      if (ac.signal.aborted) {
        const err = new Error('the download got no response (a download manager such as IDM may be blocking it)');
        err.stalled = true;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Downloads one rendered clip and makes sure what arrived is a whole, readable file.
   *
   * The clip is fetched through a small POST endpoint, a few MB per request, rather than by its
   * .mp4 URL: download managers (IDM etc.) intercept requests for media files and hold them behind
   * a dialog, which used to leave the app stuck on the first clip. Each piece has its own stall
   * timeout and retries, and a retry continues from where the last attempt stopped.
   */
  async _downloadClipBlob(src, label) {
    const { base, jobId, index, size, url } = src;
    const CHUNK = 4 * 1024 * 1024;
    const STALL_MS = 30000;
    const parts = [];
    let got = 0;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let blob;
        if (size > 0) {
          while (got < size) {
            const buf = await this._timedRequest(`${base}/api/cloud/clip-chunk`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId, index, offset: got, length: Math.min(CHUNK, size - got) }),
            }, STALL_MS, (r) => r.arrayBuffer());
            if (!buf.byteLength) throw new Error('the server sent an empty piece of the clip');
            parts.push(buf);
            got += buf.byteLength;
          }
          blob = new Blob(parts, { type: 'video/mp4' });
          if (blob.size !== size) throw new Error(`the download is incomplete (${blob.size} of ${size} bytes)`);
        } else {
          // A job created before chunked downloads existed has no size: fall back to the plain URL.
          blob = await this._timedRequest(url, {}, STALL_MS * 4, (r) => r.blob());
          if (!blob.size) throw new Error('the downloaded file was empty');
        }
        const state = await this._probeBlobPlayable(blob);
        if (state === 'bad') throw new Error('the clip has no readable length');
        const out = blob.type ? blob : new Blob([blob], { type: 'video/mp4' });
        // Remember where this file came from: videoStore uses it to download the clip again if the browser
        // ever loses its copy.
        out.cloudSource = { jobId, index, size: out.size };
        return out;
      } catch (e) {
        lastErr = e;
        console.warn(`[ClipGenerator] ${label}: download attempt ${attempt} failed:`, e);
        if (e && e.network) break; // server unreachable: retrying immediately won't help
        if (e && !e.stalled) { parts.length = 0; got = 0; } // a bad piece: start the clip over
        await new Promise((res) => setTimeout(res, 700 * attempt));
      }
    }
    const hint = lastErr && lastErr.stalled ? ' Turn it off for localhost:3000, then reload this page to resume.' : ' Reload this page to try again.';
    throw new Error(`Could not download ${label}: ${lastErr ? lastErr.message : 'unknown error'}.${hint}`);
  }

  /**
   * 'ok'      : the browser read a real length from the clip
   * 'bad'     : it loaded but the length is zero/unknown (an empty or broken file)
   * 'unknown' : the browser couldn't decide in time (e.g. a codec it doesn't support); not
   *             treated as a failure so a browser limitation never blocks saving.
   */
  _probeBlobPlayable(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      let done = false;
      const finish = (state) => {
        if (done) return; done = true; clearTimeout(timer);
        v.removeAttribute('src'); try { v.load(); } catch {}
        URL.revokeObjectURL(url); resolve(state);
      };
      const timer = setTimeout(() => finish('unknown'), 12000);
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => finish(Number.isFinite(v.duration) && v.duration > 0.2 ? 'ok' : 'bad');
      v.onerror = () => finish('unknown');
      v.src = url;
    });
  }

  async _cloudWaitAndSaveClips(baseUrl, jobId, options = {}) {
    const { uploadId, candidates = [], overlayFormat, seriesStartPart, aspectRatio, targetDuration, audioMix = null, onProgress, startIndex = 0, results = [], signal = null } = options;
    const base = String(baseUrl || '').replace(/\/+$/, '');
    let saved = startIndex;
    const start = Date.now();
    const warned = new Set();
    const notifyOnce = (key, type, message) => {
      if (warned.has(key)) return; warned.add(key);
      try { window.dispatchEvent(new CustomEvent('clip:notify', { detail: { type, message } })); } catch {}
    };

    // Live progress for the UI (the dashboard badge and the upload details window). It is broadcast from here,
    // not from whoever started the run, so it also works after a page reload when the job is picked back up.
    const emit = (detail) => {
      try { window.dispatchEvent(new CustomEvent('clip:job-progress', { detail: { uploadId, jobId, at: Date.now(), ...detail } })); } catch {}
    };
    let lastOk = Date.now();
    let netFails = 0;

    const saveOne = async (clipInfo, i) => {
      // `index` is the clip's position in the job as the server numbered it; it only differs
      // from the array position if the server skipped a clip, and part numbers must follow it.
      const jobIndex = Number.isInteger(clipInfo.index) ? clipInfo.index : i;
      const clipBlob = await this._downloadClipBlob({ base, jobId, index: jobIndex, size: Number(clipInfo.size) || 0, url: clipInfo.url }, `Part ${seriesStartPart + jobIndex}`);
      const c = {
        start: typeof clipInfo.startTime === 'number' ? clipInfo.startTime : (candidates[jobIndex]?.start || 0),
        // `duration` is the stretch of the SOURCE the clip was cut from (that is what Edit / Mix Audio / Design re-render from);
        // `outputDuration` is how long the finished clip is (they differ when the playback speed was changed)
        duration: typeof clipInfo.sourceDuration === 'number' ? clipInfo.sourceDuration : (typeof clipInfo.duration === 'number' ? clipInfo.duration : (candidates[jobIndex]?.duration || targetDuration)),
        outputDuration: typeof clipInfo.duration === 'number' ? clipInfo.duration : null,
        totalScore: typeof clipInfo.score === 'number' ? clipInfo.score : (candidates[jobIndex]?.totalScore || 0),
        audioScore: typeof clipInfo.audioScore === 'number' ? clipInfo.audioScore : (candidates[jobIndex]?.audioScore || 0),
        sceneScore: typeof clipInfo.sceneScore === 'number' ? clipInfo.sceneScore : (candidates[jobIndex]?.sceneScore || 0),
        posScore: candidates[jobIndex]?.posScore || 1,
        sources: clipInfo.sources || candidates[jobIndex]?.sources || [],
      };
      const overlayOptions = { format: overlayFormat, partNumber: seriesStartPart + jobIndex };
      const savedClip = await this._saveClip(uploadId, clipBlob, c, jobIndex, results, overlayOptions, audioMix, aspectRatio);
      if (!savedClip) throw new Error(`Failed to save clip ${jobIndex + 1} (the browser's storage may be full)`);
      for (const w of (clipInfo.warnings || [])) notifyOnce(`${jobIndex}:${w}`, 'warn', `Part ${seriesStartPart + jobIndex}: ${w}`);
      return savedClip;
    };

    try {
    while (true) {
      if (signal && signal.aborted) throw this._cancelled();
      let data;
      try {
        const r = await cloudFetch(`${base}/api/cloud/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal });
        if (!r.ok) throw await cloudHttpError(r, 'Cloud job status failed');
        data = await r.json().catch(() => ({}));
        lastOk = Date.now(); netFails = 0;
      } catch (e) {
        // The server keeps rendering while the page can't reach it for a moment (sleep, a restart of the
        // server window, a network blip), so keep trying for a few minutes instead of giving up.
        if (e && e.network && Date.now() - lastOk < 20 * 60 * 1000) {
          netFails++;
          emit({ status: 'reconnecting', saved, total: Math.max(candidates?.length || 0, saved) || 1, offlineSec: Math.round((Date.now() - lastOk) / 1000) });
          await new Promise((resolve) => setTimeout(resolve, Math.min(10000, 1500 * netFails)));
          continue;
        }
        throw e;
      }
      const clips = Array.isArray(data.clips) ? data.clips : [];
      const total = Math.max(Number(data.total) || 0, candidates?.length || 0, clips.length) || 1;
      emit({ status: data.status || 'running', serverPct: Number(data.progress) || 0, ready: clips.length, saved, total, skipped: Number(data.skipped) || 0 });

      while (saved < clips.length) {
        await saveOne(clips[saved], saved);
        saved++;
        emit({ status: data.status || 'running', serverPct: Number(data.progress) || 0, ready: clips.length, saved, total, skipped: Number(data.skipped) || 0 });
        if (onProgress) onProgress({ phase: 'generating', pct: (saved / total) * 100, clipIndex: saved - 1, total });
      }
      // Between clips, report the server's own progress so the bar keeps moving during a long render.
      if (onProgress && saved < total) {
        const serverPct = Number(data.progress) || 0;
        onProgress({ phase: 'generating', pct: Math.max((saved / total) * 100, serverPct), clipIndex: Math.min(saved, total - 1), total });
      }

      if (data.status === 'done') {
        // A job can finish between the clips array filling in and the final status flip —
        // one last check catches any clip that arrived in this same response.
        while (saved < clips.length) { await saveOne(clips[saved], saved); saved++; }
        if (data.skipped) notifyOnce('skipped', 'warn', `${data.skipped} part(s) were skipped because they start after the end of the video as the server reads it.`);
        if (!results.length) throw new Error('Cloud job returned no clips');
        emit({ status: 'done', serverPct: 100, ready: clips.length, saved, total, skipped: Number(data.skipped) || 0 });
        return results;
      }
      if (data.status === 'cancelled') throw this._cancelled(); // stopped (from here, another tab, or the details window)
      if (data.status === 'failed') { const err = new Error(data.error || 'Cloud job failed'); err.code = data.errorCode || null; err.detail = data.errorDetail || null; err.jobId = jobId; err.jobFailed = true; throw err; }
      if (Date.now() - start > 12 * 60 * 60 * 1000) throw new Error('Cloud job timed out');
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    } catch (e) {
      if (e && (e.cancelled || (signal && signal.aborted))) { emit({ status: 'cancelled', saved }); throw this._cancelled(); }
      emit({ status: 'error', saved, error: String((e && e.message) || e).slice(0, 300), network: !!(e && e.network), code: (e && e.code) || null });
      throw e;
    }
  }

  /** Waits out a cloud render job (saving clips as they arrive) and marks the upload done. */
  async _finishCloudJob(upload, base, jobId, params) {
    // Only ONE tab follows a given upload at a time (the browser's Web Locks): a second tab that also followed it would save every
    // clip a second time. The lock is released when the tab closes, so a reload picks the job up again.
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request(`clipperiq-follow-${upload.id}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return params.results || []; // another tab is already following it
        return this._finishCloudJobLocked(upload, base, jobId, params);
      });
    }
    return this._finishCloudJobLocked(upload, base, jobId, params);
  }

  async _finishCloudJobLocked(upload, base, jobId, params) {
    const { overlayFormat, seriesStartPart, aspectRatio, targetDuration, audioMix = null, onProgress, startIndex = 0, results = [], signal = null } = params;
    const release = this._claim(upload.id);
    try {
      const finalResults = await this._cloudWaitAndSaveClips(base, jobId, {
        uploadId: upload.id, overlayFormat, seriesStartPart, aspectRatio, targetDuration, audioMix,
        onProgress, startIndex, results, signal,
      });
      await db.put(STORES.UPLOADS, {
        ...(await db.get(STORES.UPLOADS, upload.id) || upload), status: 'done', error: null, resumable: false, clipCount: finalResults.length, updatedAt: new Date().toISOString(),
      });
      return finalResults;
    } catch (e) {
      // A stop is not a failure. A server that cannot be reached leaves the upload "processing" (it is picked up again by itself
      // when the server is back). Anything else is a real failure: say so, and keep it retryable.
      if (e && e.cancelled) await this._markCancelled(upload.id).catch(() => {});
      else if (!(e && e.network)) await this.markUploadFailed(upload.id, e).catch(() => {});
      throw e;
    } finally {
      release();
    }
  }

  /** The upload's state after a stop: clips already saved stay, and it can be resumed. */
  async _markCancelled(uploadId) {
    const cur = await db.get(STORES.UPLOADS, uploadId);
    if (!cur || cur.status === 'done') return;
    await db.put(STORES.UPLOADS, { ...cur, status: 'cancelled', error: null, resumable: !!(cur.cloudJobId || cur.processOptions), updatedAt: new Date().toISOString() });
  }

  /**
   * Stops an upload for real: whatever this tab is doing for it (sending the video, analysing, following the job) stops at once,
   * and the server is told to stop too (its renders are killed, a half-sent copy is discarded). Clips that are already finished
   * are kept and the upload can be resumed. Works from any tab, and after a reload.
   */
  async cancelUpload(uploadId) {
    const key = String(uploadId);
    const ctl = this._ctl.get(key);
    if (ctl) ctl.abort();
    const upload = await db.get(STORES.UPLOADS, uploadId).catch(() => null);
    let serverStopped = true;
    if (upload) {
      try {
        const base = (await getBackendBaseUrl()) || '';
        if (base && upload.cloudJobId) {
          const r = await cloudFetch(`${base}/api/cloud/jobs/${encodeURIComponent(upload.cloudJobId)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!r.ok && r.status !== 404) serverStopped = false;
        }
      } catch { serverStopped = false; } // the server could not be reached: it stops on its own when asked again (the job is cancelled on next contact)
      await this._markCancelled(uploadId).catch(() => {});
      try { window.dispatchEvent(new CustomEvent('clip:job-progress', { detail: { uploadId, jobId: upload.cloudJobId, at: Date.now(), status: 'cancelled' } })); } catch { /* ignore */ }
    }
    return { serverStopped };
  }

  /** Records that an upload stopped, with the reason, so the app can show it and offer Retry (finished clips are kept). */
  async markUploadFailed(uploadId, err) {
    const cur = await db.get(STORES.UPLOADS, uploadId);
    if (!cur || cur.status === 'done') return;
    const reason = String((err && err.message) || err || 'Processing stopped.').slice(0, 600);
    await db.put(STORES.UPLOADS, { ...cur, status: 'failed', error: reason, errorDetail: (err && err.detail) ? String(err.detail).slice(0, 900) : (cur.errorDetail || null), errorCode: (err && err.code) || null, resumable: !!(cur.cloudJobId || cur.processOptions), updatedAt: new Date().toISOString() });
  }

  // ── auto captions ────────────────────────────────────────────────────────────────────────

  async _capBase() {
    const base = (await getBackendBaseUrl()) || '';
    if (!base) throw new Error("Couldn't reach the server. Please refresh the page and try again.");
    return base;
  }

  /** What speech-to-text the server has: { ready, engine, hint }. */
  async captionEngine() {
    const base = await this._capBase();
    const r = await cloudFetch(`${base}/api/cloud/captions/engine`);
    if (!r.ok) throw await cloudHttpError(r, 'Could not check the speech-to-text engine');
    return r.json();
  }

  /** The caption words the server keeps for a video: [{ s, e, text, words? }]. */
  async loadCaptions(cloudUploadId) {
    const base = await this._capBase();
    const r = await cloudFetch(`${base}/api/cloud/captions/${encodeURIComponent(cloudUploadId)}`);
    if (!r.ok) throw await cloudHttpError(r, 'Could not load the captions');
    return ((await r.json()).cues) || [];
  }

  async _cloudSaveCaptions(base, cloudUploadId, cues) {
    const r = await cloudFetch(`${base}/api/cloud/captions/${encodeURIComponent(cloudUploadId)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cues }),
    });
    if (!r.ok) throw await cloudHttpError(r, 'Could not save the captions');
  }
  async saveCaptions(cloudUploadId, cues) { return this._cloudSaveCaptions(await this._capBase(), cloudUploadId, cues); }

  /**
   * Turns the speech of a video that is on the server into caption words. Runs as a task there (it can take minutes);
   * this follows it, reports progress as { text }, and resolves with the words. `signal` stops it.
   */
  async transcribeCaptions(cloudUploadId, { language = 'auto', rangeStart = 0, rangeEnd = 0 } = {}, onProgress = null, signal = null) {
    const base = await this._capBase();
    const say = (text) => { if (onProgress) onProgress({ text }); };
    say('Starting the speech recognition…');
    const r = await cloudFetch(`${base}/api/cloud/captions/${encodeURIComponent(cloudUploadId)}/transcribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language, rangeStart, rangeEnd }), signal,
    });
    if (!r.ok) throw await cloudHttpError(r, 'Could not start the captions');
    const { taskId } = await r.json();
    const stop = async () => { try { await cloudFetch(`${base}/api/cloud/caption-tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }); } catch { /* it ends by itself */ } };
    for (;;) {
      if (signal && signal.aborted) { await stop(); throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); }
      await new Promise((res) => setTimeout(res, 1500));
      const pr = await cloudFetch(`${base}/api/cloud/caption-tasks/${encodeURIComponent(taskId)}`);
      if (!pr.ok) throw await cloudHttpError(pr, 'Lost track of the captions');
      const t = await pr.json();
      if (t.status === 'failed') throw Object.assign(new Error(t.error || 'The speech recognition failed.'), { code: t.errorCode });
      if (t.status === 'done') break;
      say(t.status === 'queued' ? 'Waiting for the speech recognition to be free…' : `Listening to the video… ${t.progress || 0}%`);
    }
    return this.loadCaptions(cloudUploadId);
  }

  /** Asks the server to start a failed / interrupted job again (it keeps the clips that already finished). */
  async _cloudRetryJob(base, jobId, { mode = 'resume', force = false } = {}) {
    const r = await cloudFetch(`${base}/api/cloud/jobs/${encodeURIComponent(jobId)}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, force }),
    });
    if (!r.ok) throw await cloudHttpError(r, 'Could not restart the job');
    return r.json().catch(() => ({}));
  }

  /**
   * Starts the same job again as a new server job (the server no longer knows the old one, or the video it was cut from
   * is gone). With `resend` the source video is sent again from this browser first.
   */
  async _recreateJob(base, upload, { resend = false, onProgress = null } = {}) {
    const req = upload.cloudJobRequest;
    if (!req || !Array.isArray(req.candidates) || !req.candidates.length) {
      throw new Error('This upload cannot be resumed because its settings were not kept. Please upload the video again.');
    }
    let cloudUploadId = upload.cloudUploadId;
    if (resend) {
      const blob = upload.blobId ? await videoStore.getBlob(upload.blobId).catch(() => null) : null;
      if (!blob) throw new Error('The original video is no longer on the server or in this browser. Please upload it again.');
      cloudUploadId = await this._cloudUploadVideo(base, blob, (p) => { if (onProgress) onProgress({ phase: 'uploading', pct: p }); });
      await this._cloudGetDuration(base, cloudUploadId);
    }
    if (req.job && req.job.captions && req.job.captions.enabled && Array.isArray(upload.captionCues) && upload.captionCues.length) {
      await this._cloudSaveCaptions(base, cloudUploadId, upload.captionCues); // a new server copy of the video has none of the words yet
    }
    let bgmRef = null;
    if (req.bgmInput) bgmRef = await this._cloudRegisterBgm(base, req.bgmInput);
    let customOverlayId = null;
    if (upload.design && upload.design.id) customOverlayId = await this.registerDesignLayer(base, upload.design.id).catch(() => null);
    const jobId = await this._cloudStartJob(base, cloudUploadId, req.candidates, { ...req.job, bgm: bgmRef, customOverlayId, origin: 'recreate', requestId: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : undefined });
    await db.put(STORES.UPLOADS, { ...upload, cloudUploadId, cloudJobId: jobId, status: 'processing', error: null, updatedAt: new Date().toISOString() });
    return jobId;
  }

  /**
   * Runs a failed or stalled upload again, picking up where it stopped:
   *   - the server job still exists: the server continues it (clips already finished are kept, only the rest is rendered);
   *     `force` also takes over a job that is marked as running but is really stuck
   *   - the server lost the job: the same job is started again
   *   - the server lost the video too: it is sent again from this browser
   *   - it never got as far as a job: the whole upload runs again with its saved settings
   * Clips already in the library are not saved twice.
   */
  async retryUpload(uploadId, { force = false, onProgress = null } = {}) {
    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error('That upload is no longer in this browser.');
    const base = (await getBackendBaseUrl()) || '';
    if (!base) throw new Error("Couldn't reach the server. Please refresh the page and try again.");

    if (this.isWatching(uploadId)) { // this tab is already following the job: nudging the server is all that is left to do
      if (force && upload.cloudJobId) await this._cloudRetryJob(base, upload.cloudJobId, { force: true });
      return [];
    }

    if (!(upload.cloudUploadId && upload.cloudJobId)) {
      if (!upload.processOptions) throw new Error('This upload cannot be retried automatically. Please upload the video again.');
      const release = this._claim(uploadId);
      try { return await this.processUpload(uploadId, onProgress, { ...upload.processOptions }); }
      catch (e) { if (!(e && e.network)) await this.markUploadFailed(uploadId, e).catch(() => {}); throw e; }
      finally { release(); }
    }

    const releaseClaim = this._claim(uploadId); // nothing else starts following this upload while it is being picked up
    try {
    await db.put(STORES.UPLOADS, { ...upload, status: 'processing', error: null, updatedAt: new Date().toISOString() });
    let cur = await db.get(STORES.UPLOADS, uploadId);
    let jobId = cur.cloudJobId;
    try {
      await this._cloudRetryJob(base, jobId, { force });
    } catch (e) {
      if (e && e.status === 404) jobId = await this._recreateJob(base, cur, { onProgress });   // the server forgot the job
      else if (e && e.status === 409) { /* still working: just keep watching it */ }
      else throw e;
    }
    cur = await db.get(STORES.UPLOADS, uploadId);
    const params = cur.cloudJobParams || {};
    const watch = async (id) => {
      const existing = (await db.getAll(STORES.CLIPS)).filter((c) => c.uploadId === uploadId);
      return this._finishCloudJob(await db.get(STORES.UPLOADS, uploadId), base, id, {
        overlayFormat: params.overlayFormat || 'none', seriesStartPart: params.seriesStartPart || 1,
        aspectRatio: params.aspectRatio || 'original', targetDuration: params.targetDuration || 30,
        audioMix: params.audioMix || null, startIndex: existing.length, results: existing.slice(), onProgress,
      });
    };
    try {
      return await watch(jobId);
    } catch (e) {
      if (e && e.code === 'source-missing') {
        jobId = await this._recreateJob(base, await db.get(STORES.UPLOADS, uploadId), { resend: true, onProgress });
        return watch(jobId);
      }
      throw e;
    }
    } catch (e) {
      if (!(e && e.network)) await this.markUploadFailed(uploadId, e).catch(() => {}); // keeps the clearest reason, and stays retryable
      throw e;
    } finally { releaseClaim(); }
  }

  /**
   * Cloud rendering happens on the server independent of this browser tab, so closing the
   * tab, reloading the page, or the computer sleeping mid-job never loses the work — but
   * without this, the *frontend* would lose track of it, and finished clips would sit on the
   * server without ever reaching the person's library. Called once on app startup: finds any
   * upload left mid-processing from a previous session and resumes watching its job exactly
   * where it left off (skipping clips already saved before the interruption).
   * Returns a list of { upload, clips, error } — one entry per upload that was resumed.
   */
  async resumeInterruptedUploads(onProgress = null) {
    let uploads;
    try { uploads = await db.getAll(STORES.UPLOADS); } catch { return []; }
    const allStuck = (uploads || []).filter((u) => u.status === 'processing');
    if (!allStuck.length) return [];

    // A job was successfully started before the interruption — resumable.
    const stuck = allStuck.filter((u) => u.cloudUploadId && u.cloudJobId);
    // The interruption happened earlier (still uploading, or analyzing) — nothing server-side
    // to reconnect to. Rather than leave these stuck on "processing" forever with no way for
    // the person to know or retry, mark them failed once it's clearly not still in progress
    // (a generous 10-minute grace period in case this fires while a genuine upload is underway).
    const orphaned = allStuck.filter((u) => !(u.cloudUploadId && u.cloudJobId) && Date.now() - new Date(u.updatedAt || u.createdAt || 0).getTime() > 10 * 60 * 1000);
    for (const u of orphaned) {
      await db.put(STORES.UPLOADS, { ...u, status: 'failed', resumable: !!u.processOptions, error: 'Processing was interrupted before it could finish.', updatedAt: new Date().toISOString() }).catch(() => {});
    }

    const base = (await getBackendBaseUrl()) || '';
    const outcomes = [];
    for (const upload of stuck) {
      if (this.isWatching(upload.id)) continue; // something else already picked it up
      if (!base) { outcomes.push({ upload, error: new Error('offline') }); continue; }
      try {
        const existing = (await db.getAll(STORES.CLIPS)).filter((c) => c.uploadId === upload.id);
        const params = upload.cloudJobParams || {};
        const clips = await this._finishCloudJob(upload, base, upload.cloudJobId, {
          overlayFormat: params.overlayFormat || 'none',
          seriesStartPart: params.seriesStartPart || 1,
          aspectRatio: params.aspectRatio || 'original',
          targetDuration: params.targetDuration || 30,
          audioMix: params.audioMix || null,
          startIndex: existing.length,
          results: existing.slice(),
          onProgress,
        });
        outcomes.push({ upload, clips });
      } catch (e) {
        console.error('[ClipGenerator] Could not resume upload', upload.id, e);
        // The server was just unreachable: the job itself is fine, so leave it "processing" and
        // pick it up again on the next load instead of declaring it failed.
        if (e && e.network) { outcomes.push({ upload, error: new Error('offline') }); continue; }
        await db.put(STORES.UPLOADS, {
          ...upload, status: 'failed',
          error: `Processing stopped: ${String((e && e.message) || e).slice(0, 200)}`,
          resumable: true,
          updatedAt: new Date().toISOString(),
        }).catch(() => {});
        outcomes.push({ upload, error: e });
      }
    }
    return outcomes;
  }
}

ClipGenerator.prototype._getVideoDuration = function(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(v.duration); };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read video duration')); };
  });
};

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export const clipGenerator = new ClipGenerator();

// A clip whose file the browser has lost is downloaded again from the server on demand.
videoStore.setRecoverer(async (src) => {
  const base = (await getBackendBaseUrl()) || '';
  if (!base) throw new Error('no server to download from');
  return clipGenerator._downloadClipBlob({ base, jobId: src.jobId, index: src.index, size: src.size }, 'a saved clip');
});
