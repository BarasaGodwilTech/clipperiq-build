// Auto captions: cues (the text and its timing), looks (templates), page layout, the live canvas preview and the
// animated ASS subtitles the server burns into the clip.
//
// Shared by the browser (preview, editing) and the server (ffmpeg + libass), like framing.js and lowerThird.js, so the
// preview and the export are laid out by the same code: the same words per page, the same line breaks, the same
// positions and the same timing. (The preview is drawn with the browser's text engine and the export with libass, so
// letter shapes can differ by a pixel or two; nothing else should.)
//
// Words:   cue = { s, e, text, words?: [{ s, e, w }] }         seconds on the SOURCE video's timeline
// Look:    style (see defaultCaptionStyle) = font, size, colours, outline, box, position, words per page, animations
// A clip shows the cues inside its own stretch of the source; times are shifted to the clip and divided by its speed.

export const CAPTION_FONTS = [
  // family/weight: used by the preview; ass: the name libass finds in server/assets/fonts.
  // wide / wideUpper: average letter width in em (measured from the font, +6%), used to break lines without measuring text.
  // asc / desc / cap: the font's Windows ascent, descent and capital height in em. libass sizes text by (asc + desc) and
  // centres lines on it, so the same numbers place baselines identically in the preview and in the export.
  { id: 'poppins', label: 'Poppins Bold', family: 'Poppins', weight: 700, file: 'Poppins-Bold.ttf', ass: { name: 'Poppins', bold: -1 }, wide: 0.545, wideUpper: 0.615, asc: 1.135, desc: 0.627, cap: 0.705 },
  { id: 'inter', label: 'Inter ExtraBold', family: 'Inter', weight: 800, file: 'Inter-ExtraBold.ttf', ass: { name: 'Inter ExtraBold', bold: 0 }, wide: 0.524, wideUpper: 0.642, asc: 1.108, desc: 0.322, cap: 0.728 },
  { id: 'archivo', label: 'Archivo Black', family: 'Archivo Black', weight: 400, file: 'ArchivoBlack-Regular.ttf', ass: { name: 'Archivo Black', bold: 0 }, wide: 0.586, wideUpper: 0.722, asc: 1.035, desc: 0.312, cap: 0.688 },
  { id: 'oswald', label: 'Oswald Bold (condensed)', family: 'Oswald', weight: 700, file: 'Oswald-Bold.ttf', ass: { name: 'Oswald', bold: -1 }, wide: 0.435, wideUpper: 0.504, asc: 1.325, desc: 0.377, cap: 0.81 },
];
const fontOf = (id) => CAPTION_FONTS.find((f) => f.id === id) || CAPTION_FONTS[0];

export const ANIM_IN = ['none', 'fade', 'pop', 'slide', 'bounce'];
export const ANIM_OUT = ['none', 'fade'];
export const HIGHLIGHTS = ['none', 'color', 'pop'];
export const REVEALS = ['page', 'word'];

