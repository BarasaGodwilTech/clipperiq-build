// Clip adjustments: speed, pitch, flip, scale, colour and reverb applied to every clip.
//
// Shared by the browser (live preview) and the server (ffmpeg), exactly like js/shared/framing.js, so both sides
// read the same numbers. The settings live in config/clip-adjustments.json (limits, defaults, system presets,
// aspect-ratio rules); the copy below is only the fallback used when that file can't be read.
//
// The picture part rides on the framing path: `scale` multiplies the framing zoom (effectiveFrame), so the
// video is placed by the same videoRect() maths in the preview and in the render; flips, speed and colour
// are applied to the source picture before it is placed.
//
//   speed          1 = unchanged (x)
//   preservePitch  true: speed changes the tempo only; false: pitch moves with the speed (like a tape)
//   pitch          extra pitch shift in semitones
//   flipH / flipV  mirror the picture
//   scale          extra zoom in percent (100 = none)
//   brightness / contrast / saturation   change in percent (0 = none)
//   reverb         amount of room echo in percent (0 = none)
//   duck           background music dips under the voice (only matters when music is added)

import { normalizeFrame } from './framing.js';

export const ADJUST_FALLBACK_CONFIG = {
  version: 1,
  limits: {
    speed: { min: 0.5, max: 2, step: 0.01 },
    pitch: { min: -12, max: 12, step: 0.1 },
    scale: { min: 100, max: 150, step: 1 },
    color: { min: -30, max: 30, step: 1 },
    reverb: { min: 0, max: 100, step: 1 },
  },
  defaults: {
    speed: 1, preservePitch: true, pitch: 0, flipH: false, flipV: false, scale: 100,
    brightness: 0, contrast: 0, saturation: 0, reverb: 0, duck: true,
  },
  userPresetLimit: 30,
  systemPresets: [{ id: 'original', label: 'Original (no adjustments)', description: 'Every control back to its default.', values: {} }],
  aspectRules: {
    enabled: true,
    rules: [
      { aspect: '9:16', source: 'landscape', minSourceRatio: 1.5, frame: 'yt-blur', note: '16:9 source in a 9:16 frame: fit the whole video on a blurred background' },
      { aspect: '1:1', source: 'any', frame: 'fill', note: 'centre crop from the middle of the source' },
      { aspect: '4:5', source: 'any', frame: 'fill', note: 'centre crop from the middle of the source' },
    ],
  },
};

// Hard bounds: whatever the JSON says, the values can never leave what ffmpeg can do safely.
const HARD = {
  speed: [0.5, 2], pitch: [-12, 12], scale: [100, 300], color: [-100, 100], reverb: [0, 100],
};

const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

let CONFIG = clean(ADJUST_FALLBACK_CONFIG);

function limit(raw, fb, hard) {
  const lo = num(raw && raw.min, fb.min, hard[0], hard[1]);
  const hi = num(raw && raw.max, fb.max, hard[0], hard[1]);
  const step = num(raw && raw.step, fb.step, 0.001, 100);
  return lo <= hi ? { min: lo, max: hi, step } : { ...fb };
}

function clean(raw) {
  const fb = ADJUST_FALLBACK_CONFIG;
  const r = isObj(raw) ? raw : {};
  const lim = isObj(r.limits) ? r.limits : {};
  const limits = {
    speed: limit(lim.speed, fb.limits.speed, HARD.speed),
    pitch: limit(lim.pitch, fb.limits.pitch, HARD.pitch),
    scale: limit(lim.scale, fb.limits.scale, HARD.scale),
    color: limit(lim.color, fb.limits.color, HARD.color),
    reverb: limit(lim.reverb, fb.limits.reverb, HARD.reverb),
  };
  const dRaw = isObj(r.defaults) ? r.defaults : {};
  const defaults = fieldsFrom({ ...fb.defaults, ...dRaw }, limits, fb.defaults);
  const seen = new Set();
  const systemPresets = [];
  for (const p of Array.isArray(r.systemPresets) ? r.systemPresets : fb.systemPresets) {
    if (!isObj(p) || typeof p.label !== 'string' || !p.label.trim()) continue;
    const id = String(p.id || p.label).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    systemPresets.push({ id, label: p.label.trim().slice(0, 60), description: String(p.description || '').slice(0, 160), system: true, values: isObj(p.values) ? fieldsFrom({ ...defaults, ...p.values }, limits, defaults) : { ...defaults } });
  }
  if (!systemPresets.length) systemPresets.push({ ...fb.systemPresets[0], system: true, values: { ...defaults } });
  const ar = isObj(r.aspectRules) ? r.aspectRules : fb.aspectRules;
  const rules = (Array.isArray(ar.rules) ? ar.rules : []).filter((x) => isObj(x) && typeof x.aspect === 'string' && typeof x.frame === 'string')
    .map((x) => ({ aspect: x.aspect, source: x.source === 'landscape' ? 'landscape' : 'any', minSourceRatio: num(x.minSourceRatio, 1.5, 1, 10), frame: x.frame, note: String(x.note || '').slice(0, 160) }));
  return {
    version: 1, limits, defaults, systemPresets,
    userPresetLimit: Math.round(num(r.userPresetLimit, fb.userPresetLimit, 0, 200)),
    aspectRules: { enabled: ar.enabled !== false, rules },
  };
}

