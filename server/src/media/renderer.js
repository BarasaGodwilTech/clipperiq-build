'use strict';
/**
 * Clip rendering — the server-side replacement for the browser MediaRecorder pipeline.
 *
 * Behaviour carried over from the recorder:
 *   - centre-crop to the requested aspect ratio (9:16, 16:9, 1:1, 4:5, or original)
 *   - "PART N" / big-number overlay, optional delayed start, shown 5 s with a 1 s fade-out
 *   - original-audio volume + looping background music with its own volume
 *
 * Improvements:
 *   - exact frame-accurate cuts, H.264/AAC, yuv420p, faststart (plays everywhere)
 *   - background music ducks under the original audio (sidechain compression)
 *   - EBU R128 loudness normalisation, music fade-out at the end
 *   - optional blurred-background "fit" mode instead of cropping
 *   - fast stream-copy mode when nothing needs re-encoding
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { prepareOverlay, drawtextFilter, OVERLAY_SHOW_SEC, OVERLAY_FADE_SEC } = require('./overlay');
const { createLowerThirdRenderer } = require('./lowerThird');

const ASPECTS = {
  '9:16': { r: 9 / 16, refW: 1080, refH: 1920 },
  '16:9': { r: 16 / 9, refW: 1920, refH: 1080 },
  '1:1': { r: 1, refW: 1080, refH: 1080 },
  '4:5': { r: 4 / 5, refW: 1080, refH: 1350 },
};

const MAX_COPY_KEYFRAME_GAP = 2.5; // seconds

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Output size and how the source is placed in it. `frame` / `framing` (js/shared/framing.js) describe a
 * non-default placement (fit with a background, zoom, a moved video); without them the picture is the
 * plain centre crop it has always been.
 */
function computeGeometry(src, aspectRatio, frame = null, framing = null) {
  const sw = src.width || 1280;
  const sh = src.height || 720;
  const a = ASPECTS[aspectRatio];
  if (!a) {
    // "original": keep the source frame, capped at 4K so absurd sources stay manageable
    const scale = Math.min(1, 3840 / Math.max(sw, sh));
    return { crop: null, outW: even(sw * scale), outH: even(sh * scale), scale: scale < 1 };
  }
  if (framing && frame && !framing.isDefaultFrame(frame)) {
    const f = framing.normalizeFrame(frame);
    const { outW, outH } = framing.frameOutputSize(sw, sh, a, f);
    return { crop: null, outW, outH, scale: true, custom: true, frame: f, rect: framing.videoRect(sw, sh, outW, outH, f), ref: a };
  }
  let cw; let ch;
  if (sw / sh > a.r) { ch = sh; cw = sh * a.r; } else { cw = sw; ch = sw / a.r; }
  const crop = { w: even(cw), h: even(ch) };
  const scale = Math.min(1, a.refW / crop.w, a.refH / crop.h);
  const outW = even(crop.w * scale);
  const outH = even(crop.h * scale);
  return { crop, outW, outH, scale: outW !== crop.w || outH !== crop.h, ref: a };
}

/**
 * Pure function: turns a render spec into ffmpeg arguments (+ the temp files it needs).
 * `overlay` is the result of prepareOverlay(); `caps` the detected ffmpeg capabilities.
 */
