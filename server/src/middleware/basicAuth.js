'use strict';
/**
 * Optional HTTP Basic Auth gate for the whole app. Off by default (local/dev use); set
 * AUTH_PASSWORD in .env before exposing the server on the internet (e.g. on a VPS) so
 * random visitors can't upload video or spend your platform API quota.
 */
const crypto = require('crypto');

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function createBasicAuth(config) {
  if (!config.auth.password) return (req, res, next) => next();
  return (req, res, next) => {
    if (req.path === '/api/cloud/health' || req.path === '/healthz') return next();
    const header = req.header('authorization') || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      if (timingSafeEqual(user || '', config.auth.username) && timingSafeEqual(pass || '', config.auth.password)) return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="ClipperIQ Studio"');
    res.status(401).send('Authentication required');
  };
}
module.exports = { createBasicAuth };
