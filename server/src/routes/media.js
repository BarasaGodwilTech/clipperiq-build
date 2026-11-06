'use strict';
/** Audio/image proxies the frontend uses to sidestep CORS: /api/audio (BGM preview & mixing
 * source for the browser's Web Audio pipeline) and /api/proxy-image (TikTok avatar thumbnails). */
const express = require('express');
const { wrap } = require('../middleware/asyncRoute');
const { request } = require('../net');
const { HttpError } = require('../services/errors');

const ALLOWED_IMAGE_HOSTS = /(?:^|\.)tiktokcdn(?:-us)?\.com$/i;

function createMediaRouter({ ytdlp, logger }) {
  const router = express.Router();

  router.get('/audio', wrap(async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('No URL provided');
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      await ytdlp.streamBestAudio(url, res, { signal: controller.signal });
    } catch (e) {
      logger.warn(`audio proxy failed for ${url}: ${e.message}`);
      if (!res.headersSent) res.status(500).send('Error extracting audio stream');
    }
  }));

  router.get('/proxy-image', wrap(async (req, res) => {
    const raw = String(req.query.url || '');
    if (!raw) return res.status(400).send('Missing url');
    let u;
    try { u = new URL(raw); } catch { throw new HttpError(400, 'Invalid url'); }
    if (!ALLOWED_IMAGE_HOSTS.test(u.hostname || '')) throw new HttpError(403, 'Domain not allowed');
    const r = await request(u.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Referer: 'https://www.tiktok.com/',
      },
      timeoutMs: 20000,
    });
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(r.status).send(r.buffer);
  }));

  return router;
}

module.exports = { createMediaRouter };
