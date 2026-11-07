// Animated lower thirds: a name-strap / announcement / ad banner that slides, pops or types onto the video.
//
// This file is shared by the browser (live preview in the designer) and the server (which draws the same
// frames with @napi-rs/canvas and lays them over every clip with ffmpeg), so what you preview is what
// gets rendered. It therefore uses only the plain canvas 2D API and touches no DOM.
//
// A lower third is plain data (see defaultLowerThird / normalizeLowerThird). drawLowerThird() paints it for
// any moment `t` (seconds from the start of the clip); lowerThirdTimeline() says when it shows.

export const LT_STYLES = [
  { id: 'bar', label: 'Classic bar' },
  { id: 'card', label: 'Modern card' },
  { id: 'banner', label: 'Ad banner (full width)' },
  { id: 'pill', label: 'Call-to-action pill' },
  { id: 'minimal', label: 'Minimal text' },
];
export const LT_IN = [
  { id: 'slide', label: 'Slide in' },
  { id: 'rise', label: 'Rise up' },
  { id: 'fade', label: 'Fade' },
  { id: 'zoom', label: 'Pop (zoom)' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'type', label: 'Typewriter' },
  { id: 'none', label: 'Instant' },
];
export const LT_OUT = [
  { id: 'same', label: 'Same as in' },
  { id: 'slide', label: 'Slide out' },
  { id: 'rise', label: 'Drop down' },
  { id: 'fade', label: 'Fade' },
  { id: 'zoom', label: 'Shrink' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'none', label: 'Instant' },
];
export const LT_LOOPS = [
  { id: 'none', label: 'None' },
  { id: 'shine', label: 'Shine sweep' },
  { id: 'pulse', label: 'Pulse' },
];
/** What the strap does on the LAST part of a run (e.g. "Follow for Part 6" must not appear when there is no part 6). */
export const LT_LAST = [
  { id: 'same', label: 'Same as the other parts' },
  { id: 'hide', label: 'Do not show it' },
  { id: 'text', label: 'Show different text' },
];
export const LT_FONTS = [
  { id: 'archivo', label: 'Archivo Black (heavy)' },
  { id: 'inter', label: 'Inter (clean)' },
  { id: 'oswald', label: 'Oswald (condensed)' },
];
/** Font files, relative to the server's assets/fonts folder (the browser loads them from /assets/fonts/). */
export const LT_FONT_FILES = [
  { family: 'Archivo Black', weight: '400', file: 'ArchivoBlack-Regular.ttf' },
  { family: 'Inter', weight: '800', file: 'Inter-ExtraBold.woff' },
  { family: 'Oswald', weight: '700', file: 'Oswald-Bold.woff' },
];

const FACE = {
  archivo: { weight: 400, stack: '"Archivo Black", Impact, sans-serif', sub: 'inter' },
  inter: { weight: 800, stack: '"Inter", "Segoe UI", Arial, sans-serif', sub: 'inter' },
  oswald: { weight: 700, stack: '"Oswald", Impact, "Arial Narrow", sans-serif', sub: 'oswald' },
};
const fontCss = (id, px) => { const f = FACE[id] || FACE.archivo; return `${f.weight} ${Math.max(1, px)}px ${f.stack}`; };

/** Ready-made starting points; they only fill in the fields, everything stays editable. */
export const LT_PRESETS = [
  { id: 'promo', label: 'Promo / sale', spec: { style: 'banner', tag: 'SALE', title: 'UP TO 50% OFF', subtitle: 'This weekend only', cta: 'SHOP NOW', accent: '#ff3b30', bg: '#111827', font: 'archivo', in: 'slide', out: 'slide', loop: 'shine', align: 'left' } },
  { id: 'sponsor', label: 'Sponsored by…', spec: { style: 'bar', tag: 'SPONSORED', title: 'Your Brand Name', subtitle: 'Use code CLIP10 for 10% off', cta: 'Learn more', accent: '#2f80ed', bg: '#0f172a', font: 'inter', in: 'slide', out: 'slide', loop: 'shine', align: 'left' } },
  // {next} is replaced by each clip's own next part number, so every clip points at the part that follows it; atEnd shows it as the clip ends
  { id: 'follow', label: 'Follow / subscribe', spec: { last: 'text', lastTitle: 'Thanks for watching!', style: 'pill', tag: '', title: 'Follow for Part {next}', subtitle: '', cta: '', accent: '#fe2c55', bg: '#111111', font: 'inter', in: 'zoom', out: 'zoom', loop: 'pulse', align: 'center', hold: 4, repeat: 0, atEnd: true } },
  { id: 'announce', label: 'Announcement', spec: { style: 'card', tag: 'NEW', title: 'New episode every Friday', subtitle: 'Turn on notifications so you never miss it', cta: '', accent: '#f5b301', bg: '#18181b', font: 'inter', in: 'rise', out: 'fade', loop: 'none', align: 'center' } },
  { id: 'name', label: 'Name & title', spec: { style: 'minimal', tag: '', title: 'Speaker Name', subtitle: 'Role · Company', cta: '', accent: '#22d3ee', bg: '#000000', font: 'oswald', in: 'wipe', out: 'fade', loop: 'none', align: 'left' } },
];

