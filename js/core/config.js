import { db } from '../storage/db.js';

// Resolves the backend base URL (no trailing slash).
//
// The Node server serves this frontend itself, so when the page was loaded over http(s)
// the backend is simply the SAME ORIGIN — that is always correct for start.bat
// (http://localhost:3000) and for a VPS. A saved "backend_base_url" override (Admin panel /
// Firestore) is only honoured when the frontend is hosted somewhere that is NOT the backend
// (e.g. static hosting + a separate API server), and it is never used on localhost, so a
// stale ngrok URL can no longer hijack a local run.
function isLocalHost() {
  try {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch { return false; }
}

export function isLocalDev() { return isLocalHost(); }

export async function getBackendBaseUrl() {
  if (typeof window !== 'undefined' && window.location && !window.location.origin.startsWith('file:') && isLocalHost()) {
    return window.location.origin.replace(/\/+$/, '');
  }
  try {
    const v = await db.getSetting('backend_base_url');
    if (v) return String(v).replace(/\/+$/, '');
  } catch {}
  return getBackendBaseUrlSync();
}

export function getBackendBaseUrlSync() {
  try {
    if (typeof window !== 'undefined') {
      const origin = window.location && window.location.origin ? window.location.origin : '';
      if (origin && !origin.startsWith('file:')) return origin.replace(/\/+$/, '');
      // Opened straight from disk (file://): the only sensible backend is the local server.
      return 'http://localhost:3000';
    }
  } catch {}
  return '';
}

// The server's .env file is the single, canonical place to configure TikTok/YouTube/
// Instagram app credentials. On startup we pull the non-secret half of it and store it
// alongside the existing settings, so every place that already reads these via
// db.getSetting(...) picks them up automatically — no separate wiring needed. Values set
// here only overwrite a setting when the backend actually has one configured, so a backend
// with an empty .env never erases keys entered elsewhere (e.g. via the admin panel).
export async function syncApiKeysFromBackend() {
  try {
    const base = getBackendBaseUrlSync();
    if (!base) return null;
    const res = await fetch(`${base}/api/config/public`, { headers: { 'ngrok-skip-browser-warning': 'true' } });
    if (!res.ok) return null;
    const cfg = await res.json();
    if (cfg.tiktok_client_key) await db.setSetting('tiktok_client_key', cfg.tiktok_client_key);
    if (cfg.google_client_id) await db.setSetting('google_client_id', cfg.google_client_id);
    if (cfg.facebook_app_id) await db.setSetting('facebook_app_id', cfg.facebook_app_id);
    await db.setSetting('backend_config', JSON.stringify(cfg));
    return cfg;
  } catch {
    return null; // offline / no backend reachable yet — existing settings still apply
  }
}
