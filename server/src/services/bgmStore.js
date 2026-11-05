'use strict';
/**
 * Background-music library backing the cloud render pipeline.
 *
 * A track is registered once (uploaded from disk, or fetched from a link with yt-dlp) and
 * gets a bgmId that any number of render jobs can reference — so re-rendering a clip, or
 * applying the same track to a whole series, doesn't re-upload/re-fetch the audio each time.
 */
const fs = require('fs');
const path = require('path');
const { newId } = require('../db');
const { HttpError } = require('./errors');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm', '.mp4', '.wma']);

function createBgmStore({ db, config, ff, ytdlp, logger }) {
  const col = db.collection('cloud_bgm');
  const dir = path.join(config.dirs.data, 'bgm');
  fs.mkdirSync(dir, { recursive: true });

  const view = (b) => ({ bgmId: b.id, name: b.name, duration: b.duration, source: b.source.type });

  async function finalize(id, file, name, source) {
    let info;
    try { info = await ff.probe(file); } catch (e) {
      await fs.promises.unlink(file).catch(() => {});
      throw new HttpError(422, `That file doesn't look like valid audio: ${e.message}`);
    }
    if (!info.hasAudio || !(info.duration > 0)) {
      await fs.promises.unlink(file).catch(() => {});
      throw new HttpError(422, 'No audio track found in that file');
    }
    const doc = { id, file, name: String(name || 'music').slice(0, 200), duration: info.duration, source, createdAt: Date.now() };
    col.insert(doc);
    return view(doc);
  }

  /** Store a raw uploaded audio file. */
  async function fromUpload(buffer, filename) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, 'No audio data provided');
    if (buffer.length > config.limits.maxBgmBytes) throw new HttpError(413, 'Audio file is too large (100 MB max)');
    const ext = path.extname(String(filename || '')).toLowerCase();
    const id = newId('bgm');
    const file = path.join(dir, `${id}${AUDIO_EXT.has(ext) ? ext : '.audio'}`);
    await fs.promises.writeFile(file, buffer);
    return finalize(id, file, filename, { type: 'upload' });
  }

  /** Fetch and store audio from a link (YouTube/TikTok/SoundCloud/etc. via yt-dlp). Cached by URL. */
  async function fromUrl(rawUrl) {
    let url;
    try { url = ytdlp.validateUrl(rawUrl); } catch (e) { throw new HttpError(400, e.message); }
    const cached = col.findOne((b) => b.source.type === 'url' && b.source.url === url && fs.existsSync(b.file));
    if (cached) return view(cached);
    const id = newId('bgm');
    const outBase = path.join(dir, id);
    let file;
    try {
      file = await ytdlp.downloadAudioToFile(url, outBase, { maxBytes: config.limits.maxBgmBytes });
    } catch (e) {
      throw new HttpError(422, `Could not get audio from that link: ${e.message}`);
    }
    let name = 'Audio link';
    try { name = `Audio from ${new URL(url).hostname.replace(/^www\./, '')}`; } catch { /* keep default */ }
    return finalize(id, file, name, { type: 'url', url });
  }

  function get(id) {
    const b = col.get(String(id || ''));
    if (!b || !fs.existsSync(b.file)) throw new HttpError(400, 'That background-music track is no longer available; pick it again');
    return b;
  }

  /** Old, unreferenced tracks get swept up by the general cloud cleanup pass. */
  async function cleanup(isReferenced) {
    let removed = 0;
    const cutoffMs = 14 * 86400000;
    for (const b of col.all()) {
      if (Date.now() - b.createdAt > cutoffMs && !isReferenced(b.id)) {
        await fs.promises.unlink(b.file).catch(() => {});
        col.remove(b.id);
        removed++;
      }
    }
    return removed;
  }

  return { fromUpload, fromUrl, get, view, cleanup };
}

module.exports = { createBgmStore };
