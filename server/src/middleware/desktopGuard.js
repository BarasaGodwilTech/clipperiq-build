'use strict';
const crypto = require('crypto');

const COOKIE = 'ciq_token';

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Desktop app only. The server listens on the loopback address, but any web page in any browser on this computer can still
 * send requests to it. So when the app starts the server it also gives its own window a secret (a cookie that only that
 * window has); every request without it is refused, and the Host header must be the loopback address (blocks "DNS rebinding").
 * /healthz stays open so the app can tell the server is up.
 */
function createDesktopGuard(config) {
  const token = config.desktop && config.desktop.token;
  if (!(config.desktop && config.desktop.enabled && token)) return (req, res, next) => next();
  const hostOk = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, '127.0.0.1', 'localhost']);
  return (req, res, next) => {
    if (!hostOk.has(String(req.headers.host || '').toLowerCase())) return res.status(403).send('Forbidden');
    if (req.path === '/healthz') return next();
    const given = readCookie(req.headers.cookie, COOKIE) || String(req.headers['x-clipperiq-token'] || '');
    if (!given || !safeEqual(given, token)) return res.status(403).send('Forbidden');
    next();
  };
}

module.exports = { createDesktopGuard, COOKIE };