const HEX = /^#[0-9a-f]{6}$/i;
const oneOf = (v, list, d) => (list.some((x) => x.id === v) ? v : d);
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

/** A fresh, switched-off lower third. */
export function defaultLowerThird() {
  return {
    enabled: false, style: 'bar', tag: '', title: '', subtitle: '', cta: '',
    accent: '#ff2d55', bg: '#0f172a', text: '#ffffff', font: 'archivo',
    align: 'left', y: null, size: 1,
    in: 'slide', out: 'same', loop: 'shine', speed: 1,
    start: 2, hold: 6, repeat: 0, atEnd: false,
    last: 'same', lastTag: '', lastTitle: 'Thanks for watching!', lastSubtitle: '', lastCta: '',
  };
}

/** Cleans whatever came in (from the browser, or a stored design) into a complete, safe lower third. */
export function normalizeLowerThird(raw) {
  const d = defaultLowerThird();
  const r = raw && typeof raw === 'object' ? raw : {};
  const spec = {
    enabled: !!r.enabled,
    style: oneOf(r.style, LT_STYLES, d.style),
    tag: str(r.tag, 24), title: str(r.title, 70), subtitle: str(r.subtitle, 110), cta: str(r.cta, 26),
    accent: HEX.test(r.accent) ? r.accent : d.accent,
    bg: HEX.test(r.bg) ? r.bg : d.bg,
    text: HEX.test(r.text) ? r.text : d.text,
    font: oneOf(r.font, LT_FONTS, d.font),
    align: ['left', 'center', 'right'].includes(r.align) ? r.align : d.align,
    y: r.y == null || r.y === '' ? null : num(r.y, null, 0.05, 0.95),
    size: num(r.size, 1, 0.5, 1.8),
    in: oneOf(r.in, LT_IN, d.in),
    out: oneOf(r.out, LT_OUT, d.out),
    loop: oneOf(r.loop, LT_LOOPS, d.loop),
    speed: num(r.speed, 1, 0.5, 2),
    start: num(r.start, d.start, 0, 36000),
    hold: num(r.hold, d.hold, 0.5, 120),
    repeat: num(r.repeat, 0, 0, 36000),
    atEnd: !!r.atEnd,
    last: oneOf(r.last, LT_LAST, d.last),
    lastTag: str(r.lastTag, 24), lastTitle: r.lastTitle === undefined ? d.lastTitle : str(r.lastTitle, 70),
    lastSubtitle: str(r.lastSubtitle, 110), lastCta: str(r.lastCta, 26),
  };
  if (spec.repeat > 0) spec.repeat = Math.max(spec.repeat, 1);
  if (!spec.title && !spec.subtitle && !spec.cta && !spec.tag) spec.enabled = false; // nothing to show
  return spec;
}

export const MAX_LOWER_THIRDS = 6;

/**
 * The old built-in "Follow" look had "Follow for Part 2" typed in, which every clip then repeated. In STORED data that exact text
 * now means "Follow for Part {next}". (Only stored data: the text a clip actually shows, "Follow for Part 2" on part 1, must not be
 * turned back into the token when it is drawn.)
 */
export function fixLegacyFollow(spec) {
  return spec && /^follow for part 2$/i.test(String(spec.title || '').trim()) ? { ...spec, title: 'Follow for Part {next}' } : spec;
}

/** A list of lower thirds from whatever was stored: a list, a single one (older designs), or nothing. At least one entry. */
export function normalizeLowerThirds(raw) {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  const out = list.slice(0, MAX_LOWER_THIRDS).map((x) => normalizeLowerThird(fixLegacyFollow(normalizeLowerThird(x))));
  return out.length ? out : [normalizeLowerThird(null)];
}

/** Letters of text that mean "this clip's part number" ({part}) and "the next part's number" ({next}). */
const PART_TOKEN = /\{(part|next)\}/gi;
export function hasPartTokens(spec) { return !!spec && [spec.tag, spec.title, spec.subtitle, spec.cta].some((t) => typeof t === 'string' && /\{(part|next)\}/i.test(t)); }

