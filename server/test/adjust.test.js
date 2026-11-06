'use strict';
/**
 * Clip adjustments (speed, pitch, flip, zoom, colour, reverb): js/shared/adjust.js, config/clip-adjustments.json and
 * the renderer. Real ffmpeg renders are inspected (picture side, clip length, measured audio pitch).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const SHARED = path.join(REPO, 'js', 'shared');
const CONFIG_JSON = path.join(REPO, 'config', 'clip-adjustments.json');
const imp = (f) => import(pathToFileURL(path.join(SHARED, f)).href);

async function lib() {
  const a = await imp('adjust.js');
  a.setAdjustConfig(JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf8')));
  return a;
}

test('adjust: the JSON config is valid and its system presets stay inside the limits', async () => {
  const a = await lib();
  const cfg = a.getAdjustConfig();
  const raw = JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf8'));
  assert.deepEqual(cfg.defaults, a.defaultAdjust());
  assert.ok(a.isDefaultAdjust(cfg.defaults), 'the defaults change nothing');
  assert.ok(cfg.systemPresets.length >= 1);
  for (const p of a.systemPresets()) {
    assert.equal(p.system, true);
    assert.deepEqual(p.values, a.normalizeAdjust(p.values), `preset ${p.id} is already inside the limits`);
  }
  // every field of the defaults is a field the panel and the renderer know
  assert.deepEqual(Object.keys(raw.defaults).sort(), Object.keys(a.defaultAdjust()).sort());
  for (const r of cfg.aspectRules.rules) assert.ok(['9:16', '1:1', '4:5', '16:9'].includes(r.aspect));
});

test('adjust: values are held inside the configured limits, and a bad config cannot widen the hard bounds', async () => {
  const a = await lib();
  const n = a.normalizeAdjust({ speed: 9, pitch: -99, scale: 20, brightness: 80, reverb: 500, flipH: 1, nonsense: 5, contrast: 'x' });
  assert.equal(n.speed, 2); assert.equal(n.pitch, -12); assert.equal(n.scale, 100);
  assert.equal(n.brightness, 30); assert.equal(n.reverb, 100); assert.equal(n.flipH, true); assert.equal(n.contrast, 0);
  assert.equal('nonsense' in n, false);
  assert.deepEqual(a.normalizeAdjust('junk'), a.defaultAdjust());

  // someone edits the JSON: tighter limits are honoured, absurd ones are not
  a.setAdjustConfig({ limits: { speed: { min: 0.9, max: 1.1 }, scale: { min: 100, max: 99999 }, pitch: { min: 5, max: 1 } } });
  assert.equal(a.normalizeAdjust({ speed: 1.5 }).speed, 1.1);
  assert.equal(a.normalizeAdjust({ scale: 5000 }).scale, 300);
  assert.equal(a.getAdjustConfig().limits.pitch.max, 12, 'min > max falls back to the built-in range');
  a.setAdjustConfig(null);
  assert.equal(a.normalizeAdjust({ speed: 1.04 }).speed, 1.04);
});

test('adjust: presets - built-in ones come from the config, saved ones can never shadow them', async () => {
  const a = await lib();
  a.setAdjustConfig({ systemPresets: [{ id: 'Mine A', label: 'Mine A', values: { speed: 1.02, flipH: true } }, { id: 'mine-a', label: 'dupe' }, { label: '' }] });
  const sys = a.systemPresets();
  assert.equal(sys.length, 1);
  assert.equal(sys[0].id, 'mine-a'); assert.equal(sys[0].values.speed, 1.02); assert.equal(sys[0].values.flipH, true);
  const user = a.normalizeUserPresets([{ id: 'mine-a', label: 'Fake', values: {} }, { id: 'u1', label: ' Saved ', values: { scale: 110, speed: 7 } }, { label: 'x'.repeat(200) }, 'junk']);
  assert.deepEqual(user.map((p) => p.id), ['u1', user[1].id]);
  assert.equal(user[0].label, 'Saved'); assert.equal(user[0].system, false); assert.equal(user[0].values.speed, 2);
  assert.equal(user[1].label.length, 60);
  a.setAdjustConfig(JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf8')));
});

test('adjust: zoom rides on the framing zoom, so preview and render place the video with the same maths', async () => {
  const a = await lib(); const fr = await imp('framing.js');
  const none = a.effectiveFrame(null, { scale: 100 });
  assert.ok(fr.isDefaultFrame(none), 'no zoom: the default frame stays the default (nothing changes)');
  const z = a.effectiveFrame(fr.defaultFrame(), { scale: 120 });
  assert.equal(z.zoom, 1.2); assert.equal(fr.isDefaultFrame(z), false);
  const fit = a.effectiveFrame({ mode: 'fit', bg: 'blur', zoom: 0.8 }, { scale: 125 });
  assert.equal(fit.zoom, 1); assert.equal(fit.mode, 'fit');
  const aspect = { r: 9 / 16, refW: 1080, refH: 1920 };
  const size = fr.frameOutputSize(1280, 720, aspect, z);
  const rect = fr.videoRect(1280, 720, size.outW, size.outH, z);
  const base = fr.videoRect(1280, 720, size.outW, size.outH, fr.defaultFrame());
  assert.ok(rect.w > base.w && rect.covers);
});

test('adjust: aspect ratio rules use the framing presets (16:9 in 9:16 -> fit + blur; 1:1 and 4:5 -> centre crop)', async () => {
  const a = await lib(); const fr = await imp('framing.js');
  const p916 = a.aspectPlan('9:16', 1920, 1080, fr.FRAME_PRESETS);
  assert.equal(p916.ruleFrame.mode, 'fit'); assert.equal(p916.ruleFrame.bg, 'blur');
  assert.equal(a.aspectPlan('9:16', 1080, 1920, fr.FRAME_PRESETS), null, 'a portrait source is just cropped as before');
  assert.equal(a.aspectPlan('9:16', 1000, 1000, fr.FRAME_PRESETS), null, 'a square source is not a 16:9 source');
  const sq = a.aspectPlan('1:1', 1920, 1080, fr.FRAME_PRESETS);
  assert.equal(sq.ruleFrame.mode, 'fill'); assert.deepEqual(sq.crop, { w: 1080, h: 1080 });
  const p45 = a.aspectPlan('4:5', 1920, 1080, fr.FRAME_PRESETS);
  assert.deepEqual(p45.crop, { w: 864, h: 1080 });
  assert.deepEqual(a.aspectPlan('4:5', 1080, 1920, fr.FRAME_PRESETS).crop, { w: 1080, h: 1350 });
  assert.equal(a.aspectPlan('original', 1920, 1080, fr.FRAME_PRESETS), null);
  a.setAdjustConfig({ aspectRules: { enabled: false } });
  assert.equal(a.aspectPlan('9:16', 1920, 1080, fr.FRAME_PRESETS), null, 'rules can be switched off in the JSON');
  a.setAdjustConfig(JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf8')));
});

// ── the ffmpeg arguments ───────────────────────────────────────────────────────────────
const caps = { ok: true, filters: { loudnorm: true, afade: true, alimiter: true, sidechaincompress: true, amix: true, gblur: true, eq: true, aecho: true }, amixHasNormalize: true };
const cfg = { ffmpeg: { crf: 20, preset: 'veryfast', loudnormTarget: -16, clipConcurrency: 1, threads: 0 } };
const SRC = { width: 1280, height: 720, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', maxKeyframeGap: 2 };

test('adjust: ffmpeg plan - unchanged without adjustments, filters and length with them', async () => {
  const a = await lib(); const fr = await imp('framing.js');
  const { buildPlan } = require(path.join(ROOT, 'src', 'media', 'renderer.js'));
  const base = { src: SRC, inputFile: 'in.mp4', start: 10, duration: 30, outFile: 'out.mp4', aspectRatio: '9:16', audio: { originalVolume: 1, normalize: true }, reEncode: true };
  const plain = buildPlan(base, { framing: fr, caps, config: cfg });
  const withDefaults = buildPlan({ ...base, adjust: a.defaultAdjust() }, { framing: fr, adjustLib: a, caps, config: cfg });
  assert.deepEqual(withDefaults.args, plain.args, 'default adjustments leave the command exactly as it was');

  const spec = { ...base, adjust: { speed: 1.05, preservePitch: false, pitch: 0.2, flipH: true, scale: 104, contrast: 2, brightness: 1, saturation: 3, reverb: 2 } };
  const p = buildPlan(spec, { framing: fr, adjustLib: a, caps, config: cfg });
  const joined = p.args.join(' ');
  assert.match(joined, /hflip,eq=brightness=0\.01:contrast=1\.02:saturation=1\.03,setpts=PTS\/1\.05/);
  assert.match(joined, /asetrate=\d+,aresample=48000,atempo=/);
  assert.match(joined, /aecho=/);
  assert.doesNotMatch(joined, /vflip/);
  const t = p.args[p.args.lastIndexOf('-t') + 1];
  assert.ok(Math.abs(Number(t) - 30 / 1.05) < 1e-6, 'the clip is shorter by the speed-up');
  // zoom: the video is placed larger than without it (same placement path)
  const scaleW = (o) => Number(/scale=(\d+):\d+:flags=bicubic,crop=/.exec(buildPlan({ ...base, adjust: o }, { framing: fr, adjustLib: a, caps, config: cfg }).args.join(' '))[1]);
  assert.ok(scaleW({ scale: 150 }) > scaleW({ scale: 120 }) && scaleW({ scale: 120 }) > scaleW({ scale: 104 }), 'a bigger zoom places a bigger picture');
  assert.ok(Math.abs(scaleW({ scale: 150 }) / scaleW({ scale: 120 }) - 1.25) < 0.02);
  // ducking off is honoured
  const music = { file: 'm.mp3', volume: 0.3, duck: true, duration: 60, offsetSec: 0 };
  const duckOn = buildPlan({ ...base, adjust: { flipH: true }, audio: { originalVolume: 1, normalize: true, bgm: music } }, { framing: fr, adjustLib: a, caps, config: cfg }).args.join(' ');
  const duckOff = buildPlan({ ...base, adjust: { flipH: true, duck: false }, audio: { originalVolume: 1, normalize: true, bgm: music } }, { framing: fr, adjustLib: a, caps, config: cfg }).args.join(' ');
  assert.match(duckOn, /sidechaincompress/); assert.doesNotMatch(duckOff, /sidechaincompress/);
});

// ── real renders ───────────────────────────────────────────────────────────────────────
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = haveFfmpeg ? false : 'ffmpeg is not installed';

function makeSource(dir) {
  // left half red, right half blue, with a steady 440 Hz tone: a flip and a pitch change are easy to measure
  const f = path.join(dir, 'src.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x360:r=30:d=8', '-f', 'lavfi', '-i', 'color=c=blue:s=320x360:r=30:d=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
    '-filter_complex', '[0:v][1:v]hstack[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  assert.equal(r.status, 0, String(r.stderr));
  return f;
}

function dominantHz(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  const b = r.stdout; const n = b.length / 2; let crossings = 0; let prev = b.readInt16LE(0);
  for (let i = 1; i < n; i++) { const v = b.readInt16LE(i * 2); if ((prev < 0) !== (v < 0)) crossings++; prev = v; }
  return crossings / 2 / (n / 48000);
}
function sidePixels(file) {
  // the middle of the left quarter and of the right quarter of the picture, each averaged to one pixel
  const one = (crop) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', `${crop},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
    return [...r.stdout.subarray(0, 3)];
  };
  return { left: one('crop=iw/8:ih/4:iw/8:ih*3/8'), right: one('crop=iw/8:ih/4:iw*6/8:ih*3/8') };
}

test('adjust: real renders - flip, length, and the pitch really measured in the output', { skip, timeout: 240000 }, async () => {
  const { createFfmpeg } = require(path.join(ROOT, 'src', 'media', 'ffmpeg.js'));
  const { createRenderer } = require(path.join(ROOT, 'src', 'media', 'renderer.js'));
  const { load } = require(path.join(ROOT, 'src', 'config.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adj-'));
  const config = load({ ...process.env, DATA_DIR: dir }); config.rootDir = REPO; config.ffmpeg.crf = 28;
  const ff = createFfmpeg(config, null);
  assert.ok(ff.ready(), 'ffmpeg and ffprobe are available');
  await ff.detectCapabilities();
  const renderer = createRenderer({ ff, config, logger: null });
  const inputFile = makeSource(dir);
  const src = await ff.probe(inputFile);
  const go = async (name, adjust, duration = 6, aspectRatio = '16:9') => {
    const outFile = path.join(dir, `${name}.mp4`);
    const res = await renderer.render({ src: { ...src, maxKeyframeGap: 1 }, inputFile, start: 0, duration, outFile, aspectRatio, profile: 'turbo', audio: { originalVolume: 1, normalize: true, bgm: null }, adjust });
    return { outFile, res };
  };
  try {
    const base = await go('base', null);
    assert.ok(Math.abs(base.res.duration - 6) < 0.6);
    let px = sidePixels(base.outFile);
    assert.ok(px.left[0] > 150 && px.right[2] > 150, 'unflipped: red on the left, blue on the right');
    assert.ok(Math.abs(dominantHz(base.outFile) - 440) < 12);

    const flipped = await go('flip', { flipH: true });
    px = sidePixels(flipped.outFile);
    assert.ok(px.left[2] > 150 && px.right[0] > 150, 'flipped: blue on the left, red on the right');

    // speed 1.5 with the pitch kept: shorter by 1.5, the tone stays 440 Hz
    const keep = await go('keep', { speed: 1.5, preservePitch: true });
    assert.ok(Math.abs(keep.res.duration - 4) < 0.6, `length ${keep.res.duration}`);
    assert.ok(Math.abs(dominantHz(keep.outFile) - 440) < 15, `pitch kept: ${dominantHz(keep.outFile)}`);

    // speed 1.5 with the pitch following (tape style): the tone moves up by the same factor
    const tape = await go('tape', { speed: 1.5, preservePitch: false });
    assert.ok(Math.abs(tape.res.duration - 4) < 0.6);
    assert.ok(Math.abs(dominantHz(tape.outFile) - 660) < 20, `pitch followed: ${dominantHz(tape.outFile)}`);

    // pitch shift of +12 semitones at normal speed: one octave up, same length
    const oct = await go('oct', { pitch: 12 });
    assert.ok(Math.abs(oct.res.duration - 6) < 0.6);
    assert.ok(Math.abs(dominantHz(oct.outFile) - 880) < 25, `octave: ${dominantHz(oct.outFile)}`);

    // zoom + colour + reverb render in 9:16 (the framing path) and give a valid, correctly sized clip
    const full = await go('full', { speed: 1.05, scale: 110, brightness: 2, contrast: 2, saturation: 3, reverb: 3, flipH: true }, 6, '9:16');
    assert.equal(full.res.width % 2, 0);
    assert.ok(full.res.height > full.res.width, 'portrait output');
    assert.ok(Math.abs(full.res.duration - 6 / 1.05) < 0.6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
