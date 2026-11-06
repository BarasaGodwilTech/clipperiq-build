// How the source video is placed inside the output frame ("framing").
//
// Shared by the browser (the live preview) and the server (ffmpeg), so the preview shows exactly what is
// rendered. The model is deliberately small:
//   mode  'fill'  the video covers the whole frame and the overflow is cropped (the default, same as before)
//         'fit'   the whole video is visible and the rest of the frame is a background - this is how a
//                 16:9 YouTube video looks inside a 9:16 TikTok frame
//   bg    what fills the frame around a 'fit' video: 'blur' (a blurred, enlarged copy), 'black', or 'color'
//   zoom  1 = as placed by the mode; larger zooms in (up to 4x), smaller (fit only) shrinks the video
//   x, y  where the CENTRE of the video sits in the frame, 0..1 (0.5 / 0.5 = centred). Drag it to move it.

export const FRAME_MODES = [
  { id: 'fill', label: 'Fill the frame (crop)' },
  { id: 'fit', label: 'Fit the whole video' },
];
export const FRAME_BGS = [
  { id: 'blur', label: 'Blurred video' },
  { id: 'black', label: 'Black' },
  { id: 'color', label: 'Solid colour' },
];
export const FRAME_PRESETS = [
  { id: 'fill', label: 'Fill the frame (crop)', frame: { mode: 'fill', zoom: 1, x: 0.5, y: 0.5 } },
  { id: 'yt-blur', label: 'YouTube 16:9 inside 9:16 - blurred background', frame: { mode: 'fit', bg: 'blur', zoom: 1, x: 0.5, y: 0.5 } },
  { id: 'yt-black', label: 'YouTube 16:9 inside 9:16 - black bars', frame: { mode: 'fit', bg: 'black', zoom: 1, x: 0.5, y: 0.5 } },
  { id: 'yt-top', label: 'YouTube 16:9 near the top (space for captions below)', frame: { mode: 'fit', bg: 'blur', zoom: 1, x: 0.5, y: 0.36 } },
];

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export function defaultFrame() {
  return { mode: 'fill', bg: 'blur', color: '#000000', zoom: 1, x: 0.5, y: 0.5 };
}

/**
 * Cleans a stored / received framing. `legacyFit` is the old job option ('blur' = fit with a blurred background)
 * and is only used when no framing was given.
 */
export function normalizeFrame(raw, legacyFit) {
  const d = defaultFrame();
  if (!raw || typeof raw !== 'object') {
    return legacyFit === 'blur' ? { ...d, mode: 'fit', bg: 'blur' } : d;
  }
  const mode = raw.mode === 'fit' ? 'fit' : 'fill';
  return {
    mode,
    bg: ['blur', 'black', 'color'].includes(raw.bg) ? raw.bg : d.bg,
    color: HEX.test(raw.color) ? raw.color : d.color,
    zoom: num(raw.zoom, 1, mode === 'fit' ? 0.3 : 1, 4),
    x: num(raw.x, 0.5, -0.5, 1.5),
    y: num(raw.y, 0.5, -0.5, 1.5),
  };
}

export function isDefaultFrame(f) {
  const n = normalizeFrame(f);
  return n.mode === 'fill' && n.zoom === 1 && Math.abs(n.x - 0.5) < 1e-6 && Math.abs(n.y - 0.5) < 1e-6;
}

/**
 * Size of the output picture. 'fill' keeps the size of the centre crop (as always); 'fit' needs the full
 * width of the frame (without enlarging a small source), otherwise a wide video would be rendered tiny.
 * `aspect` is { r, refW, refH } of the chosen aspect ratio.
 */
export function frameOutputSize(srcW, srcH, aspect, frame) {
  const f = normalizeFrame(frame);
  if (f.mode === 'fit') {
    const outW = even(Math.min(aspect.refW, Math.max(srcW, srcH * aspect.r)));
    return { outW, outH: even(outW / aspect.r) };
  }
  let cw; let ch;
  if (srcW / srcH > aspect.r) { ch = srcH; cw = srcH * aspect.r; } else { cw = srcW; ch = srcW / aspect.r; }
  const k = Math.min(1, aspect.refW / even(cw), aspect.refH / even(ch));
  return { outW: even(even(cw) * k), outH: even(even(ch) * k) };
}

/** The video's rectangle inside an outW x outH frame: { x, y, w, h, covers } (x / y may be negative). */
export function videoRect(srcW, srcH, outW, outH, frame) {
  const f = normalizeFrame(frame);
  const base = f.mode === 'fit' ? Math.min(outW / srcW, outH / srcH) : Math.max(outW / srcW, outH / srcH);
  const k = base * f.zoom;
  const w = even(srcW * k); const h = even(srcH * k);
  let x = Math.round((f.x * outW - w / 2) / 2) * 2; // even offsets keep the chroma planes aligned
  let y = Math.round((f.y * outH - h / 2) / 2) * 2;
  if (f.mode === 'fill') { x = Math.min(0, Math.max(outW - w, x)); y = Math.min(0, Math.max(outH - h, y)); } // never reveal an edge
  return { x, y, w, h, covers: x <= 0 && y <= 0 && x + w >= outW && y + h >= outH };
}