const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const round = (n, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

export function defaultCaptionStyle() {
  return {
    font: 'poppins', size: 6.4, uppercase: false, color: '#ffffff', highlight: 'color', highlightColor: '#ffd400',
    strokeColor: '#000000', stroke: 0.14, shadow: 0.04, box: false, boxColor: '#000000', boxOpacity: 0.6,
    y: 72, widthPct: 86, wordsPerPage: 3, maxLines: 2, animIn: 'pop', animOut: 'none', reveal: 'page',
  };
}

/** Cleans a stored / received look: unknown keys dropped, numbers held inside their limits, colours checked. */
export function normalizeCaptionStyle(raw) {
  const d = defaultCaptionStyle();
  const r = isObj(raw) ? raw : {};
  return {
    font: fontOf(r.font).id,
    size: round(num(r.size, d.size, 2.5, 16), 2),
    uppercase: r.uppercase === undefined ? d.uppercase : !!r.uppercase,
    color: hex(r.color, d.color), highlight: oneOf(r.highlight, HIGHLIGHTS, d.highlight), highlightColor: hex(r.highlightColor, d.highlightColor),
    strokeColor: hex(r.strokeColor, d.strokeColor), stroke: round(num(r.stroke, d.stroke, 0, 0.4)), shadow: round(num(r.shadow, d.shadow, 0, 0.3)),
    box: r.box === undefined ? d.box : !!r.box, boxColor: hex(r.boxColor, d.boxColor), boxOpacity: round(num(r.boxOpacity, d.boxOpacity, 0, 1), 2),
    y: round(num(r.y, d.y, 6, 94), 1), widthPct: round(num(r.widthPct, d.widthPct, 40, 96), 1),
    wordsPerPage: Math.round(num(r.wordsPerPage, d.wordsPerPage, 1, 12)), maxLines: Math.round(num(r.maxLines, d.maxLines, 1, 3)),
    animIn: oneOf(r.animIn, ANIM_IN, d.animIn), animOut: oneOf(r.animOut, ANIM_OUT, d.animOut), reveal: oneOf(r.reveal, REVEALS, d.reveal),
  };
}

/** What a job carries about captions (the words themselves are kept on the server, next to the video). */
export function normalizeCaptions(raw) {
  const r = isObj(raw) ? raw : {};
  return { enabled: !!r.enabled, template: typeof r.template === 'string' ? r.template.slice(0, 60) : '', style: normalizeCaptionStyle(r.style) };
}

// ── cues ─────────────────────────────────────────────────────────────────────────────────

const splitWords = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/** Words of a cue with a time each (interpolated by letter count when the cue has only a line of text). */
export function cueWords(cue) {
  if (Array.isArray(cue.words) && cue.words.length) return cue.words.map((w) => ({ s: w.s, e: w.e, w: String(w.w) }));
  const toks = splitWords(cue.text);
  if (!toks.length) return [];
  const total = toks.reduce((a, t) => a + t.length + 1, 0);
  let at = cue.s;
  return toks.map((t) => {
    const len = ((t.length + 1) / total) * (cue.e - cue.s);
    const w = { s: round(at), e: round(at + len), w: t };
    at += len;
    return w;
  });
}

/** Sorts, repairs and de-overlaps a list of cues; drops empty ones. Returns new objects. */
export function normalizeCues(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!isObj(c)) continue;
    const s = Number(c.s); let e = Number(c.e);
    const text = splitWords(c.text != null ? c.text : (Array.isArray(c.words) ? c.words.map((w) => w && w.w).join(' ') : '')).join(' ');
    if (!Number.isFinite(s) || s < 0 || !text) continue;
    if (!Number.isFinite(e) || e <= s) e = s + Math.max(0.5, text.length * 0.06);
    const cue = { s: round(s), e: round(e), text };
    if (Array.isArray(c.words) && c.words.length) {
      const ws = c.words.filter((w) => isObj(w) && Number.isFinite(Number(w.s)) && String(w.w || '').trim())
        .map((w) => ({ s: round(Number(w.s)), e: round(Math.max(Number(w.e), Number(w.s) + 0.02)), w: String(w.w).trim() }));
      if (ws.length === splitWords(text).length) cue.words = ws;
    }
    out.push(cue);
  }
  out.sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length - 1; i++) if (out[i].e > out[i + 1].s) out[i].e = Math.max(out[i].s + 0.05, out[i + 1].s);
  return out;
}

/** Replaces a cue's text. Word timings are kept when the number of words is unchanged, otherwise re-spread over the cue. */
export function setCueText(cue, text) {
  const toks = splitWords(text);
  const next = { s: cue.s, e: cue.e, text: toks.join(' ') };
  if (Array.isArray(cue.words) && cue.words.length === toks.length) next.words = cue.words.map((w, i) => ({ s: w.s, e: w.e, w: toks[i] }));
  return next;
}

/** Splits a cue in two at the word index `at` (1..n-1). */
export function splitCue(cue, at) {
  const ws = cueWords(cue);
  if (at < 1 || at >= ws.length) return [cue];
  const a = ws.slice(0, at); const b = ws.slice(at);
  const mk = (arr) => ({ s: arr[0].s, e: arr[arr.length - 1].e, text: arr.map((w) => w.w).join(' '), words: arr });
  return [mk(a), mk(b)];
}

