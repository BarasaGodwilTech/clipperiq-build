'use strict';
/**
 * Thin, dependable wrappers around ffmpeg / ffprobe:
 *   - binary discovery (env override -> bundled npm package -> PATH)
 *   - capability detection (encoders / filters we rely on)
 *   - process runner with timeout, cancellation and progress parsing
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

function canRun(bin, args = ['-version']) {
  try {
    const r = spawnSync(bin, args, { timeout: 15000, windowsHide: true });
    return r.status === 0;
  } catch { return false; }
}

function resolveBinaries(config) {
  const tried = [];
  const pick = (candidates) => {
    for (const [source, bin] of candidates) {
      if (!bin) continue;
      tried.push(`${source}: ${bin}`);
      if (canRun(bin)) return { bin, source };
    }
    return null;
  };

  // @ffmpeg-installer/ffmpeg (like ffprobe-static below) ships its binary as a regular npm
  // optionalDependency fetched from the npm registry during `npm install`. We deliberately
  // avoid packages that fetch a binary from a GitHub release at install time (e.g.
  // ffmpeg-static) — on some school/corporate networks that download is silently blocked or
  // stripped by a firewall or antivirus, leaving a path that resolves but doesn't exist.
  const ffInstaller = tryRequire('@ffmpeg-installer/ffmpeg');
  const fpStatic = tryRequire('ffprobe-static');
  const ffmpeg = pick([
    ['FFMPEG_PATH', config.ffmpeg.path],
    ['@ffmpeg-installer/ffmpeg', ffInstaller && ffInstaller.path],
    ['system PATH', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'],
  ]);
  const ffprobe = pick([
    ['FFPROBE_PATH', config.ffmpeg.probePath],
    ['ffprobe-static', fpStatic && fpStatic.path],
    ['system PATH', IS_WIN ? 'ffprobe.exe' : 'ffprobe'],
  ]);
  return {
    ffmpeg: ffmpeg ? ffmpeg.bin : null,
    ffprobe: ffprobe ? ffprobe.bin : null,
    ffmpegSource: ffmpeg ? ffmpeg.source : null,
    ffprobeSource: ffprobe ? ffprobe.source : null,
    tried,
  };
}

function run(bin, args, { cwd, timeoutMs = 0, signal, onStdout, onStderr, collect = true, maxBuffer = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = null;
    let timer = null;
    let killTimer = null;

    const kill = (reason) => {
      if (killed) return;
      killed = reason;
      try { child.stdin.write('q'); } catch { /* ignore */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
      try { child.kill(); } catch { /* ignore */ }
    };
    if (timeoutMs > 0) timer = setTimeout(() => kill('timeout'), timeoutMs);
    const onAbort = () => kill('aborted');
    if (signal) {
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      if (collect && stdout.length < maxBuffer) stdout += d.toString('utf8');
      if (onStdout) onStdout(d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxBuffer) stderr += d.toString('utf8');
      else stderr = stderr.slice(-maxBuffer / 2) + d.toString('utf8');
      if (onStderr) onStderr(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer); clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (killed) {
        const e = new Error(killed === 'timeout' ? 'Process timed out' : 'Process aborted');
        e.code = killed === 'timeout' ? 'ETIMEDOUT' : 'ABORT_ERR';
        e.stderr = stderr;
        return reject(e);
      }
      if (code === 0) return resolve({ stdout, stderr, code });
      const e = new Error(`${bin} exited with code ${code}`);
      e.exitCode = code;
      e.stdout = stdout;
      e.stderr = stderr;
      reject(e);
    });
  });
}

/** Last meaningful lines of ffmpeg stderr for error messages. */
function tailError(stderr, lines = 6) {
  const arr = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errs = arr.filter((l) => /error|invalid|no such|unable|failed|not found|unrecognized|cannot/i.test(l));
  return (errs.length ? errs : arr).slice(-lines).join(' | ').slice(0, 800);
}

