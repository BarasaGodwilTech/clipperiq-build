'use strict';
/** Finds the speech-to-text engine that ships inside the installer (server/vendor/whisper), if there is one. */
const fs = require('fs');
const path = require('path');

const EXE_NAMES = ['whisper-cli.exe', 'whisper-cli', 'main.exe', 'main'];

function findBundledWhisper(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return null;
    const bin = EXE_NAMES.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
    const models = fs.readdirSync(dir).filter((n) => /^ggml-.+\.bin$/.test(n)).filter((n) => { try { return fs.statSync(path.join(dir, n)).size > 10 * 1024 * 1024; } catch { return false; } });
    if (!bin || !models.length) return null;
    // the most capable model that is there (the names sort tiny < base < small < medium < large)
    const rank = (n) => ['tiny', 'base', 'small', 'medium', 'large'].findIndex((k) => n.includes(k));
    models.sort((a, b) => rank(b) - rank(a));
    return { bin, model: path.join(dir, models[0]), dir };
  } catch { return null; }
}

module.exports = { findBundledWhisper, EXE_NAMES };