/** Joins two neighbouring cues into one. */
export function mergeCues(a, b) {
  const ws = [...cueWords(a), ...cueWords(b)];
  return { s: a.s, e: Math.max(a.e, b.e), text: ws.map((w) => w.w).join(' '), words: ws };
}

/** Find and replace across cues (whole text; case-insensitive unless `matchCase`). Returns { cues, count }. */
export function replaceInCues(cues, find, replace, { matchCase = false, wholeWord = true } = {}) {
  const f = String(find || '').trim();
  if (!f) return { cues, count: 0 };
  const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}'])${esc}(?![\\p{L}\\p{N}'])` : esc, matchCase ? 'gu' : 'giu');
  let count = 0;
  const out = cues.map((c) => {
    let hit = 0;
    const text = c.text.replace(re, () => { hit++; return String(replace); });
    if (!hit) return c;
    count += hit;
    return setCueText(c, text);
  });
  return { cues: out, count };
}

/** Speech-recognition words [{s,e,w}] -> readable cues (a sentence or a pause ends one). */
export function groupWordsIntoCues(words, { maxWords = 10, maxChars = 64, pause = 0.7 } = {}) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push({ s: cur[0].s, e: cur[cur.length - 1].e, text: cur.map((w) => w.w).join(' '), words: cur }); cur = []; } };
  const list = (Array.isArray(words) ? words : []).filter((w) => w && String(w.w || '').trim()).map((w) => ({ s: round(Number(w.s)), e: round(Math.max(Number(w.e), Number(w.s) + 0.02)), w: String(w.w).trim() }));
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    const prev = cur[cur.length - 1];
    if (prev && w.s - prev.e >= pause) flush();
    if (cur.length && (cur.length >= maxWords || cur.map((x) => x.w).join(' ').length + w.w.length + 1 > maxChars)) flush();
    cur.push(w);
    if (/[.!?…]["')\]]?$/.test(w.w) && cur.length >= 3) flush();
  }
  flush();
  return normalizeCues(out);
}

const toSec = (h, m, s, ms) => Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms || '0').padEnd(3, '0').slice(0, 3)) / 1000;

/** SubRip (.srt) or WebVTT (.vtt) text -> cues. */
export function parseSubtitles(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const out = [];
  const re = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const s = toSec(m[1], m[2], m[3], m[4]); const e = toSec(m[5], m[6], m[7], m[8]);
    const body = [];
    for (i++; i < lines.length && lines[i].trim() !== ''; i++) body.push(lines[i]);
    const t = body.join(' ').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    out.push({ s, e, text: t });
  }
  return normalizeCues(out);
}

const stamp = (t, comma) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${comma ? ',' : '.'}${p(ms % 1000, 3)}`;
};
/** Cues -> .srt text (times on the source video's timeline). */
export function cuesToSrt(cues) { return `${normalizeCues(cues).map((c, i) => `${i + 1}\n${stamp(c.s, true)} --> ${stamp(c.e, true)}\n${c.text}\n`).join('\n')}`; }

/** The cues that touch [from, to] (source seconds). */
export function cuesInWindow(cues, from, to) { return cues.filter((c) => c.e > from && c.s < to); }

// ── pages: what is on screen at one time ───────────────────────────────────────────────────

/** Cues -> pages of at most `wordsPerPage` words, each with the span it is shown for. */
export function pagesOf(cues, style) {
  const st = normalizeCaptionStyle(style);
  const pages = [];
  for (const c of cues) {
    const ws = cueWords(c);
    for (let i = 0; i < ws.length; i += st.wordsPerPage) {
      const words = ws.slice(i, i + st.wordsPerPage);
      pages.push({ s: words[0].s, e: words[words.length - 1].e, words });
    }
  }
  for (let i = 0; i < pages.length; i++) { // a page stays up until the next one if they are close, otherwise a little past its last word
    const gap = i + 1 < pages.length ? pages[i + 1].s - pages[i].e : Infinity;
    pages[i].e = round(pages[i].e + Math.max(0, Math.min(0.3, gap)));
  }
  return pages;
}

