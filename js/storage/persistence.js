// Keeps the library from disappearing.
//
// A browser may delete a site's stored data without asking (low disk space, "clear site data when closed",
// a profile reset), and the whole library - videos, clips, scheduled posts - lives in the browser's
// IndexedDB. Three layers of protection:
//   1. Ask the browser to treat this site's storage as persistent (navigator.storage.persist()), so it is
//      not evicted under storage pressure.
//   2. Back the small records up to the server a few seconds after every change (server/src/services/
//      stateStore.js). The big files are not copied: finished clips already live on the server.
//   3. When the app starts and finds the browser empty while the server has a backup, restore it
//      automatically; clip files are downloaded again from the server as they are needed (videoStore).
import { db, STORES } from './db.js';
import { videoStore } from './videoStore.js';
import { getBackendBaseUrl } from '../core/config.js';
import { notify } from '../ui/notifications.js';

const BACKUP_DELAY_MS = 5000;
const SOURCES_KEY = 'blob_sources';
const DRAFT_KEY = 'design:draft';
const RECORD_STORES = [STORES.UPLOADS, STORES.CLIPS, STORES.SCHEDULED_POSTS, STORES.POSTED_HISTORY];
const NOTICE_FLAG = 'cliq_persist_notice';

// Settings worth keeping: saved designs/templates and the clip-source map. Never platform tokens or keys.
const backedUpSetting = (key) => typeof key === 'string' && key !== DRAFT_KEY && (key === SOURCES_KEY || key.startsWith('design:'));

const state = {
  persisted: null, supported: false,
  ready: false,          // backups only start once the restore decision has been made
  paused: false,
  timer: null, inFlight: null,
  lastBackupAt: null, lastError: '', server: null,
};

async function apiBase() { try { return (await getBackendBaseUrl()) || ''; } catch { return ''; } }

async function api(path, init) {
  const base = await apiBase();
  if (!base) throw new Error('no server');
  const res = await fetch(`${base}/api/state${path}`, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return body;
}

async function localWeight() {
  try { return (await db.count(STORES.UPLOADS)) + (await db.count(STORES.CLIPS)); } catch { return -1; }
}

async function snapshot() {
  const out = {};
  for (const s of RECORD_STORES) out[s] = await db.getAll(s);
  const settings = await db.getAll(STORES.SETTINGS);
  out.settings = settings.filter((r) => r && backedUpSetting(r.key));
  return out;
}

// ── 1. persistent storage ───────────────────────────────────────────────────────────────
async function requestPersistence() {
  const sm = typeof navigator !== 'undefined' ? navigator.storage : null;
  if (!sm || !sm.persist) return;
  state.supported = true;
  try {
    state.persisted = await sm.persisted();
    if (!state.persisted) state.persisted = await sm.persist();
  } catch { state.persisted = false; }
  if (state.persisted === false) {
    let seen = false;
    try { seen = !!localStorage.getItem(NOTICE_FLAG); localStorage.setItem(NOTICE_FLAG, '1'); } catch { /* private mode */ }
    if (!seen) {
      notify.info('Your browser may clear stored clips when it runs low on space. Your library is backed up on the server and will be restored automatically.', 9000);
    }
  }
}

// ── 2. backup ───────────────────────────────────────────────────────────────────────────
function scheduleBackup() {
  if (!state.ready || state.paused || db.mode === 'memory') return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { backupNow().catch(() => {}); }, BACKUP_DELAY_MS);
}

