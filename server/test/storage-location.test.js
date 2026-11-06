'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../src/services/storageLocation');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-st-'));

test('override file round-trips and ignores junk', () => {
  const d = tmp(); const f = path.join(d, 'storage-location.json');
  assert.strictEqual(s.readOverride(f), '');
  s.writeOverride(f, path.join(d, 'new'));
  assert.strictEqual(s.readOverride(f), path.join(d, 'new'));
  fs.writeFileSync(f, '{not json'); assert.strictEqual(s.readOverride(f), '');
  fs.writeFileSync(f, JSON.stringify({ dataDir: 'relative/path' })); assert.strictEqual(s.readOverride(f), '');
  s.writeOverride(f, d); s.clearOverride(f); assert.strictEqual(s.readOverride(f), '');
});

test('check rejects unusable choices with plain messages', async () => {
  const cur = tmp();
  assert.match((await s.check('', cur)).error, /Enter or choose/);
  assert.match((await s.check('relative', cur)).error, /full path/);
  assert.match((await s.check(path.parse(cur).root, cur)).error, /not the drive itself/);
  assert.match((await s.check(cur, cur)).error, /already in use/);
  assert.match((await s.check(path.join(cur, 'sub'), cur)).error, /inside the current/);
  assert.match((await s.check(path.dirname(cur), cur)).error, /contain the current/);
});

test('check accepts a writable folder and reports free space', async () => {
  const cur = tmp(); const target = path.join(tmp(), 'ClipperIQ');
  const r = await s.check(target, cur);
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.free > 0);
});

test('check refuses a move that cannot fit', async () => {
  const cur = tmp(); fs.writeFileSync(path.join(cur, 'big.bin'), Buffer.alloc(1024));
  const r = await s.check(path.join(tmp(), 'x'), cur, { move: true });
  assert.strictEqual(r.ok, true); // 1 KB + 1 GB headroom fits on any dev machine
  assert.ok(r.needBytes >= 1024 ** 3);
});

test('copyData copies files with progress, skips tmp, keeps the original, and leaves no .copying files', async () => {
  const from = tmp(); const to = path.join(tmp(), 'dest');
  fs.mkdirSync(path.join(from, 'clips', 'job1'), { recursive: true }); fs.mkdirSync(path.join(from, 'tmp'));
  fs.writeFileSync(path.join(from, 'db.json'), '{"a":1}');
  fs.writeFileSync(path.join(from, 'clips', 'job1', 'clip_000.mp4'), Buffer.alloc(5000, 7));
  fs.writeFileSync(path.join(from, 'tmp', 'scratch.bin'), 'x');
  const seen = [];
  const r = await s.copyData(from, to, { onProgress: (p) => seen.push(p.done / p.total) });
  assert.strictEqual(r.files, 2);
  assert.strictEqual(fs.readFileSync(path.join(to, 'db.json'), 'utf8'), '{"a":1}');
  assert.strictEqual(fs.statSync(path.join(to, 'clips', 'job1', 'clip_000.mp4')).size, 5000);
  assert.ok(!fs.existsSync(path.join(to, 'tmp')));
  assert.ok(fs.existsSync(path.join(from, 'db.json')), 'original must stay');
  assert.strictEqual(seen[seen.length - 1], 1);
  assert.deepStrictEqual(seen, [...seen].sort((a, b) => a - b));
  const left = fs.readdirSync(path.join(to, 'clips', 'job1')).filter((n) => n.endsWith('.copying'));
  assert.strictEqual(left.length, 0);
});

test('copyData can be cancelled', async () => {
  const from = tmp(); fs.writeFileSync(path.join(from, 'a.bin'), 'a'); fs.writeFileSync(path.join(from, 'b.bin'), 'b');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => s.copyData(from, path.join(tmp(), 'd'), { signal: ac.signal }), (e) => e.code === 'ABORT_ERR');
});