/** Page showing at source time t, or null. */
export function pageAt(pages, t) {
  let lo = 0; let hi = pages.length - 1; let hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].s <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return hit !== null && t < pages[hit].e ? pages[hit] : null;
}

/**
 * Line breaks and text size for a page. Both renderers use exactly this: it estimates widths from the font's average letter
 * width (so the server needs no text measuring), breaks into balanced lines, and shrinks the text when it would not fit.
 */
export function layoutPage(page, style, W) {
  const st = normalizeCaptionStyle(style);
  const f = fontOf(st.font);
  const shown = page.words.map((w) => (st.uppercase ? w.w.toUpperCase() : w.w));
  let px = (st.size / 100) * W;
  const em = st.uppercase ? f.wideUpper : f.wide;
  const padPx = st.box ? px * 0.6 : 0;
  const maxW = Math.max(px, (W * st.widthPct) / 100 - padPx - px * st.stroke * 2);
  const total = shown.reduce((a, t) => a + t.length + 1, -1);
  let perLine = Math.max(3, Math.floor(maxW / (px * em)));
  let lines = Math.max(1, Math.ceil(total / perLine));
  if (lines > st.maxLines) { // too long for the allowed lines: make the text smaller
    const fit = Math.max(0.5, (st.maxLines * perLine) / total);
    px *= fit; perLine = Math.max(3, Math.floor(maxW / (px * em)));
    lines = Math.max(1, Math.min(st.maxLines, Math.ceil(total / perLine)));
  }
  const target = total / lines;
  const out = [[]]; let len = 0;
  shown.forEach((t, i) => {
    const cur = out[out.length - 1];
    const w = t.length + (cur.length ? 1 : 0);
    if (cur.length && out.length < lines && len + w / 2 > target) { out.push([i]); len = t.length; } else { cur.push(i); len += w; }
  });
  px = round(px, 2);
  const lineGap = round(st.box ? px * (f.asc + f.desc) * 0.92 : px * 1.2, 2);
  return { px, lines: out, shown, font: f, lineGap };
}

/**
 * Baseline (y, in frame pixels) of every line of a laid-out page. The anchor rule: a caption placed in the top part of the
 * frame hangs from its first line, in the middle it is centred, in the bottom part it stands on its last line.
 */
export function lineBaselines(lay, st, H) {
  const n = lay.lines.length; const capPx = lay.px * lay.font.cap; const yPx = (st.y / 100) * H;
  const blockH = capPx + (n - 1) * lay.lineGap;
  const anchor = anchorFor(st.y);
  const first = anchor === 'top' ? yPx + capPx : (anchor === 'middle' ? yPx - blockH / 2 + capPx : yPx - (n - 1) * lay.lineGap);
  return lay.lines.map((_, i) => round(first + i * lay.lineGap, 2));
}

/** Timing of the animations, in seconds of finished clip time. */
const IN_SEC = { fade: 0.16, pop: 0.14, slide: 0.2, bounce: 0.24 };
const OUT_SEC = 0.14;
const inDur = (st) => (IN_SEC[st.animIn] || 0);
const ease = (p) => 1 - (1 - p) * (1 - p);

/** Where the caption block is anchored for a position (% of height): 'top', 'middle' or 'bottom' (same rule in both renderers). */
export function anchorFor(y) { return y <= 38 ? 'top' : (y < 62 ? 'middle' : 'bottom'); }

// ── live preview (canvas) ─────────────────────────────────────────────────────────────────

export function ensureCaptionFonts(baseUrl = '/assets/fonts/') {
  if (typeof document === 'undefined' || !document.fonts || typeof FontFace === 'undefined') return Promise.resolve();
  if (!ensureCaptionFonts._p) {
    ensureCaptionFonts._p = Promise.all(CAPTION_FONTS.map((f) => {
      const ff = new FontFace(`${f.family}`, `url(${baseUrl}${f.file})`, { weight: String(f.weight) });
      return ff.load().then((x) => { document.fonts.add(x); }).catch(() => {});
    })).then(() => undefined);
  }
  return ensureCaptionFonts._p;
}

