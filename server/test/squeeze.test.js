'use strict';
// Squeeze screens: the spec, the timing, every template at every shape, and that the movement drawn in the preview is the
// movement FFmpeg applies to the picture.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const SHARED = pathToFileURL(path.join(__dirname, '..', '..', 'js', 'shared', 'squeeze.js')).href;
const load = () => import(SHARED);

// a drawing surface that accepts everything and records nothing, enough to run the templates without a canvas library
function fakeCtx() {
  const grad = { addColorStop() {} };
  const target = { measureText: (s) => ({ width: String(s).length * 9 }), createLinearGradient: () => grad, createRadialGradient: () => grad };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^(fillStyle|strokeStyle|font|lineWidth|globalAlpha|shadow\w+|textAlign|textBaseline|lineJoin|globalCompositeOperation)$/.test(k) ? undefined : () => undefined)), set: () => true });
}

test('the spec is repaired: unknown values, colours, images and limits', async () => {
  const sq = await load();
  const n = sq.normalizeSqueeze({ enabled: 1, template: 'nope', primary: 'red', hold: 9999, speed: 99, scale: 5, transition: 'x', loop: 'ticker', images: { logo: 'http://evil/x.png', qr: 'data:image/png;base64,AAAA', product: 'javascript:1' } });
  assert.strictEqual(n.enabled, true); assert.strictEqual(n.template, 'lbar'); assert.match(n.primary, /^#[0-9a-f]{6}$/);
  assert.ok(n.hold <= 300 && n.speed <= 2 && n.scale <= 1.15); assert.strictEqual(n.transition, 'ease');
  assert.notStrictEqual(n.loop, 'ticker', 'the ticker only exists in the Breaking Ticker template');
  assert.strictEqual(n.images.logo, ''); assert.strictEqual(n.images.product, ''); assert.ok(n.images.qr.startsWith('data:image/png'));
  assert.strictEqual(sq.normalizeSqueeze({ template: 'news', loop: 'ticker' }).loop, 'ticker');
});

test('{part} and {next} are filled in, and "near the end" is worked out', async () => {
  const sq = await load();
  const r = sq.resolveSqueeze({ enabled: true, title: 'Part {part}', cta: 'Follow for Part {next}' }, { part: 3 });
  assert.strictEqual(r.title, 'Part 3'); assert.strictEqual(r.cta, 'Follow for Part 4');
  const e = sq.resolveSqueeze({ enabled: true, atEnd: true, hold: 5 }, { part: 1, clipDuration: 40 });
  const tl = sq.squeezeTimeline(e); assert.ok(e.start + tl.total <= 40, 'it finishes before the clip ends'); assert.ok(e.start + tl.total > 38);
});

test('the amount goes 0 -> 1 -> 0, stays in between while held, and repeats on a cycle', async () => {
  const sq = await load();
  const spec = sq.normalizeSqueeze({ enabled: true, start: 2, hold: 6, transition: 'ease' }); const tl = sq.squeezeTimeline(spec);
  assert.strictEqual(sq.squeezeAmount(spec, tl, 1), 0);
  let prev = 0; for (let t = spec.start; t <= spec.start + tl.inDur; t += 0.05) { const a = sq.squeezeAmount(spec, tl, t); assert.ok(a >= prev - 1e-9, 'moves steadily in'); prev = a; }
  assert.ok(Math.abs(sq.squeezeAmount(spec, tl, spec.start + tl.inDur + 2) - 1) < 1e-9);
  assert.strictEqual(sq.squeezeAmount(spec, tl, spec.start + tl.total + 0.5), 0);
  const rep = sq.normalizeSqueeze({ enabled: true, start: 2, hold: 3, repeat: 20 }); const t2 = sq.squeezeTimeline(rep);
  assert.ok(Math.abs(sq.squeezeAmount(rep, t2, 2 + t2.inDur + 1) - 1) < 1e-9);
  assert.ok(Math.abs(sq.squeezeAmount(rep, t2, 22 + t2.inDur + 1) - 1) < 1e-9, 'shows again one cycle later');
  assert.strictEqual(sq.squeezeAmount(rep, t2, 15), 0);
  const bounce = sq.normalizeSqueeze({ enabled: true, transition: 'back', start: 0 }); const tb = sq.squeezeTimeline(bounce);
  let mx = 0; for (let t = 0; t < tb.inDur; t += 0.02) mx = Math.max(mx, sq.squeezeAmount(bounce, tb, t)); assert.ok(mx > 1.01 && mx < 1.15, 'the bounce overshoots a little');
});

test('every template draws at every shape and time without failing, and leaves the picture window inside the frame', async () => {
  const sq = await load();
  for (const t of sq.SQ_TEMPLATES) for (const [W, H] of [[1280, 720], [720, 1280], [1080, 1080], [864, 1080]]) for (const loop of t.loops) {
    const spec = sq.normalizeSqueeze({ enabled: true, template: t.id, loop, start: 0.5, hold: 4, images: {} });
    const tl = sq.squeezeTimeline(spec);
    for (const tt of [0.4, 0.5 + tl.inDur * 0.4, 0.5 + tl.inDur + 1.3, 0.5 + tl.inDur + 3.9, 0.5 + tl.total - 0.2, 9]) {
      const r = sq.drawSqueeze(fakeCtx(), W, H, spec, tt, { demo: true });
      if (tt < 0.5 || tt > 0.5 + tl.total) { assert.strictEqual(r.drawn, false, `${t.id} ${W}x${H} t=${tt} should be empty`); continue; }
      assert.strictEqual(r.drawn, true, `${t.id} ${W}x${H} t=${tt}`);
      assert.ok(r.rect.x >= -1 && r.rect.y >= -1 && r.rect.x + r.rect.w <= W + 1 && r.rect.y + r.rect.h <= H + 1, `${t.id} ${W}x${H} window inside the frame`);
    }
    const win = sq.squeezeWindow(spec, W, H);
    assert.ok(Math.abs(win.w / win.h - W / H) < 0.01, `${t.id}: the squeezed picture keeps its shape`);
  }
});

test('long text and empty fields never fail', async () => {
  const sq = await load();
  const spec = sq.normalizeSqueeze({ enabled: true, template: 'side', title: 'X'.repeat(60), caption: 'word '.repeat(40), headline: '', sub: '', cta: '', brand: '' });
  assert.doesNotThrow(() => sq.drawSqueeze(fakeCtx(), 720, 1280, spec, 4, {}));
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('the movement FFmpeg applies equals the movement the frame is drawn for', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const sq = await load();
  const W = 720; const H = 1280;
  for (const transition of ['ease', 'back', 'snap']) for (const repeat of [0, 9]) {
    const spec = sq.normalizeSqueeze({ enabled: true, template: 'lbar', start: 1, hold: 2.5, transition, repeat, speed: 1.25 });
    const ex = sq.squeezeExpr(spec, W, H); const tl = sq.squeezeTimeline(spec); const win = sq.squeezeWindow(spec, W, H);
    const dur = 12; const fps = 20;
    const evalExpr = (expr) => {
      const e = expr.replace(/\bt\b/g, 'T');
      const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=16x16:r=${fps}:d=${dur}`, '-vf', `format=gray16le,geq=lum='clip(max(0,(${e}))*20,0,65535)':cb=128:cr=128`, '-f', 'rawvideo', '-pix_fmt', 'gray16le', '-'], { maxBuffer: 1 << 26 });
      assert.strictEqual(r.status, 0, String(r.stderr));
      const out = []; const buf = r.stdout; const frame = 16 * 16 * 2;
      for (let i = 0; i < buf.length / frame; i++) out.push(buf.readUInt16LE(i * frame) / 20);
      return out;
    };
    const xs = evalExpr(ex.x.replace(/^\(/, '(').trim()); const ws = evalExpr(ex.w);
    let worst = 0;
    for (let i = 0; i < xs.length; i++) {
      const t = i / fps; const a = sq.squeezeAmount(spec, tl, t);
      const eo = sq.SQ_OVERSCAN * Math.max(0, Math.min(1, a * 10));
      const wantW = Math.trunc((W + a * (win.w - W) + 2 * eo) / 2) * 2;
      const wantX = Math.max(0, a * win.x - eo); // (the test clamps at 0: the pixel value cannot be negative)
      worst = Math.max(worst, Math.abs(ws[i] - wantW), Math.abs(xs[i] - wantX));
    }
    assert.ok(worst <= 2.5, `${transition} repeat=${repeat}: worst difference ${worst.toFixed(2)} px`);
  }
});
