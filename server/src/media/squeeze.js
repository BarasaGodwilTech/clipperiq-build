'use strict';
/**
 * Squeeze screens, server side (see js/shared/squeeze.js for what they are).
 *
 * The frame around the squeezed picture is drawn here with @napi-rs/canvas, using the SAME drawing code as the editor preview,
 * and stored as three short transparent videos ("layers") that the clip renderer lays over the picture:
 *     in    the move into the squeeze (the panels slide in)
 *     hold  one cycle of whatever keeps moving while it is held (shine, pulse, ticker), or a single still picture
 *     out   the move back to full screen
 * The renderer plays `hold` in a loop for as long as the squeeze is held, so a 10-second squeeze costs a few dozen drawn frames,
 * not hundreds, and a job's clips share the layers (they are cached by content and size).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const FPS = 30;
const HOLD_FPS = 24;
const MAX_SHOWINGS = 8;
const FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts');

let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); } catch { canvasLib = null; }

function createSqueezeRenderer({ ff, config, logger }) {
  let sharedP = null;
  let fontsReady = false;
  const inflight = new Map();
  const imageCache = new Map(); // sha1 of a data url -> loaded image

  const loadShared = () => (sharedP || (sharedP = Promise.all([
    import(pathToFileURL(path.join(config.rootDir, 'js', 'shared', 'squeeze.js')).href),
    import(pathToFileURL(path.join(config.rootDir, 'js', 'shared', 'lowerThird.js')).href),
  ]).then(([sq, lt]) => ({ sq, lt }))));

  function ensureFonts(lt) {
    if (fontsReady || !canvasLib) return;
    for (const f of lt.LT_FONT_FILES) {
      try { canvasLib.GlobalFonts.registerFromPath(path.join(FONT_DIR, f.file), f.family); } catch (e) { logger?.warn(`squeeze: font ${f.file} not loaded (${e.message})`); }
    }
    fontsReady = true;
  }

  const available = () => !!canvasLib;

  async function loadImages(spec) {
    const out = {};
    for (const slot of ['logo', 'product', 'qr']) {
      const url = spec.images && spec.images[slot];
      if (!url) continue;
      const h = crypto.createHash('sha1').update(url).digest('hex');
      try {
        if (!imageCache.has(h)) {
          imageCache.set(h, await canvasLib.loadImage(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')));
          if (imageCache.size > 30) imageCache.delete(imageCache.keys().next().value);
        }
        out[slot] = imageCache.get(h);
      } catch (e) { logger?.warn(`squeeze: the ${slot} picture could not be read (${e.message}); it is left out`); }
    }
    return out;
  }

  async function isValid(file) {
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size < 400) return false;
      const info = await ff.probe(file);
      return !!(info && info.width > 0 && info.duration > 0);
    } catch { return false; }
  }

  function sweepPartials(dir) {
    try { for (const n of fs.readdirSync(dir)) if (/^sq_[0-9a-f]+_(in|hold|out)\.mov(\..*)?\.part$/.test(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* in use */ } } } catch { /* no folder yet */ }
  }
  if (config.dirs && config.dirs.tmp) sweepPartials(config.dirs.tmp);

  /** Draws `times.length` frames and pipes them into ffmpeg, which stores them as a transparent video. */
  async function bake(draw, times, fps, { width, height, file, signal }) {
    const canvas = canvasLib.createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0',
      '-c:v', 'png', '-pix_fmt', 'rgba', '-f', 'mov', file];
    const child = spawn(ff.bins.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg could not store the squeeze frame: ${stderr.split('\n').filter(Boolean).slice(-2).join(' ')}`))));
    });
    child.stdin.on('error', () => { /* the close handler reports the real reason */ });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let failure = null;
    try {
      for (const t of times) {
        if (signal && signal.aborted) throw new Error('cancelled');
        ctx.clearRect(0, 0, width, height);
        draw(ctx, t);
        const buf = Buffer.from(ctx.getImageData(0, 0, width, height).data.buffer);
        if (!child.stdin.write(buf)) await new Promise((res) => child.stdin.once('drain', res));
        if (child.exitCode !== null) break;
      }
    } catch (e) { failure = e; } finally {
      try { child.stdin.end(); } catch { /* closed */ }
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (failure) { try { child.kill('SIGKILL'); } catch { /* gone */ } await done.catch(() => {}); throw failure; }
    await done;
  }

  /**
   * The three layers for this squeeze at this frame size (drawn if they do not exist yet), and how to place them:
   *   { inFile, holdFile, outFile, holdFps, inDur, hold, outDur, starts, expr } or null when it never shows in this clip.
   */
  async function prepare(rawSpec, { width, height, clipDuration, workDir, signal, partNumber = 1 }) {
    if (!rawSpec) return null;
    const { sq, lt } = await loadShared();
    const spec = sq.resolveSqueeze(rawSpec, { part: partNumber, clipDuration });
    if (!spec.enabled) return null;
    const tl = sq.squeezeTimeline(spec, clipDuration);
    const starts = tl.starts.filter((s) => s < clipDuration - 0.2).slice(0, MAX_SHOWINGS);
    if (!starts.length) return null;
    if (!canvasLib) throw new Error('the canvas module is not installed on the server');
    ensureFonts(lt);

    // the layers are drawn for ONE showing starting at 0, so every clip with the same look shares them whatever its start time
    const norm = { ...spec, start: 0, repeat: 0, atEnd: false };
    const imgHash = crypto.createHash('sha1').update(JSON.stringify(spec.images)).digest('hex');
    const looks = { ...norm, images: undefined };
    const key = crypto.createHash('sha1').update(JSON.stringify([looks, imgHash, width, height, FPS, HOLD_FPS])).digest('hex').slice(0, 16);
    const files = { in: path.join(workDir, `sq_${key}_in.mov`), hold: path.join(workDir, `sq_${key}_hold.mov`), out: path.join(workDir, `sq_${key}_out.mov`) };
    const per = sq.SQ_LOOP_PERIOD[spec.loop] || 0;
    const info = {
      inFile: files.in, holdFile: files.hold, outFile: files.out, holdFps: per ? HOLD_FPS : FPS,
      inDur: tl.inDur, hold: tl.hold, outDur: tl.outDur, starts, expr: sq.squeezeExpr(spec, width, height), key,
    };

    const allValid = async () => (await Promise.all(Object.values(files).map((f) => (fs.existsSync(f) ? isValid(f) : false)))).every(Boolean);
    if (await allValid()) return info;
    for (const f of Object.values(files)) await fs.promises.unlink(f).catch(() => {}); // a missing or damaged one: all three are drawn again together

    if (!inflight.has(key)) {
      const p = (async () => {
        const t0 = Date.now();
        const images = await loadImages(spec);
        const draw = (ctx, t) => sq.drawSqueeze(ctx, width, height, norm, t, { images });
        const nIn = Math.max(2, Math.ceil(tl.inDur * FPS));
        const nOut = Math.max(2, Math.ceil(tl.outDur * FPS));
        const inTimes = Array.from({ length: nIn }, (_, i) => i / FPS);
        const outTimes = Array.from({ length: nOut }, (_, i) => tl.inDur + tl.hold + i / FPS);
        const holdTimes = per ? Array.from({ length: Math.round(per * HOLD_FPS) }, (_, j) => tl.inDur + j / HOLD_FPS) : [tl.inDur + Math.min(0.5, tl.hold / 2)];
        const parts = [['in', inTimes, FPS], ['hold', holdTimes, per ? HOLD_FPS : FPS], ['out', outTimes, FPS]];
        const tmps = {};
        try {
          for (const [name, times, fps] of parts) {
            tmps[name] = `${files[name]}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
            await bake(draw, times, fps, { width, height, file: tmps[name], signal });
            if (!(await isValid(tmps[name]))) throw new Error(`the squeeze ${name} animation was not stored completely`);
          }
          for (const [name] of parts) fs.renameSync(tmps[name], files[name]);
          logger?.info(`squeeze drawn: ${spec.template}, ${nIn + nOut + holdTimes.length} frames at ${width}x${height} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (e) {
          for (const f of Object.values(tmps)) fs.promises.unlink(f).catch(() => {});
          throw e;
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    await inflight.get(key);
    return info;
  }

  async function purge(file) {
    let n = 0;
    const m = path.basename(file).match(/^sq_([0-9a-f]+)_/); if (!m) return 0;
    const dir = path.dirname(file);
    for (const part of ['in', 'hold', 'out']) { try { await fs.promises.unlink(path.join(dir, `sq_${m[1]}_${part}.mov`)); n++; } catch { /* not there */ } }
    return n;
  }

  return { prepare, available, purge, sweepPartials };
}

module.exports = { createSqueezeRenderer };
