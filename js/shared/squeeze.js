// Squeeze screens ("L-bar" / squeeze-back): the programme shrinks into a window while a branded frame animates in around it,
// then expands back to full screen. Shared by the editor preview, the server render and the phone, so what is previewed is what
// is rendered.
//
// How it is built:
//   * squeezeAmount(spec, timeline, t)  how squeezed the picture is at time t: 0 = full screen, 1 = in its window (an eased move)
//   * drawSqueeze(ctx, W, H, spec, t)   draws the FRAME for that moment: an opaque background with a window cut out where the
//                                       picture shows, plus the animated panels, texts and images. It is laid OVER the picture.
//   * squeezeExpr(...)                  the same movement as ffmpeg expressions, so the renderer can shrink the picture to match
//                                       the window the frame was drawn with.
import { LT_FONTS } from './lowerThird.js';

export const SQ_MAX_IMAGE_BYTES = 450 * 1024;
export const SQ_TRANSITIONS = [
  { id: 'ease', label: 'Smooth glide' },
  { id: 'back', label: 'Bounce' },
  { id: 'snap', label: 'Quick snap' },
];
export const SQ_LOOPS = [
  { id: 'none', label: 'Still' },
  { id: 'shine', label: 'Shine sweep' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'ticker', label: 'Scrolling ticker' },
];
const LOOP_PERIOD = { none: 0, shine: 2.4, pulse: 1.6, ticker: 6 };
export const SQ_LOOP_PERIOD = LOOP_PERIOD;