/**
 * Draws the caption page showing at source time `t` onto a W x H canvas context (transparent background).
 * `speed` is the clip's playback speed: animation lengths are given in finished-clip seconds.
 */
export function drawCaptionPage(ctx, W, H, page, style, t, { speed = 1 } = {}) {
  if (!page) return;
  const st = normalizeCaptionStyle(style);
  const lay = layoutPage(page, st, W);
  const f = lay.font; const px = lay.px;
  const sp = speed > 0 ? speed : 1;
  const sinceStart = (t - page.s) / sp;                     // finished-clip seconds since the page appeared
  const toEnd = (page.e - t) / sp;
  let n = page.words.length; let active = -1;
  for (let i = 0; i < n; i++) if (page.words[i].s <= t) active = i;
  const shownCount = st.reveal === 'word' ? Math.max(0, active + 1) : n;
  // in / out
  let alpha = 1; let scale = 1; let dy = 0;
  const d = inDur(st);
  if (d > 0 && sinceStart < d) {
    const p = Math.max(0, sinceStart / d);
    if (st.animIn === 'fade') alpha = p;
    else if (st.animIn === 'pop') { scale = 0.7 + 0.3 * ease(p); alpha = Math.min(1, p * 2); }
    else if (st.animIn === 'slide') { dy = (1 - ease(p)) * px * 0.9; alpha = p; }
    else if (st.animIn === 'bounce') { scale = p < 0.6 ? 0.6 + 0.52 * ease(p / 0.6) : 1.12 - 0.12 * ease((p - 0.6) / 0.4); alpha = Math.min(1, p * 3); }
  }
  if (st.animOut === 'fade' && toEnd < OUT_SEC) alpha *= Math.max(0, toEnd / OUT_SEC);
  if (alpha <= 0.001) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${f.weight} ${px}px "${f.family}", sans-serif`;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.lineJoin = 'round'; ctx.miterLimit = 2;
  const spaceW = ctx.measureText(' ').width;
  const bases = lineBaselines(lay, st, H);
  const midY = (bases[0] + bases[bases.length - 1]) / 2 - px * f.cap / 2;
  const cx = W / 2;
  ctx.translate(cx, midY + dy); ctx.scale(scale, scale); ctx.translate(-cx, -midY);
  const boxPad = px * 0.28;
  lay.lines.forEach((idxs, li) => {
    const widths = idxs.map((i) => ctx.measureText(lay.shown[i]).width);
    const lineW = widths.reduce((a, b) => a + b, 0) + spaceW * (idxs.length - 1);
    let x = cx - lineW / 2;
    const base = bases[li];
    if (st.box) { // libass draws the box around the whole line cell (ascent + descent) plus the padding
      ctx.save(); ctx.globalAlpha = alpha * st.boxOpacity; ctx.fillStyle = st.boxColor;
      const bx = x - boxPad; const by = base - px * f.asc - boxPad; const bw = lineW + boxPad * 2; const bh = px * (f.asc + f.desc) + boxPad * 2;
      ctx.fillRect(bx, by, bw, bh); ctx.restore();
    }
    idxs.forEach((i, k) => {
      const hidden = i >= shownCount;
      if (!hidden) {
        const isActive = i === active && st.highlight !== 'none';
        let s = 1;
        if (isActive && st.highlight === 'pop') { const wp = Math.min(1, ((t - page.words[i].s) / sp) / 0.18); s = wp < 0.5 ? 0.9 + 0.28 * ease(wp * 2) : 1.18 - 0.1 * ease((wp - 0.5) * 2); }
        const wx = x + widths[k] / 2; const wy = base - px * f.cap / 2;
        ctx.save(); ctx.translate(wx, wy); ctx.scale(s, s); ctx.translate(-wx, -wy);
        if (st.shadow > 0 && !st.box) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(lay.shown[i], x + px * st.shadow, base + px * st.shadow); }
        if (st.stroke > 0 && !st.box) { ctx.lineWidth = px * st.stroke * 2; ctx.strokeStyle = st.strokeColor; ctx.strokeText(lay.shown[i], x, base); }
        ctx.fillStyle = isActive ? st.highlightColor : st.color;
        ctx.fillText(lay.shown[i], x, base);
        ctx.restore();
      }
      x += widths[k] + spaceW;
    });
  });
  ctx.restore();
}

// ── ASS subtitles for the server ───────────────────────────────────────────────────────────

const assColor = (h, a = 0) => { const v = h.replace('#', ''); const r = v.slice(0, 2); const g = v.slice(2, 4); const b = v.slice(4, 6); return `&H${a.toString(16).toUpperCase().padStart(2, '0')}${b}${g}${r}`.toUpperCase() + '&'; };
const assTime = (t) => { const cs = Math.max(0, Math.round(t * 100)); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`; };
const assText = (s) => String(s).replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ');