/**
 * The lower third as it is for ONE clip: {part} / {next} in the text replaced by that clip's part number, and, when it is set
 * to show near the end of the clip, its start worked out from the clip's finished length (`clipDuration`, seconds).
 * Both the live preview and the server draw from this, so a clip numbered Part 4 says "Follow for Part 5" in both.
 */
export function resolveLowerThird(rawSpec, { part = 1, clipDuration = 0, isLast = false } = {}) {
  let spec = normalizeLowerThird(fixLegacyFollow(normalizeLowerThird(rawSpec))); // (rawSpec is stored data here, so the old text is converted)
  if (isLast && spec.last === 'hide') return { ...spec, enabled: false };
  if (isLast && spec.last === 'text') { // the closing words instead of the usual ones; the look and timing stay
    spec = { ...spec, tag: spec.lastTag, title: spec.lastTitle, subtitle: spec.lastSubtitle, cta: spec.lastCta };
    if (!spec.title && !spec.subtitle && !spec.cta && !spec.tag) return { ...spec, enabled: false };
  }
  const n = Math.max(1, Math.round(Number(part)) || 1);
  const sub = (t, max) => str(String(t).replace(PART_TOKEN, (_, k) => String(k.toLowerCase() === 'next' ? n + 1 : n)), max);
  const out = { ...spec, tag: sub(spec.tag, 24), title: sub(spec.title, 70), subtitle: sub(spec.subtitle, 110), cta: sub(spec.cta, 26) };
  if (spec.atEnd && clipDuration > 0) {
    const tl = lowerThirdTimeline({ ...out, repeat: 0 });
    out.repeat = 0;
    out.start = Math.max(0, Math.round((clipDuration - tl.total - 0.5) * 100) / 100); // it has gone by the last half second
    out.atEnd = false;
  }
  return out;
}

/**
 * When a lower third is on screen in a clip, as the timeline shows it: { start, end, repeats: [{ start, end }] } in seconds of the
 * finished clip. `end` is when the first showing is gone (in-animation + stays + out-animation).
 */
export function lowerThirdWindows(rawSpec, { part = 1, clipDuration = 0, isLast = false } = {}) {
  const r = resolveLowerThird(rawSpec, { part, clipDuration, isLast });
  const tl = lowerThirdTimeline(r, clipDuration > 0 ? clipDuration : Infinity);
  const repeats = tl.starts.map((s) => ({ start: s, end: s + tl.total }));
  return { start: r.start, end: r.start + tl.total, total: tl.total, inDur: tl.inDur, outDur: tl.outDur, repeats, atEnd: !!normalizeLowerThird(rawSpec).atEnd };
}

/**
 * The change to a lower third that puts its first showing between `start` and `end` seconds (what dragging a bar on the timeline
 * does): the stay is what is left after the in- and out-animations. Pinning it to a time turns "near the end" off.
 */
export function timingPatch(rawSpec, { start, end }) {
  const spec = normalizeLowerThird(rawSpec);
  const tl = lowerThirdTimeline({ ...spec, repeat: 0 });
  const s = Math.max(0, Math.round(start * 10) / 10);
  const hold = Math.max(0.5, Math.round((end - s - tl.inDur - tl.outDur) * 10) / 10);
  return { start: s, hold, atEnd: false };
}

/** Where the strap sits when the person hasn't dragged it: above TikTok's caption area on tall frames. */
export function autoY(width, height) {
  const ar = width / height;
  if (ar <= 0.6) return 0.7;
  if (ar <= 0.85) return 0.74;
  if (ar <= 1.1) return 0.78;
  return 0.8;
}

// ── timing ──────────────────────────────────────────────────────────────────────────────
const IN_SEC = { slide: 0.55, rise: 0.55, fade: 0.5, zoom: 0.6, wipe: 0.6, type: 1.4, none: 0 };
const OUT_SEC = 0.45;
const outAnim = (spec) => { const o = spec.out === 'same' ? spec.in : spec.out; return o === 'type' ? 'fade' : o; };

/**
 * When the lower third is on screen. `starts` are the moments it appears (several if it repeats);
 * `total` is how long one appearance lasts (animate in + hold + animate out); `cycle` the spacing of repeats.
 */
export function lowerThirdTimeline(spec, clipDuration = Infinity) {
  const sp = Math.max(0.5, spec.speed || 1);
  const inDur = (IN_SEC[spec.in] ?? 0.55) / sp;
  const oa = outAnim(spec);
  const outDur = oa === 'none' ? 0 : OUT_SEC / sp;
  const total = inDur + spec.hold + outDur;
  const cycle = spec.repeat > 0 ? Math.max(spec.repeat, total + 0.3) : 0;
  const starts = [];
  for (let s = spec.start, i = 0; s < clipDuration && i < 500; s += (cycle || Infinity), i++) starts.push(s);
  return { inDur, outDur, hold: spec.hold, total, cycle, starts };
}

