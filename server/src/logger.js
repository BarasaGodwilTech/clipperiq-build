'use strict';
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;

function createLogger({ level = 'info', file = null } = {}) {
  const threshold = LEVELS[level] || LEVELS.info;
  let stream = null;
  let size = 0;

  function openStream() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { size = fs.statSync(file).size; } catch { size = 0; }
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => { stream = null; });
    } catch { stream = null; }
  }
  function rotate() {
    try {
      if (stream) stream.end();
      fs.renameSync(file, `${file}.1`);
    } catch { /* ignore */ }
    openStream();
  }
  openStream();

  function fmt(arg) {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }
  function write(lvl, args) {
    if (LEVELS[lvl] < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${args.map(fmt).join(' ')}`;
    (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
    if (stream) {
      stream.write(line + '\n');
      size += line.length + 1;
      if (size > MAX_BYTES) rotate();
    }
  }
  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    close: () => { try { if (stream) stream.end(); } catch { /* ignore */ } },
  };
}

module.exports = { createLogger };
