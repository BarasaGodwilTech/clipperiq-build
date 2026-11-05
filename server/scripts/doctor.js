#!/usr/bin/env node
'use strict';
/**
 * Environment sanity check — run standalone with `npm run doctor`, or automatically from
 * start.bat before every launch. Exits non-zero (and prints a plain-English fix) on anything
 * that would stop the server from actually working.
 */
const net = require('net');
const os = require('os');
const path = require('path');
const { load } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createFfmpeg } = require('../src/media/ffmpeg');
const { createYtDlp } = require('../src/media/ytdlp');

const CHECK = '\u2714';
const CROSS = '\u2716';
const WARN = '!';

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function main() {
  const config = load();
  const logger = createLogger({ level: 'error' }); // quiet; doctor prints its own lines
  let failures = 0;
  const ok = (msg) => console.log(`  ${CHECK} ${msg}`);
  const bad = (msg) => { console.log(`  ${CROSS} ${msg}`); failures++; };
  const warn = (msg) => console.log(`  ${WARN} ${msg}`);

  console.log('ClipperIQ Studio \u2014 environment check\n');

  const [maj] = process.versions.node.split('.').map(Number);
  if (maj >= 18) ok(`Node.js ${process.version}`); else bad(`Node.js ${process.version} is too old \u2014 install Node 18 or newer from https://nodejs.org`);

  const ff = createFfmpeg(config, logger);
  const caps = await ff.detectCapabilities();
  if (caps.ok) ok(`ffmpeg ${caps.version} (${ff.bins.ffmpegSource}) \u2014 H.264 + AAC ready`);
  else bad(`ffmpeg not usable (${caps.reason || 'not found'}) \u2014 run "npm install" in the server folder, or set FFMPEG_PATH in .env`);
  if (ff.bins.ffprobe) ok(`ffprobe (${ff.bins.ffprobeSource})`); else bad('ffprobe not found \u2014 run "npm install" in the server folder, or set FFPROBE_PATH in .env');
  let hasCanvas = false;
  try { require('@napi-rs/canvas'); hasCanvas = true; ok('@napi-rs/canvas \u2014 crisp gradient overlays enabled'); }
  catch { warn('@napi-rs/canvas not installed \u2014 overlays will fall back to plain text (still works)'); }

  if (caps.ok && !caps.filters.drawtext) {
    if (hasCanvas) ok('ffmpeg build has no "drawtext" filter, but @napi-rs/canvas covers overlays instead');
    else bad('ffmpeg build has no "drawtext" filter and @napi-rs/canvas is unavailable \u2014 part-number overlays will not render');
  }
  for (const f of ['loudnorm', 'sidechaincompress', 'amix']) {
    if (caps.ok && !caps.filters[f]) warn(`ffmpeg build is missing the "${f}" filter \u2014 some audio features will use a simpler fallback`);
  }

  const yt = createYtDlp(config, logger);
  const ytStatus = await yt.status();
  if (ytStatus.available) ok('yt-dlp available (background-music links, /api/audio)');
  else warn(`yt-dlp not found \u2014 it will be downloaded automatically on first use (set YTDLP_AUTO_DOWNLOAD=false to disable)`);

  try {
    await require('fs').promises.mkdir(config.dirs.data, { recursive: true });
    const st = await require('fs').promises.statfs(config.dirs.data);
    const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1024 ** 3;
    if (freeGb > 5) ok(`${freeGb.toFixed(1)} GB free on disk`);
    else warn(`${freeGb.toFixed(1)} GB free on disk \u2014 video processing needs headroom for uploads + rendered clips`);
  } catch { warn('Could not check free disk space on this platform'); }

  const free = await portFree(config.port, config.host);
  if (free) ok(`Port ${config.port} is free`);
  else warn(`Port ${config.port} is already in use \u2014 another instance may already be running, or set PORT in .env`);

  if (!config.auth.password) warn('AUTH_PASSWORD is not set \u2014 fine for local use; set it before exposing this server on the internet (VPS)');
  else ok('HTTP Basic Auth is enabled');

  console.log('');
  if (failures) {
    console.log(`${failures} problem(s) found \u2014 fix the items marked ${CROSS} above before starting.`);
    process.exitCode = 1;
  } else {
    console.log('Everything looks good \u2014 ready to start.');
  }
}

main().catch((e) => { console.error('Doctor script crashed:', e); process.exitCode = 1; });
