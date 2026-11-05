'use strict';
/**
 * Speech to text for auto captions.
 *
 * One interface, three engines (CAPTION_ENGINE in .env: auto | faster-whisper | whisper-cpp | openai-api):
 *   faster-whisper  a Python package (`pip install faster-whisper`), runs on this computer, no account needed
 *   whisper-cpp     the whisper.cpp program and a model file, runs on this computer, no Python needed
 *   openai-api      OpenAI's hosted Whisper (needs OPENAI_API_KEY; the audio is sent to OpenAI)
 * Every engine returns the same thing: words with a start and end time in seconds [{ s, e, w }].
 *
 * The video's sound is first cut out with ffmpeg (16 kHz mono) so every engine reads the same small file; only the part
 * that is wanted is transcribed, and the times are shifted back onto the video's own timeline.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'transcribe_faster_whisper.py');

// ── output parsers (pure, so they can be tested without any engine) ──────────────────────────

/** whisper.cpp JSON (-oj / -ojf, one word per segment with -ml 1) -> words. Times are milliseconds there. */
function parseWhisperCppJson(json) {
  const segs = (json && (json.transcription || json.segments)) || [];
  const words = [];
  for (const seg of segs) {
    const from = seg.offsets ? seg.offsets.from / 1000 : Number(seg.start);
    const to = seg.offsets ? seg.offsets.to / 1000 : Number(seg.end);
    const text = String(seg.text || '').trim();
    if (!text || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (/^\[.*\]$|^\(.*\)$/.test(text)) continue; // [BLANK_AUDIO], (music) ...
    const parts = text.split(/\s+/);
    if (parts.length === 1) { words.push({ s: from, e: Math.max(to, from + 0.02), w: text }); continue; }
    // a segment with several words (the program was not told to split on words): spread them over the segment by letters
    const total = parts.reduce((a, t) => a + t.length + 1, 0);
    let at = from;
    for (const t of parts) { const len = ((t.length + 1) / total) * (to - from); words.push({ s: at, e: at + len, w: t }); at += len; }
  }
  return words;
}

/** OpenAI verbose_json with word timestamps -> words. */
function parseOpenAiVerbose(json, offsetSec = 0) {
  return ((json && json.words) || [])
    .filter((w) => w && String(w.word || '').trim())
    .map((w) => ({ s: Number(w.start) + offsetSec, e: Number(w.end) + offsetSec, w: String(w.word).trim() }));
}

/** The faster-whisper helper's JSON -> words. */
function parseHelperJson(json) {
  return ((json && json.words) || []).filter((w) => w && String(w.w || '').trim()).map((w) => ({ s: Number(w.s), e: Number(w.e), w: String(w.w).trim() }));
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────

function run(cmd, args, { signal, onLine, timeoutMs, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env }); } catch (e) { reject(e); return; }
    let err = ''; let out = ''; let buf = '';
    const timer = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('The transcription took too long and was stopped.')); }, timeoutMs) : null;
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } reject(new Error('stopped')); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    child.stdout.on('data', (d) => {
      out = (out + d).slice(-4000); buf += d;
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line && onLine) onLine(line); }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ out, err }); else reject(Object.assign(new Error((err || out || `exit code ${code}`).trim().split('\n').slice(-3).join(' ').slice(0, 400)), { code }));
    });
  });
}

