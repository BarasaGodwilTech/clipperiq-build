'use strict';
const express = require('express');
const { wrap } = require('../middleware/asyncRoute');
const { HttpError } = require('../services/errors');

/**
 * proto/host the browser used to reach us, so job clip URLs are always fetchable by that same
 * browser. This deliberately wins over PUBLIC_BASE_URL: a stale tunnel/ngrok address left in
 * .env must never make the app try to download its own clips from somewhere else. (The
 * setting is still used where an external service needs a public address, e.g. Instagram.)
 */
function externalBaseUrl(req, config) {
  const proto = String(req.header('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.header('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return config.publicBaseUrl || '';
}

function createCloudRouter({ cloud, ff, config, bgmStore, overlayStore }) {
  const router = express.Router();
  const json = express.json({ limit: '2mb' });
  const rawAudio = express.raw({ type: '*/*', limit: '100mb' });

  router.get('/health', wrap(async (req, res) => {
    const caps = ff.caps || await ff.detectCapabilities();
    if (!caps.ok) return res.status(503).json({ ok: false, error: caps.reason || 'ffmpeg not available' });
    res.json({ ok: true, ffmpeg: caps.version, encoders: caps.encoders, canvas: !!ff.caps });
  }));

  router.post('/upload/init', json, wrap(async (req, res) => {
    const uploadId = await cloud.initUpload(req.body || {});
    res.json({ uploadId });
  }));

  // Is this exact video already here? { fingerprint, size } -> { found, uploadId, duration }
  router.post('/upload/find', json, wrap(async (req, res) => { res.json(await cloud.findUpload(req.body || {})); }));

  // No body parser here: the request stream is written straight to disk at its byte offset.
  router.put('/upload', wrap(async (req, res) => {
    const uploadId = String(req.query.uploadId || '');
    if (!uploadId) throw new HttpError(400, 'Invalid uploadId');
    const result = await cloud.writeChunk(uploadId, req);
    res.json(result);
  }));

  router.post('/info', json, wrap(async (req, res) => {
    const u = await cloud.ensureReady(req.body?.uploadId);
    res.json({
      duration: u.duration, headerDuration: u.headerDuration || 0, measuredDuration: u.measuredDuration || 0,
      warning: u.warning || '', sizeMB: Math.round(u.size / 1048576),
    });
  }));

  router.post('/analyze', json, wrap(async (req, res) => {
    const { uploadId, maxClips, targetDuration, rangeStart, rangeEnd } = req.body || {};
    // if the browser goes away (the person pressed Cancel) the analysis stops instead of running on for nobody
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const result = await cloud.analyze(uploadId, { maxClips, targetDuration, rangeStart, rangeEnd }, { signal: ac.signal });
    res.json(result);
  }));

  // Finding the best moments as a background task: start, check progress, stop. (POST /analyze above still works for
  // older versions of the app.)
  router.post('/analyze/start', json, wrap(async (req, res) => {
    const { uploadId, maxClips, targetDuration, rangeStart, rangeEnd } = req.body || {};
    res.json(cloud.startAnalysis(uploadId, { maxClips, targetDuration, rangeStart, rangeEnd }));
  }));
  router.get('/analyze/:taskId', wrap(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(cloud.getAnalysis(req.params.taskId)); }));
  router.delete('/analyze/:taskId', wrap(async (req, res) => { res.json(cloud.cancelAnalysis(req.params.taskId)); }));

  // A still picture at a given time, for choosing where clips should start. POST with a neutral
  // response type so download managers leave it alone.
  router.post('/frame', json, wrap(async (req, res) => {
    const { uploadId, t, width } = req.body || {};
    const jpg = await cloud.frame(uploadId, t, width);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(jpg);
  }));

  // The person's own text / sticker / image layer, drawn by the browser into one transparent PNG.
  router.post('/overlay/upload', express.raw({ type: '*/*', limit: '26mb' }), wrap(async (req, res) => {
    if (!overlayStore) throw new HttpError(400, 'Custom overlays are not available on this server');
    res.json(await overlayStore.fromUpload(req.body));
  }));

  router.post('/jobs', json, wrap(async (req, res) => {
    const baseUrl = externalBaseUrl(req, config);
    const jobId = cloud.createJob(req.body || {}, baseUrl);
    res.json({ jobId });
  }));

  router.get('/jobs/:jobId', wrap(async (req, res) => {
    res.json(cloud.getJob(req.params.jobId));
  }));

  // ── auto captions ─────────────────────────────────────────────────────────────────────
  const bigJson = express.json({ limit: '8mb' }); // a long video has a lot of words
  router.get('/captions/engine', wrap(async (req, res) => { res.json(await cloud.captionEngine()); }));
  router.get('/caption-tasks/:taskId', wrap(async (req, res) => { res.json(cloud.getTranscription(req.params.taskId)); }));
  router.delete('/caption-tasks/:taskId', wrap(async (req, res) => { res.json(cloud.cancelTranscription(req.params.taskId)); }));
  router.get('/captions/:uploadId', wrap(async (req, res) => { res.json(await cloud.readCaptions(req.params.uploadId)); }));
  router.put('/captions/:uploadId', bigJson, wrap(async (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.cues)) throw new HttpError(400, 'cues must be a list');
    res.json(await cloud.saveCaptions(req.params.uploadId, { cues: b.cues, language: b.language }));
  }));
  router.post('/captions/:uploadId/transcribe', json, wrap(async (req, res) => {
    const b = req.body || {};
    res.json(await cloud.startTranscription(req.params.uploadId, { language: b.language, rangeStart: b.rangeStart, rangeEnd: b.rangeEnd }));
  }));

  // Stop a job (the finished clips are kept; it can be resumed later) / throw away an upload that was never completed.
  router.post('/jobs/:jobId/cancel', json, wrap(async (req, res) => { res.json(await cloud.cancelJob(req.params.jobId)); }));
  router.delete('/upload/:uploadId', wrap(async (req, res) => { res.json(await cloud.discardUpload(req.params.uploadId)); }));

  // Start a failed / interrupted job again. { mode: 'resume' (default: keep the finished clips) | 'restart' (render it all
  // again), force: true to take over a job that is marked as running but is really stuck }.
  router.post('/jobs/:jobId/retry', json, wrap(async (req, res) => {
    const body = req.body || {};
    const mode = body.mode === 'restart' ? 'restart' : 'resume';
    res.json(await cloud.retryJob(req.params.jobId, { mode, force: body.force === true }));
  }));

  // Clip bytes, a range at a time. Deliberately NOT a GET for a *.mp4 URL: download managers
  // (IDM etc.) intercept those and stall the app. A POST with a neutral content type and no file
  // extension is left alone.
  router.post('/clip-chunk', json, wrap(async (req, res) => {
    const { jobId, index, offset, length } = req.body || {};
    const { data } = await cloud.readClipChunk(jobId, index, offset, length);
    res.set({
      'Content-Type': 'application/x-clipperiq-chunk',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(data);
  }));

  // Background music: register a track once, reference it by id from any job (including
  // re-rendering a single existing clip with new music).
  router.post('/bgm/upload', rawAudio, wrap(async (req, res) => {
    const result = await bgmStore.fromUpload(req.body, String(req.query.filename || ''));
    res.json(result);
  }));

  router.post('/bgm/from-url', json, wrap(async (req, res) => {
    const result = await bgmStore.fromUrl(req.body?.url);
    res.json(result);
  }));

  return router;
}

module.exports = { createCloudRouter, externalBaseUrl };
