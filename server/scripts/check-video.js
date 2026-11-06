#!/usr/bin/env node
'use strict';
/**
 * Prints what the server will think of a video file: header length, real (scanned) length,
 * and how many series parts that makes. Usage:  node scripts/check-video.js "C:\path\video.mp4" [partSeconds]
 * (or drag the video onto check-video.bat in the main folder).
 */
const { load } = require('../src/config');
const { createFfmpeg } = require('../src/media/ffmpeg');

const fmt = (t) => {
  const s = Math.round(t); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

(async () => {
  const file = process.argv[2];
  const part = Number(process.argv[3]) || 210; // 3:30
  if (!file) { console.log('Usage: node scripts/check-video.js "path\\to\\video.mp4" [partSeconds]'); process.exit(1); }
  const ff = createFfmpeg(load(), { info() {}, warn() {}, error() {}, debug() {} });
  console.log(`Reading ${file} ...`);
  const t0 = Date.now();
  const i = await ff.probe(file, { verify: true });
  console.log('');
  console.log(`  Picture: ${i.hasVideo ? `${i.width}x${i.height} ${i.videoCodec}` : 'NONE'}   Audio: ${i.hasAudio ? i.audioCodec : 'none'}`);
  console.log(`  Length the file header claims : ${fmt(i.headerDuration)}  (${i.headerDuration.toFixed(1)}s)`);
  console.log(`  Real length found by scanning : ${fmt(i.measuredDuration)}  (${i.measuredDuration.toFixed(1)}s)   [picture ${fmt(i.videoSpan)}, audio ${fmt(i.audioSpan)}]`);
  console.log(`  Length the server will use    : ${fmt(i.duration)}  (${i.duration.toFixed(1)}s)`);
  console.log(`  Series parts of ${fmt(part)}        : ${Math.ceil(i.duration / part)}`);
  if (i.warning) console.log(`\n  WARNING: ${i.warning}`);
  console.log(`\n  (scan took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
})().catch((e) => { console.error('Could not read that file:', e.message); process.exit(1); });
