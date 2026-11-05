'use strict';
/**
 * TikTok Content Posting API proxy.
 *
 * The frontend owns the OAuth tokens (stored in the browser) and calls these routes purely
 * to reach TikTok from a stable server IP with generous timeouts/retries — browsers can't set
 * a client_secret header safely, and TikTok's endpoints have occasionally timed out through
 * Node's built-in fetch, which is why this uses the hand-rolled HTTP client in net.js instead
 * (same fix the previous backend applied by switching off undici).
 */
const express = require('express');
const { wrap } = require('../middleware/asyncRoute');
const { request, form, withRetry } = require('../net');
const { HttpError } = require('../services/errors');

function createTikTokRouter({ config, logger }) {
  const router = express.Router();
  const json = express.json({ limit: '1mb' });
  const base = config.api.tiktok;

  const authHeader = (req) => {
    const h = req.header('authorization');
    if (!h) throw new HttpError(401, 'Missing Authorization');
    return h;
  };

  router.post('/init', json, wrap(async (req, res) => {
    const auth = authHeader(req);
    const r = await request(`${base}/v2/post/publish/video/init/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: auth },
      body: JSON.stringify(req.body || {}), timeoutMs: 30000,
    });
    res.status(r.status).json(r.json());
  }));

  router.post('/inbox/init', json, wrap(async (req, res) => {
    const auth = authHeader(req);
    const r = await request(`${base}/v2/post/publish/inbox/video/init/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: auth },
      body: JSON.stringify(req.body || {}), timeoutMs: 30000,
    });
    res.status(r.status).json(r.json());
  }));

  router.post('/token', json, wrap(async (req, res) => {
    const {
      grant_type, client_key, client_secret, code, redirect_uri, code_verifier, refresh_token,
    } = req.body || {};
    const key = client_key || config.credentials.tiktok_client_key;
    const secret = client_secret || config.credentials.tiktok_client_secret || '';
    if (!grant_type || !key) return res.status(400).json({ error: 'Missing grant_type or client_key' });
    const body = { grant_type, client_key: key, client_secret: secret };
    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !code_verifier) return res.status(400).json({ error: 'Missing parameters for authorization_code' });
      Object.assign(body, { code, redirect_uri, code_verifier });
    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
      body.refresh_token = refresh_token;
    }
    try {
      const r = await withRetry(() => request(`${base}/v2/oauth/token/`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body), timeoutMs: 30000,
      }), { attempts: 3, baseMs: 1500 });
      res.status(r.status).json(r.json());
    } catch (e) {
      logger.warn(`tiktok token exchange failed: ${e.message}`);
      const timeout = e.network || e.code === 'ETIMEDOUT';
      const detail = timeout
        ? 'Cannot reach TikTok API from this server (network timeout). Ensure the server has outbound internet access.'
        : (e.message || 'TikTok token exchange failed');
      res.status(502).json({ error: detail, error_description: detail });
    }
  }));

  router.post('/revoke', json, wrap(async (req, res) => {
    const { client_key, client_secret = '', token, token_type = 'access_token' } = req.body || {};
    const key = client_key || config.credentials.tiktok_client_key;
    if (!key || !token) return res.status(400).json({ error: 'Missing client_key or token' });
    const r = await request(`${base}/v2/oauth/revoke/`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_key: key, client_secret, token, token_type }), timeoutMs: 20000,
    });
    res.status(r.status).json(r.json());
  }));

  router.post('/status', json, wrap(async (req, res) => {
    const auth = authHeader(req);
    const r = await request(`${base}/v2/post/publish/status/fetch/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: auth },
      body: JSON.stringify(req.body || {}), timeoutMs: 30000,
    });
    res.status(r.status).json(r.json());
  }));

  router.get('/user', wrap(async (req, res) => {
    const auth = authHeader(req);
    const fields = req.query.fields || 'open_id,union_id,avatar_url,display_name,username,follower_count';
    const r = await withRetry(() => request(`${base}/v2/user/info/?fields=${encodeURIComponent(fields)}`, {
      headers: { Authorization: auth, 'User-Agent': 'ClipperIQ/2.0' }, timeoutMs: 30000,
    }), { attempts: 3, baseMs: 1500 });
    res.status(r.status).json(r.json());
  }));

  // Chunked video upload proxy. Buffered (chunks are a few MiB, per TikTok's own chunking
  // rules) so a PUT that a particular upload_url rejects can be retried as POST.
  const rawVideo = express.raw({ type: '*/*', limit: '100mb' });
  router.options('/upload', (req, res) => res.sendStatus(204));
  router.post('/upload', rawVideo, wrap(async (req, res) => {
    const uploadUrl = String(req.query.upload_url || '');
    if (!uploadUrl) throw new HttpError(400, 'Missing upload_url');
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Missing body');
    const contentRange = req.header('content-range') || '';
    const headers = { 'Content-Range': contentRange, 'Content-Type': 'video/mp4', 'Content-Length': String(req.body.length), Connection: 'keep-alive', Accept: '*/*' };
    const attempt = (method) => withRetry(() => request(uploadUrl, { method, headers, body: req.body, timeoutMs: 5 * 60 * 1000 }), { attempts: 3, baseMs: 1500 });

    let r;
    try {
      r = await attempt('PUT');
      if (!r.ok && [404, 405, 503].includes(r.status)) {
        logger.warn(`tiktok upload PUT failed (${r.status}); retrying as POST`);
        r = await attempt('POST').catch(() => r);
      }
    } catch (e) {
      logger.error(`tiktok upload proxy failed: ${e.message}`);
      return res.status(502).json({ error: 'TikTok upload failed' });
    }
    res.status(r.status).send(r.text);
  }));

  return router;
}

module.exports = { createTikTokRouter };
