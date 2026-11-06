'use strict';
/**
 * YouTube resumable-upload proxy. Like TikTok, the OAuth token lives in the browser; this
 * route just starts the resumable session server-side (so redirects/headers behave) and
 * relays each chunk PUT to Google, forwarding the Range header back for 308 "keep going"
 * responses.
 */
const express = require('express');
const crypto = require('crypto');
const { wrap } = require('../middleware/asyncRoute');
const { request } = require('../net');
const { HttpError } = require('../services/errors');

const PRIVACY_MAP = { PUBLIC_TO_EVERYONE: 'public', MUTUAL_FOLLOW_FRIENDS: 'unlisted', SELF_ONLY: 'private', public: 'public', private: 'private', unlisted: 'unlisted' };
const SESSION_TTL_MS = 30 * 60 * 1000;

function createYouTubeRouter({ config }) {
  const router = express.Router();
  const json = express.json({ limit: '1mb' });
  const sessions = new Map(); // sid -> { uploadUrl, expires }

  setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) if (s.expires < now) sessions.delete(sid);
  }, 5 * 60 * 1000).unref?.();

  router.post('/init', json, wrap(async (req, res) => {
    const auth = req.header('authorization');
    if (!auth) throw new HttpError(401, 'Missing Authorization');
    const meta = req.body || {};
    const privacyStatus = PRIVACY_MAP[meta.privacy] || 'public';
    const payload = {
      snippet: { title: meta.title || 'Short', description: meta.description || '', tags: meta.tags || [], categoryId: meta.categoryId || '22' },
      status: { privacyStatus, selfDeclaredMadeForKids: false },
    };
    const headers = {
      Authorization: auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4',
    };
    if (meta.size) headers['X-Upload-Content-Length'] = String(meta.size);
    const r = await request(`${config.api.google}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST', headers, body: JSON.stringify(payload), timeoutMs: 45000,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.json()?.error?.message || 'YouTube init failed' });
    const uploadUrl = r.headers.location;
    if (!uploadUrl) return res.status(502).json({ error: 'YouTube did not return an upload URL' });
    const sid = crypto.randomBytes(16).toString('hex');
    sessions.set(sid, { uploadUrl, expires: Date.now() + SESSION_TTL_MS });
    res.json({ sid });
  }));

  const rawVideo = express.raw({ type: 'video/*', limit: '1000mb' });
  router.put('/upload', rawVideo, wrap(async (req, res) => {
    const sid = String(req.query.sid || '');
    const session = sessions.get(sid);
    if (!sid || !session) throw new HttpError(400, 'Invalid or expired session');
    const r = await request(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': req.header('content-range') || '', 'Content-Type': req.header('content-type') || 'video/mp4' },
      body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      timeoutMs: 5 * 60 * 1000,
    });
    if (r.headers.range) res.setHeader('Range', r.headers.range);
    if (r.status === 200 || r.status === 201) sessions.delete(sid);
    const ct = r.headers['content-type'] || '';
    if (ct.includes('application/json')) { try { return res.status(r.status).json(JSON.parse(r.text)); } catch { /* fall through */ } }
    res.status(r.status).send(r.text);
  }));

  return router;
}

module.exports = { createYouTubeRouter };