/** What the server needs to bake the animation into a looping layer: null if it never shows in this clip. */
export function lowerThirdLayerPlan(spec, clipDuration) {
  const tl = lowerThirdTimeline(spec, clipDuration);
  if (!tl.starts.length) return null;
  return { start: spec.start, seconds: tl.cycle || tl.total, loop: tl.cycle > 0, timeline: tl };
}

function stateAt(spec, tl, t) {
  let s = null;
  for (const st of tl.starts) { if (st <= t + 1e-9) s = st; else break; }
  if (s == null && tl.cycle > 0 && t >= spec.start) s = spec.start + Math.floor((t - spec.start) / tl.cycle) * tl.cycle;
  if (s == null) return null;
  const local = t - s;
  if (local < 0 || local > tl.total) return null;
  if (local < tl.inDur) return { phase: 'in', p: tl.inDur > 0 ? local / tl.inDur : 1, local, hold: 0 };
  if (local <= tl.inDur + tl.hold) return { phase: 'hold', p: 1, local, hold: local - tl.inDur };
  return { phase: 'out', p: tl.outDur > 0 ? (local - tl.inDur - tl.hold) / tl.outDur : 1, local, hold: tl.hold };
}

/** Two moments with the same key draw the same picture, so a renderer can reuse the frame. */
export function lowerThirdFrameKey(spec, tl, t) {
  const st = stateAt(spec, tl, t);
  if (!st) return 'off';
  if (st.phase === 'hold' && spec.loop === 'none' && spec.style !== 'card') return 'hold';
  return null;
}

// ── easing ──────────────────────────────────────────────────────────────────────────────
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeIn = (p) => p * p * p;
const easeBack = (p) => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };

// ── drawing helpers ─────────────────────────────────────────────────────────────────────
function rr(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
};
const onColor = (hex) => (luminance(hex) > 0.45 ? '#111111' : '#ffffff');

function ellipsize(ctx, text, maxW) {
  if (!text || ctx.measureText(text).width <= maxW) return text;
  let lo = 0; let hi = text.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid; else hi = mid - 1; }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Sets the font, shrinks it to fit `maxW` (down to 60 %), and cuts with an ellipsis only as a last resort. */
function fit(ctx, fontId, text, px, maxW) {
  let size = px;
  ctx.font = fontCss(fontId, size);
  let w = ctx.measureText(text).width;
  if (w > maxW) { size = Math.max(px * 0.6, px * (maxW / w)); ctx.font = fontCss(fontId, size); w = ctx.measureText(text).width; }
  const shown = w > maxW ? ellipsize(ctx, text, maxW) : text;
  return { size, text: shown, w: Math.min(w, maxW) };
}