async function backupNow() {
  if (state.paused || db.mode === 'memory') return null; // temporary mode must never overwrite the real backup

  if (state.inFlight) { await state.inFlight.catch(() => {}); }
  clearTimeout(state.timer);
  state.inFlight = (async () => {
    try {
      const snap = await snapshot();
      if (!snap.uploads.length && !snap.clips.length) return null; // nothing worth saving (the server would refuse it anyway)
      const res = await api('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snap) });
      state.lastBackupAt = res.savedAt || new Date().toISOString();
      state.lastError = '';
      return res;
    } catch (e) {
      state.lastError = String((e && e.message) || e);
      throw e;
    } finally { state.inFlight = null; }
  })();
  return state.inFlight;
}

/** Wipes the server's copy too. Called when the person clears all data on purpose, so it isn't restored. */
async function clearBackup() {
  state.paused = true;
  clearTimeout(state.timer);
  try {
    const empty = { uploads: [], clips: [], scheduled_posts: [], posted_history: [], settings: [] };
    await api('?force=1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(empty) });
    await videoStore.clearSources();
  } catch (e) { console.warn('[Persistence] could not clear the server backup:', e); }
  finally { state.paused = false; }
}

// ── 3. restore ──────────────────────────────────────────────────────────────────────────
async function fetchServerState() {
  const { state: s } = await api('');
  state.server = s ? { uploads: s.uploads.length, clips: s.clips.length, savedAt: s.savedAt } : null;
  return s;
}

/**
 * Puts the backed-up records back. With `onlyMissing` records already in the browser are left alone.
 * Clips whose file is neither here nor downloadable again are skipped (there would be nothing to play).
 */
async function applyState(s, { onlyMissing = false } = {}) {
  const srcRec = (s.settings || []).find((r) => r && r.key === SOURCES_KEY);
  const sources = (srcRec && srcRec.value) || {};
  for (const [blobId, src] of Object.entries(sources)) await videoStore.registerSource(blobId, src);

  const counts = { uploads: 0, clips: 0, scheduled: 0, history: 0, skippedClips: 0 };
  const put = async (store, rec, bucket) => {
    if (onlyMissing && (await db.get(store, rec.id))) return;
    await db.put(store, rec); counts[bucket]++;
  };
  for (const u of s.uploads || []) await put(STORES.UPLOADS, u, 'uploads');
  for (const c of s.clips || []) {
    const playable = (c.blobId && sources[c.blobId]) || (c.blobId && await videoStore.hasBlob(c.blobId));
    if (!playable) { counts.skippedClips++; continue; }
    await put(STORES.CLIPS, c, 'clips');
  }
  for (const p of s.scheduled_posts || []) await put(STORES.SCHEDULED_POSTS, p, 'scheduled');
  for (const h of s.posted_history || []) await put(STORES.POSTED_HISTORY, h, 'history');
  for (const r of s.settings || []) {
    if (!r || r.key === SOURCES_KEY || !backedUpSetting(r.key)) continue;
    if (onlyMissing && (await db.get(STORES.SETTINGS, r.key))) continue;
    await db.put(STORES.SETTINGS, r);
  }
  return counts;
}

/** Downloads every clip file the browser doesn't have, two at a time, newest first. */
async function hydrateMissingClips() {
  let clips = [];
  try { clips = (await db.getAll(STORES.CLIPS)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); } catch { return 0; }
  const missing = [];
  for (const c of clips) if (c.blobId && !(await videoStore.hasBlob(c.blobId)) && (await videoStore.getSource(c.blobId))) missing.push(c);
  if (!missing.length) return 0;
  let done = 0;
  await Promise.all(missing.map((c) => videoStore.getBlob(c.blobId).then((b) => { if (b) done++; })));
  return done;
}

async function restoreIfEmpty() {
  if ((await localWeight()) !== 0) return false; // the browser still has its library (or storage is unusable: don't touch it)
  let s = null;
  try { s = await fetchServerState(); } catch { return false; } // no server / no backup yet
  if (!s || (!s.uploads.length && !s.clips.length)) return false;
  const counts = await applyState(s);
  window.dispatchEvent(new CustomEvent('library:restored', { detail: counts }));
  const parts = [];
  if (counts.clips) parts.push(`${counts.clips} clip${counts.clips === 1 ? '' : 's'}`);
  if (counts.uploads) parts.push(`${counts.uploads} video${counts.uploads === 1 ? '' : 's'}`);
  if (counts.scheduled) parts.push(`${counts.scheduled} scheduled post${counts.scheduled === 1 ? '' : 's'}`);
  notify.success(`Your browser had lost its saved library, so it was restored from the server: ${parts.join(', ') || 'your settings'}. Clip files are downloading again.`, 10000);
  if (counts.skippedClips) notify.warn(`${counts.skippedClips} older clip${counts.skippedClips === 1 ? '' : 's'} could not be restored because their files were not saved on the server.`, 10000);
  hydrateMissingClips().then((n) => { if (n) notify.success(`${n} clip${n === 1 ? '' : 's'} downloaded again.`); }).catch(() => {});
  return true;
}

// ── public API ──────────────────────────────────────────────────────────────────────────
export const persistence = {
  /** Call once at start-up, right after the database is opened and before the screens load their data. */
  async init() {
    if (db.mode === 'memory') { state.paused = true; return; } // nothing real to protect, and nothing to restore into
    await requestPersistence();
    try { await restoreIfEmpty(); } catch (e) { console.warn('[Persistence] restore failed:', e); }
    state.ready = true;
    db.onWrite((store) => { if (RECORD_STORES.includes(store) || store === STORES.SETTINGS) scheduleBackup(); });
    // leaving the page: don't wait for the timer
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.timer) backupNow().catch(() => {}); });
    if ((await localWeight()) > 0) scheduleBackup();
  },

  backupNow,
  clearBackup,

  /** Brings back anything the server remembers that this browser doesn't have (nothing existing is overwritten). */
  async restoreMissing() {
    const s = await fetchServerState();
    if (!s) return null;
    const counts = await applyState(s, { onlyMissing: true });
    window.dispatchEvent(new CustomEvent('library:restored', { detail: counts }));
    hydrateMissingClips().catch(() => {});
    return counts;
  },

  async status() {
    let usage = null; let quota = null;
    try { const e = await navigator.storage.estimate(); usage = e.usage; quota = e.quota; } catch { /* unsupported */ }
    try { if (state.persisted == null && navigator.storage?.persisted) state.persisted = await navigator.storage.persisted(); } catch { /* unsupported */ }
    try { await fetchServerState(); } catch (e) { state.server = null; if (!state.lastError) state.lastError = String((e && e.message) || e); }
    return { persisted: state.persisted, supported: state.supported, usage, quota, lastBackupAt: state.lastBackupAt, lastError: state.lastError, server: state.server };
  },
};
