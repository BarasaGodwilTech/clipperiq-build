'use strict';
/**
 * Server-side copy of the browser's library (uploads, clips, scheduled posts, history, saved designs).
 *
 * Why it exists: the library lives in the browser (IndexedDB), and a browser can drop that storage by
 * itself (storage pressure, "clear site data when closed", a profile reset). The video files of finished
 * clips are still on this server, so a small snapshot of the browser's records is all that is needed to
 * bring the whole library back. The app uploads a snapshot a few seconds after every change and restores
 * from it automatically when it finds the browser empty.
 *
 * Safety rules:
 *   - written atomically (temp file -> fsync -> rename), the previous good file kept as ".bak"
 *   - a snapshot with NO uploads and NO clips never replaces one that has some (that is exactly what a
 *     wiped browser would send); it is refused with 409 unless forced
 *   - secrets are never part of it: the browser leaves platform tokens out
 */
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const ARRAYS = ['uploads', 'clips', 'scheduled_posts', 'posted_history', 'settings'];

function createStateStore({ config, logger }) {
  const file = path.join(config.dirs.data, 'browser-state.json');

  /** { state, status }: status is "ok", "missing", "corrupt" (not readable as JSON) or "invalid" (readable, but not a library). */
  function inspect(p) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return { state: null, status: e.code === 'ENOENT' ? 'missing' : 'corrupt', error: e }; }
    try {
      const s = JSON.parse(text);
      return valid(s) ? { state: s, status: 'ok' } : { state: null, status: 'invalid' };
    } catch (e) { return { state: null, status: 'corrupt', error: e }; }
  }

  const valid = (s) => s && typeof s === 'object' && ARRAYS.every((k) => Array.isArray(s[k]));
  const weight = (s) => (s ? s.uploads.length + s.clips.length : 0);

  /**
   * A damaged main file (what a crash or power cut can leave: empty, or full of zero bytes) is set aside, never silently used and never
   * allowed to overwrite the good backup. It is kept as browser-state.damaged-<time>.json (the last three) in case it is worth a look.
   */
  let warned = false;
  function setAside(why) {
    const dest = path.join(path.dirname(file), `browser-state.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    try { fs.renameSync(file, dest); } catch { return; }
    logger?.warn(`state: ${path.basename(file)} was damaged (${why}); it was set aside as ${path.basename(dest)} and the backup copy is being used`);
    try {
      const old = fs.readdirSync(path.dirname(file)).filter((n) => /^browser-state\.damaged-/.test(n)).sort();
      for (const n of old.slice(0, Math.max(0, old.length - 3))) fs.unlinkSync(path.join(path.dirname(file), n));
    } catch { /* tidying is best effort */ }
  }

  function get() {
    const main = inspect(file);
    if (main.status === 'ok') return main.state;
    if (main.status !== 'missing') {
      if (!warned) { warned = true; }
      setAside(main.error ? main.error.message : 'not a saved library');
    }
    const bak = inspect(`${file}.bak`);
    return bak.status === 'ok' ? bak.state : null;
  }

  function put(body, { force = false } = {}) {
    const state = {};
    for (const k of ARRAYS) {
      if (!Array.isArray(body && body[k])) throw new HttpError(400, `State is missing "${k}"`);
      state[k] = body[k];
    }
    state.version = 1;
    state.savedAt = new Date().toISOString();
    const current = get();
    if (!force && weight(state) === 0 && weight(current) > 0) {
      throw new HttpError(409, 'Refusing to replace a saved library with an empty one');
    }
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // The previous file becomes the backup ONLY if it is itself a good library. (A damaged file has been set aside by get() above, and
    // the existing backup stays untouched: it used to be overwritten with the damaged file, which destroyed the only good copy.)
    if (inspect(file).status === 'ok') { try { fs.copyFileSync(file, `${file}.bak`); } catch { /* first write */ } }
    fs.renameSync(tmp, file);
    return { savedAt: state.savedAt, uploads: state.uploads.length, clips: state.clips.length };
  }

  return { get, put, file };
}

module.exports = { createStateStore };
