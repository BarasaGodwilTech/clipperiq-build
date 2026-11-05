'use strict';
/**
 * Central configuration.
 *
 * Precedence (highest first):
 *   1. process environment
 *   2. <repo>/.env file
 *   3. built-in defaults
 *
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(SERVER_DIR, '..');

function parseEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function load(env = process.env) {
  const fileEnv = parseEnvFile(path.join(ROOT_DIR, '.env'));
  const get = (k, d = '') => {
    const v = env[k] !== undefined && env[k] !== '' ? env[k] : fileEnv[k];
    return v !== undefined && v !== '' ? String(v) : d;
  };
  const num = (k, d, { min = -Infinity, max = Infinity } = {}) => {
    const raw = get(k, '');
    if (raw === '') return d;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const bool = (k, d) => {
    const v = get(k, '').toLowerCase();
    if (!v) return d;
    return ['1', 'true', 'yes', 'on'].includes(v);
  };
  const list = (k) => get(k, '').split(',').map((s) => s.trim()).filter(Boolean);

  const dataDirRaw = get('DATA_DIR', 'data');
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(SERVER_DIR, dataDirRaw);

  const cfg = {
    env: get('NODE_ENV', 'production'),
    rootDir: ROOT_DIR,
    serverDir: SERVER_DIR,
    port: num('PORT', 3000, { min: 1, max: 65535 }),
    host: get('HOST', '127.0.0.1'),
    publicBaseUrl: get('PUBLIC_BASE_URL', '').replace(/\/+$/, ''),
    trustProxy: bool('TRUST_PROXY', true),
    logLevel: get('LOG_LEVEL', 'info'),

    auth: {
      username: get('AUTH_USERNAME', 'admin'),
      password: get('AUTH_PASSWORD', ''),
    },
    allowedOrigins: list('ALLOWED_ORIGINS'),

    dirs: {
      data: dataDir,
      uploads: path.join(dataDir, 'uploads'),
      clips: path.join(dataDir, 'clips'),
      bgm: path.join(dataDir, 'bgm'),
      tmp: path.join(dataDir, 'tmp'),
      logs: path.join(dataDir, 'logs'),
      bin: path.join(dataDir, 'bin'),
    },
    dbFile: path.join(dataDir, 'db.json'),

    limits: {
      maxUploadBytes: Math.floor(num('MAX_UPLOAD_GB', 8, { min: 0.1, max: 200 }) * 1024 ** 3),
      chunkBytes: 8 * 1024 * 1024,
      maxClipsPerJob: num('MAX_CLIPS_PER_JOB', 300, { min: 1, max: 1000 }),
      maxBgmBytes: 100 * 1024 * 1024,
    },

    ffmpeg: {
      path: get('FFMPEG_PATH', ''),
      probePath: get('FFPROBE_PATH', ''),
      preset: get('FFMPEG_PRESET', 'veryfast'),
      // Which H.264 encoder renders the clips. "libx264" (software, the default) works everywhere. "auto" uses a
      // graphics-card encoder (NVIDIA NVENC, Intel Quick Sync, AMD AMF, Apple VideoToolbox) when this machine
      // has a working one, and quietly falls back to software if it doesn't or if a render fails.
      videoEncoder: (['libx264', 'auto', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'].includes(String(get('VIDEO_ENCODER', 'libx264')).toLowerCase())
        ? String(get('VIDEO_ENCODER', 'libx264')).toLowerCase() : 'libx264'),
      crf: num('FFMPEG_CRF', 20, { min: 10, max: 35 }),
      threads: num('FFMPEG_THREADS', 0, { min: 0, max: 64 }),
      loudnormTarget: num('LOUDNORM_TARGET', -16, { min: -30, max: -5 }),
      // Normalise the background-music track once per job instead of again for every clip
      // (loudness normalisation is one of the slowest filters). Set BGM_PRENORMALIZE=0 to go back.
      bgmPrenormalize: get('BGM_PRENORMALIZE', '1') !== '0',
      maxConcurrentRenders: num('MAX_CONCURRENT_RENDERS', 1, { min: 1, max: Math.max(1, os.cpus().length) }),
      // How many clips of ONE job render at the same time. Encoding mostly runs on a few threads
      // at a time (decode, crop/scale, audio loudness), so on a multi-core machine rendering a
      // couple of clips together keeps more cores busy. Auto: 1 on <4 cores, 2 on 4-11, 3 on 12+.
      clipConcurrency: num('CLIP_CONCURRENCY', (() => {
        const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
        return cores >= 12 ? 3 : cores >= 4 ? 2 : 1;
      })(), { min: 1, max: 8 }),
      renderTimeoutMin: num('RENDER_TIMEOUT_MIN', 90, { min: 1, max: 1440 }),
    },

    // Auto captions: turning speech into text. "auto" uses the first engine that is set up: faster-whisper (Python,
    // `pip install faster-whisper`), whisper.cpp (a downloaded program + model file), or the OpenAI API (needs an API key).
    captions: {
      engine: String(get('CAPTION_ENGINE', 'auto')).toLowerCase(),
      model: get('WHISPER_MODEL', 'small'),               // faster-whisper: tiny, base, small, medium, large-v3 ...
      python: get('WHISPER_PYTHON', ''),                  // python command that has faster-whisper installed (default: python / python3)
      cppBin: get('WHISPER_CPP_BIN', ''),                 // whisper.cpp program (whisper-cli / main)
      cppModel: get('WHISPER_CPP_MODEL', ''),             // whisper.cpp model file (ggml-small.bin ...)
      openaiKey: get('OPENAI_API_KEY', ''),
      openaiBase: get('OPENAI_BASE_URL', 'https://api.openai.com').replace(/\/+$/, ''),
      openaiModel: get('OPENAI_TRANSCRIBE_MODEL', 'whisper-1'),
      timeoutMin: num('CAPTION_TIMEOUT_MIN', 180, { min: 1, max: 1440 }),
    },

    retention: {
      sourceDays: num('SOURCE_RETENTION_DAYS', 30, { min: 0, max: 3650 }),
      // Rendered clips stay on the server this long after their job finished (0 = keep forever). The app
      // can re-download a clip from here if the browser lost its copy, so this is also how long that works.
      clipDays: num('CLIP_RETENTION_DAYS', 30, { min: 0, max: 3650 }),
      tmpHours: 12,
    },

    ytdlp: {
      path: get('YTDLP_PATH', ''),
      autoDownload: bool('YTDLP_AUTO_DOWNLOAD', true),
      extraHosts: list('BGM_URL_HOSTS').map((h) => h.toLowerCase()),
    },

    // Platform credentials (may be overridden by data/settings.json at runtime)
    credentials: {
      tiktok_client_key: get('TIKTOK_CLIENT_KEY'),
      tiktok_client_secret: get('TIKTOK_CLIENT_SECRET'),
      google_client_id: get('GOOGLE_CLIENT_ID'),
      google_client_secret: get('GOOGLE_CLIENT_SECRET'),
      facebook_app_id: get('FACEBOOK_APP_ID'),
      facebook_app_secret: get('FACEBOOK_APP_SECRET'),
    },

    // Upstream API bases (overridable in case an endpoint ever moves)
    api: {
      tiktok: get('TIKTOK_API_BASE', 'https://open.tiktokapis.com').replace(/\/+$/, ''),
      google: get('GOOGLE_API_BASE', 'https://www.googleapis.com').replace(/\/+$/, ''),
    },
  };
  return cfg;
}

module.exports = { load, parseEnvFile, ROOT_DIR, SERVER_DIR };
