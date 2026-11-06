// Bump this on every deploy that changes any cached file (js/, css/, index.html, etc.) —
// otherwise returning visitors keep loading the old cached version indefinitely.
const CACHE_VERSION = 'clipperiq-v39';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/css/components.css',
  '/css/animations.css',
  '/css/editor.css',
  '/css/polish.css',
  '/css/upload.css',
  '/css/responsive.css',
  '/js/app.js',
  '/js/storage/db.js',
  '/js/storage/authStore.js',
  '/js/storage/videoStore.js',
  '/js/core/audioAnalyzer.js',
  '/js/core/sceneDetector.js',
  '/js/core/videoProcessor.js',
  '/js/core/clipGenerator.js',
  '/js/platforms/oauthHelper.js',
  '/js/platforms/tiktok.js',
  '/js/platforms/instagram.js',
  '/js/platforms/youtube.js',
  '/js/scheduler/jobQueue.js',
  '/js/scheduler/retryHandler.js',
  '/js/scheduler/cronEngine.js',
  '/js/ui/notifications.js',
  '/js/ui/dashboard.js',
  '/js/core/designStore.js',
  '/js/shared/lowerThird.js',
  '/js/shared/framing.js',
  '/js/ui/lookPanels.js',
  '/js/shared/adjust.js',
  '/js/shared/captions.js',
  '/js/core/errors.js',
  '/js/core/settingsProfile.js',
  '/js/ui/captionsPanel.js',
  '/js/ui/ltTimeline.js',
  '/config/caption-templates.json',
  '/js/ui/adjustPanel.js',
  '/config/clip-adjustments.json',
  '/js/storage/persistence.js',
  '/js/ui/processingStatus.js',
  '/js/ui/upload.js',
  '/js/ui/uploadPage.js',
  '/js/ui/storageSettings.js',
  '/js/ui/editor.js',
  '/js/ui/designer.js',
  '/js/ui/clips.js',
  '/js/ui/queue.js',
  '/auth/callback.html',
  '/manifest.json',
];

// No COOP/COEP any more: they were only needed for in-browser FFmpeg (SharedArrayBuffer). Cross-origin isolation
// breaks sign-in / OAuth popups (window.opener is cut) and third-party fonts, and clips are now cut on the server.
const COOP_COEP_HEADERS = {
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  const isLocal = url.origin === self.location.origin;
  const isNavigate = request.mode === 'navigate';
  const isStaticAsset = isLocal && STATIC_ASSETS.some(a => url.pathname === a || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html') || url.pathname.endsWith('.json'));
  const isFFmpegAsset = url.hostname.includes('unpkg.com') || url.hostname.includes('cdn.jsdelivr.net');

  // Do not intercept cross-origin requests (except whitelisted CDNs) to avoid
  // COEP/CORP issues with third-party APIs like Google Firestore or TikTok CDN
  if (!isLocal && !isFFmpegAsset) {
    return; // allow the browser to handle normally
  }

  if (isFFmpegAsset) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return addHeaders(cached, request.url.endsWith('.wasm') ? { ...COOP_COEP_HEADERS, 'Content-Type': 'application/wasm' } : COOP_COEP_HEADERS);
        const fetched = await fetch(request);
        cache.put(request, fetched.clone());
        return addHeaders(fetched, COOP_COEP_HEADERS);
      })
    );
    return;
  }

  // Network-first for the app's own files: you always get the latest code when the server is
  // up (e.g. right after start.bat), and the cached copy only kicks in when it's unreachable.
  // API calls (/api/*, /uploads/*, /upload/*) are never touched by the cache.
  const isApi = /^\/(api|uploads|upload|healthz)(\/|$)/.test(url.pathname);
  if (!isApi && request.method === 'GET' && (isNavigate || (isLocal && (isStaticAsset || url.pathname === '/')))) {
    event.respondWith(
      fetch(request).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, clone)).catch(() => {});
        }
        return addHeaders(res, COOP_COEP_HEADERS);
      }).catch(async () => {
        const cached = await caches.match(request);
        return cached ? addHeaders(cached, COOP_COEP_HEADERS) : Response.error();
      })
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (e) {
        const cached = await caches.match(request);
        return cached || Response.error();
      }
    })()
  );
});

function addHeaders(response, headers) {
  if (!response) return response;
  const newHeaders = new Headers(response.headers);
  for (const [key, val] of Object.entries(headers)) {
    newHeaders.set(key, val);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