function buildPlan(spec, { overlay = null, lowerThird = null, lowerThirds: ltList = null, captions = null, framing = null, adjustLib = null, caps, config, workDir, encoder = 'libx264' }) {
  const { src, start, duration } = spec;
  // Clip adjustments (js/shared/adjust.js): null when nothing is adjusted, so the plan is exactly what it always was.
  const ap = adjustLib && spec.adjust && !adjustLib.isDefaultAdjust(spec.adjust) ? adjustLib.adjustPlan(spec.adjust) : null;
  const outDur = ap ? duration / ap.speed : duration; // a faster clip is shorter than the stretch of video it uses
  const frame = framing ? frameWithAdjust(framing, adjustLib, spec) : null;
  const geo = computeGeometry(src, spec.aspectRatio, frame, framing);
  const wantsOverlay = !!overlay;
  const bgm = spec.audio && spec.audio.bgm ? spec.audio.bgm : null;
  const originalVolume = spec.audio && Number.isFinite(spec.audio.originalVolume) ? spec.audio.originalVolume : 1;
  const hasAudio = !!src.hasAudio;
  const sameGeometry = !geo.crop && !geo.scale && !geo.custom;
  // Stream-copy can only begin on a keyframe. With long gaps between keyframes (screen
  // recordings, some downloads) a "fast" cut starts far earlier than asked and runs far too long,
  // so copy is only used when the keyframe spacing is known and short.
  const gapOk = Number(src.maxKeyframeGap) > 0 && Number(src.maxKeyframeGap) <= MAX_COPY_KEYFRAME_GAP;
  const canCopy = gapOk && src.videoCodec === 'h264' && (!hasAudio || src.audioCodec === 'aac');
  const customOverlay = spec.customOverlay && spec.customOverlay.file ? spec.customOverlay : null;
  // one or several animated lower thirds (each a prepared layer); `lowerThird` is the single-layer form
  const lts = Array.isArray(ltList) && ltList.length ? ltList : (lowerThird ? [lowerThird] : []);
  const needsFilters = !sameGeometry || wantsOverlay || !!customOverlay || lts.length > 0 || !!captions || !!bgm || originalVolume !== 1 || !!ap;
  const reEncode = !!spec.reEncode || needsFilters || !canCopy;

  const args = ['-ss', String(Math.max(0, start)), '-i', spec.inputFile];
  let nextInput = 1;

  if (!reEncode) {
    args.push('-t', String(duration), '-map', '0:v:0');
    if (hasAudio) args.push('-map', '0:a:0');
    // 'disabled' (not make_zero): the muxer then trims the lead-in frames before the requested start with
    // an edit list, so the clip begins exactly where asked with picture and sound in sync. make_zero
    // instead showed the lead-in from the previous keyframe (1-2 s early, ~80 ms video-behind-audio).
    args.push('-c', 'copy', '-avoid_negative_ts', 'disabled', '-movflags', '+faststart', spec.outFile);
    return { args, mode: 'copy', outW: src.width, outH: src.height };
  }

  // Decode warm-up. Seeking straight to the cut can land on a keyframe that is not a clean restart point
  // (common in .ts / streamed sources): the first frames then can't be decoded and the clip opens on a
  // frozen picture for up to a second while the sound plays. So decoding starts a little earlier and the
  // warm-up is trimmed off inside the filter graph (the overlay and music timelines are unaffected).
  // A cut at the very start of the video needs no seek and keeps the exact previous command.
  const keyGap = Number(src.maxKeyframeGap) || 0;
  const pre = Math.min(Math.max(0, start), Math.max(4, Math.min(12, keyGap + 2)));
  const warm = pre > 0.05;
  if (warm) args[1] = String(Math.max(0, start) - pre);
  const preS = pre.toFixed(3);
  let vSrc = warm ? 'vsrc' : '0:v:0';
  const aSrc = warm ? 'asrc' : '0:a:0';

  const fc = []; // filter_complex chains
  if (warm) {
    fc.push(`[0:v:0]trim=start=${preS},setpts=PTS-${preS}/TB[vsrc]`);
    if (hasAudio) fc.push(`[0:a:0]atrim=start=${preS},asetpts=PTS-${preS}/TB[asrc]`);
  }
  // ── clip adjustments, picture part ───────────────────────────────────────
  // Flip, colour and speed change the source picture BEFORE it is placed in the frame (so the blurred background
  // follows them too). The zoom part of the adjustments is not here: it was folded into the framing above
  // (frameWithAdjust), so the preview and this render place the video with the same maths.
  if (ap) {
    const pre = [];
    if (ap.flipH) pre.push('hflip');
    if (ap.flipV) pre.push('vflip');
    if (ap.colour && caps.filters.eq !== false) pre.push(`eq=brightness=${ap.colour.brightness}:contrast=${ap.colour.contrast}:saturation=${ap.colour.saturation}`);
    if (Math.abs(ap.speed - 1) > 1e-6) pre.push(`setpts=PTS/${ap.speed}`);
    if (pre.length) { fc.push(`[${vSrc}]${pre.join(',')}[vadj]`); vSrc = 'vadj'; }
  }
  // ── video ────────────────────────────────────────────────────────────────
  let vLabel = vSrc;
  const vChain = [];
  if (geo.custom) {
    // Framing: the video is scaled and placed inside the output frame (see js/shared/framing.js).
    const { outW, outH, rect, frame: fr } = geo;
    if (rect.covers) {
      vChain.push(`scale=${rect.w}:${rect.h}:flags=bicubic`, `crop=${outW}:${outH}:${Math.max(0, -rect.x)}:${Math.max(0, -rect.y)}`, 'setsar=1');
      fc.push(`[${vLabel}]${vChain.join(',')}[vbase]`);
    } else {
      fc.push(`[${vSrc}]split=2[bgsrc][fgsrc]`);
      if (fr.bg === 'blur') {
        const blurFilter = caps.filters.gblur ? 'gblur=sigma=28' : 'boxblur=24:2';
        fc.push(`[bgsrc]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},${blurFilter},eq=brightness=-0.08[bg]`);
      } else {
        const colour = fr.bg === 'color' ? `0x${fr.color.slice(1)}` : 'black';
        fc.push(`[bgsrc]scale=${outW}:${outH},drawbox=x=0:y=0:w=iw:h=ih:color=${colour}:t=fill[bg]`);
      }
      fc.push(`[fgsrc]scale=${rect.w}:${rect.h}:flags=bicubic[fg]`);
      fc.push(`[bg][fg]overlay=${rect.x}:${rect.y},setsar=1[vbase]`);
    }
    vLabel = 'vbase';
  } else {
    if (geo.crop) vChain.push(`crop=${geo.crop.w}:${geo.crop.h}:(iw-${geo.crop.w})/2:(ih-${geo.crop.h})/2`);
    if (geo.scale) vChain.push(`scale=${geo.outW}:${geo.outH}:flags=bicubic`);
    vChain.push('setsar=1');
    fc.push(`[${vLabel}]${vChain.join(',')}[vbase]`);
    vLabel = 'vbase';
  }

  // The person's own layer (text, stickers, images drawn in the upload editor): one transparent PNG
  // laid over the whole clip, scaled to the output size so it lands exactly where it was placed.
  if (customOverlay) {
    args.push('-loop', '1', '-framerate', '30', '-t', String(duration + 0.5), '-i', customOverlay.file);
    const ci = nextInput++;
    fc.push(`[${ci}:v]format=rgba,scale=${geo.outW}:${geo.outH}:flags=lanczos[cust]`);
    fc.push(`[${vLabel}][cust]overlay=0:0:eof_action=pass[vcust]`);
    vLabel = 'vcust';
  }

  // The animated lower third: a short transparent video drawn by lowerThird.js, shifted to its start time
  // (and looped when it repeats). It only covers the band it moves in, so it is laid at that height.
  // Several of them are laid on in order, each at its own start time (the first uses the labels it always had).
  lts.forEach((lt, k) => {
    if (lt.loop) args.push('-stream_loop', '-1');
    args.push('-t', String(duration + 1), '-i', lt.file);
    const li = nextInput++;
    const sfx = k === 0 ? '' : String(k + 1);
    fc.push(`[${li}:v]format=rgba,setpts=PTS+${Number(lt.start).toFixed(3)}/TB[ltl${sfx}]`);
    fc.push(`[${vLabel}][ltl${sfx}]overlay=0:${lt.y}:eof_action=pass[vlt${sfx}]`);
    vLabel = `vlt${sfx}`;
  });

  const vOut = captions ? 'vcapin' : 'vout';
  if (overlay && overlay.kind === 'png') {
    const s = spec.overlay.startSec || 0;
    const total = s + OVERLAY_SHOW_SEC;
    args.push('-loop', '1', '-framerate', '30', '-t', String(total + 0.5), '-i', overlay.file);
    const idx = nextInput++;
    const fadeStart = total - OVERLAY_FADE_SEC;
    fc.push(`[${idx}:v]format=rgba,fade=t=out:st=${fadeStart}:d=${OVERLAY_FADE_SEC}:alpha=1[ovl]`);
    fc.push(`[${vLabel}][ovl]overlay=0:0:enable='between(t,${s},${total})':eof_action=pass[${vOut}]`);
  } else if (overlay && overlay.kind === 'drawtext') {
    fc.push(`[${vLabel}]${overlay.filter}[${vOut}]`);
  } else {
    fc.push(`[${vLabel}]null[${vOut}]`);
  }

  // ── audio ────────────────────────────────────────────────────────────────
  // Levels work like this: the original audio is first brought to a standard loudness, THEN the
  // "original volume" slider scales it (so 50% really is half as loud, instead of being undone
  // by normalisation). Background music is brought to the same standard loudness and scaled
  // by its own slider, so "music 25%" means the same thing whatever track you pick. Ducking
  // listens to the full-strength voice, so music dips under speech at any slider setting.
  const profile = PROFILES[spec.profile] || PROFILES.balanced;
  const doNorm = !!(spec.audio && spec.audio.normalize !== false && profile.normalize !== false && caps.filters.loudnorm);
  const aFmt = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const loud = `loudnorm=I=${config.ffmpeg.loudnormTarget}:TP=-1.5:LRA=11`;
  const norm = (extra = []) => [aFmt, ...(doNorm ? [loud, aFmt] : []), ...extra].join(',');
  const vol = (n) => `volume=${Math.max(0, n).toFixed(3)}`;
  const limiter = caps.filters.alimiter ? 'alimiter=limit=0.95:level=0' : null;
  const hasVoice = hasAudio && originalVolume > 0.001;
  const aAdj = ap && ap.audioChanges ? audioAdjustChain(ap, caps) : []; // speed / pitch / reverb of the original sound
  let audioOut = null;
  if (bgm) {
    const offset = Math.max(0, bgm.offsetSec || 0);
    args.push('-stream_loop', '-1', '-ss', String(offset), '-i', bgm.file);
    const bi = nextInput++;
    const bv = Math.max(0, Math.min(1.5, bgm.volume));
    // A track that was normalised once up front (prepareBgm) only needs its format and level here.
    const musicChain = bgm.preNormalized ? [aFmt, vol(bv)].join(',') : norm([vol(bv)]);
    fc.push(`[${bi}:a]${musicChain}[b0]`);
    if (hasVoice) {
      const canDuck = bgm.duck !== false && !(ap && ap.duck === false) && caps.filters.sidechaincompress;
      fc.push(`[${aSrc}]${norm(aAdj)}[v0]`);
      if (canDuck) fc.push('[v0]asplit=2[v1][v2]'); else fc.push('[v0]anull[v1]');
      fc.push(`[v1]${vol(originalVolume)}[a0]`);
      // Only newer ffmpeg builds accept amix's `normalize` option; older ones reject it as an
      // unknown option and fail the whole filter graph, so it's included conditionally. Builds
      // without it halve every input, which the extra volume=2 below puts back.
      const amixOpts = `inputs=2:duration=first:dropout_transition=0${caps.amixHasNormalize ? ':normalize=0' : ''}`;
      let musicLabel = 'b0';
      if (canDuck) {
        fc.push('[b0][v2]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=350[bduck]');
        musicLabel = 'bduck';
      }
      const tail = [];
      if (!caps.amixHasNormalize) tail.push('volume=2');
      if (caps.filters.afade && outDur > 2) tail.push(`afade=t=out:st=${Math.max(0, outDur - 1)}:d=1`);
      if (limiter) tail.push(limiter);
      fc.push(`[a0][${musicLabel}]amix=${amixOpts}${tail.length ? ',' + tail.join(',') : ''}[aout]`);
    } else {
      // Music only (no usable original audio, or original volume set to 0).
      const tail = [];
      if (caps.filters.afade && outDur > 2) tail.push(`afade=t=out:st=${Math.max(0, outDur - 1)}:d=1`);
      if (limiter) tail.push(limiter);
      fc.push(`[b0]${tail.length ? tail.join(',') : 'anull'}[aout]`);
    }
    audioOut = '[aout]';
  } else if (hasAudio) {
    const extra = [...aAdj];
    if (originalVolume !== 1) extra.push(vol(originalVolume));
    if (originalVolume > 1 && limiter) extra.push(limiter);
    fc.push(`[${aSrc}]${norm(extra)}[aout]`);
    audioOut = '[aout]';
  }

  // captions go on last, over everything else (the part number, the lower third, custom overlays)
  if (captions) fc.push(`[vcapin]ass=filename='${ffFilterPath(captions.file)}':fontsdir='${ffFilterPath(captions.fontsDir)}'[vout]`);
  args.push('-filter_complex', fc.join(';'), '-map', '[vout]');
  if (audioOut) args.push('-map', audioOut);
  args.push('-t', String(outDur));
  args.push(...videoEncoderArgs(encoder, profile.preset || config.ffmpeg.preset, Number(config.ffmpeg.crf) + (profile.crfDelta || 0)));
  // With several clips rendering at once, give each its share of the cores instead of every
  // encoder grabbing them all (oversubscribing the CPU makes parallel renders slower, not faster).
  const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  const conc = Math.max(1, Number(config.ffmpeg.clipConcurrency) || 1);
  const encThreads = config.ffmpeg.threads || (conc > 1 ? Math.max(2, Math.ceil(cores / conc)) : 0);
  if (encThreads) args.push('-threads', String(encThreads));
  if (audioOut) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2');
  else args.push('-an');
  args.push('-movflags', '+faststart', spec.outFile);

  return { args, mode: 'encode', outW: geo.outW, outH: geo.outH };
}

