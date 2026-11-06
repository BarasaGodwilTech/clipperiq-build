'use strict';
/**
 * Custom overlay layers (the text / sticker / image layer a person designs in the upload editor).
 *
 * The browser draws the whole layer into one transparent PNG, so what ends up on the video is exactly
 * what was shown in the editor (any font, emoji, image) and the server never has to render text itself.
 * A layer is registered once and referenced by id from render jobs.
 */
const fs = require('fs');
const path = require('path');
const { newId } = require('../db');
const { HttpError } = require('./errors');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 25 * 1024 * 1024;

function createOverlayStore({ db, config, logger }) {
  const col = db.collection('cloud_overlays');
  const dir = path.join(config.dirs.data, 'overlays');
  fs.mkdirSync(dir, { recursive: true });

  async function fromUpload(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, 'No overlay image provided');
    if (buffer.length > MAX_BYTES) throw new HttpError(413, 'Overlay image is too large (25 MB max)');
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new HttpError(400, 'The overlay must be a PNG image');
    const id = newId('ovl');
    const file = path.join(dir, `${id}.png`);
    await fs.promises.writeFile(file, buffer);
    col.insert({ id, file, size: buffer.length, createdAt: Date.now() });
    return { overlayId: id, size: buffer.length };
  }

  /** Returns the stored layer, or throws a clear error if it expired. */
  function get(id) {
    const rec = col.get(String(id || ''));
    if (!rec || !fs.existsSync(rec.file)) throw new HttpError(404, 'The custom overlay is no longer on the server. Open the editor and apply it again.');
    return rec;
  }

  /** Drops layers that no job references any more (and are older than a day). */
  async function cleanup(isLive) {
    let removed = 0;
    const now = Date.now();
    for (const rec of col.all()) {
      if (now - rec.createdAt < 24 * 3600 * 1000 || isLive(rec.id)) continue;
      await fs.promises.unlink(rec.file).catch(() => {});
      col.remove(rec.id);
      removed++;
    }
    if (removed) logger?.info(`overlay cleanup: removed ${removed} unused layer(s)`);
    return removed;
  }

  return { fromUpload, get, cleanup };
}

module.exports = { createOverlayStore };
