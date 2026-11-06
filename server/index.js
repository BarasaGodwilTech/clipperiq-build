'use strict';
/**
 * ClipperIQ Studio backend.
 *
 * Serves the PWA frontend (the folder above this one) and everything it needs from a server:
 *   /api/cloud/*      video upload, highlight analysis and ffmpeg rendering (see src/routes/cloud.js)
 *   /api/tiktok/*     TikTok Content Posting API proxy
 *   /api/youtube/*    YouTube resumable-upload proxy
 *   /upload/*         Instagram Reels publish-URL helper
 *   /api/audio,
 *   /api/proxy-image  CORS proxies for background music & avatar images
 *
 * Start with `npm start` (or start.bat on Windows), or `npm run doctor` to check the
 * environment (ffmpeg, disk space, port) before launching.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

const { load } = require('./src/config');
const { createLogger } = require('./src/logger');
const { Store } = require('./src/db');
const { createFfmpeg } = require('./src/media/ffmpeg');
const { createRenderer } = require('./src/media/renderer');
const { createYtDlp } = require('./src/media/ytdlp');
const { createBgmStore } = require('./src/services/bgmStore');
const { createOverlayStore } = require('./src/services/overlayStore');
const { createCloudStore } = require('./src/services/cloudStore');
const { createTranscriber } = require('./src/media/transcriber');
const { createBasicAuth } = require('./src/middleware/basicAuth');
const { notFoundHandler, createErrorHandler } = require('./src/middleware/errorHandler');
const { createCloudRouter } = require('./src/routes/cloud');
const { createTikTokRouter } = require('./src/routes/tiktok');
const { createYouTubeRouter } = require('./src/routes/youtube');
const { createInstagramUploadRouter } = require('./src/routes/instagramUpload');
const { createMediaRouter } = require('./src/routes/media');
const { createConfigRouter } = require('./src/routes/config');
const { createStorageRouter } = require('./src/routes/storage');
const { createStateRouter } = require('./src/routes/state');
const { createStateStore } = require('./src/services/stateStore');

async function main() {
  const config = load();
  for (const dir of Object.values(config.dirs)) fs.mkdirSync(dir, { recursive: true });

  const logger = createLogger({ level: config.logLevel, file: path.join(config.dirs.logs, 'server.log') });
  logger.info(`ClipperIQ Studio server starting (${config.env}) \u2014 pid ${process.pid}`);

  const db = new Store(config.dbFile, { logger });
  const ff = createFfmpeg(config, logger);
  const caps = await ff.detectCapabilities();
  if (caps.ok) logger.info(`ffmpeg ${caps.version} ready (${ff.bins.ffmpegSource})`);
  else logger.error(`ffmpeg is not usable: ${caps.reason || 'not found'}. Run "npm install" in the server folder, or set FFMPEG_PATH in .env. Run "npm run doctor" for details.`);

  const renderer = createRenderer({ ff, config, logger });
  const ytdlp = createYtDlp(config, logger);
  const bgmStore = createBgmStore({ db, config, ff, ytdlp, logger });
  const overlayStore = createOverlayStore({ db, config, logger });
  const transcriber = createTranscriber({ ff, config, logger });
  const cloud = createCloudStore({ db, config, logger, ff, renderer, bgmStore, overlayStore, transcriber });
  const stateStore = createStateStore({ config, logger });
  cloud.recover();

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Permissive CORS by default so the frontend works whether it's opened from this same
  // server, a file:// page during development, or a different host — narrow this with
  // ALLOWED_ORIGINS in .env once you have a fixed production domain.
  app.use((req, res, next) => {
    const origin = req.header('origin');
    const allowed = config.allowedOrigins;
    res.setHeader('Access-Control-Allow-Origin', (!allowed.length || (origin && allowed.includes(origin))) ? (origin || '*') : allowed[0]);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    const reqHeaders = req.header('access-control-request-headers');
    res.setHeader('Access-Control-Allow-Headers', reqHeaders || 'Content-Type, Authorization, Content-Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Range');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(createBasicAuth(config));

  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.use('/api/cloud', createCloudRouter({ cloud, ff, config, bgmStore, overlayStore }));
  app.use('/api/tiktok', createTikTokRouter({ config, logger }));
  app.use('/api/youtube', createYouTubeRouter({ config }));
  app.use('/upload', createInstagramUploadRouter({ config }));
  app.use('/api', createMediaRouter({ ytdlp, logger }));
  app.use('/api/config', createConfigRouter({ config }));
  app.use('/api/storage', createStorageRouter({ config, cloud, logger }));
  app.use('/api/state', createStateRouter({ stateStore }));

  // Rendered clips and Instagram-publish files.
  app.use('/uploads', express.static(path.join(config.dirs.data, 'uploads'), {
    maxAge: '1y', immutable: true, setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
  }));

  // Fonts the browser needs to draw lower thirds exactly as the server renders them.
  app.use('/assets/fonts', express.static(path.join(__dirname, 'assets', 'fonts'), {
    maxAge: '30d', setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
  }));

  // The PWA is served straight from the project folder, which also contains the server's own code,
  // database, logs and uploaded videos. None of that may ever be downloadable.
  app.use((req, res, next) => {
    const p = decodeURIComponent(req.path || '/').toLowerCase();
    if (/^\/(server|data|node_modules)(\/|$)/.test(p) || /(^|\/)\.[^/]/.test(p)) return res.status(404).send('Not found');
    next();
  });

  // The PWA itself (index.html, js/, css/, admin/, …) — same origin as the API, so no CORS
  // configuration is ever required for local or VPS use.
  app.use(express.static(config.rootDir, { extensions: ['html'], setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin') }));
  app.get(/^\/(?!api\/|uploads\/|upload\/|healthz).*/, (req, res, next) => {
    if (req.method !== 'GET' || path.extname(req.path)) return next();
    res.sendFile(path.join(config.rootDir, 'index.html'), (err) => { if (err) next(); });
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  const server = app.listen(config.port, config.host, () => {
    const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
    logger.info(`Listening on ${url}`);
    console.log('');
    console.log('  ClipperIQ Studio is running');
    console.log(`  ${url}`);
    console.log('');
    if (!caps.ok) console.log(`  \u26a0  ffmpeg problem detected \u2014 run "npm run doctor" for details\n`);
  });
  server.requestTimeout = 0; // large uploads / long renders must not be killed by a request timeout
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 61000;

  const cleanupTimer = setInterval(() => cloud.cleanup().catch((e) => logger.warn(`cleanup failed: ${e.message}`)), 60 * 60 * 1000);
  cleanupTimer.unref();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down\u2026`);
    clearInterval(cleanupTimer);
    server.close(() => logger.info('HTTP server closed'));
    db.close();
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => logger.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));
}

main().catch((e) => { console.error('Fatal startup error:', e); process.exit(1); });
