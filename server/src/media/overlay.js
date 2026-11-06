'use strict';
/**
 * Part-number overlays.
 *
 * The drawing code is a direct port of the canvas code from the browser recorder so the
 * look is identical:
 *   part-text     "PART N" — heavy sans, red fill, dark stroke, top 8 %
 *   styled-number big N — white->grey gradient, orange stroke, drop shadow, 42 % down
 *
 * Primary path renders a transparent PNG (via @napi-rs/canvas) that ffmpeg overlays with a
 * timed fade. If the canvas module is unavailable we fall back to ffmpeg's drawtext filter
 * (same placement, no gradient) so clips never fail because of a missing optional dependency.
 */
const fs = require('fs');
const path = require('path');

let canvasLib = null;
try { canvasLib = require('@napi-rs/canvas'); } catch { canvasLib = null; }

const FONT_FILE = path.resolve(__dirname, '..', '..', 'assets', 'fonts', 'ArchivoBlack-Regular.ttf');
let fontFamilyReady = false;
function ensureFont() {
  if (fontFamilyReady || !canvasLib) return;
  try { canvasLib.GlobalFonts.registerFromPath(FONT_FILE, 'Archivo Black'); } catch { /* fall back to system fonts */ }
  fontFamilyReady = true;
}

const OVERLAY_SHOW_SEC = 5;
const OVERLAY_FADE_SEC = 1;

function fontSpec(px) {
  ensureFont();
  const has = (f) => { try { return canvasLib.GlobalFonts.has(f); } catch { return false; } };
  if (has('Arial Black')) return `bold ${px}px 'Arial Black'`;
  return `${px}px 'Archivo Black', Impact, sans-serif`;
}

function isSupportedFormat(format) { return format === 'part-text' || format === 'styled-number'; }

async function renderPng({ format, partNumber, width, height, outFile }) {
  if (!canvasLib) return false;
  ensureFont();
  const canvas = canvasLib.createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);

  if (format === 'part-text') {
    const fs_ = Math.round(width * 0.085);
    ctx.font = fontSpec(fs_);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = fs_ * 0.12;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(`PART ${partNumber}`, width / 2, height * 0.08);
    ctx.fillStyle = '#cc0000';
    ctx.fillText(`PART ${partNumber}`, width / 2, height * 0.08);
  } else if (format === 'styled-number') {
    const ns = Math.round(width * 0.28);
    ctx.font = fontSpec(ns);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = ns * 0.12;
    ctx.shadowOffsetX = ns * 0.06;
    ctx.shadowOffsetY = ns * 0.06;
    ctx.strokeStyle = '#b85c00';
    ctx.lineWidth = ns * 0.09;
    ctx.strokeText(String(partNumber), width / 2, height * 0.42);
    const grad = ctx.createLinearGradient(0, height * 0.42 - ns / 2, 0, height * 0.42 + ns / 2);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.45, '#e0e0e0');
    grad.addColorStop(1, '#909090');
    ctx.fillStyle = grad;
    ctx.fillText(String(partNumber), width / 2, height * 0.42);
  } else {
    return false;
  }
  const png = await canvas.encode('png');
  await fs.promises.writeFile(outFile, png);
  return true;
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** drawtext fallback (no gradient). Returns a filter string operating on the current video label. */
function drawtextFilter({ format, partNumber, width, height, startSec }) {
  const s = startSec;
  const e = startSec + OVERLAY_SHOW_SEC;
  const fadeAt = startSec + OVERLAY_SHOW_SEC - OVERLAY_FADE_SEC;
  const alpha = `if(gt(t,${fadeAt}),max(0,1-(t-${fadeAt})/${OVERLAY_FADE_SEC}),1)`;
  const font = escapeFilterPath(FONT_FILE);
  if (format === 'part-text') {
    const size = Math.round(width * 0.085);
    return `drawtext=fontfile='${font}':text='PART ${partNumber}':x=(w-text_w)/2:y=${Math.round(height * 0.08)}:fontsize=${size}:fontcolor=0xcc0000:borderw=${Math.max(2, Math.round(size * 0.06))}:bordercolor=black@0.85:alpha='${alpha}':enable='between(t,${s},${e})'`;
  }
  const size = Math.round(width * 0.28);
  return `drawtext=fontfile='${font}':text='${partNumber}':x=(w-text_w)/2:y=${Math.round(height * 0.42 - size / 2)}:fontsize=${size}:fontcolor=white:borderw=${Math.max(3, Math.round(size * 0.045))}:bordercolor=0xb85c00:shadowcolor=black@0.7:shadowx=${Math.round(size * 0.06)}:shadowy=${Math.round(size * 0.06)}:alpha='${alpha}':enable='between(t,${s},${e})'`;
}

/**
 * Decide how to draw the overlay for a clip.
 * Returns null | { kind: 'png', file } | { kind: 'drawtext', filter }
 */
async function prepareOverlay({ format, partNumber, startSec = 0, width, height, dir, name, hasDrawtext }) {
  if (!isSupportedFormat(format) || partNumber === null || partNumber === undefined) return null;
  if (canvasLib) {
    const file = path.join(dir, `${name}.png`);
    if (await renderPng({ format, partNumber, width, height, outFile: file })) return { kind: 'png', file };
  }
  if (hasDrawtext) return { kind: 'drawtext', filter: drawtextFilter({ format, partNumber, width, height, startSec }) };
  return null;
}

module.exports = {
  prepareOverlay, renderPng, drawtextFilter, isSupportedFormat,
  OVERLAY_SHOW_SEC, OVERLAY_FADE_SEC, hasCanvas: () => !!canvasLib,
};
