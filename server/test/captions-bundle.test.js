'use strict';
// The speech-to-text engine that ships in the installer: picking the right download, unpacking it, finding it at start-up,
// and the captions engine really using it (with a stand-in program that behaves like whisper.cpp).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pickAsset, findExe, extractZip, MODELS, MODEL_URL } = require('../scripts/fetch-captions');
const { findBundledWhisper } = require('../src/services/bundledEngines');
const { createTranscriber } = require('../src/media/transcriber');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-cb-'));

test('the Windows x64 CPU build is chosen from a release, never the CUDA or BLAS ones', () => {
  const names = ['whisper-blas-bin-x64.zip', 'whisper-cublas-12.4.0-bin-x64.zip', 'whisper-bin-Win32.zip', 'whisper-bin-x64.zip', 'whisper-v1.7.zip'];
  assert.equal(pickAsset({ assets: names.map((name) => ({ name })) }).name, 'whisper-bin-x64.zip');
  assert.equal(pickAsset({ assets: [{ name: 'whisper-cublas-bin-x64.zip' }, { name: 'whisper-win-bin-x64.zip' }] }).name, 'whisper-win-bin-x64.zip');
  assert.equal(pickAsset({ assets: [{ name: 'source.tar.gz' }] }), null);
  assert.equal(pickAsset(null), null);
});

test('every model choice has a download address and a sensible file name', () => {
  for (const [k, f] of Object.entries(MODELS)) { assert.match(f, new RegExp(`^ggml-${k}-q5_[01]\\.bin$`)); assert.ok(MODEL_URL(f).startsWith('https://huggingface.co/')); }
});

test('the program is found inside an unpacked release, whatever folder it is in', { skip: spawnSync('zip', ['-v']).status !== 0 && 'no zip tool' }, () => {
  const d = tmp(); const src = path.join(d, 'Release'); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'whisper-cli.exe'), 'x'); fs.writeFileSync(path.join(src, 'whisper.dll'), 'x'); fs.writeFileSync(path.join(src, 'readme.txt'), 'x');
  const zip = path.join(d, 'w.zip'); assert.equal(spawnSync('zip', ['-qr', zip, 'Release'], { cwd: d }).status, 0);
  const out = path.join(d, 'out');
  if (process.platform !== 'win32') { extractZip(zip, out); assert.equal(path.basename(findExe(out)), 'whisper-cli.exe'); }
});

test('the server finds the bundled engine, and ignores a folder that is incomplete', () => {
  const d = tmp();
  assert.equal(findBundledWhisper(d), null);
  fs.writeFileSync(path.join(d, 'whisper-cli.exe'), 'x'); assert.equal(findBundledWhisper(d), null, 'no model yet');
  fs.writeFileSync(path.join(d, 'ggml-tiny-q5_1.bin'), Buffer.alloc(11 * 1024 * 1024));
  const a = findBundledWhisper(d); assert.ok(a && a.bin.endsWith('whisper-cli.exe') && a.model.endsWith('ggml-tiny-q5_1.bin'));
  fs.writeFileSync(path.join(d, 'ggml-small-q5_1.bin'), Buffer.alloc(11 * 1024 * 1024));
  assert.ok(findBundledWhisper(d).model.endsWith('ggml-small-q5_1.bin'), 'the most capable model wins');
  assert.equal(findBundledWhisper(path.join(d, 'nope')), null);
});

test('captions use the bundled engine first, and turn its output into timed words', { skip: process.platform === 'win32' && 'uses a shell script as the stand-in program' }, async () => {
  const d = tmp();
  // a stand-in for whisper-cli: writes the JSON that whisper.cpp writes (-oj -of <base>), one word per segment
  const bin = path.join(d, 'whisper-cli'); const model = path.join(d, 'ggml-tiny.bin'); fs.writeFileSync(model, 'm');
  fs.writeFileSync(bin, `#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -of) OF="$2"; shift 2;; *) shift;; esac; done
printf '{"result":{"language":"pt"},"transcription":[{"offsets":{"from":500,"to":900},"text":" Olá"},{"offsets":{"from":900,"to":1500},"text":" mundo"},{"offsets":{"from":1500,"to":1600},"text":"[BLANK_AUDIO]"}]}' > "$OF.json"
`); fs.chmodSync(bin, 0o755);
  const ffbin = spawnSync('which', ['ffmpeg']).stdout.toString().trim();
  const wav = path.join(d, 'in.mp4'); assert.equal(spawnSync(ffbin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'aac', wav]).status, 0);
  const config = { dirs: { tmp: path.join(d, 'tmp') }, captions: { bundled: true, engine: 'auto', cppBin: bin, cppModel: model, python: 'definitely-not-python', timeoutMin: 5, openaiKey: '' } };
  const t = createTranscriber({ ff: { bins: { ffmpeg: ffbin } }, config, logger: { info() {}, warn() {} } });
  const st = await t.status(); assert.equal(st.engine, 'whisper-cpp'); assert.equal(st.ready, true);
  const r = await t.transcribe(wav, { language: 'auto' });
  assert.equal(r.engine, 'whisper-cpp'); assert.equal(r.language, 'pt');
  assert.deepEqual(r.words.map((w) => w.w), ['Olá', 'mundo']);
  assert.ok(Math.abs(r.words[0].s - 0.5) < 1e-6 && Math.abs(r.words[1].e - 1.5) < 1e-6);
});
