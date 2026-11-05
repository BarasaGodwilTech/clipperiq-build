import { db, STORES } from './db.js';

// Where each rendered clip can be fetched again from the server: blobId -> { jobId, index, size }.
// Clips are stored in this browser as files, and a browser may drop them by itself (storage pressure,
// "clear site data"). Rendered clips stay on the server, so a clip whose file has vanished is simply
// downloaded again the next time something asks for it. The map is small and is kept in the settings
// store (and in the server backup, see persistence.js).
const SOURCES_KEY = 'blob_sources';
let sources = null;            // loaded lazily
let sourcesWrite = Promise.resolve();
let recoverer = null;          // async (source) => Blob, set by the clip generator
const recovering = new Map();  // blobId -> in-flight recovery (so many callers share one download)
let recoverActive = 0;
const recoverWaiting = [];
const RECOVER_PARALLEL = 2;

async function loadSources() {
  if (sources) return sources;
  let rec = null;
  try { rec = await db.get(STORES.SETTINGS, SOURCES_KEY); } catch { /* storage unavailable */ }
  sources = (rec && rec.value && typeof rec.value === 'object') ? rec.value : {};
  return sources;
}

function saveSources() {
  sourcesWrite = sourcesWrite.then(() => db.put(STORES.SETTINGS, { key: SOURCES_KEY, value: sources })).catch(() => {});
  return sourcesWrite;
}

function runRecovery(task) {
  return new Promise((resolve, reject) => {
    const go = () => {
      recoverActive++;
      task().then(resolve, reject).finally(() => { recoverActive--; const next = recoverWaiting.shift(); if (next) next(); });
    };
    if (recoverActive < RECOVER_PARALLEL) go(); else recoverWaiting.push(go);
  });
}

export const videoStore = {
  async saveBlob(id, blob, meta = {}) {
    await db.put(STORES.VIDEO_BLOBS, {
      id,
      blob,
      size: blob.size,
      type: blob.type,
      savedAt: new Date().toISOString(),
      ...meta,
    });
    // A clip downloaded from the server carries where it came from (see ClipGenerator._downloadClipBlob).
    if (blob && blob.cloudSource) await this.registerSource(id, blob.cloudSource);
    return id;
  },

  /** Remembers where `blobId` can be downloaded again ({ jobId, index, size }). */
  async registerSource(blobId, src) {
    if (!blobId || !src || !src.jobId) return;
    const map = await loadSources();
    map[blobId] = { jobId: src.jobId, index: src.index, size: Number(src.size) || 0 };
    await saveSources();
  },

  async getSource(blobId) { return (await loadSources())[blobId] || null; },

  /** Registers the function that downloads a clip from its source (set once at start-up). */
  setRecoverer(fn) { recoverer = fn; },

  async getBlob(id) {
    const record = await db.get(STORES.VIDEO_BLOBS, id);
    if (record) return record.blob;
    return this._recover(id);
  },

  /** Downloads a missing clip file again from the server and stores it under the same id. Null if that isn't possible. */
  async _recover(id) {
    if (!recoverer) return null;
    const src = await this.getSource(id);
    if (!src) return null;
    if (recovering.has(id)) return recovering.get(id);
    const p = runRecovery(async () => {
      const blob = await recoverer(src, id);
      if (blob) await this.saveBlob(id, blob, { recovered: true });
      return blob || null;
    }).catch((e) => { console.warn('[VideoStore] could not download the clip again:', id, e); return null; })
      .finally(() => recovering.delete(id));
    recovering.set(id, p);
    return p;
  },

  /** True if the file is in this browser right now (no download is started). */
  async hasBlob(id) {
    try { return !!(await db.get(STORES.VIDEO_BLOBS, id)); } catch { return false; }
  },

  async getBlobRecord(id) {
    return db.get(STORES.VIDEO_BLOBS, id);
  },

  async deleteBlob(id) {
    const map = await loadSources();
    if (map[id]) { delete map[id]; saveSources(); }
    return db.delete(STORES.VIDEO_BLOBS, id);
  },

  /** Forgets every remembered source (used when all data is cleared on purpose). */
  async clearSources() { sources = {}; await saveSources(); },

  async listBlobs() {
    return db.getAll(STORES.VIDEO_BLOBS);
  },

  generateId(prefix = 'blob') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  },

  async saveUpload(file) {
    const id = this.generateId('upload');
    await this.saveBlob(id, file, { name: file.name, originalName: file.name });
    const base = String(file.name || '').replace(/\.[^.]+$/, '');
    const words = base.replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const seriesKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const uploadRecord = {
      blobId: id,
      name: file.name,
      size: file.size,
      type: file.type,
      createdAt: new Date().toISOString(),
      status: 'uploaded',
      title,
      seriesKey,
    };
    const uploadId = await db.put(STORES.UPLOADS, uploadRecord);
    return { id: uploadId, blobId: id, ...uploadRecord };
  },

  async saveUploadMetaOnly(file, extra = {}) {
    const base = String(file?.name || '').replace(/\.[^.]+$/, '');
    const words = base.replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const seriesKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const uploadRecord = {
      blobId: null,
      name: file?.name || 'video',
      size: file?.size || 0,
      type: file?.type || '',
      createdAt: new Date().toISOString(),
      status: 'uploaded',
      title,
      seriesKey,
      storageMode: 'cloud',
      ...extra,
    };
    const uploadId = await db.put(STORES.UPLOADS, uploadRecord);
    return { id: uploadId, ...uploadRecord };
  },

  async getUpload(uploadId) {
    return db.get(STORES.UPLOADS, uploadId);
  },

  async getAllUploads() {
    return db.getAll(STORES.UPLOADS);
  },

  async updateUploadStatus(uploadId, status, extra = {}) {
    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);
    return db.put(STORES.UPLOADS, { ...upload, status, ...extra, updatedAt: new Date().toISOString() });
  },

  async updateUploadMeta(uploadId, patch = {}) {
    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);
    const next = { ...upload, ...patch, updatedAt: new Date().toISOString() };
    await db.put(STORES.UPLOADS, next);
    return next;
  },
};