// ───────────────────────────── templates ─────────────────────────────
export const SQ_TEMPLATES = [
  { id: 'lbar', label: 'L-Bar Classic', desc: 'Product column and offer bar, like a TV ad break', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#7a1230', secondary: '#3a0a1c', accent: '#ffd400', text: '#ffffff' } },
  { id: 'bottom', label: 'Bottom Banner', desc: 'Picture on top, an offer banner slides up', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#0b3b8f', secondary: '#061d4a', accent: '#ffb703', text: '#ffffff' } },
  { id: 'side', label: 'Side Panel', desc: 'Picture to the left, a call-to-action panel on the right', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#14532d', secondary: '#052e16', accent: '#a3e635', text: '#ffffff' } },
  { id: 'corner', label: 'Corner Pop', desc: 'A small picture with huge type and a spinning sticker', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#ff3d71', secondary: '#7b1fa2', accent: '#ffe14d', text: '#ffffff' } },
  { id: 'card', label: 'Soft Card', desc: 'A rounded card floating over a gradient with soft shapes', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#6d28d9', secondary: '#1e1b4b', accent: '#f0abfc', text: '#ffffff' } },
  { id: 'neon', label: 'Neon Frame', desc: 'Dark stage, a glowing frame around the picture', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#0a0a1a', secondary: '#05050f', accent: '#22f0ff', text: '#ffffff' } },
  { id: 'news', label: 'Breaking Ticker', desc: 'News look with a LIVE badge and a scrolling ticker', loops: ['none', 'ticker', 'pulse'],
    colors: { primary: '#b91c1c', secondary: '#111827', accent: '#ffffff', text: '#ffffff' } },
  { id: 'burst', label: 'Sale Burst', desc: 'Rotating rays and a bouncing discount badge', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#ea580c', secondary: '#9a3412', accent: '#fde047', text: '#ffffff' } },
  { id: 'story', label: 'Story Stack', desc: 'Made for tall (9:16) videos: title, picture, button; wide videos get the Soft Card look', loops: ['none', 'shine', 'pulse'],
    colors: { primary: '#0f766e', secondary: '#042f2e', accent: '#fbbf24', text: '#ffffff' } },
];
const TEMPLATE = (id) => SQ_TEMPLATES.find((t) => t.id === id) || SQ_TEMPLATES[0];

// the window the picture shrinks into: scale of the full frame, and where its top-left corner sits (fractions of the frame)
const WIN = {
  lbar:   { landscape: { s: 0.665, x: 0.305, y: 0.035 }, portrait: { s: 0.66, x: 0.17, y: 0.03 },  square: { s: 0.70, x: 0.27, y: 0.03 } },
  bottom: { landscape: { s: 0.70, x: 0.15, y: 0.035 },   portrait: { s: 0.68, x: 0.16, y: 0.03 },  square: { s: 0.72, x: 0.14, y: 0.03 } },
  side:   { landscape: { s: 0.62, x: 0.025, y: 0.19 },   portrait: { s: 0.60, x: 0.20, y: 0.03 },  square: { s: 0.60, x: 0.03, y: 0.19 } },
  corner: { landscape: { s: 0.46, x: 0.03, y: 0.05 },    portrait: { s: 0.60, x: 0.04, y: 0.04 },  square: { s: 0.50, x: 0.04, y: 0.04 } },
  card:   { landscape: { s: 0.68, x: 0.16, y: 0.09 },    portrait: { s: 0.66, x: 0.17, y: 0.08 },  square: { s: 0.70, x: 0.15, y: 0.08 } },
  neon:   { landscape: { s: 0.62, x: 0.19, y: 0.07 },    portrait: { s: 0.70, x: 0.15, y: 0.06 },  square: { s: 0.62, x: 0.19, y: 0.07 } },
  news:   { landscape: { s: 0.60, x: 0.03, y: 0.07 },    portrait: { s: 0.62, x: 0.19, y: 0.03 },  square: { s: 0.66, x: 0.04, y: 0.06 } },
  burst:  { landscape: { s: 0.58, x: 0.04, y: 0.14 },    portrait: { s: 0.58, x: 0.21, y: 0.03 },  square: { s: 0.60, x: 0.05, y: 0.15 } },
  story:  { landscape: { s: 0.68, x: 0.16, y: 0.09 },    portrait: { s: 0.68, x: 0.16, y: 0.14 },  square: { s: 0.70, x: 0.15, y: 0.08 } },
};
export const sqKind = (W, H) => { const r = W / H; return r > 1.2 ? 'landscape' : r < 0.8 ? 'portrait' : 'square'; };

// ───────────────────────────── the spec ─────────────────────────────
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : d);
const oneOf = (v, list, d) => (list.some((o) => o.id === v) ? v : d);
const image = (v) => (typeof v === 'string' && /^data:image\/(png|jpe?g|webp);base64,/i.test(v) && v.length <= SQ_MAX_IMAGE_BYTES * 1.4 ? v : '');

export function defaultSqueeze(template = 'lbar') {
  const t = TEMPLATE(template);
  return {
    enabled: false, template: t.id,
    brand: 'Your Brand', headline: '36%', sub: 'OFF', title: 'PRODUCT NAME', caption: 'A short line about the offer', cta: 'Scan and check it out!', badge: '',
    ticker: 'Breaking: big news from our brand  •  follow for more  •  new offers every week',
    ...t.colors, font: 'archivo',
    transition: 'ease', loop: t.loops.includes('shine') ? 'shine' : t.loops[1] || 'none', speed: 1,
    start: 2, hold: 8, repeat: 0, atEnd: false, scale: 1, mirror: false,
    images: { logo: '', product: '', qr: '' },
  };
}

export function normalizeSqueeze(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const t = TEMPLATE(r.template);
  const d = defaultSqueeze(t.id);
  const im = r.images && typeof r.images === 'object' ? r.images : {};
  const loop = oneOf(r.loop, SQ_LOOPS, d.loop);
  return {
    enabled: !!r.enabled, template: t.id,
    brand: r.brand === undefined ? d.brand : str(r.brand, 40), headline: r.headline === undefined ? d.headline : str(r.headline, 14),
    sub: r.sub === undefined ? d.sub : str(r.sub, 22), title: r.title === undefined ? d.title : str(r.title, 60),
    caption: r.caption === undefined ? d.caption : str(r.caption, 110), cta: r.cta === undefined ? d.cta : str(r.cta, 40),
    badge: r.badge === undefined ? d.badge : str(r.badge, 14), ticker: r.ticker === undefined ? d.ticker : str(r.ticker, 220),
    primary: hex(r.primary, d.primary), secondary: hex(r.secondary, d.secondary), accent: hex(r.accent, d.accent), text: hex(r.text, d.text),
    font: oneOf(r.font, LT_FONTS, d.font),
    transition: oneOf(r.transition, SQ_TRANSITIONS, d.transition),
    loop: t.loops.includes(loop) ? loop : d.loop,
    speed: num(r.speed, 1, 0.5, 2),
    start: num(r.start, 2, 0, 600), hold: num(r.hold, 8, 1.5, 300), repeat: num(r.repeat, 0, 0, 600), atEnd: !!r.atEnd,
    scale: num(r.scale, 1, 0.8, 1.15), mirror: !!r.mirror,
    images: { logo: image(im.logo), product: image(im.product), qr: image(im.qr) },
  };
}

/** A spec for one clip: {part} / {next} filled in, and "near the end" worked out. */
export function resolveSqueeze(rawSpec, { part = 1, clipDuration = 0 } = {}) {
  const spec = normalizeSqueeze(rawSpec);
  const sub = (s, max) => String(s || '').replace(/\{part\}/gi, String(part)).replace(/\{next\}/gi, String(part + 1)).slice(0, max);
  const out = { ...spec, brand: sub(spec.brand, 40), headline: sub(spec.headline, 14), sub: sub(spec.sub, 22), title: sub(spec.title, 60), caption: sub(spec.caption, 110), cta: sub(spec.cta, 40), badge: sub(spec.badge, 14), ticker: sub(spec.ticker, 220) };
  if (spec.atEnd && clipDuration > 0) {
    const tl = squeezeTimeline({ ...out, repeat: 0 });
    out.repeat = 0; out.start = Math.max(0, Math.round((clipDuration - tl.total - 0.4) * 100) / 100); out.atEnd = false;
  }
  return out;
}

// ───────────────────────────── time and movement ─────────────────────────────
/** inDur / outDur: the move in and out; total; cycle: how often it repeats (0 = once); starts: when each showing begins. */
export function squeezeTimeline(spec, clipDuration = Infinity) {
  const sp = spec.speed || 1;
  const inDur = 0.9 / sp; const outDur = 0.7 / sp;
  const total = inDur + spec.hold + outDur;
  const cycle = spec.repeat > 0 ? Math.max(spec.repeat, total + 0.4) : 0;
  const starts = [];
  for (let s = spec.start, i = 0; s < clipDuration && i < 200; s += (cycle || Infinity), i++) starts.push(s);
  return { inDur, outDur, hold: spec.hold, total, cycle, starts };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
// The easing curves. Each exists twice: as a function here, and as an ffmpeg expression below. Keep them identical.
const EASE_IN = {
  ease: (p) => 1 - Math.pow(1 - p, 3),
  back: (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2),
  snap: (p) => 1 - Math.pow(1 - p, 5),
};
const easeOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const EXPR_IN = {
  ease: (P) => `(1-pow(1-(${P}),3))`,
  back: (P) => `(1+2.70158*pow((${P})-1,3)+1.70158*pow((${P})-1,2))`,
  snap: (P) => `(1-pow(1-(${P}),5))`,
};
const exprOut = (P) => `if(lt((${P}),0.5),4*pow((${P}),3),1-pow(-2*(${P})+2,3)/2)`;

/** How squeezed the picture is at time t (0 = full screen, 1 = in its window; "bounce" overshoots a little). */
export function squeezeAmount(spec, tl, t) {
  let tt = t - spec.start;
  if (tt < 0) return 0;
  if (tl.cycle > 0) tt %= tl.cycle;
  if (tt >= tl.total) return 0;
  if (tt < tl.inDur) return (EASE_IN[spec.transition] || EASE_IN.ease)(clamp01(tt / tl.inDur));
  if (tt < tl.inDur + tl.hold) return 1;
  return 1 - easeOut(clamp01((tt - tl.inDur - tl.hold) / tl.outDur));
}

/** The window the picture ends up in, in pixels of a W x H frame. */
export function squeezeWindow(spec, W, H) {
  const k = sqKind(W, H); const w = (WIN[spec.template] || WIN.lbar)[k];
  const s = w.s * spec.scale; const cx = (w.x + w.s / 2) * W; const cy = (w.y + w.s / 2) * H;
  const ww = s * W; const wh = s * H;
  let x = cx - ww / 2; let y = cy - wh / 2;
  x = Math.max(W * 0.012, Math.min(W - ww - W * 0.012, x)); y = Math.max(H * 0.012, Math.min(H - wh - H * 0.012, y));
  if (spec.mirror) x = W - x - ww;
  return { x, y, w: ww, h: wh };
}
export const squeezeRect = (win, W, H, a) => ({ x: a * win.x, y: a * win.y, w: W + a * (win.w - W), h: H + a * (win.h - H) });

/** Overscan: the picture is drawn a few pixels bigger than the window so a rounding difference never shows a gap. */
export const SQ_OVERSCAN = 4;

/**
 * The movement of the picture as ffmpeg expressions (variable t = seconds of the clip), for the scale and overlay filters:
 *   { w, h, x, y }
 */
export function squeezeExpr(spec, W, H) {
  const tl = squeezeTimeline(spec); const win = squeezeWindow(spec, W, H);
  const f = (n) => Number(n).toFixed(4);
  const tt = tl.cycle > 0 ? `if(lt(t,${f(spec.start)}),-1,mod(t-${f(spec.start)},${f(tl.cycle)}))` : `(t-${f(spec.start)})`;
  const pin = `clip(${tt}/${f(tl.inDur)},0,1)`;
  const pout = `clip((${tt}-${f(tl.inDur + tl.hold)})/${f(tl.outDur)},0,1)`;
  const ein = (EXPR_IN[spec.transition] || EXPR_IN.ease)(pin);
  const a = `if(lt(${tt},0),0,if(lt(${tt},${f(tl.total)}),if(lt(${tt},${f(tl.inDur)}),${ein},if(lt(${tt},${f(tl.inDur + tl.hold)}),1,1-${exprOut(pout)})),0))`;
  const ex = `(${SQ_OVERSCAN}*clip((${a})*10,0,1))`;
  return {
    w: `trunc((${W}+(${a})*(${f(win.w)}-${W})+2*${ex})/2)*2`,
    h: `trunc((${H}+(${a})*(${f(win.h)}-${H})+2*${ex})/2)*2`,
    x: `(${a})*${f(win.x)}-${ex}`,
    y: `(${a})*${f(win.y)}-${ex}`,
  };
}

// ───────────────────────────── drawing helpers ─────────────────────────────
const FACE = {
  archivo: { weight: 400, stack: '"Archivo Black", Impact, sans-serif', sub: '"Inter", "Segoe UI", Arial, sans-serif', subWeight: 800 },
  inter: { weight: 800, stack: '"Inter", "Segoe UI", Arial, sans-serif', sub: '"Inter", "Segoe UI", Arial, sans-serif', subWeight: 700 },
  oswald: { weight: 700, stack: '"Oswald", Impact, "Arial Narrow", sans-serif', sub: '"Oswald", "Arial Narrow", sans-serif', subWeight: 500 },
};
const hx = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgba = (c, a = 1) => { const [r, g, b] = hx(c); return `rgba(${r},${g},${b},${a})`; };
const mix = (a, b, t) => { const A = hx(a); const B = hx(b); return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`; };
const lighten = (c, t) => mix(c, '#ffffff', t); const darken = (c, t) => mix(c, '#000000', t);
const lum = (c) => { const [r, g, b] = hx(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const readable = (bg, light = '#ffffff', dark = '#101010') => (lum(bg) > 0.62 ? dark : light);
const stage = (a, from, to) => { const p = clamp01((a - from) / (to - from)); return 1 - Math.pow(1 - p, 3); }; // eased progress of a part of the move
const back = (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);

function rr(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath(); ctx.moveTo(x + k, y); ctx.arcTo(x + w, y, x + w, y + h, k); ctx.arcTo(x + w, y + h, x, y + h, k); ctx.arcTo(x, y + h, x, y, k); ctx.arcTo(x, y, x + w, y, k); ctx.closePath();
}
function lg(ctx, x0, y0, x1, y1, stops) { const g = ctx.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, c]) => g.addColorStop(o, c)); return g; }

function makeG(ctx, W, H, spec, t, a, tl, opts) {
  const face = FACE[spec.font] || FACE.archivo;
  const win = squeezeWindow(spec, W, H); const rect = squeezeRect(win, W, H, a); // (not clamped: the bounce goes a little past 1, and the cut-out must follow the picture exactly)
  const per = LOOP_PERIOD[spec.loop] || 0;
  const tt = t - spec.start; const cyc = tl.cycle > 0 ? tt % tl.cycle : tt;
  const phase = per ? (((cyc % per) + per) % per) / per : 0;
  const g = {
    ctx, W, H, U: W / 100, spec, a, win, rect, kind: sqKind(W, H), face, phase, loop: spec.loop, cyc, demo: !!(opts && opts.demo),
    images: (opts && opts.images) || {}, over: [],
    col: { primary: spec.primary, secondary: spec.secondary, accent: spec.accent, text: spec.text },
    R: Math.min(W, H) * 0.028,
  };
  g.font = (px, sub = false) => `${sub ? face.subWeight : face.weight} ${Math.max(1, Math.round(px))}px ${sub ? face.sub : face.stack}`;
  // text that shrinks to fit a width; opts: size, color, align, base, maxW, sub, stroke, shadow, alpha
  g.text = (s, x, y, o = {}) => {
    if (!s) return 0;
    let size = o.size || g.U * 3; const maxW = o.maxW || Infinity;
    ctx.save(); ctx.font = g.font(size, o.sub); let w = ctx.measureText(s).width;
    if (w > maxW) { size *= maxW / w; ctx.font = g.font(size, o.sub); w = ctx.measureText(s).width; }
    ctx.textAlign = o.align || 'left'; ctx.textBaseline = o.base || 'alphabetic'; ctx.globalAlpha *= o.alpha == null ? 1 : o.alpha;
    if (o.shadow) { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = size * 0.18; ctx.shadowOffsetY = size * 0.06; }
    if (o.stroke) { ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.14; ctx.strokeStyle = o.stroke; ctx.strokeText(s, x, y); }
    ctx.fillStyle = o.color || g.col.text; ctx.fillText(s, x, y); ctx.restore();
    return w;
  };
  g.wrap = (s, maxW, size, maxLines = 2, sub = true) => {
    ctx.save(); ctx.font = g.font(size, sub); const words = String(s || '').split(/\s+/).filter(Boolean); const lines = []; let line = '';
    for (const w of words) { const test = line ? `${line} ${w}` : w; if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test; }
    if (line) lines.push(line); ctx.restore();
    if (lines.length > maxLines) { const cut = lines.slice(0, maxLines); cut[maxLines - 1] = cut[maxLines - 1].replace(/\s*\S*$/, '…'); return cut; }
    return lines;
  };
  // draws an image inside a box ('contain' or 'cover'), optionally clipped to rounded corners
  g.img = (im, x, y, w, h, o = {}) => {
    if (!im) return false;
    const iw = im.width || im.naturalWidth; const ih = im.height || im.naturalHeight; if (!iw || !ih) return false;
    const k = (o.fit === 'cover' ? Math.max : Math.min)(w / iw, h / ih); const dw = iw * k; const dh = ih * k;
    ctx.save(); if (o.r) { rr(ctx, x, y, w, h, o.r); ctx.clip(); }
    ctx.drawImage(im, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore(); return true;
  };
  g.hole = (r = win, grow = 0) => { // cut the window out (the picture shows through here)
    const q = squeezeRect(win, W, H, g.a);
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000';
    rr(ctx, q.x - grow, q.y - grow, q.w + grow * 2, q.h + grow * 2, g.R * g.a); ctx.fill(); ctx.restore();
  };
  g.shine = (x, y, w, h, r = 0, strength = 0.35) => { // a bright diagonal sweep over a panel (only for the Shine loop)
    if (g.loop !== 'shine') return;
    ctx.save(); rr(ctx, x, y, w, h, r); ctx.clip();
    const cx = x - w * 0.3 + (w * 1.6) * g.phase; const sw = w * 0.22;
    ctx.translate(cx, y); ctx.transform(1, 0, -0.35, 1, 0, 0);
    ctx.fillStyle = lg(ctx, -sw, 0, sw, 0, [[0, 'rgba(255,255,255,0)'], [0.5, `rgba(255,255,255,${strength})`], [1, 'rgba(255,255,255,0)']]);
    ctx.fillRect(-sw, -4, sw * 2, h + 8); ctx.restore();
  };
  g.pulse = (base = 0, amp = 1) => (g.loop === 'pulse' ? base + amp * (0.5 + 0.5 * Math.sin(g.phase * Math.PI * 2)) : base + amp * 0.5);
  g.placeholderProduct = (x, y, w, h) => {
    const c1 = lighten(g.col.accent, 0.1); const c2 = darken(g.col.primary, 0.1);
    const cw = Math.min(w * 0.42, h * 0.5); const ch = cw * 1.2;
    [[x + w * 0.5 - cw * 1.05, y + h - ch - h * 0.05, c1], [x + w * 0.5 + cw * 0.05, y + h - ch * 1.12 - h * 0.12, c2]].forEach(([px, py, c]) => {
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = cw * 0.25; ctx.shadowOffsetY = cw * 0.08;
      rr(ctx, px, py, cw, ch, cw * 0.28); ctx.fillStyle = lg(ctx, px, py, px + cw, py + ch, [[0, lighten(c, 0.35)], [1, darken(c, 0.2)]]); ctx.fill(); ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,.85)'; rr(ctx, px + cw * 0.18, py + ch * 0.38, cw * 0.64, ch * 0.2, cw * 0.06); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.25)'; rr(ctx, px + cw * 0.28, py + ch * 0.45, cw * 0.44, ch * 0.05, 2); ctx.fill();
    });
  };
  g.placeholderQr = (x, y, s) => { // a stand-in pattern for previews only; never drawn in a real render
    ctx.fillStyle = '#fff'; rr(ctx, x, y, s, s, s * 0.06); ctx.fill(); ctx.fillStyle = '#111'; const n = 21; const c = (s * 0.84) / n; const ox = x + s * 0.08; const oy = y + s * 0.08;
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const f = (i < 7 && j < 7) || (i > 13 && j < 7) || (i < 7 && j > 13);
      if (f) { const ring = Math.max(Math.abs((i % 14) - 3), Math.abs((j % 14) - 3)); if (ring === 3 || ring <= 1) ctx.fillRect(ox + i * c, oy + j * c, c, c); } else if (rnd() > 0.52) ctx.fillRect(ox + i * c, oy + j * c, c, c);
    }
  };
  g.slot = (name, x, y, w, h, o = {}) => { // an image slot: the person's picture, or (previews only) a stand-in
    if (g.img(g.images[name], x, y, w, h, o)) return true;
    if (!g.demo) return false;
    if (name === 'product') g.placeholderProduct(x, y, w, h);
    else if (name === 'qr') g.placeholderQr(x, y, Math.min(w, h));
    else if (name === 'logo') { ctx.save(); rr(ctx, x, y, w, h, h * 0.25); ctx.fillStyle = g.col.accent; ctx.fill(); ctx.restore(); g.text(spec.brand.slice(0, 1).toUpperCase() || 'B', x + w / 2, y + h / 2, { size: h * 0.62, align: 'center', base: 'middle', color: readable(g.col.accent) }); }
    return true;
  };
  g.has = (name) => !!(g.images[name] || g.demo);
  return g;
}

// ───────────────────────────── the templates ─────────────────────────────
const DRAW = {};

// L-Bar Classic: product column on the left, offer bar underneath, picture top right (a TV ad break)
DRAW.lbar = (g) => {
  const { ctx, W, H, U, spec, win, col } = g; const k = g.kind;
  ctx.fillStyle = lg(ctx, 0, 0, W * 0.4, H, [[0, col.primary], [1, col.secondary]]); ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalAlpha = 0.07; ctx.fillStyle = '#fff'; for (let i = -4; i < 14; i++) { ctx.beginPath(); ctx.moveTo(i * U * 9, 0); ctx.lineTo(i * U * 9 + U * 3, 0); ctx.lineTo(i * U * 9 - H * 0.4 + U * 3, H); ctx.lineTo(i * U * 9 - H * 0.4, H); ctx.fill(); } ctx.restore();
  g.hole();
  const pad = U * 1.6; const barY = win.y + win.h + pad; const barH = H - barY - pad;
  // left column (landscape / square): brand, then product, then QR with its line, each in its own room
  if (k !== 'portrait') {
    const p1 = stage(g.a, 0.05, 0.7); const colW = win.x - pad * 1.5; const dx = -(colW + pad * 2) * (1 - p1);
    ctx.save(); ctx.translate(dx, 0);
    const brandH = U * 6;
    if (g.images.logo) g.slot('logo', pad, pad, colW, brandH, { fit: 'contain' }); else g.text(spec.brand, pad + colW / 2, pad + U * 4.6, { size: U * 4.2, align: 'center', maxW: colW, shadow: true });
    let bottom = barY - pad;                                   // the lowest y the column may use
    if (g.has('qr')) { const qs = Math.min(colW * 0.62, U * 15, (barY - pad * 2 - brandH) * 0.42); const qx = pad + (colW - qs) / 2; const qy = bottom - qs; g.slot('qr', qx, qy, qs, qs, { fit: 'contain', r: qs * 0.06 }); if (spec.cta) g.text(spec.cta, pad + colW / 2, qy - U * 0.9, { size: U * 1.4, sub: true, align: 'center', maxW: colW, color: col.accent }); bottom = qy - U * 3.2; }
    const top = pad * 2 + brandH; const ph = Math.max(0, Math.min(bottom - top, colW * 1.3)); const pp = stage(g.a, 0.35, 0.95); const sc = 0.7 + 0.3 * back(pp);
    if (ph > U * 4) { ctx.save(); ctx.translate(pad + colW / 2, top + ph / 2); ctx.scale(sc, sc); ctx.globalAlpha = pp; g.slot('product', -colW / 2, -ph / 2, colW, ph, { fit: 'contain' }); ctx.restore(); }
    ctx.restore();
  }
  // bottom bar
  const p2 = stage(g.a, 0.2, 0.8); const by = barY + (H - barY) * (1 - p2);
  const bx = k === 'landscape' ? win.x : pad; const bw = W - bx - pad;
  ctx.save(); ctx.translate(0, by - barY);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = U; rr(ctx, bx, barY, bw, barH, g.R); ctx.fillStyle = lg(ctx, bx, barY, bx, barY + barH, [[0, lighten(col.primary, 0.06)], [1, darken(col.primary, 0.25)]]); ctx.fill(); ctx.restore();
  const ob = readable(col.accent); const blockW = Math.min(bw * 0.34, U * 26);
  ctx.save(); rr(ctx, bx, barY, bw, barH, g.R); ctx.clip();
  ctx.fillStyle = col.accent; ctx.fillRect(bx, barY, blockW, barH);
  ctx.fillStyle = darken(col.accent, 0.12); ctx.beginPath(); ctx.moveTo(bx + blockW, barY); ctx.lineTo(bx + blockW + U * 2.4, barY); ctx.lineTo(bx + blockW, barY + barH); ctx.fill();
  g.shine(bx, barY, bw, barH, 0, 0.22); ctx.restore();
  const hp = stage(g.a, 0.5, 1);
  g.text(spec.headline, bx + blockW * 0.5, barY + barH * 0.66, { size: Math.min(barH * 0.62, blockW * 0.5), align: 'center', maxW: blockW * 0.9, color: ob, alpha: hp });
  g.text(spec.sub, bx + blockW * 0.5, barY + barH * 0.9, { size: barH * 0.2, sub: true, align: 'center', maxW: blockW * 0.9, color: ob, alpha: hp });
  const tx = bx + blockW + U * 4; const tw = bw - blockW - U * 6;
  if (spec.badge) g.text(spec.badge, tx, barY + barH * 0.28, { size: barH * 0.2, sub: true, color: col.accent, maxW: tw, alpha: hp });
  g.text(spec.title, tx, barY + barH * (spec.badge ? 0.62 : 0.5), { size: barH * 0.36, maxW: tw, color: col.text, alpha: hp, base: 'middle' });
  if (spec.caption) g.text(spec.caption, tx, barY + barH * 0.86, { size: barH * 0.17, sub: true, maxW: tw, color: rgba(col.text, 0.85), alpha: hp });
  ctx.restore();
  if (k === 'portrait') {
    if (g.has('qr')) { const qs = U * 17; const pq = stage(g.a, 0.45, 1); ctx.save(); ctx.globalAlpha = pq; g.slot('qr', W - qs - pad * 1.4, barY - qs * 0.55, qs, qs, { fit: 'contain', r: qs * 0.06 }); ctx.restore(); }
  }
};

// Bottom Banner: picture on top, an offer banner with a pill and a ticker slides up
DRAW.bottom = (g) => {
  const { ctx, W, H, U, spec, win, col } = g;
  ctx.fillStyle = lg(ctx, 0, 0, 0, H, [[0, col.secondary], [1, darken(col.primary, 0.1)]]); ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalAlpha = 0.1; ctx.fillStyle = col.accent; ctx.beginPath(); ctx.arc(W * 0.92, H * 0.95, H * 0.5, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(W * 0.02, H * 0.2, H * 0.22, 0, 7); ctx.fill(); ctx.restore();
  g.hole();
  const pad = U * 1.6; const y0 = win.y + win.h + pad; const h = H - y0 - pad;
  const bn = g.kind === 'portrait' ? { x: pad, w: W - pad * 2 } : { x: win.x, w: win.w }; // on tall video the banner spans the width
  const p = stage(g.a, 0.15, 0.8); const dy = (H - y0) * (1 - p);
  ctx.save(); ctx.translate(0, dy);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = U * 1.2; rr(ctx, bn.x, y0, bn.w, h, g.R); ctx.fillStyle = lg(ctx, 0, y0, 0, y0 + h, [[0, lighten(col.primary, 0.1)], [1, col.primary]]); ctx.fill(); ctx.restore();
  g.shine(bn.x, y0, bn.w, h, g.R);
  const pillW = Math.min(bn.w * 0.3, U * 24); const pillH = h * 0.62; const px = bn.x + pad; const py = y0 + (h - pillH) / 2; const pp = 1 + 0.03 * (g.loop === 'pulse' ? g.pulse(0, 1) : 0);
  ctx.save(); ctx.translate(px + pillW / 2, py + pillH / 2); ctx.scale(pp, pp); ctx.translate(-pillW / 2, -pillH / 2);
  rr(ctx, 0, 0, pillW, pillH, pillH * 0.5); ctx.fillStyle = col.accent; ctx.fill();
  g.text(spec.headline, pillW * (spec.sub ? 0.42 : 0.5), pillH * 0.5, { size: pillH * 0.58, align: 'center', base: 'middle', maxW: pillW * (spec.sub ? 0.55 : 0.84), color: readable(col.accent) });
  if (spec.sub) g.text(spec.sub, pillW * 0.8, pillH * 0.5, { size: pillH * 0.26, sub: true, align: 'center', base: 'middle', maxW: pillW * 0.3, color: readable(col.accent) });
  ctx.restore();
  const hp = stage(g.a, 0.5, 1);
  const tx = px + pillW + pad * 1.4; const tw = bn.x + bn.w - tx - pad - bn.w * 0.2;
  if (spec.badge) g.text(spec.badge, tx, y0 + h * 0.25, { size: h * 0.16, sub: true, color: col.accent, maxW: tw, alpha: hp });
  g.text(spec.title, tx, y0 + h * (spec.badge ? 0.55 : 0.46), { size: h * 0.3, maxW: tw, base: 'middle', alpha: hp });
  g.text(spec.caption, tx, y0 + h * 0.82, { size: h * 0.15, sub: true, maxW: tw, color: rgba(col.text, 0.85), alpha: hp });
  if (g.images.logo) g.slot('logo', bn.x + bn.w - pad - U * 11, y0 + h * 0.2, U * 11, h * 0.6, { fit: 'contain' }); else g.text(spec.brand, bn.x + bn.w - pad, y0 + h * 0.5, { size: h * 0.22, sub: true, align: 'right', base: 'middle', maxW: bn.w * 0.2, color: col.accent, alpha: hp });
  ctx.restore();
};

// Side Panel: picture left, a call-to-action panel slides in from the right
DRAW.side = (g) => {
  const { ctx, W, H, U, spec, win, col, kind } = g;
  ctx.fillStyle = lg(ctx, 0, 0, W, H, [[0, col.secondary], [1, darken(col.primary, 0.2)]]); ctx.fillRect(0, 0, W, H);
  g.hole();
  const pad = U * 1.6; const stack = kind === 'portrait';
  const px = stack ? pad : win.x + win.w + pad * 1.6; const py = stack ? win.y + win.h + pad : pad; const pw = stack ? W - pad * 2 : W - px - pad; const ph = stack ? H - py - pad : H - pad * 2;
  const p = stage(g.a, 0.1, 0.8); ctx.save(); if (stack) ctx.translate(0, (H - py) * (1 - p)); else ctx.translate((W - px) * (1 - p), 0);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = U * 1.4; rr(ctx, px, py, pw, ph, g.R * 1.4); ctx.fillStyle = lg(ctx, px, py, px, py + ph, [[0, lighten(col.primary, 0.12)], [1, darken(col.primary, 0.2)]]); ctx.fill(); ctx.restore();
  g.shine(px, py, pw, ph, g.R * 1.4);
  const ip = pw * 0.07; const cw = pw - ip * 2; const hp = stage(g.a, 0.4, 1);
  let y = py + ip;
  if (g.has('logo') && g.images.logo) { g.slot('logo', px + ip, y, cw * 0.5, ph * 0.1, { fit: 'contain' }); } else g.text(spec.brand, px + ip, y + ph * 0.06, { size: ph * (stack ? 0.06 : 0.055), maxW: cw, color: col.accent, alpha: hp });
  y += ph * 0.14;
  if (spec.badge) { const bw = Math.min(cw, U * 14); rr(ctx, px + ip, y, bw, ph * 0.07, ph * 0.035); ctx.fillStyle = col.accent; ctx.fill(); g.text(spec.badge, px + ip + bw / 2, y + ph * 0.037, { size: ph * 0.04, sub: true, align: 'center', base: 'middle', maxW: bw * 0.9, color: readable(col.accent) }); y += ph * 0.1; }
  g.text(spec.headline, px + ip, y + ph * 0.19, { size: ph * (stack ? 0.2 : 0.22), maxW: cw * 0.7, color: col.accent, alpha: hp });
  g.text(spec.sub, px + ip + cw * 0.72, y + ph * 0.19, { size: ph * 0.07, sub: true, maxW: cw * 0.28, color: col.text, alpha: hp });
  y += ph * 0.25;
  g.text(spec.title, px + ip, y + ph * 0.06, { size: ph * 0.072, maxW: cw, alpha: hp });
  const lines = g.wrap(spec.caption, cw, ph * 0.042, 3); lines.forEach((ln, i) => g.text(ln, px + ip, y + ph * 0.13 + i * ph * 0.052, { size: ph * 0.042, sub: true, color: rgba(col.text, 0.85), alpha: hp }));
  const prodY = y + ph * 0.28; const prodH = ph - (prodY - py) - ph * 0.16 - ip;
  if (prodH > ph * 0.14) { const pp = stage(g.a, 0.45, 1); ctx.save(); ctx.globalAlpha = pp; g.slot('product', px + ip, prodY, cw * (g.has('qr') ? 0.62 : 1), prodH, { fit: 'contain' }); if (g.has('qr')) g.slot('qr', px + ip + cw * 0.68, prodY + prodH - cw * 0.3, cw * 0.3, cw * 0.3, { fit: 'contain', r: 6 }); ctx.restore(); }
  if (spec.cta) { const bw = cw; const bh = ph * 0.1; const by = py + ph - ip - bh; const sc = 1 + 0.035 * g.pulse(0, 1); ctx.save(); ctx.translate(px + ip + bw / 2, by + bh / 2); ctx.scale(sc, sc); rr(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2); ctx.fillStyle = col.accent; ctx.fill(); g.text(spec.cta, 0, 0, { size: bh * 0.42, align: 'center', base: 'middle', maxW: bw * 0.88, color: readable(col.accent) }); ctx.restore(); }
  ctx.restore();
};

// Corner Pop: small picture, huge type, a spinning sticker
DRAW.corner = (g) => {
  const { ctx, W, H, U, spec, win, col, kind } = g;
  ctx.fillStyle = lg(ctx, 0, 0, W, H, [[0, col.primary], [1, col.secondary]]); ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalAlpha = 0.1; ctx.fillStyle = '#fff'; const st = U * 12; for (let i = -6; i < 16; i++) { ctx.save(); ctx.translate(i * st + g.phase * st * (g.loop === 'shine' ? 1 : 0), 0); ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(st * 0.5, H); ctx.lineTo(st * 0.5 + H * 0.9, 0); ctx.lineTo(H * 0.9, 0); ctx.fill(); ctx.restore(); } ctx.restore();
  g.hole();
  { const q = squeezeRect(win, W, H, g.a); ctx.save(); ctx.strokeStyle = col.accent; ctx.lineWidth = U * 0.5; rr(ctx, q.x - U * 0.6, q.y - U * 0.6, q.w + U * 1.2, q.h + U * 1.2, g.R * 1.3 * g.a); ctx.stroke(); ctx.restore(); }
  g.hole(win, 0);
  const pad = U * 2; const p = stage(g.a, 0.1, 0.75); const hp = stage(g.a, 0.4, 1);
  const stack = kind === 'portrait'; const tx = stack ? pad : win.x + win.w + pad * 1.5; const tw = W - tx - pad; const ty = stack ? win.y + win.h + pad * 1.2 : win.y;
  ctx.save(); ctx.translate((stack ? 0 : (W - tx) * (1 - p)), stack ? (H - ty) * (1 - p) : 0);
  g.text(spec.brand, tx, ty + U * 3, { size: U * 2.6, sub: true, color: col.accent, maxW: tw });
  g.text(spec.headline, tx, ty + (stack ? U * 20 : U * 21), { size: stack ? U * 21 : U * 19, maxW: tw * 0.9, color: '#fff', stroke: darken(col.secondary, 0.3), shadow: true });
  g.text(spec.sub, tx, ty + (stack ? U * 28 : U * 28.5), { size: U * 5, maxW: tw, color: col.accent, stroke: darken(col.secondary, 0.4) });
  g.text(spec.title, tx, ty + (stack ? U * 36 : U * 36), { size: U * 4, maxW: tw, alpha: hp });
  g.wrap(spec.caption, tw, U * 2.2, 2).forEach((ln, i) => g.text(ln, tx, ty + (stack ? U * 41 : U * 41) + i * U * 2.9, { size: U * 2.2, sub: true, color: rgba(col.text, 0.9), alpha: hp }));
  ctx.restore();
  if (spec.cta) { const bw = Math.min(U * 38, W - pad * 2); const bh = U * 6; const bx = stack ? pad : W - bw - pad; const by = H - bh - pad; const bp = stage(g.a, 0.55, 1); ctx.save(); ctx.globalAlpha = bp; ctx.translate(0, (1 - bp) * U * 6); rr(ctx, bx, by, bw, bh, bh / 2); ctx.fillStyle = col.accent; ctx.fill(); g.text(spec.cta, bx + bw / 2, by + bh / 2, { size: bh * 0.4, align: 'center', base: 'middle', maxW: bw * 0.88, color: readable(col.accent) }); ctx.restore(); }
  // the sticker: spins in with the move and keeps a gentle wobble
  const sr = U * (stack ? 10 : 8.5); const sx = win.x + win.w - sr * 0.4; const sy = win.y + win.h - sr * 0.3; const sp = stage(g.a, 0.35, 1);
  g.over.push(() => { ctx.save(); ctx.translate(sx, sy); ctx.rotate((1 - sp) * 6 + Math.sin(g.phase * Math.PI * 2) * 0.08 + 0.12); ctx.scale(sp * back(sp), sp * back(sp)); ctx.beginPath(); for (let i = 0; i < 24; i++) { const r = i % 2 ? sr * 0.82 : sr; const a = (i / 24) * Math.PI * 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = U; ctx.fillStyle = col.accent; ctx.fill(); ctx.shadowColor = 'transparent'; g.text(spec.badge || spec.sub || 'NEW', 0, 0, { size: sr * 0.5, align: 'center', base: 'middle', maxW: sr * 1.4, color: readable(col.accent) }); ctx.restore(); });
};

// Soft Card: a rounded card floating over a gradient with soft shapes
DRAW.card = (g) => {
  const { ctx, W, H, U, spec, win, col } = g;
  ctx.fillStyle = lg(ctx, 0, 0, W, H, [[0, col.primary], [1, col.secondary]]); ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 6; i++) { const ph = g.phase * Math.PI * 2 + i * 1.7; const x = W * (0.12 + i * 0.16) + Math.sin(ph) * U * 2; const y = H * (i % 2 ? 0.82 : 0.12) + Math.cos(ph) * U * 2; ctx.save(); ctx.globalAlpha = 0.18; ctx.fillStyle = i % 2 ? col.accent : '#fff'; ctx.beginPath(); ctx.arc(x, y, U * (3 + (i % 3) * 2.2), 0, 7); ctx.fill(); ctx.restore(); }
  const q = squeezeRect(win, W, H, g.a);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = U * 3; ctx.shadowOffsetY = U * 1.2; ctx.fillStyle = '#fff'; rr(ctx, q.x - U * 0.8, q.y - U * 0.8, q.w + U * 1.6, q.h + U * 1.6, g.R * 1.5 * g.a + 2); ctx.fill(); ctx.restore();
  g.hole(win, 0);
  const hp = stage(g.a, 0.4, 1); const pad = U * 1.5;
  ctx.save(); ctx.globalAlpha = hp;
  const top = win.y - U * 2.4; g.text(spec.brand, W / 2, Math.max(U * 3.2, top), { size: U * 2.6, align: 'center', color: col.accent, maxW: W * 0.7 });
  const y0 = win.y + win.h + U * 1.8;
  g.text(spec.title, W / 2, y0 + U * 3.2, { size: U * 3.8, align: 'center', maxW: W * 0.86, shadow: true });
  g.text(spec.caption, W / 2, y0 + U * 6.6, { size: U * 1.9, sub: true, align: 'center', maxW: W * 0.86, color: rgba(col.text, 0.88) });
  if (spec.cta) { const bw = Math.min(W * 0.62, U * 40); const bh = U * 4.8; const bx = (W - bw) / 2; const by = Math.min(H - bh - pad, y0 + U * 8.4); const sc = 1 + 0.04 * g.pulse(0, 1); ctx.save(); ctx.translate(W / 2, by + bh / 2); ctx.scale(sc, sc); rr(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2); ctx.fillStyle = col.accent; ctx.fill(); g.text(spec.cta, 0, 0, { size: bh * 0.4, align: 'center', base: 'middle', maxW: bw * 0.9, color: readable(col.accent) }); ctx.restore(); }
  ctx.restore();
  if (spec.headline) { const bs = U * 8.5; const bx = win.x + win.w - bs * 0.55; const by = win.y - bs * 0.35; const sp = stage(g.a, 0.5, 1); g.over.push(() => { ctx.save(); ctx.translate(bx, by + bs / 2); ctx.scale(sp * back(sp), sp * back(sp)); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = U; ctx.beginPath(); ctx.arc(0, 0, bs / 2, 0, 7); ctx.fillStyle = col.accent; ctx.fill(); ctx.shadowColor = 'transparent'; g.text(spec.headline, 0, spec.sub ? -bs * 0.06 : 0, { size: bs * 0.34, align: 'center', base: 'middle', maxW: bs * 0.8, color: readable(col.accent) }); if (spec.sub) g.text(spec.sub, 0, bs * 0.24, { size: bs * 0.15, sub: true, align: 'center', base: 'middle', maxW: bs * 0.8, color: readable(col.accent) }); ctx.restore(); }); }
};

// Neon Frame: a dark stage with a glowing frame around the picture
DRAW.neon = (g) => {
  const { ctx, W, H, U, spec, win, col } = g;
  ctx.fillStyle = lg(ctx, 0, 0, 0, H, [[0, '#04040c'], [1, col.primary]]); ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.strokeStyle = rgba(col.accent, 0.1); ctx.lineWidth = 1; for (let x = 0; x < W; x += U * 5) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); } for (let y = 0; y < H; y += U * 5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } ctx.restore();
  g.hole();
  const q = squeezeRect(win, W, H, g.a); const glow = 0.65 + 0.35 * g.pulse(0, 1);
  ctx.save(); ctx.beginPath(); rr(ctx, 0, 0, W, H, 0); rr(ctx, q.x, q.y, q.w, q.h, g.R * g.a); ctx.clip('evenodd');
  ctx.shadowColor = col.accent; ctx.shadowBlur = U * 3.2 * glow; ctx.strokeStyle = col.accent; ctx.lineWidth = U * 0.45; rr(ctx, q.x - U * 0.4, q.y - U * 0.4, q.w + U * 0.8, q.h + U * 0.8, g.R * g.a + 4); ctx.stroke();
  ctx.shadowBlur = U * 1.2; ctx.strokeStyle = '#fff'; ctx.lineWidth = U * 0.15; rr(ctx, q.x - U * 0.4, q.y - U * 0.4, q.w + U * 0.8, q.h + U * 0.8, g.R * g.a + 4); ctx.stroke(); ctx.restore();
  const hp = stage(g.a, 0.4, 1); const y0 = win.y + win.h; const rem = H - y0 - U * 1.2; const ts = Math.min(U * 4.2, rem * 0.2);
  ctx.save(); ctx.globalAlpha = hp; ctx.shadowColor = col.accent; ctx.shadowBlur = U * 2 * glow;
  g.text(spec.title, W / 2, y0 + rem * 0.26, { size: ts, align: 'center', maxW: W * 0.88, color: '#fff' }); ctx.shadowBlur = 0;
  g.text(spec.caption, W / 2, y0 + rem * 0.5, { size: Math.min(U * 2, rem * 0.11), sub: true, align: 'center', maxW: W * 0.86, color: rgba(col.text, 0.85) });
  g.text(`${spec.headline} ${spec.sub}`.trim(), W / 2, y0 + rem * 0.86, { size: Math.min(U * 5.2, rem * 0.27), align: 'center', maxW: W * 0.7, color: col.accent });
  ctx.restore();
  g.text(spec.brand, W / 2, Math.max(U * 3.4, win.y - U * 1.6), { size: U * 2.4, sub: true, align: 'center', maxW: W * 0.6, color: col.accent, alpha: hp });
  if (g.loop === 'shine' || g.loop === 'pulse') { const sy = win.y + ((g.phase * 1.2) % 1) * win.h; g.over.push(() => { ctx.save(); const qq = squeezeRect(win, W, H, g.a); rr(ctx, qq.x, qq.y, qq.w, qq.h, g.R * g.a); ctx.clip(); ctx.fillStyle = lg(ctx, 0, sy - U * 3, 0, sy + U * 3, [[0, rgba(col.accent, 0)], [0.5, rgba(col.accent, 0.18)], [1, rgba(col.accent, 0)]]); ctx.fillRect(qq.x, sy - U * 3, qq.w, U * 6); ctx.restore(); }); }
};

// Breaking Ticker: news look, LIVE badge, scrolling ticker
DRAW.news = (g) => {
  const { ctx, W, H, U, spec, win, col, kind } = g;
  ctx.fillStyle = lg(ctx, 0, 0, W, H, [[0, col.secondary], [1, darken(col.secondary, 0.3)]]); ctx.fillRect(0, 0, W, H);
  g.hole();
  const pad = U * 1.5; const tickH = U * 6.2; const ty = H - tickH - pad * 0.5; const p = stage(g.a, 0.1, 0.7); const hp = stage(g.a, 0.4, 1);
  ctx.save(); ctx.translate(0, (H - ty) * (1 - p) + 0);
  ctx.fillStyle = col.primary; ctx.fillRect(0, ty, W, tickH + pad);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, ty - U * 0.35, W, U * 0.35);
  const lw = U * 15; ctx.fillStyle = '#fff'; ctx.fillRect(0, ty, lw, tickH + pad); g.text(spec.badge || 'LIVE', lw / 2, ty + tickH * 0.52, { size: tickH * 0.52, align: 'center', base: 'middle', maxW: lw * 0.85, color: col.primary });
  ctx.save(); ctx.beginPath(); ctx.rect(lw + pad, ty, W - lw - pad * 2, tickH + pad); ctx.clip();
  ctx.font = g.font(tickH * 0.46, true); const unit = `${spec.ticker}      `; const uw = Math.max(10, ctx.measureText(unit).width); const off = g.loop === 'ticker' ? -g.phase * uw : 0; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  for (let x = lw + pad + off; x < W; x += uw) ctx.fillText(unit, x, ty + tickH * 0.52); ctx.restore(); ctx.restore();
  const bl = g.pulse(0.55, 0.45); const rx = kind === 'portrait' ? pad : win.x + win.w + pad * 1.6; const ry = kind === 'portrait' ? win.y + win.h + pad : win.y; const rw = W - rx - pad; const rh = kind === 'portrait' ? ty - ry - pad : win.h;
  ctx.save(); ctx.globalAlpha = hp; ctx.translate(kind === 'portrait' ? 0 : (1 - hp) * U * 8, kind === 'portrait' ? (1 - hp) * U * 6 : 0);
  rr(ctx, rx, ry, U * 12, U * 3.4, 6); ctx.fillStyle = col.primary; ctx.fill(); ctx.save(); ctx.globalAlpha *= bl; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(rx + U * 1.6, ry + U * 1.7, U * 0.7, 0, 7); ctx.fill(); ctx.restore(); g.text(spec.badge ? 'NEWS' : 'BREAKING', rx + U * 7.2, ry + U * 1.75, { size: U * 1.8, sub: true, align: 'center', base: 'middle', maxW: U * 8.5 });
  g.text(spec.title, rx, ry + U * 8.6, { size: U * (kind === 'portrait' ? 4.6 : 4.2), maxW: rw, color: '#fff' });
  g.wrap(spec.caption, rw, U * 2.2, 3).forEach((ln, i) => g.text(ln, rx, ry + U * 13 + i * U * 3, { size: U * 2.2, sub: true, color: rgba(col.text, 0.88) }));
  if (spec.headline) { g.text(`${spec.headline} ${spec.sub}`.trim(), rx, Math.min(ry + rh - U * 1.5, ry + U * 24), { size: U * 6.4, maxW: rw, color: col.accent === '#ffffff' ? '#fde047' : col.accent }); }
  ctx.restore();
  g.text(spec.brand, W - pad, U * 3.2, { size: U * 2.2, sub: true, align: 'right', maxW: W * 0.35, color: rgba('#ffffff', 0.9), alpha: hp });
};

// Sale Burst: rotating rays, a bouncing discount badge and a ribbon
DRAW.burst = (g) => {
  const { ctx, W, H, U, spec, win, col, kind } = g;
  ctx.fillStyle = lg(ctx, 0, 0, W, H, [[0, col.primary], [1, col.secondary]]); ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.translate(W * (kind === 'portrait' ? 0.5 : 0.62), H * 0.5); ctx.rotate(g.phase * Math.PI * 0.6 + g.cyc * 0.05); ctx.globalAlpha = 0.16; ctx.fillStyle = '#fff';
  for (let i = 0; i < 18; i++) { ctx.rotate(Math.PI / 9); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.max(W, H), -Math.max(W, H) * 0.07); ctx.lineTo(Math.max(W, H), Math.max(W, H) * 0.07); ctx.fill(); } ctx.restore();
  g.hole();
  { const q = squeezeRect(win, W, H, g.a); ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = U * 0.6; rr(ctx, q.x - U * 0.3, q.y - U * 0.3, q.w + U * 0.6, q.h + U * 0.6, g.R * g.a); ctx.stroke(); ctx.restore(); }
  g.hole(win, 0);
  const hp = stage(g.a, 0.35, 1); const bp = stage(g.a, 0.45, 1);
  const cx = kind === 'portrait' ? W * 0.5 : win.x + win.w + (W - win.x - win.w) / 2; const cy = kind === 'portrait' ? win.y + win.h + (H - win.y - win.h) * 0.45 : H * 0.42; const br = U * (kind === 'portrait' ? 13 : 12);
  ctx.save(); ctx.translate(cx, cy); const sc = bp * back(bp) * (1 + 0.04 * g.pulse(0, 1)); ctx.scale(sc, sc); ctx.rotate(-0.12);
  ctx.beginPath(); for (let i = 0; i < 28; i++) { const r = i % 2 ? br * 0.86 : br; const a = (i / 28) * Math.PI * 2; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath();
  ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = U * 1.4; ctx.shadowOffsetY = U * 0.6; ctx.fillStyle = col.accent; ctx.fill(); ctx.shadowColor = 'transparent';
  g.text(spec.headline, 0, spec.sub ? -br * 0.08 : 0, { size: br * 0.78, align: 'center', base: 'middle', maxW: br * 1.4, color: readable(col.accent) });
  if (spec.sub) g.text(spec.sub, 0, br * 0.5, { size: br * 0.3, sub: true, align: 'center', base: 'middle', maxW: br * 1.2, color: readable(col.accent) }); ctx.restore();
  const ry = kind === 'portrait' ? H - U * 22 : H - U * 15.5; const rw = Math.min(W * 0.88, U * 80); const rh = U * 7.4; const rx = (W - rw) / 2;
  ctx.save(); ctx.globalAlpha = hp; ctx.translate(0, (1 - hp) * U * 10); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = U; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx + rw, ry); ctx.lineTo(rx + rw - U * 1.6, ry + rh / 2); ctx.lineTo(rx + rw, ry + rh); ctx.lineTo(rx, ry + rh); ctx.lineTo(rx + U * 1.6, ry + rh / 2); ctx.closePath(); ctx.fill(); ctx.shadowColor = 'transparent';
  g.text(spec.title, W / 2, ry + rh * 0.5, { size: rh * 0.5, align: 'center', base: 'middle', maxW: rw * 0.86, color: col.secondary });
  ctx.restore();
  g.text(spec.cta || spec.caption, W / 2, ry + rh + U * 3.6, { size: U * 2.1, sub: true, align: 'center', maxW: W * 0.86, color: '#fff', alpha: hp });
  g.text(spec.brand, W - U * 2, U * 3.6, { size: U * 2.4, sub: true, align: 'right', maxW: W * 0.3, color: '#fff', alpha: hp });
};

// Story Stack: made for tall videos: title above, picture, button below
DRAW.story = (g) => {
  const { ctx, W, H, U, spec, win, col } = g;
  ctx.fillStyle = lg(ctx, 0, 0, 0, H, [[0, col.primary], [1, col.secondary]]); ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = col.accent; ctx.beginPath(); ctx.arc(W * 0.9, H * 0.08, W * 0.45, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(W * 0.05, H * 0.95, W * 0.4, 0, 7); ctx.fill(); ctx.restore();
  const q = squeezeRect(win, W, H, g.a); ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = U * 2.4; ctx.fillStyle = col.accent; rr(ctx, q.x - U * 0.5, q.y - U * 0.5, q.w + U, q.h + U, g.R * 1.3 * g.a + 2); ctx.fill(); ctx.restore();
  g.hole(win, 0);
  const hp = stage(g.a, 0.35, 1);
  const topRoom = Math.max(0, win.y - U * 1.2);
  ctx.save(); ctx.globalAlpha = hp;
  if (topRoom > U * 5) g.text(spec.brand, W / 2, win.y - U * 2.2, { size: Math.min(U * 3.2, topRoom * 0.45), align: 'center', maxW: W * 0.86, color: col.accent });
  const y0 = win.y + win.h + U * 2.2;
  g.text(spec.title, W / 2, y0 + U * 4.4, { size: U * 5.4, align: 'center', maxW: W * 0.9, shadow: true });
  g.wrap(spec.caption, W * 0.86, U * 2.5, 2).forEach((ln, i) => g.text(ln, W / 2, y0 + U * 9 + i * U * 3.3, { size: U * 2.5, sub: true, align: 'center', color: rgba(col.text, 0.9) }));
  const bh0 = U * 7; const ctaTop = H - bh0 - U * 4.2;
  if (spec.headline) { const room = ctaTop - (y0 + U * 14); g.text(`${spec.headline} ${spec.sub}`.trim(), W / 2, ctaTop - U * 2.4, { size: Math.max(U * 2.5, Math.min(U * 7, room * 0.7)), align: 'center', maxW: W * 0.8, color: col.accent }); }
  if (spec.cta) { const bw = Math.min(W * 0.8, U * 60); const bh = U * 7; const bx = (W - bw) / 2; const by = H - bh - U * 4.2; const sc = 1 + 0.04 * g.pulse(0, 1); ctx.save(); ctx.translate(W / 2, by + bh / 2 + Math.sin(g.phase * Math.PI * 2) * U * (g.loop === 'pulse' ? 0.6 : 0)); ctx.scale(sc, sc); rr(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2); ctx.fillStyle = col.accent; ctx.fill(); g.text(spec.cta, 0, 0, { size: bh * 0.38, align: 'center', base: 'middle', maxW: bw * 0.9, color: readable(col.accent) }); g.shine(-bw / 2, -bh / 2, bw, bh, bh / 2, 0.3); ctx.restore(); }
  ctx.restore();
  if (g.has('logo') && g.images.logo) g.slot('logo', W / 2 - U * 9, U * 1.2, U * 18, U * 5, { fit: 'contain' });
};

// ───────────────────────────── the frame ─────────────────────────────
/**
 * Draws the frame for time t onto a transparent canvas of W x H. Returns { drawn, a, rect }: `rect` is where the picture shows
 * (null when the picture is full screen and nothing is drawn).
 * opts: { images: { logo, product, qr }  loaded images, demo: draw stand-ins for empty image slots (previews only) }
 */
export function drawSqueeze(ctx, W, H, rawSpec, t, opts = {}) {
  const spec = rawSpec && rawSpec._resolved ? rawSpec : normalizeSqueeze(rawSpec);
  const tl = squeezeTimeline(spec);
  const a = squeezeAmount(spec, tl, t);
  if (a <= 0.0005) return { drawn: false, a: 0, rect: null };
  const g = makeG(ctx, W, H, spec, t, a, tl, opts);
  ctx.save();
  const draw = spec.template === 'story' && g.kind !== 'portrait' ? DRAW.card : (DRAW[spec.template] || DRAW.lbar); // Story Stack is for tall video
  draw(g);
  g.hole(); // nothing may cover the picture
  for (const fn of g.over) fn(); // stickers that are meant to sit over the picture's corner
  ctx.restore();
  return { drawn: true, a, rect: g.rect };
}

/** The frames a renderer needs for one showing: which moments to draw, and which can be shared. */
export function squeezeFrameKey(spec, tl, t) {
  const a = squeezeAmount(spec, tl, t);
  if (a <= 0.0005) return 'off';
  let tt = t - spec.start; if (tl.cycle > 0) tt %= tl.cycle;
  if (tt >= tl.inDur && tt < tl.inDur + tl.hold && (spec.loop === 'none')) return 'hold';
  return null;
}
