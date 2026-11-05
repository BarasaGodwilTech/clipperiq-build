'use strict';
/** Several lower thirds on one clip: the filter graph, and a real render with two layers at their own times. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const { buildPlan } = require(path.join(ROOT, 'src', 'media', 'renderer.js'));
const framing = () => import(pathToFileURL(path.join(REPO, 'js', 'shared', 'framing.js')).href);
const caps = { ok: true, filters: { loudnorm: true, afade: true, alimiter: true, sidechaincompress: true, amix: true, gblur: true, eq: true, aecho: true, ass: true }, amixHasNormalize: true };
const cfg = { ffmpeg: { crf: 28, preset: 'ultrafast', loudnormTarget: -16, clipConcurrency: 1, threads: 0 } };
const SRC = { width: 640, height: 360, hasAudio: false, videoCodec: 'h264', audioCodec: '', maxKeyframeGap: 1 };
const base = { src: SRC, inputFile: 'in.mp4', start: 0, duration: 8, outFile: 'o.mp4', aspectRatio: 'original', audio: { originalVolume: 1, normalize: false }, reEncode: true };

test('one lower third gives the command it always did; several are laid on in order', async () => {
  const fr = await framing();
  const one = { file: 'a.mov', y: 100, start: 2, loop: false };
  const two = { file: 'b.mov', y: 200, start: 4.5, loop: true };
  const single = buildPlan(base, { framing: fr, lowerThird: one, caps, config: cfg });
  const asList = buildPlan(base, { framing: fr, lowerThirds: [one], caps, config: cfg });
  assert.deepEqual(asList.args, single.args, 'a list of one is exactly the single form');
  const fcOf = (p) => p.args[p.args.indexOf('-filter_complex') + 1];
  assert.match(fcOf(single), /\[1:v\]format=rgba,setpts=PTS\+2\.000\/TB\[ltl\];\[[^\]]+\]\[ltl\]overlay=0:100:eof_action=pass\[vlt\]/);
  const multi = buildPlan(base, { framing: fr, lowerThirds: [one, two], caps, config: cfg });
  const fc = fcOf(multi);
  assert.match(fc, /\[2:v\]format=rgba,setpts=PTS\+4\.500\/TB\[ltl2\];\[vlt\]\[ltl2\]overlay=0:200:eof_action=pass\[vlt2\]/);
  assert.match(fc, /\[vlt2\]null\[vout\]/, 'the last layer feeds the output');
  assert.equal(multi.args.filter((a) => a === '-stream_loop').length, 1, 'only the looping layer is looped');
  assert.equal(multi.args.filter((a) => a === '-i').length, 3);
});

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('two lower thirds show at their own times in a real render', { skip: !haveFfmpeg, timeout: 120000 }, async (t) => {
  const fr = await framing();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) => { const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args]); assert.equal(r.status, 0, String(r.stderr)); };
  const input = path.join(dir, 'in.mp4');
  run(['-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=8', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', input]);
  const layer = (name, colour) => { const f = path.join(dir, name); run(['-f', 'lavfi', '-i', `color=c=${colour}:s=640x60:d=2:r=30`, '-vf', 'format=argb', '-c:v', 'qtrle', f]); return f; };
  const red = layer('red.mov', 'red'); const blue = layer('blue.mov', 'blue');
  const plan = buildPlan({ ...base, inputFile: input, outFile: path.join(dir, 'out.mp4') }, {
    framing: fr, caps, config: cfg, lowerThirds: [{ file: red, y: 40, start: 1, loop: false }, { file: blue, y: 260, start: 4.5, loop: false }],
  });
  run(plan.args);
  const px = (sec, x, y) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(sec), '-i', path.join(dir, 'out.mp4'), '-frames:v', '1', '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 16 }); return [...r.stdout]; };
  const isRed = (p) => p[0] > 150 && p[2] < 80; const isBlue = (p) => p[2] > 150 && p[0] < 80; const isBlack = (p) => Math.max(...p) < 60;
  assert.ok(isBlack(px(0.4, 300, 60)) && isBlack(px(0.4, 300, 280)), 'nothing at the start');
  assert.ok(isRed(px(1.8, 300, 60)) && isBlack(px(1.8, 300, 280)), 'the first one is up, the second is not');
  assert.ok(isBlack(px(3.6, 300, 60)) && isBlack(px(3.6, 300, 280)), 'the first has gone, the second is not here yet');
  assert.ok(isBlue(px(5.2, 300, 280)) && isBlack(px(5.2, 300, 60)), 'the second is up on its own');
});
