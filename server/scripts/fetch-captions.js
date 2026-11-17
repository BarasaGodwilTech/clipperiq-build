#!/usr/bin/env node
'use strict';
/**
 * Downloads the speech-to-text engine that goes INSIDE the installer, once, on the computer that builds it:
 *   - the whisper.cpp program for Windows (from its GitHub releases)
 *   - a speech model (from Hugging Face)
 * into server/vendor/whisper. The app finds them there by itself, so on the computers the installer is copied to, captions work
 * with nothing else to install. Run automatically before the installer is built (desktop "predist"); safe to run again (it skips
 * what is already there).
 *
 *   node scripts/fetch-captions.js [--model tiny|base|small|medium] [--force]
 *   CAPTIONS_MODEL=base      choose a smaller (faster, less accurate) model; default is small
 *   SKIP_CAPTIONS_FETCH=1    do nothing (build without captions)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const OUT_DIR = path.resolve(__dirname, '..', 'vendor', 'whisper');
const MODELS = { // quantised models: about a third of the size of the originals, nearly the same accuracy
  tiny: 'ggml-tiny-q5_1.bin', base: 'ggml-base-q5_1.bin', small: 'ggml-small-q5_1.bin', medium: 'ggml-medium-q5_0.bin',
};
const RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=40';
const MODEL_URL = (file) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
const MIN_MODEL_BYTES = 20 * 1024 * 1024;

/** The release file for Windows x64 that runs on any processor (not the CUDA or BLAS builds). */
function pickAsset(release) {
  const assets = (release && release.assets) || [];
  const ok = (a) => /\.zip$/i.test(a.name) && /x64/i.test(a.name) && !/cublas|blas|cuda|vulkan|openvino|arm/i.test(a.name);
  return assets.find((a) => /^whisper-bin-x64\.zip$/i.test(a.name)) || assets.find((a) => ok(a) && /bin/i.test(a.name)) || assets.find(ok) || null;
}

/**
 * The newest release that actually carries a Windows x64 build. The very latest release does not always have one (some releases
 * are published without Windows files), so looking only at "latest" made the installer build fail.
 */
function pickRelease(releases) {
  for (const r of (Array.isArray(releases) ? releases : [])) {
    if (!r || r.draft || r.prerelease) continue;
    const asset = pickAsset(r);
    if (asset) return { release: r, asset };
  }
  return null;
}

function findExe(dir) {
  const want = ['whisper-cli.exe', 'main.exe', 'whisper-cli', 'main'];
  const stack = [dir]; const found = [];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (want.includes(e.name)) found.push(p);
    }
  }
  found.sort((a, b) => want.indexOf(path.basename(a)) - want.indexOf(path.basename(b)));
  return found[0] || null;
}

