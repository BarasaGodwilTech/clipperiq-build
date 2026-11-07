// Look and lower thirds for the phone app. Pure logic, no screen code.
// It uses the SAME modules as the Windows version (shared/lowerThird.js, adjust.js, framing.js), so a lower third drawn here
// is the one you designed on the computer, and the numbers in an imported settings file mean the same thing.
import {
  LT_FONT_FILES, normalizeLowerThirds, resolveLowerThird, lowerThirdLayerPlan, lowerThirdFrameKey, lowerThirdBand, drawLowerThird,
} from './shared/lowerThird.js';
import { normalizeAdjust, normalizeUserPresets, setAdjustConfig, getAdjustConfig } from './shared/adjust.js';
import { normalizeFrame } from './shared/framing.js';

export const FPS = 24;
export const PHONE_ASPECTS = { '9:16': { r: 9 / 16, outH: 1280 }, '4:5': { r: 4 / 5, outH: 1080 }, '1:1': { r: 1, outH: 1080 }, '16:9': { r: 16 / 9, outH: 720 } };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// ───────────── set-up: limits and fonts ─────────────
let ready = null;
export function loadConfigAndFonts() {
  if (ready) return ready;
  ready = (async () => {
    try { const r = await fetch('./shared/clip-adjustments.json', { cache: 'no-cache' }); if (r.ok) setAdjustConfig(await r.json()); } catch { /* built-in limits apply */ }
    try {
      await Promise.all(LT_FONT_FILES.map(async (f) => {
        const face = new FontFace(f.family, `url(./shared/fonts/${f.file})`, { weight: f.weight });
        await face.load(); document.fonts.add(face);
      }));
    } catch (e) { console.warn('lower-third fonts did not load:', e); }
  })();
  return ready;
}

// ───────────── what the native engine needs ─────────────
/** Output picture size for a chosen shape (the engine makes exactly this size, so lower-third pictures line up). */
export function outputSize(aspect, srcW, srcH) {
  if (PHONE_ASPECTS[aspect]) { const a = PHONE_ASPECTS[aspect]; return { outH: a.outH, outW: even(a.outH * a.r), r: a.r }; }
  const h = even(Math.min(srcH || 1080, 1080)); const r = (srcW || 16) / (srcH || 9);
  return { outH: h, outW: even(h * r), r };
}

/** Framing + adjustments -> the plain numbers sent to the engine. */
export function planFx({ frame, adjust, aspect, srcW, srcH }) {
  const f = normalizeFrame(frame); const a = normalizeAdjust(adjust);
  const size = outputSize(aspect, srcW, srcH);
  const zoom = f.zoom * (a.scale / 100);
  const fx = {
    outW: size.outW, outH: size.outH, fit: false, fitScale: 1, crop: null,
    flipH: a.flipH, flipV: a.flipV,
    brightness: a.brightness / 100, contrast: a.contrast / 100, saturation: a.saturation,
    speed: a.speed, pitch: 2 ** (a.pitch / 12), preservePitch: a.preservePitch,
  };
  if (f.mode === 'fit' && aspect !== 'original') { fx.fit = true; fx.fitScale = zoom; return fx; }
  // fill: the part of the source that ends up in the frame (same maths as the Windows version's videoRect)
  const sr = srcW / srcH; const r = size.r;
  let cw; let ch;
  if (sr > r) { ch = srcH; cw = srcH * r; } else { cw = srcW; ch = srcW / r; }
  cw /= zoom; ch /= zoom;
  if (zoom === 1 && Math.abs(f.x - 0.5) < 1e-6 && Math.abs(f.y - 0.5) < 1e-6 && (aspect === 'original' || Math.abs(sr - r) < 1e-3)) return fx; // nothing to crop
  let cx = srcW / 2 + (0.5 - f.x) * cw; let cy = srcH / 2 + (0.5 - f.y) * ch;
  cx = Math.min(srcW - cw / 2, Math.max(cw / 2, cx)); cy = Math.min(srcH - ch / 2, Math.max(ch / 2, cy)); // never show past the edge
  fx.crop = { x0: (cx - cw / 2) / srcW, x1: (cx + cw / 2) / srcW, y0: (cy - ch / 2) / srcH, y1: (cy + ch / 2) / srcH };
  return fx;
}

