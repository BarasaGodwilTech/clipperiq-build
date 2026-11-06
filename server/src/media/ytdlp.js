'use strict';
/**
 * yt-dlp integration.
 *   streamBestAudio() powers GET /api/audio (live audio extraction for the browser's
 *     Web Audio pipeline — same behaviour as before, just with a resolvable binary and
 *     actual error reporting instead of a silently-hanging response).
 *   downloadAudioToFile() is used by the cloud renderer when a job asks for background
 *     music from a link.
 * The binary is located on PATH / in data/bin, or downloaded once from the official
 * GitHub release the first time it's needed (disable with YTDLP_AUTO_DOWNLOAD=false).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WIN, run } = require('./ffmpeg');

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function createYtDlp(config, logger) {
  let resolved = null;
  let downloading = null;
  const localBin = path.join(config.dirs.bin, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');

  async function probeBin(bin) {
    try { await run(bin, ['--version'], { timeoutMs: 15000 }); return true; } catch { return false; }
  }

  async function locate() {
    if (resolved) return resolved;
    for (const c of [config.ytdlp.path, localBin, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp'].filter(Boolean)) {
      if (await probeBin(c)) { resolved = c; return c; }
    }
    return null;
  }

  async function download() {
    if (downloading) return downloading;
    downloading = (async () => {
      const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName()}`;
      logger.info(`yt-dlp: downloading ${assetName()} \u2026`);
      await fs.promises.mkdir(config.dirs.bin, { recursive: true });
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      const tmp = `${localBin}.part`;
      const { Readable } = require('stream');
      const { pipeline } = require('stream/promises');
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      await fs.promises.chmod(tmp, 0o755).catch(() => {});
      await fs.promises.rename(tmp, localBin);
      logger.info('yt-dlp: installed');
    })().finally(() => { downloading = null; });
    return downloading;
  }

  async function ensure() {
    const found = await locate();
    if (found) return found;
    if (!config.ytdlp.autoDownload) throw new Error('yt-dlp is not installed. Install it, or set YTDLP_PATH in .env.');
    await download().catch((e) => { throw new Error(`Could not install yt-dlp automatically (${e.message}). Install it manually or set YTDLP_PATH.`); });
    resolved = null;
    const again = await locate();
    if (!again) throw new Error('yt-dlp was downloaded but will not run on this machine');
    return again;
  }

  function validateUrl(raw) {
    let u;
    try { u = new URL(String(raw || '').trim()); } catch { throw new Error('Not a valid URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) links are supported');
    return u.toString();
  }

  /** Pipe the best available audio track straight through to an HTTP response. */
  async function streamBestAudio(rawUrl, res, { signal } = {}) {
    const url = validateUrl(rawUrl);
    const bin = await ensure();
    const args = ['--no-playlist', '--no-warnings', '--no-part', '-f', 'bestaudio/best', '-o', '-', '--', url];
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let headerSent = false;
    child.stdout.once('data', () => {
      if (!res.headersSent) { res.setHeader('Content-Type', 'audio/webm'); res.setHeader('Cache-Control', 'no-store'); }
      headerSent = true;
    });
    child.stdout.pipe(res);
    child.stderr.on('data', (d) => { stderr += d.toString('utf8').slice(0, 4000); });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (code === 0 || headerSent) return resolve();
        reject(new Error(`Could not extract audio from that link${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
      });
    });
  }

  /** Download best audio and convert to mp3 for use as an ffmpeg input. Returns the file path. */
  async function downloadAudioToFile(rawUrl, outBase, { maxBytes } = {}) {
    const url = validateUrl(rawUrl);
    const bin = await ensure();
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '30',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', `${outBase}.%(ext)s`,
    ];
    if (maxBytes) args.push('--max-filesize', String(maxBytes));
    args.push('--', url);
    await run(bin, args, { timeoutMs: 5 * 60 * 1000 });
    const dir = path.dirname(outBase);
    const stem = path.basename(outBase);
    const file = fs.readdirSync(dir).find((f) => f.startsWith(`${stem}.`) && !f.endsWith('.part'));
    if (!file) throw new Error('The link did not produce any audio');
    return path.join(dir, file);
  }

  return { ensure, locate, streamBestAudio, downloadAudioToFile, validateUrl, status: async () => ({ available: !!(await locate()), autoDownload: config.ytdlp.autoDownload }) };
}

module.exports = { createYtDlp };