/** The framing the picture is placed with: the chosen framing zoomed by the adjustments' scale (js/shared/adjust.js). */
function frameWithAdjust(framing, adjustLib, spec) {
  const f = framing.normalizeFrame(spec.frame, spec.fit);
  return adjustLib && spec.adjust ? adjustLib.effectiveFrame(f, spec.adjust) : f;
}

// atempo only accepts 0.5 - 2 per filter, so a bigger change is split into several
function atempoChain(x) {
  const out = [];
  let t = x;
  while (t > 2) { out.push('atempo=2'); t /= 2; }
  while (t < 0.5) { out.push('atempo=0.5'); t /= 0.5; }
  if (Math.abs(t - 1) > 1e-6) out.push(`atempo=${t.toFixed(5)}`);
  return out;
}

/**
 * Audio filters for the adjustments, applied to the original sound after it was normalised (48 kHz):
 *   keep pitch ON : tempo follows the speed; the extra pitch shift is done by resampling and the tempo compensated
 *   keep pitch OFF: pitch follows the speed (like a tape) plus the extra shift; tempo is just the speed
 * then an optional light room echo (reverb).
 */
function audioAdjustChain(ap, caps) {
  const out = [];
  const s = ap.speed; const r = ap.pitchRatio;
  if (ap.preservePitch) {
    if (Math.abs(r - 1) > 1e-6) out.push(`asetrate=${Math.round(48000 * r)}`, 'aresample=48000');
    out.push(...atempoChain(s / r));
  } else if (Math.abs(s * r - 1) > 1e-6) {
    out.push(`asetrate=${Math.round(48000 * s * r)}`, 'aresample=48000');
    out.push(...atempoChain(1 / r));
  }
  if (ap.echo && caps.filters.aecho !== false) out.push(`aecho=in_gain=0.9:out_gain=${ap.echo.outGain}:delays=45|90:decays=${ap.echo.decay1}|${ap.echo.decay2}`);
  return out;
}