/** What the person's adjustments cannot do on the phone (so it is said, not silently skipped). */
export function unsupportedNotes({ frame, adjust, design }) {
  const notes = [];
  const f = normalizeFrame(frame); const a = normalizeAdjust(adjust);
  if (f.mode === 'fit' && f.bg === 'blur') notes.push('A blurred background is not available on the phone yet: black bars are used instead.');
  if (f.mode === 'fit' && Math.abs(f.y - 0.5) > 0.01) notes.push('Moving the picture up or down inside a fitted frame is not available on the phone yet.');
  if (a.reverb > 0) notes.push('Reverb is not available on the phone yet.');
  if (design && design.captions && design.captions.enabled) notes.push('Captions are not available on the phone yet.');
  if (design && Array.isArray(design.items) && design.items.length) notes.push('Text, sticker and picture overlays are not available on the phone yet.');
  return notes;
}

// ───────────── lower-third pictures ─────────────
function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }

/**
 * Draws one lower third for one clip: every frame of its animation (a repeating one only a single cycle), the way the
 * Windows server does, but as small transparent pictures of the band the strap moves in.
 * Returns null when it never shows in this clip.
 */
export function renderLayer(rawSpec, { part, clipDuration, outW, outH, isLast = false }) {
  const spec = resolveLowerThird(rawSpec, { part, clipDuration, isLast });
  if (!spec.enabled) return null;
  const plan = lowerThirdLayerPlan(spec, clipDuration);
  if (!plan) return null;
  const mctx = document.createElement('canvas').getContext('2d');
  const band = lowerThirdBand(mctx, outW, outH, spec);
  const canvas = document.createElement('canvas'); canvas.width = outW; canvas.height = band.h;
  const ctx = canvas.getContext('2d');
  const n = Math.max(1, Math.ceil(plan.seconds * FPS));
  const frames = []; const map = []; let lastKey = null; let lastIdx = -1;
  for (let i = 0; i < n; i++) {
    const t = spec.start + i / FPS;
    const key = lowerThirdFrameKey(spec, plan.timeline, t);
    if (key === 'off') { map.push(-1); lastKey = key; lastIdx = -1; continue; }
    if (key && key === lastKey && lastIdx >= 0) { map.push(lastIdx); continue; } // the same picture as the one before
    ctx.clearRect(0, 0, outW, band.h);
    const shown = drawLowerThird(ctx, outW, outH, spec, t, { offsetY: band.y0 });
    if (!shown) { map.push(-1); lastKey = key; lastIdx = -1; continue; }
    frames.push(canvas.toDataURL('image/png')); lastIdx = frames.length - 1; map.push(lastIdx); lastKey = key;
  }
  const key = 'lt' + hash(JSON.stringify([spec, outW, outH, plan.seconds, plan.loop, FPS]));
  return { key, frames, meta: { key, frameW: outW, frameH: outH, width: outW, height: band.h, y0: band.y0, fps: FPS, startSec: spec.start, seconds: plan.seconds, loop: plan.loop, map } };
}

/** Sends a drawn layer to the engine (once per distinct picture set). */
export async function uploadLayer(eng, layer, sent) {
  if (sent.has(layer.key)) return;
  await eng.beginOverlay(layer.meta);
  const BATCH = 6;
  for (let i = 0; i < layer.frames.length; i += BATCH) await eng.addOverlayFrames({ key: layer.key, start: i, frames: layer.frames.slice(i, i + BATCH) });
  sent.add(layer.key);
}

/** The overlay keys for one clip (drawing and uploading what is not there yet). */
export async function overlaysForClip(eng, lts, { part, clipDuration, outW, outH, isLast = false }, sent) {
  const keys = [];
  if (!eng.beginOverlay) return keys; // an older engine without lower thirds
  for (const lt of lts) {
    if (!lt || !lt.enabled) continue;
    const layer = renderLayer(lt, { part, clipDuration, outW, outH, isLast });
    if (!layer || !layer.frames.length) continue;
    await uploadLayer(eng, layer, sent);
    keys.push(layer.key);
  }
  return keys;
}