/** Everything measured once: sizes of the text, of the card, and a paint() that draws it at (0,0). */
function layout(ctx, W, H, spec) {
  const u = (W / 1080) * spec.size;
  const sub = FACE[spec.font].sub;
  const isBanner = spec.style === 'banner';
  const maxCard = isBanner ? W : W * 0.9;
  const pad = 28 * u;
  const accent = spec.accent; const bg = spec.bg; const fg = spec.text;

  // text blocks that depend on the style's available width are measured below per style
  const hasTitle = !!spec.title; const hasSub = !!spec.subtitle; const hasTag = !!spec.tag; const hasCta = !!spec.cta;

  const ctaBox = (maxW) => {
    if (!hasCta) return null;
    const f = fit(ctx, spec.font, spec.cta.toUpperCase(), 30 * u, maxW);
    return { ...f, boxW: f.w + 44 * u, boxH: 58 * u };
  };
  const tagBox = () => {
    if (!hasTag) return null;
    const f = fit(ctx, sub, spec.tag.toUpperCase(), 22 * u, 260 * u);
    return { ...f, boxW: f.w + 26 * u, boxH: 36 * u };
  };

  let L;
  if (spec.style === 'banner') {
    const cta = ctaBox(W * 0.28);
    const tag = tagBox();
    const left = (tag ? tag.boxW + 2 * pad * 0.6 : 18 * u + pad * 0.7);
    const room = W - left - pad - (cta ? cta.boxW + pad : 0);
    const t = hasTitle ? fit(ctx, spec.font, spec.title, 64 * u, room) : null;
    const s = hasSub ? fit(ctx, sub, spec.subtitle, 34 * u, room) : null;
    const textH = (t ? t.size * 1.12 : 0) + (t && s ? 8 * u : 0) + (s ? s.size * 1.2 : 0);
    const h = Math.max(128 * u, textH + 2 * pad);
    L = { w: W, h, paint: (c, p) => {
      c.save();
      const g = c.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, rgba(bg, 0.96)); g.addColorStop(1, rgba(bg, 0.86));
      c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 26 * u; c.shadowOffsetY = 6 * u;
      c.fillStyle = g; c.fillRect(0, 0, W, h);
      c.restore();
      shape(c, p, () => { c.beginPath(); c.rect(0, 0, W, h); }, W, h);
      c.fillStyle = accent;
      if (tag) {
        c.fillRect(0, 0, tag.boxW + pad * 0.6, h);
        c.fillStyle = onColor(accent); c.font = fontCss(sub, tag.size); c.textBaseline = 'middle'; c.textAlign = 'center';
        c.fillText(reveal(tag.text, p.tag), (tag.boxW + pad * 0.6) / 2, h / 2);
      } else c.fillRect(0, 0, 18 * u, h);
      let y = (h - textH) / 2;
      c.textAlign = 'left'; c.textBaseline = 'top'; c.fillStyle = fg;
      if (t) { c.font = fontCss(spec.font, t.size); c.fillText(reveal(t.text, p.title), left, y); y += t.size * 1.12 + (s ? 8 * u : 0); }
      if (s) { c.font = fontCss(sub, s.size); c.fillStyle = rgba(fg, 0.85); c.fillText(reveal(s.text, p.sub), left, y); }
      if (cta) drawCta(c, cta, W - pad - cta.boxW, (h - cta.boxH) / 2, accent, p.pulse, spec.font, u);
    } };
  } else if (spec.style === 'pill') {
    const circle = 64 * u;
    const cta = ctaBox(maxCard * 0.3);
    const room = maxCard - 2 * 20 * u - circle - 18 * u - (cta ? cta.boxW + 18 * u : 0) - 30 * u;
    const t = hasTitle ? fit(ctx, spec.font, spec.title, 44 * u, room) : null;
    const s = hasSub ? fit(ctx, sub, spec.subtitle, 28 * u, room) : null;
    const textW = Math.max(t ? t.w : 0, s ? s.w : 0);
    const textH = (t ? t.size * 1.12 : 0) + (t && s ? 4 * u : 0) + (s ? s.size * 1.2 : 0);
    const h = Math.max(circle + 28 * u, textH + 30 * u);
    const w = 20 * u + circle + 18 * u + textW + (cta ? 18 * u + cta.boxW : 0) + 30 * u;
    L = { w, h, paint: (c, p) => {
      const path = () => rr(c, 0, 0, w, h, h / 2);
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 26 * u; c.shadowOffsetY = 8 * u;
      path(); c.fillStyle = rgba(bg, 0.94); c.fill();
      c.restore();
      shape(c, p, path, w, h);
      const cx = 20 * u + circle / 2; const cy = h / 2;
      c.save(); c.translate(cx, cy); c.scale(p.pulse, p.pulse);
      c.beginPath(); c.arc(0, 0, circle / 2, 0, Math.PI * 2); c.fillStyle = accent; c.fill();
      c.fillStyle = onColor(accent); c.beginPath();
      c.moveTo(-circle * 0.12, -circle * 0.22); c.lineTo(circle * 0.24, 0); c.lineTo(-circle * 0.12, circle * 0.22); c.closePath(); c.fill();
      c.restore();
      let y = (h - textH) / 2; const x = 20 * u + circle + 18 * u;
      c.textAlign = 'left'; c.textBaseline = 'top';
      if (t) { c.font = fontCss(spec.font, t.size); c.fillStyle = fg; c.fillText(reveal(t.text, p.title), x, y); y += t.size * 1.12 + (s ? 4 * u : 0); }
      if (s) { c.font = fontCss(sub, s.size); c.fillStyle = rgba(fg, 0.8); c.fillText(reveal(s.text, p.sub), x, y); }
      if (cta) drawCta(c, cta, w - 30 * u - cta.boxW + 12 * u, (h - cta.boxH) / 2, accent, p.pulse, spec.font, u);
    } };
  } else if (spec.style === 'minimal') {
    const room = maxCard;
    const t = hasTitle ? fit(ctx, spec.font, spec.title, 68 * u, room) : null;
    const s = hasSub ? fit(ctx, sub, spec.subtitle, 36 * u, room) : null;
    const tag = hasTag ? fit(ctx, sub, spec.tag.toUpperCase(), 24 * u, room) : null;
    const cta = hasCta ? fit(ctx, spec.font, `${spec.cta.toUpperCase()}  →`, 30 * u, room) : null;
    const lineH = 8 * u;
    const rows = [];
    if (tag) rows.push(['tag', tag.size * 1.2 + 6 * u]);
    if (t) rows.push(['title', t.size * 1.12]);
    rows.push(['line', lineH + 12 * u]);
    if (s) rows.push(['sub', s.size * 1.25]);
    if (cta) rows.push(['cta', cta.size * 1.2 + 10 * u]);
    const h = rows.reduce((a, r) => a + r[1], 0);
    const w = Math.max(t ? t.w : 0, s ? s.w : 0, tag ? tag.w : 0, cta ? cta.w : 0, 120 * u);
    L = { w, h, noShape: true, paint: (c, p) => {
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.65)'; c.shadowBlur = 14 * u; c.shadowOffsetY = 3 * u;
      c.textAlign = spec.align === 'right' ? 'right' : spec.align === 'center' ? 'center' : 'left'; c.textBaseline = 'top';
      const x = spec.align === 'right' ? w : spec.align === 'center' ? w / 2 : 0;
      let y = 0;
      for (const [kind, rh] of rows) {
        if (kind === 'tag') { c.font = fontCss(sub, tag.size); c.fillStyle = accent; c.fillText(reveal(tag.text, p.tag), x, y); }
        else if (kind === 'title') { c.font = fontCss(spec.font, t.size); c.fillStyle = fg; c.fillText(reveal(t.text, p.title), x, y); }
        else if (kind === 'line') {
          const lw = Math.max(80 * u, (t ? t.w : w) * 0.55) * p.line;
          const lx = spec.align === 'right' ? w - lw : spec.align === 'center' ? (w - lw) / 2 : 0;
          c.fillStyle = accent; rr(c, lx, y + 6 * u, lw, lineH, lineH / 2); c.fill();
        } else if (kind === 'sub') { c.font = fontCss(sub, s.size); c.fillStyle = rgba(fg, 0.9); c.fillText(reveal(s.text, p.sub), x, y); }
        else if (kind === 'cta') { c.font = fontCss(spec.font, cta.size); c.fillStyle = accent; c.fillText(cta.text, x, y + 4 * u); }
        y += rh;
      }
      c.restore();
    } };
  } else if (spec.style === 'card') {
    const cta = ctaBox(maxCard * 0.3);
    const tag = hasTag ? fit(ctx, sub, spec.tag.toUpperCase(), 22 * u, 300 * u) : null;
    const room = maxCard - 2 * pad - (cta ? cta.boxW + 24 * u : 0);
    const t = hasTitle ? fit(ctx, spec.font, spec.title, 58 * u, room) : null;
    const s = hasSub ? fit(ctx, sub, spec.subtitle, 32 * u, room) : null;
    const textW = Math.max(t ? t.w : 0, s ? s.w : 0, tag ? tag.w + 30 * u : 0);
    const tagH = tag ? tag.size * 1.2 + 10 * u : 0;
    const textH = tagH + (t ? t.size * 1.12 : 0) + (t && s ? 8 * u : 0) + (s ? s.size * 1.2 : 0);
    const w = pad * 2 + textW + (cta ? 24 * u + cta.boxW : 0);
    const bar = 8 * u;
    const h = Math.max(110 * u, textH + 2 * pad) + bar;
    L = { w, h, paint: (c, p) => {
      const path = () => rr(c, 0, 0, w, h, 30 * u);
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 30 * u; c.shadowOffsetY = 10 * u;
      path(); c.fillStyle = rgba(bg, 0.95); c.fill();
      c.restore();
      shape(c, p, path, w, h);
      let y = (h - bar - textH) / 2;
      c.textAlign = 'left'; c.textBaseline = 'top';
      if (tag) {
        c.fillStyle = accent; c.beginPath(); c.arc(pad + 7 * u, y + tag.size * 0.6, 7 * u, 0, Math.PI * 2); c.fill();
        c.font = fontCss(sub, tag.size); c.fillText(reveal(tag.text, p.tag), pad + 24 * u, y); y += tagH;
      }
      if (t) { c.font = fontCss(spec.font, t.size); c.fillStyle = fg; c.fillText(reveal(t.text, p.title), pad, y); y += t.size * 1.12 + (s ? 8 * u : 0); }
      if (s) { c.font = fontCss(sub, s.size); c.fillStyle = rgba(fg, 0.82); c.fillText(reveal(s.text, p.sub), pad, y); }
      if (cta) drawCta(c, cta, w - pad - cta.boxW, (h - bar - cta.boxH) / 2, accent, p.pulse, spec.font, u);
      // a thin bar that runs down while the card is on screen
      c.save(); path(); c.clip();
      c.fillStyle = rgba(fg, 0.12); c.fillRect(0, h - bar, w, bar);
      c.fillStyle = accent; c.fillRect(0, h - bar, w * clamp01(p.timer), bar);
      c.restore();
    } };
  } else { // 'bar'
    const cta = ctaBox(maxCard * 0.3);
    const tag = tagBox();
    const stripe = 14 * u;
    const room = maxCard - stripe - 2 * pad - (cta ? cta.boxW + 28 * u : 0);
    const t = hasTitle ? fit(ctx, spec.font, spec.title, 58 * u, room) : null;
    const s = hasSub ? fit(ctx, sub, spec.subtitle, 34 * u, room) : null;
    const textW = Math.max(t ? t.w : 0, s ? s.w : 0, tag ? tag.boxW : 0);
    const textH = (t ? t.size * 1.12 : 0) + (t && s ? 8 * u : 0) + (s ? s.size * 1.2 : 0);
    const w = stripe + pad + textW + (cta ? 28 * u + cta.boxW : 0) + pad;
    const h = Math.max(104 * u, textH + 2 * pad);
    L = { w, h, paint: (c, p) => {
      const path = () => { c.beginPath(); c.rect(0, 0, w, h); };
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 24 * u; c.shadowOffsetY = 6 * u;
      c.fillStyle = rgba(bg, 0.94); c.fillRect(0, 0, w, h);
      c.restore();
      shape(c, p, path, w, h);
      c.fillStyle = accent; c.fillRect(0, 0, stripe, h);
      if (tag) {
        c.fillStyle = accent; c.fillRect(stripe, -tag.boxH, tag.boxW, tag.boxH);
        c.fillStyle = onColor(accent); c.font = fontCss(sub, tag.size); c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(reveal(tag.text, p.tag), stripe + tag.boxW / 2, -tag.boxH / 2 + 1 * u);
      }
      let y = (h - textH) / 2; const x = stripe + pad;
      c.textAlign = 'left'; c.textBaseline = 'top';
      if (t) { c.font = fontCss(spec.font, t.size); c.fillStyle = fg; c.fillText(reveal(t.text, p.title), x, y); y += t.size * 1.12 + (s ? 8 * u : 0); }
      if (s) { c.font = fontCss(sub, s.size); c.fillStyle = rgba(fg, 0.85); c.fillText(reveal(s.text, p.sub), x, y); }
      if (cta) drawCta(c, cta, w - pad - cta.boxW, (h - cta.boxH) / 2, accent, p.pulse, spec.font, u);
    } };
  }

  // placement
  const margin = 0.06 * W;
  let x = isBanner ? 0 : spec.align === 'right' ? W - margin - L.w : spec.align === 'center' ? (W - L.w) / 2 : margin;
  if (spec.style === 'minimal' && spec.align === 'center') x = (W - L.w) / 2;
  const cy = (spec.y == null ? autoY(W, H) : spec.y) * H;
  const y = Math.max(0, Math.min(H - L.h, cy - L.h / 2));
  return { ...L, x, y, u };
}