function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // Windows 10+ has tar (bsdtar), which reads zip files; elsewhere use unzip
  const r = process.platform === 'win32' ? spawnSync('tar', ['-xf', zip, '-C', dest], { encoding: 'utf8' }) : spawnSync('unzip', ['-o', '-q', zip, '-d', dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not unpack ${path.basename(zip)}: ${(r.stderr || r.stdout || r.error || '').toString().trim().slice(0, 300)}`);
}

function get(url, { json = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 8) { reject(new Error('too many redirects')); return; }
      https.get(u, { headers: { 'User-Agent': 'ClipperIQ-build', Accept: json ? 'application/vnd.github+json' : '*/*', ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); go(new URL(res.headers.location, u).href, hops + 1); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`${u} answered ${res.statusCode}`)); return; }
        resolve(res);
      }).on('error', reject);
    };
    go(url, 0);
  });
}
async function getJson(url) {
  // GitHub limits anonymous requests; the build machine on GitHub Actions has a token for this (GITHUB_TOKEN)
  const res = await get(url, { json: true, headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {} }); const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function download(url, file, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await get(url); const total = Number(res.headers['content-length']) || 0; const part = `${file}.part`;
      const out = fs.createWriteStream(part); let got = 0; let last = 0;
      await new Promise((resolve, reject) => {
        res.on('data', (c) => { got += c.length; if (total && got - last > total / 20) { last = got; process.stdout.write(`\r  ${label}: ${Math.round((got / total) * 100)}%   `); } });
        res.on('error', reject); out.on('error', reject); out.on('finish', resolve); res.pipe(out);
      });
      process.stdout.write('\n');
      if (total && got !== total) throw new Error(`the download stopped early (${got} of ${total} bytes)`);
      fs.renameSync(part, file); return;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`\n  ${label}: ${e.message}; trying again (${attempt}/2)`);
    }
  }
}

function smokeTest(exe) {
  const r = spawnSync(exe, ['--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.error) throw new Error(`the speech engine did not start: ${r.error.message}. On Windows this usually means the "Microsoft Visual C++ Redistributable" is missing: https://aka.ms/vs/17/release/vc_redist.x64.exe`);
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  if (!/usage|whisper|options/i.test(text)) throw new Error(`the speech engine did not behave as expected: ${text.slice(0, 200)}`);
}

async function main() {
  if (process.env.SKIP_CAPTIONS_FETCH === '1') { console.log('captions: skipped (SKIP_CAPTIONS_FETCH=1): the installer will not include speech to text.'); return 0; }
  const argv = process.argv.slice(2); const force = argv.includes('--force');
  const mi = argv.indexOf('--model'); const choice = String((mi >= 0 && argv[mi + 1]) || process.env.CAPTIONS_MODEL || 'small').toLowerCase();
  if (!MODELS[choice]) { console.error(`captions: unknown model "${choice}". Choose one of: ${Object.keys(MODELS).join(', ')}`); return 1; }
  if (process.platform !== 'win32') { console.log('captions: the bundled engine is for the Windows installer; on this system install whisper.cpp or faster-whisper yourself (see .env.example).'); return 0; }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const modelFile = path.join(OUT_DIR, MODELS[choice]);
  const exeThere = ['whisper-cli.exe', 'main.exe'].map((n) => path.join(OUT_DIR, n)).find((p) => fs.existsSync(p));
  const modelThere = fs.existsSync(modelFile) && fs.statSync(modelFile).size > MIN_MODEL_BYTES;
  if (!force && exeThere && modelThere) { smokeTest(exeThere); console.log(`captions: already in place (${path.basename(exeThere)}, ${MODELS[choice]}).`); return 0; }

  console.log('captions: getting the speech-to-text engine for the installer (one time)…');
  if (force || !exeThere) {
    // CAPTIONS_WHISPER_URL=<direct link to a whisper.cpp Windows x64 .zip> skips the search (for a build machine that can't reach the API)
    let release; let asset;
    if (process.env.CAPTIONS_WHISPER_URL) {
      const u = process.env.CAPTIONS_WHISPER_URL;
      release = { tag_name: 'custom' }; asset = { name: path.basename(new URL(u).pathname) || 'whisper.zip', browser_download_url: u };
    } else {
      const found = pickRelease(await getJson(RELEASES_API));
      if (!found) throw new Error(`no whisper.cpp release with a Windows build was found. Download whisper-bin-x64.zip yourself from https://github.com/ggml-org/whisper.cpp/releases (or any build of it), then either set CAPTIONS_WHISPER_URL to its direct link, or put whisper-cli.exe and its .dll files in ${OUT_DIR}`);
      ({ release, asset } = found);
      console.log(`captions: using whisper.cpp ${release.tag_name} (${asset.name})`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cliq-whisper-'));
    try {
      const zip = path.join(tmp, asset.name);
      await download(asset.browser_download_url, zip, `whisper.cpp ${release.tag_name}`);
      extractZip(zip, path.join(tmp, 'x'));
      const exe = findExe(path.join(tmp, 'x'));
      if (!exe) throw new Error(`whisper-cli.exe was not found inside ${asset.name}`);
      // keep the speech program and its libraries only: the release also carries ~20 test and demo programs the app never uses
      const KEEP_EXE = new Set(['whisper-cli.exe', 'main.exe']);
      for (const f of fs.readdirSync(path.dirname(exe))) {
        const src = path.join(path.dirname(exe), f);
        if (!fs.statSync(src).isFile()) continue;
        if (/\.exe$/i.test(f) && !KEEP_EXE.has(f.toLowerCase())) continue;
        fs.copyFileSync(src, path.join(OUT_DIR, f));
      }
      fs.writeFileSync(path.join(OUT_DIR, 'VERSION.json'), JSON.stringify({ whisperCpp: release.tag_name, asset: asset.name, model: MODELS[choice], fetchedAt: new Date().toISOString() }, null, 2));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  if (force || !modelThere) await download(MODEL_URL(MODELS[choice]), modelFile, `model ${MODELS[choice]}`);
  const exe = ['whisper-cli.exe', 'main.exe'].map((n) => path.join(OUT_DIR, n)).find((p) => fs.existsSync(p));
  smokeTest(exe);
  console.log(`captions: ready (${path.basename(exe)} + ${MODELS[choice]}, ${(fs.statSync(modelFile).size / 1048576).toFixed(0)} MB).`);
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error(`\ncaptions: ${e.message}\n(Build without captions by setting SKIP_CAPTIONS_FETCH=1.)`); process.exit(1); });

module.exports = { pickAsset, pickRelease, findExe, extractZip, MODELS, MODEL_URL };