/** Installs the settings read from config/clip-adjustments.json (anything unusable falls back to the built-ins). */
export function setAdjustConfig(raw) { CONFIG = clean(raw); return CONFIG; }
export function getAdjustConfig() { return CONFIG; }

/** Loads config/clip-adjustments.json in the browser; keeps the built-ins if it can't be read. */
export async function loadAdjustConfig(url = '/config/clip-adjustments.json') {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.ok) setAdjustConfig(await res.json());
  } catch { /* offline or missing: the built-ins apply */ }
  return CONFIG;
}

function fieldsFrom(raw, limits, d) {
  const lc = limits.color;
  return {
    speed: round(num(raw.speed, d.speed, limits.speed.min, limits.speed.max)),
    preservePitch: raw.preservePitch === undefined ? !!d.preservePitch : !!raw.preservePitch,
    pitch: round(num(raw.pitch, d.pitch, limits.pitch.min, limits.pitch.max)),
    flipH: !!raw.flipH,
    flipV: !!raw.flipV,
    scale: round(num(raw.scale, d.scale, limits.scale.min, limits.scale.max)),
    brightness: round(num(raw.brightness, d.brightness, lc.min, lc.max)),
    contrast: round(num(raw.contrast, d.contrast, lc.min, lc.max)),
    saturation: round(num(raw.saturation, d.saturation, lc.min, lc.max)),
    reverb: round(num(raw.reverb, d.reverb, limits.reverb.min, limits.reverb.max)),
    duck: raw.duck === undefined ? d.duck !== false : raw.duck !== false,
  };
}

export function defaultAdjust() { return { ...CONFIG.defaults }; }

/** Cleans a stored / received set of adjustments: unknown keys dropped, every number held inside its limits. */
export function normalizeAdjust(raw) {
  if (!isObj(raw)) return defaultAdjust();
  return fieldsFrom({ ...CONFIG.defaults, ...raw }, CONFIG.limits, CONFIG.defaults);
}

/** True when nothing would change in the clip (so the render stays exactly as before). */
export function isDefaultAdjust(a) {
  const n = normalizeAdjust(a);
  return Math.abs(n.speed - 1) < 1e-6 && Math.abs(n.pitch) < 1e-6 && !n.flipH && !n.flipV && Math.abs(n.scale - 100) < 1e-6
    && !n.brightness && !n.contrast && !n.saturation && !n.reverb;
}

/** The look of a stored value for the clips screen: 'Speed 1.05x, flip, zoom 104%' ... */
export function describeAdjust(a) {
  const n = normalizeAdjust(a); const out = [];
  if (Math.abs(n.speed - 1) > 1e-6) out.push(`${n.speed}x`);
  if (Math.abs(n.pitch) > 1e-6) out.push(`pitch ${n.pitch > 0 ? '+' : ''}${n.pitch}`);
  if (n.flipH) out.push('flip H');
  if (n.flipV) out.push('flip V');
  if (n.scale !== 100) out.push(`zoom ${n.scale}%`);
  if (n.brightness || n.contrast || n.saturation) out.push('colour');
  if (n.reverb) out.push(`reverb ${n.reverb}%`);
  return out.join(', ');
}

/**
 * The framing the picture is really placed with: the chosen framing, zoomed by the adjustment's scale. Preview and
 * render both place the video from THIS, through framing.videoRect(), so they cannot disagree.
 */
