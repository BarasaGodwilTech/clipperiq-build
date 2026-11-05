'use strict';
/**
 * Highlight detection — a server-side port of the original in-browser analysis
 * (AudioAnalyzer + SceneDetector + ClipGenerator scoring), now driven by ffmpeg so it runs on
 * the original file at native speed instead of seeking a <video> element.
 *
 *   audio : RMS per 1 s window, smoothed (+/-3 windows), peaks where value >= 0.6 * max
 *   scene : frame every 0.5 s at 160x90, mean |RGB diff|; change when diff > 18/255
 *   score : audio*0.40 + scene*0.30 + position*0.20 + duration*0.10
 */

const SAMPLE_RATE = 8000;
const AUDIO_WINDOW_SEC = 1;
const SMOOTHING = 3;
const PEAK_THRESHOLD = 0.6;
const SCENE_FPS = 2;
const SCENE_W = 160;
const SCENE_H = 90;
const DIFF_THRESHOLD = 18;

async function analyzeAudio(ff, file, { signal, seek = [] } = {}) {
  const windowSamples = SAMPLE_RATE * AUDIO_WINDOW_SEC;
  const rms = [];
  let sumSq = 0;
  let inWindow = 0;
  let leftover = null;

  const onData = (chunk) => {
    let buf = chunk;
    if (leftover) { buf = Buffer.concat([leftover, chunk]); leftover = null; }
    const usable = buf.length - (buf.length % 2);
    if (usable !== buf.length) leftover = buf.subarray(usable);
    for (let i = 0; i < usable; i += 2) {
      const s = buf.readInt16LE(i) / 32768;
      sumSq += s * s;
      if (++inWindow === windowSamples) {
        rms.push(Math.sqrt(sumSq / windowSamples));
        sumSq = 0; inWindow = 0;
      }
    }
  };

  try {
    await ff.streamFfmpeg([
      ...seek, '-i', file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-',
    ], { signal, onData });
  } catch (e) {
    if (e.code === 'ABORT_ERR') throw e;
    return { peaks: [], rmsValues: [], hasAudio: false }; // no audio track / undecodable audio
  }

  const n = rms.length;
  const smoothed = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0; let count = 0;
    for (let j = Math.max(0, i - SMOOTHING); j <= Math.min(n - 1, i + SMOOTHING); j++) { sum += rms[j]; count++; }
    smoothed[i] = sum / count;
  }
  let maxRMS = 0;
  for (const v of smoothed) if (v > maxRMS) maxRMS = v;
  const threshold = PEAK_THRESHOLD * maxRMS;
  const peaks = [];
  let inPeak = false;
  for (let w = 0; w < n; w++) {
    if (maxRMS > 0 && smoothed[w] >= threshold) {
      if (!inPeak) { peaks.push({ timestamp: w * AUDIO_WINDOW_SEC, rms: smoothed[w], normalizedScore: smoothed[w] / maxRMS }); inPeak = true; }
    } else inPeak = false;
  }
  return { peaks, rmsValues: smoothed, hasAudio: true };
}

async function analyzeScenes(ff, file, { duration, signal, onProgress, seek = [] } = {}) {
  const frameBytes = SCENE_W * SCENE_H * 3;
  const changes = [];
  let prev = null;
  let index = 0;
  let pending = Buffer.alloc(0);
  const expected = Math.max(1, Math.floor(duration * SCENE_FPS));

  const onData = (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      if (prev) {
        let total = 0;
        for (let i = 0; i < frameBytes; i += 3) {
          total += (Math.abs(frame[i] - prev[i]) + Math.abs(frame[i + 1] - prev[i + 1]) + Math.abs(frame[i + 2] - prev[i + 2])) / 3;
        }
        const diff = total / (frameBytes / 3);
        if (diff > DIFF_THRESHOLD) {
          changes.push({ timestamp: index / SCENE_FPS, diff, normalizedDiff: Math.min(diff / 100, 1) });
        }
      }
      prev = Buffer.from(frame); // copy: `frame` is a view into a buffer that gets recycled
      pending = pending.subarray(frameBytes);
      index++;
      if (onProgress && index % 120 === 0) onProgress(Math.min(1, index / expected));
    }
  };

  try {
    await ff.streamFfmpeg([
      ...seek, '-i', file, '-an', '-map', '0:v:0',
      '-vf', `fps=${SCENE_FPS},scale=${SCENE_W}:${SCENE_H}:flags=fast_bilinear,format=rgb24`,
      '-f', 'rawvideo', '-',
    ], { signal, onData });
  } catch (e) {
    if (e.code === 'ABORT_ERR') throw e;
    return { sceneChanges: [], frames: index };
  }
  if (onProgress) onProgress(1);
  return { sceneChanges: changes, frames: index };
}

