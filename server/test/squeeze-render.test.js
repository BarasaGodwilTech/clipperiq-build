'use strict';
/**
 * A squeeze screen rendered for real: the clip is cut by FFmpeg and then inspected pixel by pixel.
 * Needs FFmpeg and @napi-rs/canvas (both are normal dependencies of the server); skipped where either is missing.
 *
 *   before it starts      the picture fills the frame (no frame around it)
 *   while it is held      the frame is drawn around a window, and the picture is inside that window
 *   after it has left     the picture fills the frame again
 *   the length and sound of the clip are unchanged; a second clip with the same look reuses the drawn layers
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let canvasOk = true; try { require('@napi-rs/canvas'); } catch { canvasOk = false; }
const ffOk = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const skip = !ffOk ? 'no ffmpeg' : !canvasOk ? 'no @napi-rs/canvas' : false;

function setup() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-sqr-'));
  process.env.DATA_DIR = data; process.env.STORAGE_CONFIG_FILE = path.join(data, 'none.json');
  delete require.cache[require.resolve('../src/config')];
  const { load } = require('../src/config'); const config = load();
  for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true });
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const { createFfmpeg } = require('../src/media/ffmpeg'); const { createRenderer } = require('../src/media/renderer');
  const ff = createFfmpeg(config, logger);
  return { config, ff, renderer: createRenderer({ ff, config, logger }), data };
}

const frameCache = new Map();
const pixel = (file, t, x, y) => { // the colour at (x, y) of the frame at time t (read as a whole frame: one pixel of a subsampled frame cannot be cropped)
  const key = `${file}@${t}`;
  if (!frameCache.has(key)) {
    const info = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]).stdout.toString()).streams[0];
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, String(r.stderr));
    frameCache.set(key, { w: info.width, h: info.height, buf: r.stdout });
  }
  const f = frameCache.get(key); const i = (y * f.w + x) * 3; return [f.buf[i], f.buf[i + 1], f.buf[i + 2]];
};
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const probe = (file) => JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]).stdout.toString());

test('a squeeze screen shrinks the picture into its window and brings it back', { skip, timeout: 120000 }, async () => {
  const { config, ff, renderer, data } = setup();
  const input = path.join(data, 'red.mp4');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=25:d=10', '-f', 'lavfi', '-i', 'sine=frequency=440:d=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]).status, 0);
  const src = { width: 1280, height: 720, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', duration: 10, maxKeyframeGap: 10 };
  const look = { enabled: true, template: 'bottom', loop: 'none', transition: 'ease', start: 2, hold: 3, title: 'TEST OFFER', headline: '50%', sub: 'OFF', primary: '#0b3b8f', secondary: '#061d4a', accent: '#ffb703' };
  const make = async (name, partNumber) => {
    const out = path.join(data, name);
    await renderer.render({ src, inputFile: input, start: 0, duration: 8, outFile: out, partNumber, aspectRatio: 'original', profile: 'fast', squeeze: look, overlay: { format: 'none' }, audio: { normalize: false } }, { workDir: config.dirs.tmp });
    return out;
  };
  const t0 = Date.now(); const out = await make('a.mp4', 1); const first = Date.now() - t0;
  const info = probe(out); const v = info.streams.find((s) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [1280, 720]);
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'the sound is kept');
  assert.ok(Math.abs(Number(info.format.duration) - 8) < 0.3, `the length is unchanged (${info.format.duration})`);

  // before the squeeze: the red picture fills everything, corners included
  for (const [x, y] of [[5, 5], [1270, 5], [5, 715], [1270, 715], [640, 360]]) assert.ok(isRed(pixel(out, 1.0, x, y)), `full screen at 1.0s, (${x},${y})`);
  // held (2.0 + 0.9 in = 2.9s onwards): the window is red, the frame around it is not
  const tHold = 4.0;
  assert.ok(isRed(pixel(out, tHold, 640, 250)), 'the picture shows inside the window');
  for (const [x, y] of [[5, 5], [1270, 5], [5, 715], [1270, 715], [640, 700]]) assert.ok(!isRed(pixel(out, tHold, x, y)), `the frame is drawn at (${x},${y})`);
  // after it has left (2 + 0.9 + 3 + 0.7 = 6.6s): full screen again
  for (const [x, y] of [[5, 5], [1270, 715], [640, 360]]) assert.ok(isRed(pixel(out, 7.2, x, y)), `full screen again at 7.2s, (${x},${y})`);

  // the same look for another clip: the drawn layers are reused, so it is much quicker
  const t1 = Date.now(); await make('b.mp4', 2); const second = Date.now() - t1;
  assert.ok(second < first, `the second clip reuses the drawn frames (${second}ms vs ${first}ms)`);
  assert.ok(fs.readdirSync(config.dirs.tmp).filter((f) => /^sq_[0-9a-f]+_(in|hold|out)\.mov$/.test(f)).length === 3, 'one set of three layers, shared');
});

test('a squeeze screen that cannot be drawn still gives a clip, with a warning', { skip, timeout: 120000 }, async () => {
  const { config, renderer, data } = setup();
  const input = path.join(data, 'in.mp4');
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
  const out = path.join(data, 'o.mp4');
  const src = { width: 640, height: 360, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', duration: 4, maxKeyframeGap: 4 };
  // starting after the clip ends: nothing to show, so no squeeze and no problem
  const r = await renderer.render({ src, inputFile: input, start: 0, duration: 3, outFile: out, partNumber: 1, aspectRatio: 'original', profile: 'fast', squeeze: { enabled: true, template: 'lbar', start: 50 }, overlay: { format: 'none' }, audio: { normalize: false } }, { workDir: config.dirs.tmp });
  assert.ok(fs.existsSync(out)); assert.ok(isRed(pixel(out, 1.5, 320, 180)));
  assert.ok(r);
});