export function effectiveFrame(frame, adj) {
  const f = normalizeFrame(frame);
  const a = normalizeAdjust(adj);
  return a.scale === 100 ? f : normalizeFrame({ ...f, zoom: f.zoom * (a.scale / 100) });
}

/** What the renderer needs, worked out once (all plain numbers). */
export function adjustPlan(adj) {
  const a = normalizeAdjust(adj);
  const r = 2 ** (a.pitch / 12); // pitch ratio of the extra shift
  const colour = a.brightness || a.contrast || a.saturation
    ? { brightness: round(a.brightness / 100, 4), contrast: round(1 + a.contrast / 100, 4), saturation: round(1 + a.saturation / 100, 4) } : null;
  const wet = a.reverb / 100;
  return {
    speed: a.speed,
    pitchRatio: r,
    preservePitch: a.preservePitch,
    flipH: a.flipH, flipV: a.flipV,
    colour,
    echo: wet > 0 ? { decay1: round(Math.min(0.6, wet * 6), 3), decay2: round(Math.min(0.36, wet * 3.6), 3), outGain: round(1 - Math.min(0.3, wet * 3), 3) } : null,
    duck: a.duck,
    audioChanges: Math.abs(a.speed - 1) > 1e-6 || Math.abs(a.pitch) > 1e-6 || wet > 0,
  };
}

/** How the preview shows the adjustments on the picture (CSS) and on playback. */
export function previewStyle(adj) {
  const a = normalizeAdjust(adj);
  const flip = `${a.flipH ? 'scaleX(-1)' : ''} ${a.flipV ? 'scaleY(-1)' : ''}`.trim();
  const filter = a.brightness || a.contrast || a.saturation
    ? `brightness(${1 + a.brightness / 100}) contrast(${1 + a.contrast / 100}) saturate(${1 + a.saturation / 100})` : '';
  return { transform: flip, filter, playbackRate: a.speed, preservesPitch: a.preservePitch };
}

// ── presets ──────────────────────────────────────────────────────────────────────────────
export function systemPresets() { return CONFIG.systemPresets.map((p) => ({ ...p, values: { ...p.values } })); }

/** Cleans the presets a person saved in the browser (never trusts what is stored). */
export function normalizeUserPresets(list) {
  const out = []; const used = new Set(CONFIG.systemPresets.map((p) => p.id));
  for (const p of Array.isArray(list) ? list : []) {
    if (!isObj(p) || typeof p.label !== 'string' || !p.label.trim()) continue;
    const id = String(p.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || `u${Date.now().toString(36)}${out.length}`;
    if (used.has(id)) continue;
    used.add(id);
    out.push({ id, label: p.label.trim().slice(0, 60), description: '', system: false, values: normalizeAdjust(p.values) });
  }
  return out.slice(0, CONFIG.userPresetLimit);
}

// ── aspect ratio -> framing ──────────────────────────────────────────────────────────────
/**
 * The framing rule for an aspect ratio and a source size (the Update 10 framing presets):
 *   9:16 with a landscape source -> a framing preset ('yt-blur': fit the whole video on a blurred background)
 *   1:1 / 4:5                    -> centre crop; the crop box is worked out from the source size
 * Returns { ruleFrame, crop, note } or null when no rule applies (e.g. 'original', or rules switched off).
 * `framePresets` is FRAME_PRESETS from framing.js.
 */
export function aspectPlan(aspect, srcW, srcH, framePresets = []) {
  const ar = CONFIG.aspectRules;
  if (!ar.enabled) return null;
  const ratio = srcW > 0 && srcH > 0 ? srcW / srcH : 0;
  const rule = ar.rules.find((x) => x.aspect === aspect && (x.source !== 'landscape' || (ratio >= x.minSourceRatio)));
  if (!rule) return null;
  const preset = framePresets.find((p) => p.id === rule.frame);
  if (!preset) return null;
  let crop = null;
  const [aw, ah] = String(aspect).split(':').map(Number);
  if (preset.frame.mode === 'fill' && aw > 0 && ah > 0 && ratio > 0) {
    const r = aw / ah;
    crop = ratio > r ? { w: Math.round(srcH * r), h: srcH } : { w: srcW, h: Math.round(srcW / r) };
  }
  return { ruleFrame: { ...preset.frame }, crop, note: rule.note || '' };
}