/**
 * Build & score candidate windows of exactly `clipDuration` seconds.
 * Improvements over the browser version: windows near the end are clamped instead of dropped,
 * every clip honours the requested duration, and selected clips don't heavily overlap.
 */
function buildCandidates({ duration, audio, scene, clipDuration, maxClips }) {
  const dur = Math.max(1, Math.min(clipDuration, duration));
  if (duration <= 0) return [];
  const cands = new Map();
  const add = (rawStart, source) => {
    let start = Math.max(0, rawStart);
    if (start + dur > duration) start = Math.max(0, duration - dur);
    const key = Math.round(start * 2) / 2;
    if (!cands.has(key)) cands.set(key, { start: key, duration: dur, sources: new Set() });
    cands.get(key).sources.add(source);
  };

  for (const p of audio.peaks) add(p.timestamp - dur * 0.25, 'audio');
  for (const s of scene.sceneChanges) add(s.timestamp - 1.5, 'scene');
  const step = Math.max(30, duration / (Math.max(1, maxClips) * 2));
  for (let t = 0; t + dur <= duration + 1e-6; t += step) add(t, 'uniform');
  if (!cands.size) add(0, 'uniform');

  const scored = Array.from(cands.values()).map((c) => {
    let audioScore = 0;
    let sceneScore = 0;
    for (const p of audio.peaks) {
      if (p.timestamp >= c.start && p.timestamp <= c.start + c.duration) audioScore = Math.max(audioScore, p.normalizedScore);
    }
    for (const s of scene.sceneChanges) {
      if (s.timestamp >= c.start && s.timestamp <= c.start + c.duration) sceneScore = Math.min(sceneScore + s.normalizedDiff * 0.3, 1);
    }
    const posScore = 1 - Math.abs((c.start + c.duration / 2) / duration - 0.5) * 0.3;
    const durationScore = 1;
    const totalScore = Math.round((audioScore * 0.4 + sceneScore * 0.3 + posScore * 0.2 + durationScore * 0.1) * 100);
    return { start: c.start, duration: c.duration, audioScore, sceneScore, posScore, totalScore, sources: Array.from(c.sources) };
  });
  scored.sort((a, b) => b.totalScore - a.totalScore || a.start - b.start);

  const picked = [];
  const allowedOverlap = dur * 0.25;
  for (const c of scored) {
    const clash = picked.some((p) => Math.min(p.start + p.duration, c.start + c.duration) - Math.max(p.start, c.start) > allowedOverlap);
    if (!clash) picked.push(c);
    if (picked.length >= maxClips) break;
  }
  return picked;
}

async function analyze(ff, file, { duration, clipDuration, maxClips, signal, onProgress, rangeStart = 0, rangeEnd = 0 }) {
  onProgress?.(0);
  // Optional window: only look for highlights between rangeStart and rangeEnd. With no window (the
  // default) nothing changes. Timestamps inside the window are relative to its start and are shifted
  // back onto the real timeline below.
  const winStart = Math.max(0, Math.min(Number(rangeStart) || 0, Math.max(0, duration - 1)));
  const winEnd = Number(rangeEnd) > winStart + 1 ? Math.min(Number(rangeEnd), duration) : duration;
  const windowed = winStart > 0.01 || winEnd < duration - 0.5;
  const seek = windowed ? ['-ss', String(winStart), '-t', String(winEnd - winStart)] : [];
  const span = windowed ? winEnd - winStart : duration;
  const [audio, scene] = await Promise.all([
    analyzeAudio(ff, file, { signal, seek }),
    analyzeScenes(ff, file, { duration: span, signal, seek, onProgress: (p) => onProgress?.(p * 0.95) }),
  ]);
  const candidates = buildCandidates({ duration: span, audio, scene, clipDuration, maxClips });
  if (windowed) for (const c of candidates) c.start += winStart;
  onProgress?.(1);
  return { candidates, audioPeaks: audio.peaks.length, sceneChanges: scene.sceneChanges.length, hasAudio: audio.hasAudio };
}

module.exports = { analyze, analyzeAudio, analyzeScenes, buildCandidates };
