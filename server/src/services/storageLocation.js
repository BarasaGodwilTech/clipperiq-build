'use strict';
/**
 * Where ClipperIQ keeps its videos, clips and database, and how that place is changed.
 *
 * The choice is stored in a tiny file (storage-location.json) that is read BEFORE the rest of the configuration,
 * so it wins over DATA_DIR in .env. If the chosen folder is not reachable at start-up (for example an external
 * drive that is unplugged) the default folder is used instead and the app says so, rather than failing to start.
 */
const fs = require('fs');
const path = require('path');

const KEEP_OUT = new Set(['tmp']); // scratch space is not worth copying
const GB = 1024 ** 3;

function readOverride(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j.dataDir === 'string' && path.isAbsolute(j.dataDir)) return path.normalize(j.dataDir);
  } catch { /* none, or unreadable: no override */ }
  return '';
}

function writeOverride(file, dataDir) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ dataDir, savedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file); // atomic: a crash can never leave half a file
}

function clearOverride(file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }

/**
 * Create a folder one level at a time. (mkdirSync's own `recursive` option can spin forever on odd paths such as a
 * missing drive or a read-only virtual folder; this fails at once with the real reason.)
 */
function makeDirs(dir) {
  const missing = [];
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) { missing.push(d); const up = path.dirname(d); if (up === d || missing.length > 64) break; d = up; }
  if (!fs.existsSync(d)) { const e = new Error('no such drive or folder'); e.code = 'ENOENT'; throw e; }
  if (!fs.statSync(d).isDirectory()) { const e = new Error('not a folder'); e.code = 'ENOTDIR'; throw e; }
  for (const m of missing.reverse()) fs.mkdirSync(m);
}

/** Can this folder be used? Creates it if needed and proves it is writable. Never throws. */
function usable(dir) {
  try {
    makeDirs(dir);
    const probe = path.join(dir, `.clipperiq-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) { return { ok: false, error: friendlyFsError(e) }; }
}

function friendlyFsError(e) {
  const c = e && e.code;
  if (c === 'ENOENT') return 'That drive or folder cannot be found. If it is an external drive, plug it in.';
  if (c === 'EACCES' || c === 'EPERM') return 'ClipperIQ is not allowed to write to that folder. Choose another one, or check its permissions.';
  if (c === 'ENOSPC') return 'That drive is full.';
  if (c === 'EROFS') return 'That drive is read-only.';
  if (c === 'ENOTDIR') return 'That path is a file, not a folder.';
  return `That folder cannot be used (${(e && e.message) || e}).`;
}

async function freeSpace(dir) {
  // statfs exists from Node 18.15; walk up to the nearest folder that exists (the target may not have been created yet)
  let d = dir;
  for (let i = 0; i < 64; i++) {
    try {
      const s = await fs.promises.statfs(d);
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch { const up = path.dirname(d); if (up === d) break; d = up; }
  }
  return { free: null, total: null };
}

async function dirSize(dir, skip = KEEP_OUT) {
  let total = 0; let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (d === dir && skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += (await fs.promises.stat(p)).size; files++; } catch { /* vanished */ } }
    }
  }
  return { bytes: total, files };
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Everything that must be true before switching. Returns { ok, error, free, total, hasData, needBytes }. */
async function check(target, currentDir, { move = false } = {}) {
  if (typeof target !== 'string' || !target.trim()) return { ok: false, error: 'Enter or choose a folder.' };
  const t = path.normalize(target.trim());
  if (!path.isAbsolute(t)) return { ok: false, error: 'Use the full path, for example D:\\ClipperIQ or /mnt/storage/clipperiq.' };
  if (path.parse(t).root === t) return { ok: false, error: 'Choose a folder on the drive, not the drive itself (for example D:\\ClipperIQ).' };
  if (path.resolve(t) === path.resolve(currentDir)) return { ok: false, error: 'That is the folder already in use.' };
  if (isInside(t, currentDir)) return { ok: false, error: 'The new folder cannot be inside the current one.' };
  if (isInside(currentDir, t)) return { ok: false, error: 'The new folder cannot contain the current one. Choose a separate folder.' };
  const u = usable(t);
  if (!u.ok) return { ok: false, error: u.error };
  const space = await freeSpace(t);
  const hasData = fs.existsSync(path.join(t, 'db.json'));
  let needBytes = 0;
  if (move) {
    const { bytes } = await dirSize(currentDir);
    needBytes = bytes + 1 * GB; // the data plus 1 GB of headroom
    if (space.free != null && space.free < needBytes) {
      return { ok: false, error: `Not enough free space there. Moving needs about ${fmt(needBytes)} and that drive has ${fmt(space.free)} free.`, ...space, hasData, needBytes };
    }
  }
  if (!move && space.free != null && space.free < 2 * GB) {
    return { ok: false, error: `That drive only has ${fmt(space.free)} free. Videos need much more than that.`, ...space, hasData, needBytes };
  }
  return { ok: true, ...space, hasData, needBytes, path: t };
}

function fmt(b) { if (b == null) return '?'; return b >= GB ? (b / GB).toFixed(1) + ' GB' : (b / 1048576).toFixed(0) + ' MB'; }

/**
 * Copy the data folder to a new place. Nothing is deleted from the old folder. Reports progress through
 * onProgress({ done, total, file }). Aborting stops cleanly between files.
 */
async function copyData(from, to, { onProgress, signal } = {}) {
  const plan = []; let total = 0;
  const walk = async (rel) => {
    const abs = path.join(from, rel);
    for (const e of await fs.promises.readdir(abs, { withFileTypes: true })) {
      if (!rel && KEEP_OUT.has(e.name)) continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { plan.push({ dir: r }); await walk(r); }
      else if (e.isFile()) { const size = (await fs.promises.stat(path.join(from, r))).size; plan.push({ file: r, size }); total += size; }
    }
  };
  await walk('');
  let done = 0;
  for (const item of plan) {
    if (signal && signal.aborted) { const e = new Error('Cancelled'); e.code = 'ABORT_ERR'; throw e; }
    if (item.dir) { await fs.promises.mkdir(path.join(to, item.dir), { recursive: true }); continue; }
    const dest = path.join(to, item.file);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    // copy to a temporary name first so a stopped copy never leaves a file that looks finished but is cut short
    const part = `${dest}.copying`;
    await fs.promises.copyFile(path.join(from, item.file), part);
    const st = await fs.promises.stat(part);
    if (st.size !== item.size) throw new Error(`Copy of ${item.file} came out the wrong size (${st.size} of ${item.size} bytes). The drive may be failing.`);
    await fs.promises.rename(part, dest);
    done += item.size;
    if (onProgress) onProgress({ done, total, file: item.file });
  }
  return { bytes: total, files: plan.filter((p) => p.file).length };
}

module.exports = { readOverride, writeOverride, clearOverride, usable, friendlyFsError, freeSpace, dirSize, check, copyData, isInside, fmt };