function createTranscriber({ ff, config, logger }) {
  const cfg = config.captions;
  const pythonCandidates = () => (cfg.python ? [cfg.python] : (process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']));
  const probeCache = new Map();

  async function hasPythonPackage() {
    for (const py of pythonCandidates()) {
      try { await run(py, ['-c', 'import faster_whisper'], { timeoutMs: 20000 }); return py; } catch { /* try the next one */ }
    }
    return null;
  }
  async function exists(file) { try { await fs.promises.access(file); return true; } catch { return false; } }

  /** Which engine will be used, and whether it is ready. Cheap results are cached for a minute. */
  async function status() {
    const hit = probeCache.get('s');
    if (hit && Date.now() - hit.at < 60000) return hit.v;
    const want = cfg.engine;
    const tryEngine = async (name) => {
      if (name === 'faster-whisper') { const py = await hasPythonPackage(); return py ? { engine: name, ready: true, python: py } : null; }
      if (name === 'whisper-cpp') return cfg.cppBin && cfg.cppModel && (await exists(cfg.cppBin)) && (await exists(cfg.cppModel)) ? { engine: name, ready: true } : null;
      if (name === 'openai-api') return cfg.openaiKey ? { engine: name, ready: true } : null;
      return null;
    };
    let v = null;
    if (want === 'off') v = { engine: 'off', ready: false, hint: 'Auto captions are switched off (CAPTION_ENGINE=off). You can still import an .srt / .vtt file or type captions.' };
    else {
      const order = want === 'auto' ? ['faster-whisper', 'whisper-cpp', 'openai-api'] : [want];
      for (const name of order) { v = await tryEngine(name); if (v) break; }
      if (!v) v = { engine: want === 'auto' ? 'none' : want, ready: false, hint: SETUP_HINT };
    }
    probeCache.set('s', { at: Date.now(), v });
    return v;
  }
  const SETUP_HINT = 'No speech-to-text engine is set up yet. Easiest: install Python, run "pip install faster-whisper", then restart the server. '
    + 'Or set WHISPER_CPP_BIN and WHISPER_CPP_MODEL (whisper.cpp), or OPENAI_API_KEY (hosted). See server/README.md, "Auto captions". '
    + 'Meanwhile you can import an .srt / .vtt file or type captions.';

  async function extractAudio(file, out, { start = 0, duration = 0, signal, mp3 = false } = {}) {
    const args = ['-y', '-v', 'error'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', file);
    if (duration > 0) args.push('-t', String(duration));
    args.push('-vn', '-ac', '1', '-ar', '16000');
    if (mp3) args.push('-b:a', '32k', '-c:a', 'libmp3lame'); else args.push('-c:a', 'pcm_s16le');
    args.push(out);
    await run(ff.bins.ffmpeg, args, { signal, timeoutMs: 30 * 60 * 1000 });
  }

  async function viaFasterWhisper(st, wav, { language, signal, onProgress, tmp }) {
    const out = path.join(tmp, 'out.json');
    await run(st.python, [SCRIPT, wav, out, cfg.model, language || 'auto'], {
      signal, timeoutMs: cfg.timeoutMin * 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      onLine: (l) => { const m = /^PROGRESS\s+([\d.]+)/.exec(l); if (m && onProgress) onProgress(Math.min(0.99, Number(m[1]))); },
    });
    const json = JSON.parse(await fs.promises.readFile(out, 'utf8'));
    return { words: parseHelperJson(json), language: json.language || language || '' };
  }

  async function viaWhisperCpp(wav, { language, signal, onProgress, tmp }) {
    const base = path.join(tmp, 'cpp');
    const args = ['-m', cfg.cppModel, '-f', wav, '-oj', '-of', base, '-ml', '1', '-sow', '-pp'];
    if (language && language !== 'auto') args.push('-l', language); else args.push('-l', 'auto');
    await run(cfg.cppBin, args, { signal, timeoutMs: cfg.timeoutMin * 60000, onLine: (l) => { const m = /progress\s*=\s*(\d+)%/i.exec(l); if (m && onProgress) onProgress(Math.min(0.99, Number(m[1]) / 100)); } });
    const json = JSON.parse(await fs.promises.readFile(`${base}.json`, 'utf8'));
    return { words: parseWhisperCppJson(json), language: (json.result && json.result.language) || language || '' };
  }

  async function viaOpenAi(file, { language, signal, onProgress, tmp, start, duration }) {
    const CHUNK = 600; // seconds per request: keeps every upload far below the API's 25 MB limit
    const total = duration > 0 ? duration : Math.max(1, (await ff.probe(file)).duration - start);
    const words = []; let lang = language || '';
    for (let at = 0, i = 0; at < total; at += CHUNK, i++) {
      const part = path.join(tmp, `part${i}.mp3`);
      await extractAudio(file, part, { start: start + at, duration: Math.min(CHUNK, total - at), signal, mp3: true });
      const form = new FormData();
      form.append('model', cfg.openaiModel);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      if (language && language !== 'auto') form.append('language', language);
      form.append('file', new Blob([await fs.promises.readFile(part)], { type: 'audio/mpeg' }), `part${i}.mp3`);
      const res = await fetch(`${cfg.openaiBase}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.openaiKey}` }, body: form, signal });
      if (!res.ok) throw new Error(`The OpenAI transcription failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
      const json = await res.json();
      lang = json.language || lang;
      words.push(...parseOpenAiVerbose(json, at));
      if (onProgress) onProgress(Math.min(0.99, (at + CHUNK) / total));
    }
    return { words, language: lang };
  }

  /**
   * Transcribes [rangeStart, rangeEnd] of a video (the whole video when both are 0).
   * Returns { words: [{ s, e, w }], language, engine } on the video's own timeline.
   */
  async function transcribe(file, { rangeStart = 0, rangeEnd = 0, language = 'auto', signal, onProgress } = {}) {
    const st = await status();
    if (!st.ready) throw Object.assign(new Error(st.hint || SETUP_HINT), { status: 503, code: 'engine-missing' });
    const start = Math.max(0, Number(rangeStart) || 0);
    const duration = rangeEnd > start ? rangeEnd - start : 0;
    const base = config.dirs.tmp || os.tmpdir();
    await fs.promises.mkdir(base, { recursive: true }); // a fresh install has no temp folder yet
    const tmp = await fs.promises.mkdtemp(path.join(base, 'caps-'));
    try {
      let r;
      if (st.engine === 'openai-api') r = await viaOpenAi(file, { language, signal, onProgress, tmp, start, duration });
      else {
        const wav = path.join(tmp, 'audio.wav');
        await extractAudio(file, wav, { start, duration, signal });
        r = st.engine === 'faster-whisper' ? await viaFasterWhisper(st, wav, { language, signal, onProgress, tmp }) : await viaWhisperCpp(wav, { language, signal, onProgress, tmp });
      }
      const words = r.words.map((w) => ({ s: Math.round((w.s + start) * 1000) / 1000, e: Math.round((w.e + start) * 1000) / 1000, w: w.w }));
      logger?.info(`captions: ${words.length} words transcribed with ${st.engine}`);
      return { words, language: r.language, engine: st.engine };
    } finally {
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { status, transcribe, SETUP_HINT };
}

module.exports = { createTranscriber, parseWhisperCppJson, parseOpenAiVerbose, parseHelperJson };
