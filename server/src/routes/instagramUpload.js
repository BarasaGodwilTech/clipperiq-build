'use strict';
/**
 * Publishes a rendered clip to a fetchable https URL so Instagram's Graph API can pull it
 * when creating a Reels container (Instagram fetches the video itself; it never accepts
 * a direct upload).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { wrap } = require('../middleware/asyncRoute');
const { HttpError } = require('../services/errors');

function createInstagramUploadRouter({ config }) {
  const router = express.Router();
  const dir = path.join(config.dirs.data, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const rawVideo = express.raw({ type: 'video/*', limit: '200mb' });

  router.post('/instagram-video', rawVideo, wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'No video data provided');
    const hint = String(req.query.filename || '');
    const safeName = /^[\w.-]+$/.test(hint) ? hint : `ig-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`;
    const filePath = path.join(dir, safeName);
    await fs.promises.writeFile(filePath, req.body);
    const proto = String(config.publicBaseUrl ? '' : (req.header('x-forwarded-proto') || req.protocol)).split(',')[0].trim();
    const host = String(req.header('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const base = config.publicBaseUrl || `${proto}://${host}`;
    res.json({ url: `${base}/uploads/${encodeURIComponent(path.basename(filePath))}` });
  }));

  return router;
}

module.exports = { createInstagramUploadRouter };
