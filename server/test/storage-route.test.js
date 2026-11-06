'use strict';
// Exercises the storage routes without a real web server: express is replaced by a tiny recorder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const routes = {};
const fakeExpress = () => ({});
fakeExpress.Router = () => {
  const r = {};
  for (const m of ['get', 'post']) r[m] = (p, ...hs) => { routes[`${m.toUpperCase()} ${p}`] = hs[hs.length - 1]; };
  return r;
};
fakeExpress.json = () => (q, s, n) => n && n();
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'express' ? fakeExpress : origLoad.call(this, request, ...rest); };
const { createStorageRouter } = require('../src/routes/storage');
Module._load = origLoad;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-rt-'));
const call = async (key, req) => {
  let out = null; let err = null;
  const res = { json: (v) => { out = v; } };
  await new Promise((resolve) => { routes[key]({ socket: { remoteAddress: '127.0.0.1' }, body: {}, ...req }, res, (e) => { err = e; resolve(); }); const t = setInterval(() => { if (out || err) { clearInterval(t); resolve(); } }, 5); });
  return { out, err };
};

function setup({ busy = false, password = '' } = {}) {
  for (const k of Object.keys(routes)) delete routes[k];
  const data = tmp(); fs.writeFileSync(path.join(data, 'db.json'), '{}');
  const cfgFile = path.join(tmp(), 'storage-location.json');
  const config = { dirs: { data }, storage: { configFile: cfgFile, defaultDir: data, chosenDir: '', fallback: null }, auth: { password } };
  const logger = { info() {}, warn() {} };
  createStorageRouter({ config, cloud: { isBusy: () => busy }, logger });
  return { data, cfgFile };
}

test('GET reports folder, space and permissions', async () => {
  const { data } = setup();
  const { out } = await call('GET /', {});
  assert.strictEqual(out.dataDir, data); assert.ok(out.freeBytes > 0); assert.strictEqual(out.canChange, true); assert.strictEqual(out.busy, false);
});

test('changing is refused from another computer when there is no password', async () => {
  setup();
  const { err } = await call('POST /apply', { socket: { remoteAddress: '192.168.1.50' }, body: { path: path.join(tmp(), 'x') } });
  assert.strictEqual(err.status, 403);
});

test('changing is refused while videos are processing', async () => {
  setup({ busy: true });
  const { err } = await call('POST /apply', { body: { path: path.join(tmp(), 'x') } });
  assert.strictEqual(err.status, 409);
});

test('moving copies the data, saves the choice, and reports done', async () => {
  const { data, cfgFile } = setup();
  fs.mkdirSync(path.join(data, 'clips'), { recursive: true }); fs.writeFileSync(path.join(data, 'clips', 'a.mp4'), Buffer.alloc(2048, 1));
  const target = path.join(tmp(), 'NewHome');
  const r = await call('POST /apply', { body: { path: target, move: true } });
  assert.strictEqual(r.out.started, true);
  let st; for (let i = 0; i < 100; i++) { st = (await call('GET /', {})).out.task; if (st && st.state !== 'running') break; await new Promise((x) => setTimeout(x, 20)); }
  assert.strictEqual(st.state, 'done', JSON.stringify(st));
  assert.strictEqual(fs.statSync(path.join(target, 'clips', 'a.mp4')).size, 2048);
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).dataDir, target);
  assert.ok(fs.existsSync(path.join(data, 'clips', 'a.mp4')), 'old data is kept');
});

test('a bad folder gives a clear 400 and changes nothing', async () => {
  const { cfgFile } = setup();
  const { err } = await call('POST /apply', { body: { path: 'not-absolute' } });
  assert.strictEqual(err.status, 400); assert.match(err.message, /full path/);
  assert.ok(!fs.existsSync(cfgFile));
});

test('reset removes the saved choice', async () => {
  const { cfgFile } = setup();
  fs.writeFileSync(cfgFile, JSON.stringify({ dataDir: '/x' }));
  await call('POST /reset', {});
  assert.ok(!fs.existsSync(cfgFile));
});

test('restart without the desktop app asks for a manual restart', async () => {
  setup(); delete process.env.CLIPPERIQ_SUPERVISED;
  const { out } = await call('POST /restart', {});
  assert.deepStrictEqual(out, { restarted: false, manual: true });
});
