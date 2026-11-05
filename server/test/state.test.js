'use strict';
/** The server's copy of the browser library: a damaged file must never destroy the good backup. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createStateStore } = require(path.join(__dirname, '..', 'src', 'services', 'stateStore.js'));

const lib = (n) => ({ uploads: Array.from({ length: n }, (_, i) => ({ id: i })), clips: [], scheduled_posts: [], posted_history: [], settings: [] });
function make(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const warns = [];
  const store = createStateStore({ config: { dirs: { data: dir } }, logger: { warn: (m) => warns.push(m), info() {}, error() {}, debug() {} } });
  return { dir, store, warns };
}

test('a damaged main file falls back to the backup, is set aside once, and the backup survives the next save', (t) => {
  const { dir, store, warns } = make(t);
  store.put(lib(1)); store.put(lib(2));                       // main = 2 uploads, .bak = 1 upload
  fs.writeFileSync(store.file, Buffer.alloc(300));            // a crash leaves a file full of zero bytes
  assert.equal(store.get().uploads.length, 1, 'the backup is used');
  assert.ok(!fs.existsSync(store.file), 'the damaged file was moved out of the way');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('browser-state.damaged-')).length, 1);
  assert.equal(warns.length, 1, 'said once, not on every read');
  assert.equal(store.get().uploads.length, 1); assert.equal(warns.length, 1);
  // the next save must NOT copy the damaged file over the good backup
  store.put(lib(3));
  assert.equal(JSON.parse(fs.readFileSync(`${store.file}.bak`, 'utf8')).uploads.length, 1, 'the good backup was not destroyed');
  assert.equal(store.get().uploads.length, 3);
});

test('empty, invalid and half-written files are all treated as damaged; nothing there at all is fine', (t) => {
  const { dir, store, warns } = make(t);
  assert.equal(store.get(), null); assert.equal(warns.length, 0, 'a first run is not an error');
  store.put(lib(1)); store.put(lib(2));
  for (const bad of ['', '{"uploads": [1,2', '{"hello":1}', '[]']) {
    fs.writeFileSync(store.file, bad);
    assert.equal(store.get().uploads.length, 1, `"${bad.slice(0, 12)}" -> backup`);
    store.put(lib(2));
  }
  assert.ok(fs.readdirSync(dir).filter((n) => n.startsWith('browser-state.damaged-')).length <= 3, 'only the last three damaged files are kept');
});

test('both files damaged: no library (the browser keeps its own), and an empty snapshot is still refused over a good one', (t) => {
  const { store } = make(t);
  store.put(lib(2)); store.put(lib(2));
  fs.writeFileSync(store.file, 'x'); fs.writeFileSync(`${store.file}.bak`, 'y');
  assert.equal(store.get(), null);
  store.put(lib(1));
  assert.throws(() => store.put(lib(0)), (e) => e.status === 409);
});
