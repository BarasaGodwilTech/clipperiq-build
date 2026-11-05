'use strict';
/**
 * Where does the time go? Times each stage of making clips from one of YOUR videos, on THIS computer, with the real code:
 *
 *     cd server
 *     node scripts/benchmark.js "C:\path\to\your-video.mp4"
 *
 * It checks the video, scans it (what "highlights" mode does), and makes a 20-second clip in each speed profile (and by copying,
 * where that is possible). Nothing is kept. Send the output along if something is slower than you expect.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const { load } = require(path.join(ROOT, 'src', 'config'));
const { createFfmpeg } = require(path.join(ROOT, 'src', 'media', 'ffmpeg.js'));
const { createRenderer } = require(path.join(ROOT, 'src', 'media', 'renderer.js'));
const analyzer = require(path.join(ROOT, 'src', 'media', 'analyzer.js'));

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('Usage: node scripts/benchmark.js "<path to a video file>"'); process.exit(1); }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipperiq-bench-'));
const config = load({ ...process.env, DATA_DIR: dataDir }); config.rootDir = path.resolve(ROOT, '..');
fs.mkdirSync(config.dirs.tmp, { recursive: true });
const time = async (label, fn) => { const a = process.hrtime.bigint(); const r = await fn(); const s = Number(process.hrtime.bigint() - a) / 1e9; console.log(`${label.padEnd(52)} ${s.toFixed(1).padStart(8)} s`); return { r, s }; };

(async () => {
  const ff = createFfmpeg(config, null); await ff.detectCapabilities();
  const renderer = createRenderer({ ff, config, logger: null });
  const probe = (await time('1. read the video (quick look)', () => ff.probe(file))).r;
  const total = probe.duration || 0;
  console.log(`   ${path.basename(file)}: ${(fs.statSync(file).size / 1e6).toFixed(0)} MB, ${Math.round(total)} s, ${probe.width}x${probe.height}, ${os.cpus().length} CPU cores, encoder: ${config.ffmpeg.videoEncoder || 'libx264'}`);
  await time('2. check every packet of the file (upload check)', () => ff.probe(file, { verify: true }));
  const slice = Math.min(120, Math.max(30, total));
  const sc = await time(`3. scan ${Math.round(slice)} s for highlights (audio + scenes)`, () => analyzer.analyze(ff, file, { duration: slice, clipDuration: 20, maxClips: 3, rangeStart: 0, rangeEnd: slice }));
  if (total > slice) console.log(`   (whole video would take about ${Math.round(sc.s * total / slice / 60)} min)`);
  const src = { ...probe, maxKeyframeGap: probe.maxKeyframeGap || 2 };
  const start = Math.min(10, Math.max(0, total - 25));
  for (const profile of ['balanced', 'fast', 'turbo']) {
    const r = await time(`4. make a 20 s clip 9:16, speed profile "${profile}"`, () => renderer.render({ src, inputFile: file, start, duration: 20, outFile: path.join(dataDir, `c_${profile}.mp4`), aspectRatio: '9:16', profile, audio: { originalVolume: 1, normalize: true, bgm: null }, reEncode: true }, { workDir: config.dirs.tmp }));
    console.log(`   -> ${(20 / r.s).toFixed(2)}x real time: a 6-minute clip would take about ${(360 / (20 / r.s) / 60).toFixed(1)} min`);
  }
  try {
    await time('5. make a 20 s clip by copying (no re-encode)', () => renderer.render({ src, inputFile: file, start, duration: 20, outFile: path.join(dataDir, 'c_copy.mp4'), aspectRatio: 'original', profile: 'balanced', audio: { originalVolume: 1, normalize: false, bgm: null }, reEncode: false }, { workDir: config.dirs.tmp }));
  } catch (e) { console.log(`5. copying is not possible for this video (${String(e.message).slice(0, 80)})`); }
  console.log('\nThe biggest number tells you what to change: re-encoding (step 4) is usually most of it. "turbo" is the quickest profile;');
  console.log('VIDEO_ENCODER=auto in .env uses the graphics card when there is one; CLIP_CONCURRENCY raises how many clips are made at once.');
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
