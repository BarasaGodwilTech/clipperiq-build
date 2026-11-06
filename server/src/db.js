'use strict';
/**
 * Tiny transactional-ish JSON document store.
 *
 *  - all data lives in memory; every mutation schedules a debounced atomic flush
 *    (write temp file -> fsync -> rename) so a crash never leaves a half-written file
 *  - the previous good file is kept as <file>.bak and used if the main file is corrupt
 *  - collections are plain maps keyed by string id
 *
 * This is deliberately dependency-free (no native modules) so `npm install` always works
 * on Windows. It comfortably handles tens of thousands of records; swap for SQLite/Postgres
 * behind the same interface if you outgrow it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

class Collection {
  constructor(store, name, map) {
    this.store = store;
    this.name = name;
    this.map = map;
  }
  get(id) { return this.map.get(String(id)) || null; }
  all() { return Array.from(this.map.values()); }
  find(fn) { return this.all().filter(fn); }
  findOne(fn) { return this.all().find(fn) || null; }
  count(fn) { return fn ? this.find(fn).length : this.map.size; }
  insert(doc) {
    if (!doc.id) throw new Error(`${this.name}: document needs an id`);
    const id = String(doc.id);
    if (this.map.has(id)) throw new Error(`${this.name}: duplicate id ${id}`);
    this.map.set(id, doc);
    this.store.markDirty();
    return doc;
  }
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    Object.assign(cur, typeof patch === 'function' ? patch(cur) || {} : patch);
    this.store.markDirty();
    return cur;
  }
  upsert(doc) {
    const id = String(doc.id);
    const cur = this.map.get(id);
    if (cur) Object.assign(cur, doc); else this.map.set(id, doc);
    this.store.markDirty();
    return this.map.get(id);
  }
  remove(id) {
    const ok = this.map.delete(String(id));
    if (ok) this.store.markDirty();
    return ok;
  }
}

class Store {
  constructor(file, { flushDelayMs = 250, logger = null } = {}) {
    this.file = file;
    this.flushDelayMs = flushDelayMs;
    this.logger = logger;
    this.data = {};
    this.collections = {};
    this.timer = null;
    this.writing = false;
    this.dirty = false;
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let parsed = null;
    let usedBackup = false;
    for (const candidate of [this.file, `${this.file}.bak`]) {
      try {
        parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        usedBackup = candidate !== this.file;
        if (usedBackup) this.logger?.warn(`db: main file unreadable, restored from ${path.basename(candidate)}`);
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') this.logger?.warn(`db: could not read ${path.basename(candidate)}: ${e.message}`);
      }
    }
    // A main file that exists but could not be read is set aside before anything is saved. Otherwise the
    // next save would copy it over the good backup (or overwrite it) and the data would be gone for good.
    if ((usedBackup || !parsed) && fs.existsSync(this.file)) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
        this.logger?.error(`db: the database file was damaged; kept it as ${path.basename(aside)}${usedBackup ? ' and restored the last backup' : ' and started empty'}`);
      } catch { /* best effort */ }
    }
    this.data = parsed && typeof parsed === 'object' ? parsed : {};
  }

  collection(name) {
    if (!this.collections[name]) {
      const obj = this.data[name] || {};
      const map = new Map(Object.entries(obj));
      this.collections[name] = new Collection(this, name, map);
    }
    return this.collections[name];
  }

  snapshot() {
    const out = {};
    for (const [name, col] of Object.entries(this.collections)) out[name] = Object.fromEntries(col.map);
    // keep collections that were loaded but never touched
    for (const name of Object.keys(this.data)) if (!(name in out)) out[name] = this.data[name];
    return out;
  }

  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushDelayMs);
    this.timer.unref?.();
  }

  flush() {
    if (!this.dirty || this.writing) return;
    this.writing = true;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      const json = JSON.stringify(this.snapshot());
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch { /* first write */ }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.dirty = true;
      this.logger?.error('db: flush failed', e);
    } finally {
      this.writing = false;
    }
  }

  close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = true;
    this.flush();
  }
}

module.exports = { Store, Collection, newId };