// A shine sweep is drawn clipped to the card shape. `shape` records the path and applies it once painting
// of the card body is done (the card body itself is drawn by each style before calling this).
function shape(c, p, pathFn, w, h) {
  if (!p.shine || p.shine <= 0) return;
  c.save();
  pathFn(); c.clip();
  const bandW = Math.max(60, w * 0.22);
  const x = -bandW + (w + bandW * 2) * p.shine;
  c.translate(x, 0);
  c.transform(1, 0, -0.35, 1, 0, 0);
  const g = c.createLinearGradient(-bandW / 2, 0, bandW / 2, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.28)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(-bandW / 2, -4, bandW, h + 8);
  c.restore();
}

function drawCta(c, cta, x, y, accent, pulse, fontId, u) {
  c.save();
  c.translate(x + cta.boxW / 2, y + cta.boxH / 2); c.scale(pulse, pulse);
  rr(c, -cta.boxW / 2, -cta.boxH / 2, cta.boxW, cta.boxH, cta.boxH / 2);
  c.fillStyle = accent; c.fill();
  c.fillStyle = onColor(accent); c.font = fontCss(fontId, cta.size); c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(cta.text, 0, 1 * u);
  c.restore();
}

/** Typewriter: the first part of a string (everything when `frac` is 1 or undefined). */
function reveal(text, frac) {
  if (frac == null || frac >= 1) return text;
  return text.slice(0, Math.max(0, Math.ceil(text.length * frac)));
}