function createFfmpeg(config, logger) {
  const bins = resolveBinaries(config);
  const state = { bins, caps: null };

  function assertReady() {
    if (!bins.ffmpeg || !bins.ffprobe) {
      const e = new Error('ffmpeg/ffprobe not found. Run "npm install" in the server folder (installs bundled binaries) or set FFMPEG_PATH / FFPROBE_PATH.');
      e.code = 'FFMPEG_MISSING';
      throw e;
    }
  }

  async function detectCapabilities() {
    if (!bins.ffmpeg) { state.caps = { ok: false, reason: 'ffmpeg not found' }; return state.caps; }
    const caps = { ok: true, version: null, encoders: {}, filters: {}, canvas: false };
    try {
      const v = await run(bins.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 15000 });
      caps.version = (v.stdout.split(/\r?\n/)[0] || '').replace(/^ffmpeg version\s+/i, '').split(' ')[0];
      const enc = await run(bins.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
      for (const name of ['libx264', 'aac', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']) caps.encoders[name] = new RegExp(`\\s${name}\\s`).test(enc.stdout);
      const fil = await run(bins.ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 15000 });
      for (const name of ['drawtext', 'overlay', 'amix', 'sidechaincompress', 'loudnorm', 'afade', 'alimiter', 'crop', 'scale', 'fade', 'tile', 'boxblur', 'gblur', 'eq', 'aecho', 'ass']) {
        caps.filters[name] = new RegExp(`\\s${name}\\s`).test(fil.stdout);
      }
      // amix's `normalize` option (skip auto-attenuating combined volume) only exists on
      // newer ffmpeg builds; older ones (e.g. the ~4.1 build some npm ffmpeg packages ship)
      // reject it outright as an unknown option, which fails the whole render.
      if (caps.filters.amix) {
        // `-h filter=X` commonly exits non-zero even on success (it's a diagnostic dump, not
        // an actual encode), so read from the error object's captured stdout too rather than
        // treating a non-zero exit as "couldn't check, assume unsupported".
        try {
          const help = await run(bins.ffmpeg, ['-hide_banner', '-h', 'filter=amix'], { timeoutMs: 15000 });
          caps.amixHasNormalize = /\bnormalize\b/.test(help.stdout);
        } catch (e) {
          caps.amixHasNormalize = /\bnormalize\b/.test(e.stdout || '');
        }
      }
      caps.ok = caps.encoders.libx264 && caps.encoders.aac;
      if (!caps.ok) caps.reason = 'ffmpeg build lacks libx264 or aac encoder';
    } catch (e) {
      caps.ok = false;
      caps.reason = e.message;
    }
    state.caps = caps;
    return caps;
  }

  /**
   * Whether an encoder actually works on this machine (a build can list a hardware encoder that has no
   * matching GPU / driver). Runs a tiny real encode; never throws.
   */
  async function testEncoder(name) {
    if (!bins.ffmpeg) return false;
    try {
      await run(bins.ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.3',
        '-frames:v', '6', '-c:v', name, '-pix_fmt', 'yuv420p', '-f', 'null', '-'], { timeoutMs: 20000 });
      return true;
    } catch { return false; }
  }

  async function probe(file, { verify = false } = {}) {
    assertReady();
    let stdout;
    try {
      ({ stdout } = await run(bins.ffprobe, [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
      ], { timeoutMs: 60000 }));
    } catch (e) {
      const why = e.stderr ? tailError(e.stderr, 2) : '';
      if (/moov atom not found/i.test(why)) e.message = 'the file is incomplete (the end of the MP4 is missing, so the download or export did not finish)';
      else if (why) e.message = why;
      throw e;
    }
    const j = JSON.parse(stdout || '{}');
    const streams = j.streams || [];
    const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const a = streams.find((s) => s.codec_type === 'audio');
    let rotation = 0;
    if (v) {
      const side = (v.side_data_list || []).find((d) => d.rotation !== undefined);
      rotation = Number(side ? side.rotation : (v.tags && v.tags.rotate) || 0) || 0;
    }
    let width = v ? Number(v.width) || 0 : 0;
    let height = v ? Number(v.height) || 0 : 0;
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    let fps = 0;
    if (v && v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
      const [n, d] = v.avg_frame_rate.split('/').map(Number);
      fps = d ? n / d : n;
    }
    // r_frame_rate is the stream's nominal rate; unlike avg_frame_rate it isn't derived from
    // the (possibly broken) timeline, so it's what frame counts are compared against.
    let nominalFps = 0;
    if (v && v.r_frame_rate && v.r_frame_rate !== '0/0') {
      const [n, d] = v.r_frame_rate.split('/').map(Number);
      nominalFps = d ? n / d : n;
      if (!(nominalFps > 0 && nominalFps <= 240)) nominalFps = 0;
    }
    // Container headers can understate the length (files stitched from streaming segments,
    // fragmented MP4s), so take the longest figure any part of the header gives.
    const headerDurations = [j.format && j.format.duration, v && v.duration, a && a.duration].map((x) => Number(x) || 0);
    let duration = Math.max(0, ...headerDurations);
    const headerDuration = duration;
    let warning = '';
    // Some files (screen recordings, browser-recorded .webm, some .mkv) don't store a length in
    // their header. Rather than reject them, measure it by reading through the file once
    // (stream copy, no re-encoding, so it's fast).
    if (!(duration > 0) && v) duration = await measureDuration(file);
    // verify: read the whole file once (stream copy, no re-encode) and trust the real length
    // over the header when the file turns out to be longer than it claims.
    let measuredDuration = 0;
    let videoSpan = 0;
    let audioSpan = 0;
    let videoPacketSum = 0;
    let videoFrames = 0;
    let maxKeyframeGap = 0;
    let timelineIssue = ''; // '' | 'restart' | 'gap' | 'compressed'
    if (verify && v) {
      // Read every packet's timestamp (no decoding, so it's quick). This is the real length of
      // the file, whatever the header claims; streaming (M3U8) downloads and stitched files
      // often carry a header that describes only the first segment.
      const scan = await scanPackets(file);
      const vs = scan.get(v.index);
      const as = a ? scan.get(a.index) : null;
      if (vs) {
        videoSpan = vs.span; videoPacketSum = vs.sum; videoFrames = vs.count; maxKeyframeGap = vs.maxKeyGap;
        // How the clock disagrees with the frames actually in the file:
        //   restart    : clock jumps back, so frame durations add up to more than the timeline
        //   compressed : far more frames than the timeline has room for (squashed timestamps)
        //   gap        : clock jumps forward (ad breaks, dropped segments): the file claims to be
        //                far longer than the footage in it, and time-based cuts land in empty space
        if (vs.sum > vs.span * 1.1 + 2) timelineIssue = 'restart';
        else if (nominalFps > 0 && vs.count > 50 && vs.count / nominalFps > vs.span * 1.1 + 2) timelineIssue = 'compressed';
        else if (vs.withDur >= vs.count * 0.9 && vs.sum > 0 && vs.span > vs.sum * 1.1 + 5) timelineIssue = 'gap';
      }
      if (as) audioSpan = as.span;
      measuredDuration = Math.max(videoSpan, audioSpan);
      if (!(measuredDuration > 0)) measuredDuration = await measureDuration(file); // fallback: remux scan
      if (measuredDuration > 0) {
        // The scan reads the actual packets, so it wins over the header whenever they disagree.
        if (Math.abs(measuredDuration - duration) > Math.max(1, duration * 0.02)) duration = measuredDuration;
      }
      if (videoSpan > 0 && audioSpan > 0 && Math.abs(videoSpan - audioSpan) > Math.max(5, Math.max(videoSpan, audioSpan) * 0.1)) {
        warning = `The picture runs ${Math.round(videoSpan)}s but the audio runs ${Math.round(audioSpan)}s, so this file is damaged or was stitched together badly. Parts past the shorter track may be black or silent.`;
      } else if (timelineIssue === 'restart' || timelineIssue === 'compressed') {
        warning = `The video's timestamps are broken (${Math.round(videoSpan)}s of timeline but about ${Math.round(Math.max(videoPacketSum, nominalFps ? videoFrames / nominalFps : 0))}s of footage), so clips may be cut from the wrong place. Re-export the file as MP4 first.`;
      } else if (timelineIssue === 'gap') {
        warning = `The video's clock jumps forward partway through: it claims ${Math.round(videoSpan)}s but only about ${Math.round(videoPacketSum)}s of footage is in the file. Clips would repeat or come out empty. Re-export the file as MP4 first.`;
      }
    }
    return {
      duration, headerDuration, measuredDuration, videoSpan, audioSpan, videoPacketSum, videoFrames, maxKeyframeGap, timelineIssue, warning,
      width, height, fps, nominalFps,
      hasVideo: !!v,
      hasAudio: !!a,
      videoCodec: v ? v.codec_name : null,
      audioCodec: a ? a.codec_name : null,
      audioChannels: a ? Number(a.channels) || 0 : 0,
      size: Number((j.format && j.format.size) || 0) || 0,
      format: j.format ? j.format.format_name : null,
      rotation,
    };
  }

  /**
   * Walks every packet with ffprobe (demux only) and returns, per stream index, the real time
   * span (last packet end - first packet start), the sum of packet durations and the count.
   */
  async function scanPackets(file) {
    const per = new Map();
    let buf = '';
    const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
    const eat = (line) => {
      if (!line) return;
      const f = {};
      for (const kv of line.split('|')) { const i = kv.indexOf('='); if (i > 0) f[kv.slice(0, i)] = kv.slice(i + 1); }
      const idx = num(f.stream_index);
      if (idx === null) return;
      let st = per.get(idx);
      if (!st) { st = { min: Infinity, max: -Infinity, sum: 0, count: 0, withDur: 0, lastKey: null, maxKeyGap: 0 }; per.set(idx, st); }
      const t = num(f.pts_time) !== null ? num(f.pts_time) : num(f.dts_time);
      const d = num(f.duration_time) || 0;
      if (t !== null) {
        st.min = Math.min(st.min, t); st.max = Math.max(st.max, t + d);
        // Keyframe spacing: stream-copy can only start a clip on a keyframe, so the longest gap
        // between them is how far a "fast" cut can land from where it was asked to.
        if (String(f.flags || '').includes('K')) {
          if (st.lastKey !== null && t > st.lastKey) st.maxKeyGap = Math.max(st.maxKeyGap, t - st.lastKey);
          st.lastKey = t;
        }
      }
      if (d > 0) st.withDur++;
      st.sum += d; st.count++;
    };
    try {
      await run(bins.ffprobe, [
        '-v', 'error', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time,flags',
        '-of', 'compact=p=0:nk=0', file,
      ], {
        timeoutMs: 30 * 60 * 1000, collect: false,
        onStdout: (d) => {
          buf += d.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
        },
      });
      eat(buf.trim());
    } catch { /* partial results are still useful; caller falls back to the remux scan */ }
    const out = new Map();
    for (const [idx, st] of per) {
      if (st.count && st.max > st.min) {
        // the tail after the last keyframe counts too (a file with one keyframe has a "gap" of its whole length)
        const tailGap = st.lastKey !== null ? Math.max(0, st.max - st.lastKey) : 0;
        out.set(idx, { span: st.max - st.min, sum: st.sum, count: st.count, withDur: st.withDur, maxKeyGap: Math.max(st.maxKeyGap, tailGap) });
      }
    }
    return out;
  }

  /** Length in seconds of a file whose header has none, by remuxing to nowhere and reading the clock. */
  async function measureDuration(file) {
    try {
      const r = await run(bins.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { timeoutMs: 30 * 60 * 1000, collect: false });
      const times = [...String(r.stderr).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      if (!times.length) return 0;
      const t = times[times.length - 1];
      return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
    } catch { return 0; }
  }

  /**
   * Run ffmpeg with machine-readable progress.
   * onProgress receives seconds of output produced so far.
   */
  async function runFfmpeg(args, { signal, timeoutMs, onProgress, cwd } = {}) {
    assertReady();
    const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
    let buf = '';
    const onStdout = (d) => {
      if (!onProgress) return;
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    };
    try {
      return await run(bins.ffmpeg, full, { signal, timeoutMs, onStdout, cwd, collect: false });
    } catch (e) {
      if (e.stderr) e.message = `${e.message}: ${tailError(e.stderr)}`;
      throw e;
    }
  }

  /**
   * Stream-copies a file into a clean MP4 with continuous timestamps (no re-encoding, fast).
   * Fixes files stitched from streaming segments whose clock restarts partway through.
   */
  async function remuxClean(inFile, outFile) {
    await runFfmpeg([
      '-fflags', '+genpts', '-i', inFile, '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-movflags', '+faststart', outFile,
    ], { timeoutMs: 60 * 60 * 1000 });
  }

  /**
   * Last-resort repair for files whose timestamps can't be fixed by a plain re-wrap (e.g. an MP4
   * whose clock was squashed): re-encodes once, rebuilding the video clock from frame order at
   * the stream's nominal frame rate. Slow (a full encode) so it only runs when remuxClean did
   * not recover the file's real length.
   */
  async function rebuildTimestamps(inFile, outFile, { fps = 25, hasAudio = true } = {}) {
    const rate = fps > 0 && fps <= 120 ? fps : 25;
    const args = ['-fflags', '+genpts', '-i', inFile, '-map', '0:v:0'];
    if (hasAudio) args.push('-map', '0:a:0?');
    args.push('-vf', `setpts=N/(${rate}*TB)`, '-r', String(rate),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    if (hasAudio) args.push('-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', '160k');
    args.push('-movflags', '+faststart', outFile);
    await runFfmpeg(args, { timeoutMs: 6 * 60 * 60 * 1000 });
  }

  /**
   * Decodes one tiny grayscale frame at `atSec` and returns its pixels (or null if nothing could
   * be decoded). Used to tell a real picture from a black / undecodable one.
   */
  async function sampleFrame(file, atSec) {
    assertReady();
    const chunks = [];
    try {
      await streamFfmpeg(['-ss', String(Math.max(0, atSec)), '-i', file, '-an', '-frames:v', '1',
        '-vf', 'scale=32:18:flags=fast_bilinear,format=gray', '-f', 'rawvideo', '-'],
      { timeoutMs: 60000, onData: (d) => chunks.push(Buffer.from(d)) });
    } catch { return null; }
    const buf = Buffer.concat(chunks);
    return buf.length ? buf : null;
  }

  /** Stream raw output (stdout) of ffmpeg to a consumer callback. Used by the analyzer. */
  function streamFfmpeg(args, { signal, onData, timeoutMs } = {}) {
    assertReady();
    const full = ['-hide_banner', '-nostdin', '-v', 'error', ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(bins.ffmpeg, full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let killed = false;
      const kill = () => { killed = true; try { child.kill('SIGKILL'); } catch { /* ignore */ } };
      const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null;
      const onAbort = () => kill();
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      child.stdout.on('data', (d) => { try { onData(d); } catch (e) { kill(); reject(e); } });
      child.stderr.on('data', (d) => { if (stderr.length < 200000) stderr += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (killed) { const e = new Error('aborted'); e.code = 'ABORT_ERR'; return reject(e); }
        if (code === 0) return resolve();
        const e = new Error(`ffmpeg exited with code ${code}: ${tailError(stderr)}`);
        e.stderr = stderr; e.exitCode = code;
        reject(e);
      });
    });
  }

  return {
    get bins() { return bins; },
    get caps() { return state.caps; },
    assertReady, detectCapabilities, testEncoder, probe, remuxClean, rebuildTimestamps, sampleFrame, runFfmpeg, streamFfmpeg,
    ready: () => !!(bins.ffmpeg && bins.ffprobe),
  };
}


module.exports = { createFfmpeg, resolveBinaries, run, tailError, IS_WIN };