/**
 * ASS script for one clip.
 *   cues       source-timeline cues (any; those outside the clip are ignored)
 *   clipStart  where the clip starts in the source (s)       span  how much source it covers (s)       speed  playback speed
 * Returns '' when no caption falls inside the clip.
 */
export function buildAss({ cues, style, W, H, clipStart = 0, span, speed = 1 }) {
  const st = normalizeCaptionStyle(style);
  const sp = speed > 0 ? speed : 1;
  const outLen = span / sp;
  const f = fontOf(st.font);
  const pages = pagesOf(normalizeCues(cues), st).filter((p) => p.e > clipStart && p.s < clipStart + span);
  if (!pages.length) return '';
  const toClip = (t) => Math.max(0, Math.min(outLen, (t - clipStart) / sp));
  const xPx = Math.round(W / 2);
  const hl = st.highlight !== 'none';
  const basePx = (st.size / 100) * W;
  const box = st.box;
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: None', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    // Alignment 2 = bottom centre: the line is placed by its own \pos, so lines never depend on libass' line spacing
    `Style: Cap,${f.ass.name},${round(basePx * (f.asc + f.desc), 2)},${assColor(st.color)},${assColor(st.color)},${assColor(box ? st.boxColor : st.strokeColor, box ? Math.round((1 - st.boxOpacity) * 255) : 0)},${assColor('#000000', box ? 255 : 140)},${f.ass.bold},0,0,0,100,100,0,0,${box ? 3 : 1},${round(box ? basePx * 0.28 : basePx * st.stroke, 2)},${box ? 0 : round(basePx * st.shadow, 2)},2,0,0,0,1`,
    '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  ];
  const events = [];
  for (const page of pages) {
    const lay = layoutPage(page, st, W);
    const bases = lineBaselines(lay, st, H);
    const n = page.words.length;
    const states = (hl || st.reveal === 'word') ? n : 1;
    for (let k = 0; k < states; k++) {
      const s0 = states === 1 ? page.s : page.words[k].s;
      const e0 = states === 1 ? page.e : (k < n - 1 ? page.words[k + 1].s : page.e);
      const a = toClip(Math.max(s0, clipStart)); const b = toClip(Math.min(e0, clipStart + span));
      if (b - a < 0.02) continue;
      const first = k === 0; const last = k === states - 1;
      const dIn = Math.round(inDur(st) * 1000);
      lay.lines.forEach((idxs, li) => {
        // the line's bottom edge sits below its baseline by the font's descent
        const yPx = Math.round(bases[li] + lay.px * lay.font.desc);
        const tags = [`\\an2`, `\\fs${round(lay.px * (lay.font.asc + lay.font.desc), 2)}`];
        if (first && st.animIn === 'slide') tags.push(`\\move(${xPx},${yPx + Math.round(lay.px * 0.9)},${xPx},${yPx},0,${dIn})`); else tags.push(`\\pos(${xPx},${yPx})`);
        if (first && st.animIn === 'pop') tags.push('\\fscx70\\fscy70', `\\t(0,${dIn},\\fscx100\\fscy100)`);
        if (first && st.animIn === 'bounce') tags.push('\\fscx60\\fscy60', `\\t(0,${Math.round(dIn * 0.6)},\\fscx112\\fscy112)`, `\\t(${Math.round(dIn * 0.6)},${dIn},\\fscx100\\fscy100)`);
        const fadeIn = first ? (st.animIn === 'fade' || st.animIn === 'slide' ? dIn : (st.animIn === 'pop' || st.animIn === 'bounce' ? Math.round(dIn * 0.5) : 0)) : 0;
        const fadeOut = last && st.animOut === 'fade' ? Math.round(OUT_SEC * 1000) : 0;
        if (fadeIn || fadeOut) tags.push(`\\fad(${fadeIn},${fadeOut})`);
        const text = idxs.map((i) => {
          const w = assText(lay.shown[i]);
          if (st.reveal === 'word' && i > k) return `{\\alpha&HFF&}${w}{\\alpha&H00&}`;
          if (hl && i === k) {
            const pop = st.highlight === 'pop' ? '\\fscx90\\fscy90\\t(0,90,\\fscx118\\fscy118)\\t(90,180,\\fscx108\\fscy108)' : '';
            return `{\\1c${assColor(st.highlightColor)}${pop}}${w}{\\1c${assColor(st.color)}\\fscx100\\fscy100}`;
          }
          return w;
        }).join(' ');
        events.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Cap,,0,0,0,,{${tags.join('')}}${text}`);
      });
    }
  }
  if (!events.length) return '';
  return `${head.join('\n')}\n${events.join('\n')}\n`;
}

// ── saved looks (templates) ───────────────────────────────────────────────────────────────

export const CAPTION_FALLBACK_TEMPLATES = [
  { id: 'pop-highlight', label: 'Pop Highlight', description: 'Bold uppercase words, the spoken word turns yellow and swells.', style: { font: 'poppins', size: 7.2, uppercase: true, highlight: 'pop', y: 70, wordsPerPage: 3, animIn: 'pop' } },
];
let TEMPLATES = CAPTION_FALLBACK_TEMPLATES.map((t) => ({ ...t, system: true, style: normalizeCaptionStyle(t.style) }));
let USER_LIMIT = 30;

/** Installs the built-in looks read from config/caption-templates.json (unusable entries are skipped). */
export function setCaptionTemplates(raw) {
  const list = isObj(raw) && Array.isArray(raw.templates) ? raw.templates : CAPTION_FALLBACK_TEMPLATES;
  const seen = new Set(); const out = [];
  for (const t of list) {
    if (!isObj(t) || typeof t.label !== 'string' || !t.label.trim()) continue;
    const id = String(t.id || t.label).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: t.label.trim().slice(0, 60), description: String(t.description || '').slice(0, 160), system: true, style: normalizeCaptionStyle(t.style) });
  }
  TEMPLATES = out.length ? out : CAPTION_FALLBACK_TEMPLATES.map((t) => ({ ...t, system: true, style: normalizeCaptionStyle(t.style) }));
  USER_LIMIT = isObj(raw) ? Math.round(num(raw.userTemplateLimit, 30, 0, 200)) : 30;
  return TEMPLATES;
}
export function captionTemplates() { return TEMPLATES.map((t) => ({ ...t, style: { ...t.style } })); }
export function userTemplateLimit() { return USER_LIMIT; }

/** Cleans the looks a person saved in the browser; they can never take the id of a built-in one. */
export function normalizeUserTemplates(list) {
  const used = new Set(TEMPLATES.map((t) => t.id)); const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!isObj(t) || typeof t.label !== 'string' || !t.label.trim()) continue;
    const id = String(t.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || `u${Date.now().toString(36)}${out.length}`;
    if (used.has(id)) continue;
    used.add(id);
    out.push({ id, label: t.label.trim().slice(0, 60), description: '', system: false, style: normalizeCaptionStyle(t.style) });
  }
  return out.slice(0, USER_LIMIT);
}

export async function loadCaptionTemplates(url = '/config/caption-templates.json') {
  try { const res = await fetch(url, { cache: 'no-cache' }); if (res.ok) setCaptionTemplates(await res.json()); } catch { /* the built-ins apply */ }
  return TEMPLATES;
}
