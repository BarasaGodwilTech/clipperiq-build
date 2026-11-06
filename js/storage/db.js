const DB_NAME = 'ClipperIQDB';
const DB_VERSION = 1;

const STORES = {
  UPLOADS: 'uploads',
  CLIPS: 'clips',
  SCHEDULED_POSTS: 'scheduled_posts',
  POSTED_HISTORY: 'posted_history',
  VIDEO_BLOBS: 'video_blobs',
  SETTINGS: 'settings',
};

/**
 * A stand-in database that lives in memory. Used only when the browser cannot open its real one (damaged or locked storage
 * for this address): the app stays usable for this session instead of hanging on "Loading...". Nothing in it is kept.
 */
class MemoryDatabase {
  constructor() {
    this.stores = {};
    this.next = {};
    for (const s of Object.values(STORES)) { this.stores[s] = new Map(); this.next[s] = 1; }
  }
  _kp(store) { return store === STORES.SETTINGS ? 'key' : 'id'; }
  _copy(v) { try { return structuredClone(v); } catch { return { ...v }; } }
  async put(store, data) {
    const rec = this._copy(data); const kp = this._kp(store);
    if (rec[kp] == null) rec[kp] = this.next[store]++;
    else if (typeof rec[kp] === 'number' && rec[kp] >= this.next[store]) this.next[store] = rec[kp] + 1;
    this.stores[store].set(rec[kp], rec);
    return rec[kp];
  }
  async get(store, key) { const r = this.stores[store].get(key); return r === undefined ? undefined : this._copy(r); }
  async getAll(store) { return [...this.stores[store].values()].map((r) => this._copy(r)); }
  async getAllByIndex(store, field, value) { return (await this.getAll(store)).filter((r) => r[field] === value); }
  async delete(store, key) { this.stores[store].delete(key); }
  async count(store) { return this.stores[store].size; }
}

class ClipperIQDatabase {
  constructor() {
    this.db = null;
    this.memory = null;      // set when the real database could not be opened (temporary mode)
    this.mode = 'indexeddb'; // 'indexeddb' | 'memory'
    this.failure = null;     // { name, message } of the error that caused temporary mode
    this._opening = null;
    this._listeners = new Set();
    this._degradedListeners = new Set();
  }

  /** Calls fn(failure) when the app has to fall back to temporary (in-memory) storage. */
  onDegraded(fn) { this._degradedListeners.add(fn); if (this.memory) { try { fn(this.failure); } catch { /* ignore */ } } return () => this._degradedListeners.delete(fn); }

