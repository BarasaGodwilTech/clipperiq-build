'use strict';
/**
 * Animated lower thirds, server side.
 *
 * The drawing code is shared with the browser (js/shared/lowerThird.js), so what the person previews is what
 * is rendered. Here every frame of the animation is drawn with @napi-rs/canvas and streamed straight into
 * ffmpeg, which stores them as a small transparent video ("layer"). The clip renderer then lays that layer
 * over the clip with ffmpeg's overlay filter (see renderer.js).
 *
 * The layer only covers the horizontal band the strap moves in, and a job's clips all share one layer (it is
 * cached by content + size), so a 30-part series draws the animation once, not 30 times. When the strap
 * repeats, the layer holds a single cycle and ffmpeg loops it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const FPS = 30;
const FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts');

let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); } catch { canvasLib = null; }

function createLowerThirdRenderer({ ff, config, logger }) {
  let sharedP = null;
  let fontsReady = false;
  const inflight = new Map(); // layer key -> Promise<layer>

  function loadShared() {
    if (!sharedP) sharedP = import(pathToFileURL(path.join(config.rootDir, 'js', 'shared', 'lowerThird.js')).href);
    return sharedP;
  }

  function ensureFonts(shared) {
    if (fontsReady || !canvasLib) return;
    for (const f of shared.LT_FONT_FILES) {
      try { canvasLib.GlobalFonts.registerFromPath(path.join(FONT_DIR, f.file), f.family); } catch (e) { logger?.warn(`lower third: font ${f.file} not loaded (${e.message})`); }
    }
    fontsReady = true;
  }

  const available = () => !!canvasLib;

  // ── the cache of drawn layers (lt_<key>.mov in the temporary folder) must never hold a damaged file ──────────────────────────
  const checked = new Map(); // "file|size|mtime" -> true: a layer that was already looked at and is fine

  /** Is this layer file a complete, readable animation? (A file cut short, e.g. "moov atom not found", is not.) */
  async function isValidLayer(file) {
    let st;
    try { st = await fs.promises.stat(file); } catch { return false; }
    if (!st.isFile() || st.size < 1500) return false;
    const k = `${file}|${st.size}|${st.mtimeMs}`;
    if (checked.get(k)) return true;
    try {
      const info = await ff.probe(file);
      if (!info || !(info.width > 0) || !(info.duration > 0)) return false;
    } catch { return false; }
    checked.set(k, true);
    if (checked.size > 500) checked.clear();
    return true;
  }

  /** Deletes a cached layer (and any half-drawn leftovers of it). Used when a render found it damaged. */
  async function purge(file) {
    checked.clear();
    let removed = 0;
    const dir = path.dirname(file); const base = path.basename(file);
    try {
      for (const n of await fs.promises.readdir(dir)) {
        if (n === base || (n.startsWith(`${base}.`) && n.endsWith('.part'))) { try { await fs.promises.unlink(path.join(dir, n)); removed++; } catch { /* in use: it is drawn again under a new name anyway */ } }
      }
    } catch { /* folder gone */ }
    return removed;
  }

  /** Removes half-drawn layers that a stopped or crashed server left behind. */
  function sweepPartials(dir) {
    try { for (const n of fs.readdirSync(dir)) if (/^lt_[0-9a-f]+\.mov(\..*)?\.part$/.test(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* in use */ } } } catch { /* no folder yet */ }
  }
  if (config.dirs && config.dirs.tmp) sweepPartials(config.dirs.tmp);

  /** Draws every frame and pipes it into ffmpeg. Resolves when the layer file is complete. */
  async function renderLayer(shared, spec, plan, { width, height, band, file, signal }) {
    const canvas = canvasLib.createCanvas(width, band.h);
    const ctx = canvas.getContext('2d');
    const frames = Math.max(1, Math.ceil(plan.seconds * FPS));
    const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${band.h}`, '-r', String(FPS), '-i', 'pipe:0',
      '-c:v', 'png', '-pix_fmt', 'rgba', '-f', 'mov', file];
    const child = spawn(ff.bins.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg could not store the animation: ${stderr.split('\n').filter(Boolean).slice(-2).join(' ')}`))));
    });
    child.stdin.on('error', () => { /* the close handler reports the real reason */ });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const tl = plan.timeline;
    let last = null; let lastKey = null;
    let failure = null;
    try {
      for (let i = 0; i < frames; i++) {
        if (signal && signal.aborted) throw new Error('cancelled');
        const t = spec.start + i / FPS;
        const key = shared.lowerThirdFrameKey(spec, tl, t);
        let buf;
        if (key && key === lastKey && last) buf = last; // identical picture (steady hold, or nothing on screen)
        else {
          ctx.clearRect(0, 0, width, band.h);
          shared.drawLowerThird(ctx, width, height, spec, t, { offsetY: band.y0 });
          buf = Buffer.from(ctx.getImageData(0, 0, width, band.h).data.buffer);
          last = buf; lastKey = key;
        }
        if (!child.stdin.write(buf)) await new Promise((res) => child.stdin.once('drain', res));
        if (child.exitCode !== null) break;
      }
    } catch (e) {
      failure = e;
    } finally {
      try { child.stdin.end(); } catch { /* already closed */ }
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (failure) { // stopped part-way: make sure ffmpeg is really gone before anyone touches (or deletes) the file
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await done.catch(() => {});
      throw failure;
    }
    await done;
  }

  /**
   * Returns the layer for this lower third at this frame size, drawing it if it doesn't exist yet:
   * { file, y, start, loop } or null when nothing shows within the clip. Throws if it can't be drawn.
   */
  async function prepare(rawSpec, { width, height, clipDuration, workDir, signal, partNumber = 1 }) {
    if (!rawSpec) return null;
    const shared = await loadShared();
    // this clip's own text ("Follow for Part {next}" -> "Follow for Part 4") and, if asked, its start near the end of the clip
    const spec = shared.resolveLowerThird(rawSpec, { part: partNumber, clipDuration });
    if (!spec.enabled) return null;
    const plan = shared.lowerThirdLayerPlan(spec, clipDuration);
    if (!plan) return null;
    if (!canvasLib) throw new Error('the canvas module is not installed on the server');
    ensureFonts(shared);

    const mctx = canvasLib.createCanvas(8, 8).getContext('2d');
    const band = shared.lowerThirdBand(mctx, width, height, spec);
    const key = crypto.createHash('sha1').update(JSON.stringify([spec, width, height, plan.seconds, plan.loop])).digest('hex').slice(0, 16);
    const file = path.join(workDir, `lt_${key}.mov`);
    const info = { file, y: band.y0, start: spec.start, loop: plan.loop, width, height: band.h };

    if (fs.existsSync(file)) { // drawn earlier (another clip of the job, or an earlier job): used only if it is whole
      if (await isValidLayer(file)) return info;
      logger?.warn(`lower third: the saved animation ${path.basename(file)} is damaged; it is deleted and drawn again`);
      await purge(file);
    }
    if (!inflight.has(key)) {
      // every attempt writes under its own name, so two attempts (an interrupted one and its retry) can never write into one file
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
      const p = (async () => {
        const t0 = Date.now();
        try {
          await renderLayer(shared, spec, plan, { width, height, band, file: tmp, signal });
          if (!(await isValidLayer(tmp))) throw new Error('the lower-third animation was not stored completely');
          fs.renameSync(tmp, file);
          logger?.info(`lower third drawn: ${spec.style}, ${Math.ceil(plan.seconds * FPS)} frames at ${width}x${band.h} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (e) {
          fs.promises.unlink(tmp).catch(() => {});
          throw e;
        }
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    await inflight.get(key);
    return info;
  }

  return { prepare, available, purge, isValidLayer, sweepPartials };
}

module.exports = { createLowerThirdRenderer };
