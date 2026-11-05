'use strict';
/**
 * Minimal HTTP client built on node:http/https.
 *
 * Why not global fetch? Node's built-in fetch (undici) has a hard 10 s connect timeout that
 * breaks on some networks (the original backend hit exactly this against TikTok's API), and it
 * can't stream large request bodies with a known Content-Length as simply. This client uses the
 * classic agents, supports streamed / buffered bodies, per-request timeouts and abort signals.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

try { if (net.setDefaultAutoSelectFamilyAttemptTimeout) net.setDefaultAutoSelectFamilyAttemptTimeout(2500); } catch { /* older Node */ }

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 16 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 16 }),
};

class HttpFailure extends Error {
  constructor(message, { status, body, cause, network } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.cause = cause;
    this.network = !!network;
  }
}

function request(url, { method = 'GET', headers = {}, body, timeoutMs = 60000, signal, maxBytes = 25 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new HttpFailure(`Invalid URL: ${url}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const h = { 'User-Agent': 'ClipperIQ/2.0', Accept: 'application/json, */*', ...headers };
    let payload = null;
    let stream = null;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
        h['Content-Length'] = String(payload.length);
      } else stream = body;
    } else if (['POST', 'PUT', 'PATCH'].includes(method)) h['Content-Length'] = '0';

    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method, headers: h, agent: agents[u.protocol],
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (d) => { size += d.length; if (size <= maxBytes) chunks.push(d); });
      res.on('end', () => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers,
          buffer: buf,
          get text() { return buf.toString('utf8'); },
          json() { try { return JSON.parse(buf.toString('utf8')); } catch { return {}; } },
        });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(new HttpFailure(e.message, { network: true, cause: e })); });
    });

    const timer = setTimeout(() => { req.destroy(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    req.on('error', (e) => {
      clearTimeout(timer);
      if (e.code === 'ABORT_ERR') return reject(e);
      reject(new HttpFailure(`Network error contacting ${u.hostname}: ${e.code || e.message}`, { network: true, cause: e }));
    });
    if (payload) req.end(payload);
    else if (stream) stream.pipe(req);
    else req.end();
  });
}

const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)).toString();

/** Retry network-level failures and 5xx with exponential backoff. */
async function withRetry(fn, { attempts = 3, baseMs = 1000, signal } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn(i);
      if (r && r.status >= 500 && i < attempts - 1) { last = r; await sleep(baseMs * 2 ** i, signal); continue; }
      return r;
    } catch (e) {
      if (e.code === 'ABORT_ERR' || !e.network || i === attempts - 1) throw e;
      last = e;
      await sleep(baseMs * 2 ** i, signal);
    }
  }
  if (last instanceof Error) throw last;
  return last;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); }, { once: true });
  });
}

module.exports = { request, form, withRetry, sleep, HttpFailure };