// ───────────── a settings file saved on the computer ─────────────
/**
 * Everything in a Windows settings file that the phone can use:
 *   look      the processing settings (series / spread, length, number, shape, PART label, first part)
 *   frame     framing (fill / fit, zoom, position)
 *   adjust    speed, pitch, flip, zoom, brightness, contrast, saturation
 *   lowerThirds  every lower third, with its text, colours, animation and timing
 *   adjustPresets, designs   the saved presets and designs
 * and what it holds that the phone cannot do yet.
 */
export function parseDesktopProfile(profile) {
  if (!profile || profile.kind !== 'settings-profile') throw new Error('This is not a ClipperIQ settings file.');
  const pr = profile.processing || {}; const d = profile.design && typeof profile.design === 'object' ? profile.design : null;
  const out = { look: null, frame: null, adjust: null, lowerThirds: null, adjustPresets: [], designs: [], notes: [], summary: [] };
  if (Object.keys(pr).length) {
    out.look = { mode: pr.seriesMode ? 'series' : 'even', len: pr.clipDuration, cnt: pr.maxClips, aspect: pr.aspectRatio, ptxt: pr.overlayFormat !== 'none', sp: pr.seriesStartPart };
    out.summary.push('clip settings');
    if (!pr.seriesMode) out.notes.push('"Best moments" becomes "Spread out" here, because moment detection is not on the phone yet.');
    if (pr.overlayFormat === 'styled-number') out.notes.push('The large styled number becomes the plain PART label.');
    if (pr.bgmUrl) out.notes.push('Background music is not available on the phone yet.');
  }
  if (d) {
    if (d.frame) { out.frame = normalizeFrame(d.frame); out.summary.push('framing'); }
    if (d.adjust) { out.adjust = normalizeAdjust(d.adjust); out.summary.push('adjustments'); }
    const raw = Array.isArray(d.lowerThirds) ? d.lowerThirds : (d.lowerThird ? [d.lowerThird] : null);
    if (raw) {
      out.lowerThirds = normalizeLowerThirds(raw);
      const n = out.lowerThirds.filter((x) => x.enabled).length;
      if (n) out.summary.push(`${n} lower third${n > 1 ? 's' : ''}`);
    }
    out.notes.push(...unsupportedNotes({ frame: out.frame, adjust: out.adjust, design: d }));
  }
  const presets = profile.presets || {};
  if (Array.isArray(presets.adjust)) {
    out.adjustPresets = normalizeUserPresets(presets.adjust).map((p) => ({ name: p.label, adjust: p.values }));
    if (out.adjustPresets.length) out.summary.push(`${out.adjustPresets.length} adjustment preset${out.adjustPresets.length > 1 ? 's' : ''}`);
  }
  if (Array.isArray(presets.designs)) {
    for (const x of presets.designs.slice(0, 40)) {
      if (!x || typeof x.name !== 'string' || !x.data || typeof x.data !== 'object') continue;
      const dd = x.data; const p = { name: x.name };
      if (dd.frame) p.frame = normalizeFrame(dd.frame);
      if (dd.adjust) p.adjust = normalizeAdjust(dd.adjust);
      const raw = Array.isArray(dd.lowerThirds) ? dd.lowerThirds : (dd.lowerThird ? [dd.lowerThird] : null);
      if (raw) p.lts = normalizeLowerThirds(raw);
      if (PHONE_ASPECTS[x.aspect]) p.aspect = x.aspect;
      out.designs.push(p);
    }
    if (out.designs.length) out.summary.push(`${out.designs.length} saved design${out.designs.length > 1 ? 's' : ''}`);
  }
  if (Array.isArray(presets.captionLooks) && presets.captionLooks.length) out.notes.push('Caption looks are not available on the phone yet.');
  if (!out.summary.length) throw new Error('That settings file has nothing the phone can use.');
  return out;
}

export { getAdjustConfig };