/** The rectangle the strap occupies (before any animation) - for placing a drag handle or cropping a layer. */
export function measureLowerThird(ctx, W, H, spec) {
  const L = layout(ctx, W, H, spec);
  return { x: L.x, y: L.y, w: L.w, h: L.h, u: L.u };
}

/** A horizontal band of the frame that fully contains the strap while it animates (for a small layer). */
export function lowerThirdBand(ctx, W, H, spec) {
  const m = measureLowerThird(ctx, W, H, spec);
  const pad = 150 * m.u;
  const y0 = Math.max(0, Math.floor(m.y - pad));
  const y1 = Math.min(H, Math.ceil(m.y + m.h + pad));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { y0: Math.min(y0, Math.max(0, H - 2)), h: Math.min(H - Math.min(y0, Math.max(0, H - 2)), even(y1 - y0)) };
}

/**
 * Paints the lower third as it looks `t` seconds into the clip. Draws nothing (and returns false) when it is
 * not on screen. The canvas should be transparent beforehand; `W` x `H` is the size of the whole frame, and
 * `offsetY` shifts the drawing up when only a band of the frame is being rendered.
 */
export function drawLowerThird(ctx, W, H, rawSpec, t, { offsetY = 0 } = {}) {
  const spec = normalizeLowerThird(rawSpec);
  if (!spec.enabled) return false;
  const tl = lowerThirdTimeline(spec);
  const st = stateAt(spec, lowerThirdTimeline(spec, t + 1), t);
  if (!st) return false;
  const L = layout(ctx, W, H, spec);
  const u = L.u;

  // how visible it is (0..1) and the shape of the animation
  let anim = spec.in; let e = 1;
  if (st.phase === 'in') e = anim === 'zoom' ? easeBack(clamp01(st.p)) : easeOut(clamp01(st.p));
  else if (st.phase === 'out') { anim = outAnim(spec); e = 1 - easeIn(clamp01(st.p)); }
  if (anim === 'type' && st.phase !== 'in') anim = 'none';

  let alpha = 1; let dx = 0; let dy = 0; let sc = 1; let wipe = 1;
  const dir = spec.align === 'right' ? 1 : -1;
  if (anim === 'slide') { dx = (1 - e) * dir * (L.w + L.x + 80 * u); alpha = clamp01(e * 2.5); if (spec.style === 'banner') dx = (1 - e) * -W; }
  else if (anim === 'rise') { dy = (1 - e) * 90 * u; alpha = clamp01(e); }
  else if (anim === 'fade') alpha = clamp01(e);
  else if (anim === 'zoom') { sc = 0.72 + 0.28 * e; alpha = clamp01(e * 2); }
  else if (anim === 'wipe') { wipe = clamp01(e); alpha = clamp01(e * 3); }
  else if (anim === 'type') alpha = clamp01(e * 4);
  if (st.phase === 'out' && anim === 'none') return false;

  const typed = anim === 'type' && st.phase === 'in';
  const hold = st.phase === 'hold' ? st.hold : st.phase === 'out' ? tl.hold : 0;
  const shineActive = spec.loop === 'shine' && st.phase !== 'in' ? ((hold + (st.phase === 'out' ? 0 : 0)) % 2.6) / 0.95 : 0;
  const pulseOn = spec.loop === 'pulse' && st.phase !== 'in';
  const p = {
    shine: shineActive > 0 && shineActive < 1 ? shineActive : 0,
    pulse: pulseOn ? 1 + 0.06 * (0.5 + 0.5 * Math.sin((hold * 2 * Math.PI) / 1.2)) : 1,
    timer: st.phase === 'in' ? 1 : st.phase === 'hold' ? 1 - hold / Math.max(0.01, tl.hold) : 0,
    line: st.phase === 'in' ? clamp01((e - 0.35) / 0.65) : 1,
    tag: typed ? clamp01(e / 0.25) : 1,
    title: typed ? clamp01((e - 0.15) / 0.55) : 1,
    sub: typed ? clamp01((e - 0.6) / 0.4) : 1,
  };

  ctx.save();
  ctx.translate(0, -offsetY);
  ctx.globalAlpha = alpha;
  ctx.translate(L.x + dx, L.y + dy);
  if (sc !== 1) { ctx.translate(L.w / 2, L.h / 2); ctx.scale(sc, sc); ctx.translate(-L.w / 2, -L.h / 2); }
  if (anim === 'wipe') {
    ctx.beginPath();
    const cw = (L.w + 20 * u) * wipe;
    if (spec.align === 'right' && spec.style !== 'banner') ctx.rect(L.w + 10 * u - cw, -120 * u, cw, L.h + 240 * u);
    else ctx.rect(-10 * u, -120 * u, cw, L.h + 240 * u);
    ctx.clip();
  }
  L.paint(ctx, p);
  ctx.restore();
  return true;
}
