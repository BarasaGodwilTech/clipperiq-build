'use strict';
/**
 * Settings > Storage: shows where videos and clips are kept and lets the person move them to another drive.
 * Changing the place is only allowed from this computer, or when the server has a password (it deletes nothing,
 * but it decides where every future file goes).
 */
const express = require('express');
const fs = require('fs');
const { wrap } = require('../middleware/asyncRoute');
const { HttpError } = require('../services/errors');
const loc = require('../services/storageLocation');

function createStorageRouter({ config, cloud, logger }) {
  const router = express.Router();
  const json = express.json({ limit: '10kb' });
  let task = null; // the one running (or last finished) move
  let sizeCache = { at: 0, v: null };

  const isLoopback = (req) => /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(String(req.socket && req.socket.remoteAddress || ''));
  const mayChange = (req) => isLoopback(req) || !!config.auth.password;
  const guard = (req) => { if (!mayChange(req)) throw new HttpError(403, 'The storage folder can only be changed from the computer running ClipperIQ, or when this server has a password set.'); };

  async function sizes() {
    if (Date.now() - sizeCache.at < 30000 && sizeCache.v) return sizeCache.v;
    const v = await loc.dirSize(config.dirs.data);
    sizeCache = { at: Date.now(), v }; return v;
  }

  router.get('/', wrap(async (req, res) => {
    const space = await loc.freeSpace(config.dirs.data);
    const used = await sizes();
    res.json({
      dataDir: config.dirs.data, defaultDir: config.storage.defaultDir, chosenDir: config.storage.chosenDir,
      fallback: config.storage.fallback, freeBytes: space.free, totalBytes: space.total, usedBytes: used.bytes, usedFiles: used.files,
      canChange: mayChange(req), busy: cloud.isBusy(), supervised: process.env.CLIPPERIQ_SUPERVISED === '1',
      task: task && { state: task.state, done: task.done, total: task.total, error: task.error, target: task.target, restartRequired: task.state === 'done' },
    });
  }));

  router.post('/check', json, wrap(async (req, res) => {
    guard(req);
    const r = await loc.check(String(req.body && req.body.path || ''), config.dirs.data, { move: !!(req.body && req.body.move) });
    res.json(r);
  }));

  router.post('/apply', json, wrap(async (req, res) => {
    guard(req);
    if (task && task.state === 'running') throw new HttpError(409, 'A move is already in progress.');
    if (cloud.isBusy()) throw new HttpError(409, 'Videos are being processed right now. Wait for them to finish (or stop them) and try again.');
    const move = !!(req.body && req.body.move);
    const c = await loc.check(String(req.body && req.body.path || ''), config.dirs.data, { move });
    if (!c.ok) throw new HttpError(400, c.error);
    const target = c.path;
    task = { state: 'running', done: 0, total: 0, error: null, target, ac: new AbortController() };
    const t = task;
    (async () => {
      try {
        if (move) {
          const r = await loc.copyData(config.dirs.data, target, { signal: t.ac.signal, onProgress: (p) => { t.done = p.done; t.total = p.total; } });
          logger.info(`storage: copied ${r.files} files (${loc.fmt(r.bytes)}) to ${target}`);
        }
        loc.writeOverride(config.storage.configFile, target);
        t.state = 'done';
      } catch (e) {
        t.state = e && e.code === 'ABORT_ERR' ? 'cancelled' : 'failed';
        t.error = loc.friendlyFsError(e) === `That folder cannot be used (${e && e.message}).` ? String(e && e.message || e) : loc.friendlyFsError(e);
        logger.warn(`storage: change failed: ${e && e.message}`);
      }
    })();
    res.json({ started: true, move, target });
  }));

  router.post('/cancel', wrap(async (req, res) => {
    guard(req);
    if (task && task.state === 'running') task.ac.abort();
    res.json({ ok: true });
  }));

  router.post('/reset', wrap(async (req, res) => {
    guard(req);
    if (cloud.isBusy()) throw new HttpError(409, 'Videos are being processed right now. Try again when they are finished.');
    loc.clearOverride(config.storage.configFile);
    task = { state: 'done', done: 0, total: 0, error: null, target: config.storage.defaultDir };
    res.json({ ok: true });
  }));

  // The new folder is used after the server starts again. Under the desktop app that happens by itself.
  router.post('/restart', wrap(async (req, res) => {
    guard(req);
    if (process.env.CLIPPERIQ_SUPERVISED !== '1') return res.json({ restarted: false, manual: true });
    res.json({ restarted: true });
    setTimeout(() => process.exit(0), 400);
  }));

  return router;
}

module.exports = { createStorageRouter };