/** A file path inside an ffmpeg filter option: forward slashes, and the colon of a Windows drive letter escaped. */
function ffFilterPath(p) { return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'"); }
const CAPTION_FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts');

// Speed profiles, chosen per job. Faster presets finish sooner but make bigger files, so the default stays
// the balanced one. "turbo" also skips loudness normalisation (about a fifth of the render time).
const PROFILES = {
  balanced: {},
  fast: { preset: 'superfast', crfDelta: 2 },
  turbo: { preset: 'ultrafast', crfDelta: 5, normalize: false },
};

function videoEncoderArgs(name, preset, crf) {
  switch (name) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(Math.min(51, crf + 3)), '-b:v', '0', '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-global_quality', String(Math.min(51, crf + 3)), '-preset', 'veryfast', '-pix_fmt', 'nv12'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(Math.min(51, crf + 2)), '-qp_p', String(Math.min(51, crf + 4)), '-pix_fmt', 'yuv420p'];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-q:v', '60', '-pix_fmt', 'yuv420p'];
    default: return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  }
}

function createRenderer({ ff, config, logger }) {
  const lowerThirds = createLowerThirdRenderer({ ff, config, logger });
  // js/shared/framing.js is an ES module shared with the browser; it is loaded once, on first use.
  let framingP = null;
  const loadFraming = () => (framingP || (framingP = import(pathToFileURL(path.join(config.rootDir, 'js', 'shared', 'framing.js')).href)));
  // js/shared/captions.js (auto captions) too
  let captionsP = null;
  const loadCaptions = () => (captionsP || (captionsP = import(pathToFileURL(path.join(config.rootDir, 'js', 'shared', 'captions.js')).href)));
  // js/shared/adjust.js (clip adjustments) is loaded the same way, with its settings from config/clip-adjustments.json.
  let adjustP = null;
  const loadAdjust = () => (adjustP || (adjustP = (async () => {
    const lib = await import(pathToFileURL(path.join(config.rootDir, 'js', 'shared', 'adjust.js')).href);
    try { lib.setAdjustConfig(JSON.parse(await fs.promises.readFile(path.join(config.rootDir, 'config', 'clip-adjustments.json'), 'utf8'))); } catch (e) {
      logger?.warn(`clip adjustments: config/clip-adjustments.json not used (${e.code === 'ENOENT' ? 'file missing' : e.message}); built-in limits apply`);
    }
    return lib;
  })()));

  // Which encoder renders clips: software by default; a working graphics-card encoder if the person asked
  // for one (VIDEO_ENCODER). Decided once, by really trying it, then remembered.
  let encoderChoice = null;
  async function resolveEncoder(caps) {
    if (encoderChoice) return encoderChoice;
    const want = String(config.ffmpeg.videoEncoder || 'libx264').toLowerCase();
    let pick = 'libx264';
    if (want !== 'libx264' && typeof ff.testEncoder === 'function') {
      const order = want === 'auto' ? ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'] : [want];
      for (const name of order) {
        if (caps.encoders && caps.encoders[name] === false) continue;
        if (await ff.testEncoder(name)) { pick = name; break; }
      }
      logger?.info(pick === 'libx264'
        ? `video encoder: software (libx264) - no working hardware encoder found for VIDEO_ENCODER=${want}`
        : `video encoder: ${pick} (hardware)`);
    }
    encoderChoice = pick;
    return pick;
  }

  async function render(spec, { signal, onProgress, workDir } = {}) {
    const caps = ff.caps || (await ff.detectCapabilities());
    if (!caps.ok) throw new Error(`ffmpeg is not usable: ${caps.reason || 'unknown reason'}`);

    const framing = await loadFraming();
    const adjustLib = await loadAdjust();
    const adjusted = !!spec.adjust && !adjustLib.isDefaultAdjust(spec.adjust);
    const expectDur = adjusted ? spec.duration / adjustLib.adjustPlan(spec.adjust).speed : spec.duration; // length of the finished clip
    const geo = computeGeometry(spec.src, spec.aspectRatio, frameWithAdjust(framing, adjustLib, spec), framing);
    const warnings = [];
    const preparedLts = [];
    const ltSpecs = (Array.isArray(spec.lowerThirds) && spec.lowerThirds.length ? spec.lowerThirds : (spec.lowerThird ? [spec.lowerThird] : [])).filter((x) => x && x.enabled);
    for (const [n, ltSpec] of ltSpecs.entries()) {
      // Like the part number, a lower third is an extra: if one can't be drawn the clip is still made (with the others).
      try {
        const layer = await lowerThirds.prepare(ltSpec, { width: geo.outW, height: geo.outH, clipDuration: expectDur, workDir, partNumber: spec.partNumber });
        if (layer) preparedLts.push(layer);
      } catch (e) {
        logger?.warn(`render: lower third ${n + 1} failed (${e.message})`);
        warnings.push(`${ltSpecs.length > 1 ? `Lower third ${n + 1}` : 'The lower third'} could not be added to this clip (${String(e.message).slice(0, 120)}).`);
      }
    }
    let overlay = null;
    if (spec.overlay && spec.overlay.format && spec.overlay.format !== 'none') {
      // Overlay rendering is a nice-to-have, not something that should ever sink an entire
      // clip: if canvas throws for any reason (a native-module quirk on a given platform, a
      // font issue, low memory), fall back to the drawtext filter instead of failing the job.
      try {
        overlay = await prepareOverlay({
          format: spec.overlay.format,
          partNumber: spec.overlay.partNumber,
          startSec: spec.overlay.startSec || 0,
          width: geo.outW,
          height: geo.outH,
          dir: workDir,
          name: `overlay_${path.basename(path.dirname(spec.outFile))}_${path.basename(spec.outFile, '.mp4')}`,
          hasDrawtext: !!caps.filters.drawtext,
        });
      } catch (e) {
        logger?.warn(`render: canvas overlay failed (${e.message}); falling back to drawtext`);
        overlay = caps.filters.drawtext
          ? { kind: 'drawtext', filter: drawtextFilter({ format: spec.overlay.format, partNumber: spec.overlay.partNumber, startSec: spec.overlay.startSec || 0, width: geo.outW, height: geo.outH }) }
          : null;
      }
      if (!overlay) logger?.warn('render: overlay requested but neither canvas nor drawtext is available; continuing without it');
    }

    // Captions: animated subtitles (ASS) made for this clip's own stretch of the video, drawn by ffmpeg's libass.
    let captions = null;
    if (spec.captions && Array.isArray(spec.captions.cues) && spec.captions.cues.length) {
      try {
        const capLib = await loadCaptions();
        const speed = adjusted ? adjustLib.adjustPlan(spec.adjust).speed : 1;
        const ass = capLib.buildAss({ cues: spec.captions.cues, style: spec.captions.style, W: geo.outW, H: geo.outH, clipStart: spec.start, span: spec.duration, speed });
        if (ass && !caps.filters.ass) warnings.push('Captions need an ffmpeg build with subtitle support (libass); this clip was made without them.');
        else if (ass) {
          const file = path.join(workDir, `caps_${path.basename(path.dirname(spec.outFile))}_${path.basename(spec.outFile, '.mp4')}.ass`);
          await fs.promises.writeFile(file, ass, 'utf8');
          captions = { file, fontsDir: CAPTION_FONT_DIR };
        }
      } catch (e) {
        logger?.warn(`render: captions failed (${e.message})`);
        warnings.push(`Captions could not be added to this clip (${String(e.message).slice(0, 120)}).`);
      }
    }

    const gapSlack = Number(spec.src.maxKeyframeGap) || 0;
    const runPlan = async (planSpec) => {
      const encoder = await resolveEncoder(caps);
      const timeoutMs = config.ffmpeg.renderTimeoutMin * 60 * 1000;
      const attempt = async (enc) => {
        const plan = buildPlan(planSpec, { overlay, lowerThirds: preparedLts, captions, framing, adjustLib, caps, config, encoder: enc });
        logger?.debug(`render: ${plan.mode} ${spec.start}s+${spec.duration}s -> ${path.basename(spec.outFile)} (${enc})`);
        await fs.promises.unlink(spec.outFile).catch(() => {});
        await ff.runFfmpeg(plan.args, {
          signal, timeoutMs,
          onProgress: (sec) => onProgress?.(Math.max(0, Math.min(1, sec / Math.max(0.1, expectDur)))),
        });
        return plan;
      };
      try {
        return await attempt(encoder);
      } catch (e) {
        // A graphics-card encoder that fails mid-job (driver hiccup, too many sessions) must never sink the
        // clip: switch the whole renderer to software and redo this clip.
        if (encoder !== 'libx264' && !(signal && signal.aborted)) {
          logger?.warn(`render: ${encoder} failed (${String(e.message).slice(0, 160)}); switching to software encoding`);
          encoderChoice = 'libx264';
          return attempt('libx264');
        }
        throw e;
      }
    };

    // Checks what actually came out: right length, decodable, a real picture. Returns '' when
    // the clip is fine, otherwise a short reason.
    const check = async (plan) => {
      let info;
      try { info = await ff.probe(spec.outFile); } catch (e) { return `unreadable (${e.message})`; }
      if (!info.hasVideo) return 'has no video';
      const want = expectDur;
      const d = info.duration;
      if (!(d > 0.2)) return 'is empty';
      const slack = Math.max(2.5, want * 0.05) + (plan.mode === 'copy' ? gapSlack : 0);
      if (d > want + slack) return `is ${d.toFixed(0)}s long instead of ${want.toFixed(0)}s`;
      if (d < want * 0.5 && want - d > 3) return `is only ${d.toFixed(0)}s long instead of ${want.toFixed(0)}s`;
      if (d < want - slack) warnings.push(`Clip is ${d.toFixed(0)}s instead of ${want.toFixed(0)}s (the source ends early).`);
      // a few frames across the clip: all black means the cut landed on nothing
      const frames = [];
      for (const f of [0.1, 0.5, 0.9]) frames.push(await ff.sampleFrame(spec.outFile, d * f));
      if (frames.every((b) => !b)) return 'has no decodable picture';
      if (frames.every((b) => b && Math.max(...b) < 12)) return 'is completely black';
      return '';
    };

    let plan;
    let problem;
    try {
      plan = await runPlan(spec);
      problem = await check(plan);
      if (problem && plan.mode === 'copy') {
        // Fast copy gave a bad result: redo this one clip with an accurate re-encode instead.
        logger?.warn(`render: fast copy ${path.basename(spec.outFile)} ${problem}; re-rendering it by encoding`);
        plan = await runPlan({ ...spec, reEncode: true });
        problem = await check(plan);
      }
    } finally {
      if (overlay && overlay.file) fs.promises.unlink(overlay.file).catch(() => {});
      if (captions) fs.promises.unlink(captions.file).catch(() => {});
    }
    if (problem) {
      if (/black/.test(problem)) warnings.push('This clip looks black: the source may have no picture at this point.');
      else throw new Error(`Rendered clip ${problem}. The source video may be damaged at ${Math.round(spec.start)}s.`);
    }

    const info = await ff.probe(spec.outFile);
    return { mode: plan.mode, width: info.width, height: info.height, duration: info.duration, size: info.size || fs.statSync(spec.outFile).size, warnings };
  }

  /**
   * Normalises a background-music track to the target loudness ONCE, into a temp FLAC, so every
   * clip of a job can skip that step. Returns { bgm, cleanup }; on anything unexpected (feature
   * off, no loudnorm filter, very long track, ffmpeg error) the original track is returned
   * untouched and clips normalise it themselves exactly as before.
   */
  async function prepareBgm(bgm, { workDir, key, signal } = {}) {
    const noop = { bgm, cleanup: async () => {} };
    try {
      if (!bgm || !bgm.file || !config.ffmpeg.bgmPrenormalize) return noop;
      const caps = ff.caps || (await ff.detectCapabilities());
      if (!caps.ok || !caps.filters.loudnorm) return noop;
      const dur = Number(bgm.duration) || 0;
      if (!(dur > 0) || dur > 20 * 60) return noop; // unknown / very long: not worth a big temp file
      const out = path.join(workDir, `bgmnorm_${String(key).replace(/[^a-zA-Z0-9_-]/g, '')}.flac`);
      const fmt = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
      await ff.runFfmpeg(['-i', bgm.file, '-vn', '-af', `${fmt},loudnorm=I=${config.ffmpeg.loudnormTarget}:TP=-1.5:LRA=11,${fmt}`,
        '-ar', '48000', '-ac', '2', '-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', '0', out],
      { signal, timeoutMs: 10 * 60 * 1000 });
      const info = await ff.probe(out);
      // must still be the same track: same length (within a second), or don't use it
      if (!(info.duration > 0) || Math.abs(info.duration - dur) > Math.max(1, dur * 0.02)) {
        await fs.promises.unlink(out).catch(() => {});
        return noop;
      }
      return { bgm: { ...bgm, file: out, preNormalized: true }, cleanup: async () => { await fs.promises.unlink(out).catch(() => {}); } };
    } catch (e) {
      logger?.warn(`render: could not pre-normalise the background music (${e.message}); normalising per clip instead`);
      return noop;
    }
  }

  /**
   * An ffmpeg error names the file it could not read. If that is one of the cached lower-third animations, delete it so it is drawn
   * again, and report how many files were removed. (Called by the job runner before it tries the clip once more.)
   */
  async function purgeBrokenInputs(message) {
    let n = 0;
    const names = new Set(String(message || '').match(/\blt_[0-9a-f]{8,}\.mov\b/g) || []);
    for (const name of names) n += await lowerThirds.purge(path.join(config.dirs.tmp, name));
    return n;
  }

  return { render, purgeBrokenInputs, prepareBgm, buildPlan: (spec, opts) => buildPlan(spec, opts), computeGeometry };
}

module.exports = { createRenderer, buildPlan, computeGeometry, audioAdjustChain, ASPECTS };