  /** Calls fn(storeName) after every write (put / delete). Returns an unsubscribe function. */
  onWrite(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _wrote(storeName) {
    for (const fn of this._listeners) { try { fn(storeName); } catch { /* a listener must never break a save */ } }
  }

  async open() {
    if (this.db) return this.db;
    if (this.memory) return this.memory;
    if (this._opening) return this._opening;
    this._opening = this._openWithRetry().finally(() => { this._opening = null; });
    return this._opening;
  }

  /**
   * Opens the real database. A failure here is often momentary (the browser is still releasing a lock after a reload), so it is
   * tried a few times; a database that hangs is given up on after a few seconds; and if it still cannot be opened the app
   * carries on in temporary mode (see MemoryDatabase) rather than staying on "Loading..." forever.
   */
  async _openWithRetry() {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this._open(6000); } catch (e) { last = e; }
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1) * (attempt + 1)));
    }
    this.memory = new MemoryDatabase();
    this.mode = 'memory';
    this.failure = { name: (last && last.name) || 'Error', message: String((last && last.message) || last || 'The database could not be opened.') };
    console.error('[DB] could not open the browser database; working in temporary mode:', last);
    for (const fn of this._degradedListeners) { try { fn(this.failure); } catch { /* ignore */ } }
    return this.memory;
  }

  /** Tries the real database again (the "Try again" button); resolves with the mode now in use. */
  async retry() {
    this.memory = null; this.mode = 'indexeddb'; this.failure = null; this.db = null;
    await this.open();
    return this.mode;
  }

  /**
   * Deletes this address's browser database (the "Repair" button), for a database that cannot be opened. The library is
   * backed up on the server and comes back by itself afterwards (see persistence.js).
   */
  async repair() {
    try { if (this.db) this.db.close(); } catch { /* already closed */ }
    this.db = null; this.memory = null;
    await new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.deleteDatabase(DB_NAME); } catch (e) { reject(e); return; }
      const t = setTimeout(() => reject(Object.assign(new Error('The database is still in use by another ClipperIQ tab or window. Close them all and try again.'), { name: 'BlockedError' })), 8000);
      req.onsuccess = () => { clearTimeout(t); resolve(); };
      req.onerror = () => { clearTimeout(t); reject(req.error || new Error('The browser would not delete its saved data.')); };
    });
  }

  _open(timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        if (typeof indexedDB === 'undefined') throw Object.assign(new Error('This browser has no local storage available (is it in private mode, or is site data blocked?).'), { name: 'SecurityError' });
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) { reject(e); return; }
      const timer = timeoutMs ? setTimeout(() => reject(Object.assign(new Error('The browser did not open its saved data in time.'), { name: 'TimeoutError' })), timeoutMs) : null;
      const done = (fn, v) => { if (timer) clearTimeout(timer); fn(v); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORES.UPLOADS)) {
          const uploads = db.createObjectStore(STORES.UPLOADS, { keyPath: 'id', autoIncrement: true });
          uploads.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.CLIPS)) {
          const clips = db.createObjectStore(STORES.CLIPS, { keyPath: 'id', autoIncrement: true });
          clips.createIndex('uploadId', 'uploadId', { unique: false });
          clips.createIndex('score', 'score', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.SCHEDULED_POSTS)) {
          const posts = db.createObjectStore(STORES.SCHEDULED_POSTS, { keyPath: 'id', autoIncrement: true });
          posts.createIndex('scheduledAt', 'scheduledAt', { unique: false });
          posts.createIndex('status', 'status', { unique: false });
          posts.createIndex('platform', 'platform', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.POSTED_HISTORY)) {
          const hist = db.createObjectStore(STORES.POSTED_HISTORY, { keyPath: 'id', autoIncrement: true });
          hist.createIndex('postedAt', 'postedAt', { unique: false });
          hist.createIndex('platform', 'platform', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.VIDEO_BLOBS)) {
          db.createObjectStore(STORES.VIDEO_BLOBS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => {
        const conn = e.target.result;
        this.db = conn;
        // The browser can close a connection by itself (storage cleared or evicted, another tab upgrading
        // the database). Forget it, so the next call opens a fresh one instead of failing for the rest of
        // the session with "the database connection is closing".
        conn.onclose = () => { if (this.db === conn) this.db = null; };
        conn.onversionchange = () => { try { conn.close(); } catch { /* already closed */ } if (this.db === conn) this.db = null; };
        done(resolve, conn);
      };
      req.onerror = (e) => done(reject, (e.target && e.target.error) || new Error('The database could not be opened.'));
      req.onblocked = () => console.warn('[DB] opening is waiting for another ClipperIQ tab to let go of the database');
    });
  }

  async transaction(storeName, mode = 'readonly') {
    let db = await this.open();
    try {
      return db.transaction(storeName, mode).objectStore(storeName);
    } catch (e) {
      if (e && e.name === 'InvalidStateError') { // the connection was closed under us: reopen once
        this.db = null;
        db = await this.open();
        return db.transaction(storeName, mode).objectStore(storeName);
      }
      throw e;
    }
  }

  async put(storeName, data) {
    if (this.memory) { const k = await this.memory.put(storeName, data); this._wrote(storeName); return k; }
    const store = await this.transaction(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(data);
      req.onsuccess = () => { this._wrote(storeName); resolve(req.result); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async get(storeName, key) {
    if (this.memory) return this.memory.get(storeName, key);
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAll(storeName) {
    if (this.memory) return this.memory.getAll(storeName);
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getAllByIndex(storeName, indexName, value) {
    if (this.memory) return this.memory.getAllByIndex(storeName, indexName, value);
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const idx = store.index(indexName);
      const req = idx.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async delete(storeName, key) {
    if (this.memory) { await this.memory.delete(storeName, key); this._wrote(storeName); return; }
    const store = await this.transaction(storeName, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onsuccess = () => { this._wrote(storeName); resolve(); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async count(storeName) {
    if (this.memory) return this.memory.count(storeName);
    const store = await this.transaction(storeName, 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async getSetting(key) {
    const record = await this.get(STORES.SETTINGS, key);
    return record ? record.value : null;
  }

  async setSetting(key, value) {
    return this.put(STORES.SETTINGS, { key, value });
  }

  async getScheduledPostsDue(now = new Date()) {
    const all = await this.getAll(STORES.SCHEDULED_POSTS);
    return all.filter(p => p.status === 'scheduled' && new Date(p.scheduledAt) <= now);
  }

  async updatePostStatus(id, status, extra = {}) {
    const post = await this.get(STORES.SCHEDULED_POSTS, id);
    if (!post) throw new Error(`Post ${id} not found`);
    return this.put(STORES.SCHEDULED_POSTS, { ...post, status, ...extra, updatedAt: new Date().toISOString() });
  }
}

export const db = new ClipperIQDatabase();
export { STORES };
