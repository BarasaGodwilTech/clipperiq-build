import { db, STORES } from './storage/db.js';
import { persistence } from './storage/persistence.js';
import { videoStore } from './storage/videoStore.js';
import { authStore } from './storage/authStore.js';
import { notify, confirmAction } from './ui/notifications.js';
import { dashboard } from './ui/dashboard.js';
import { processingStatus } from './ui/processingStatus.js';
import { editorUI } from './ui/editor.js';
import { uploadUI } from './ui/upload.js';
import { clipGenerator } from './core/clipGenerator.js';
import { clipsUI } from './ui/clips.js';
import { queueUI } from './ui/queue.js';
import { tiktokAPI } from './platforms/tiktok.js';
import { instagramAPI } from './platforms/instagram.js';
import { youtubeAPI } from './platforms/youtube.js';
import { cronEngine } from './scheduler/cronEngine.js';
import { jobQueue } from './scheduler/jobQueue.js';
// Firebase is loaded on demand (see init): a static import from a CDN would stop the WHOLE app from starting offline.
import { syncApiKeysFromBackend } from './core/config.js';
import { getBackendBaseUrl } from './core/config.js';
import { settingsProfile } from './core/settingsProfile.js';
import { installGlobalErrorHandlers, showStorageBanner, showStartupFailure, diagnostics } from './core/errors.js';

const PAGE_TITLES = {
  login: 'Sign In',
  dashboard: 'Dashboard',
  upload: 'New Project',
  clips: 'Generated Clips',
  scheduler: 'Scheduler',
  queue: 'Post Queue',
  analytics: 'Analytics',
  accounts: 'Connected Accounts',
  settings: 'Settings',
};

class ClipperIQApp {
  constructor() {
    this.currentView = 'dashboard';
    this.compatOk = true;
    this._connecting = false;
    this._modalOpenCount = 0;
  }

  _lockBodyScroll() {
    this._modalOpenCount++;
    if (this._modalOpenCount === 1) {
      document.body.style.overflow = 'hidden';
    }
  }

  _unlockBodyScroll() {
    this._modalOpenCount = Math.max(0, this._modalOpenCount - 1);
    if (this._modalOpenCount === 0) {
      document.body.style.overflow = '';
    }
  }

  async _refreshPlatformInsights() {
    const containerId = 'platformInsights';
    const container = document.getElementById(containerId);
    if (!container) return;

    const rows = [];
    const safe = (v) => (v == null ? '—' : v);

    // TikTok: refresh user via API when possible, then use posted history for recents
    try {
      const ttConnected = await authStore.isConnected('tiktok');
      if (ttConnected) {
        let info = {};
        try { info = await tiktokAPI.fetchUserInfo(); }
        catch {
          const raw = await db.getSetting('tiktok_user');
          info = raw ? JSON.parse(raw) : {};
        }
        // Fallback to token open_id if username/display_name missing
        if (!info?.username && !info?.display_name) {
          try { const tok = await authStore.getToken('tiktok'); if (tok?.open_id) info.username = tok.open_id; } catch {}
        }
        // build recent from posted history (best-effort)
        let recent = [];
        try {
          const hist = await db.getAll(STORES.POSTED_HISTORY);
          const lastTt = hist.filter(h => h.platform === 'TikTok').sort((a,b)=>new Date(b.postedAt||b.scheduledAt)-new Date(a.postedAt||a.scheduledAt)).slice(0,5);
          const username = info?.username;
          recent = lastTt.map(h => {
            let url = null;
            try {
              const data = JSON.parse(h.result||'{}');
              url = data.url || (data.videoId && username ? `https://www.tiktok.com/@${username}/video/${data.videoId}` : null);
            } catch {}
            return { title: h.caption?.slice(0,40) || `Clip #${h.clipId}`, url };
          });
        } catch {}

        let avatar = info.avatar_url || '';
        try {
          if (avatar) {
            const base = await getBackendBaseUrl();
            if (base && !avatar.startsWith(base + '/api/proxy-image')) {
              avatar = `${base}/api/proxy-image?url=${encodeURIComponent(avatar)}`;
            }
          }
        } catch {}
        rows.push({
          platform: 'TikTok',
          color: 'var(--tiktok)',
          avatar,
          handle: info.username ? '@' + info.username : (info.display_name || 'Connected'),
          followers: info.follower_count,
          recent,
        });
      }
    } catch {}

    // Instagram: use new getInsights()
    try {
      const igConnected = await authStore.isConnected('instagram');
      if (igConnected) {
        const data = await instagramAPI.getInsights(5);
        rows.push({
          platform: 'Instagram',
          color: 'var(--insta)',
          avatar: data.user?.profile_picture_url || '',
          handle: data.user?.username ? '@' + data.user.username : 'Connected',
          followers: data.user?.followers_count,
          recent: (data.recent || []).map(m => ({
            title: m.caption?.slice(0, 40) || m.id,
            url: m.permalink || null,
            likes: m.like_count,
            comments: m.comments_count,
          })),
        });
      }
    } catch {}

    // YouTube: use new getInsights()
    try {
      const ytConnected = await authStore.isConnected('youtube');
      if (ytConnected) {
        const data = await youtubeAPI.getInsights(5);
        const stats = data.channel?.statistics || {};
        rows.push({
          platform: 'YouTube',
          color: 'var(--youtube)',
          avatar: data.channel?.snippet?.thumbnails?.default?.url || '',
          handle: data.channel?.snippet?.title || 'Connected',
          followers: stats.subscriberCount,
          recent: (data.recent || []).map(v => ({ title: v.title, url: v.url })),
        });
      }
    } catch {}

    if (rows.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);font-size:13px">Connect accounts to see insights</div>';
      return;
    }

    const html = rows.map(r => `
      <div class="video-item">
        <div class="video-thumb" style="width:28px;height:28px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.04)">
          ${r.avatar ? `<img src="${r.avatar}" alt="" style="width:100%;height:100%;object-fit:cover">` : `<div style="width:14px;height:14px;border-radius:50%;background:${r.color}"></div>`}
        </div>
        <div class="video-info">
          <div class="video-name" style="color:${r.color}">${r.platform}</div>
          <div class="video-meta">${safe(r.handle)} · Followers/Subs: ${safe(r.followers)}</div>
        </div>
      </div>
      ${r.recent && r.recent.length ? `<div style="margin:6px 0 10px 36px;display:flex;flex-direction:column;gap:6px">${r.recent.map(x => `<a ${x.url?`href=\"${x.url}\" target=\"_blank\" rel=\"noopener\"`:''} style="font-size:12px;color:var(--muted);text-decoration:none">• ${x.title || 'Post'}${(x.likes!=null||x.comments!=null)?` — ${x.likes??'–'}❤ · ${x.comments??'–'}💬`:''}</a>`).join('')}</div>` : ''}
    `).join('');

    container.innerHTML = html;
  }

  async initAudioPreviews() {
    const audioProxyBase = (await getBackendBaseUrl().catch(() => '')) || '';
    // Helper function to bind audio preview logic
    const bindPreview = (urlId, fileId, previewId) => {
      const urlEl = document.getElementById(urlId);
      const fileEl = document.getElementById(fileId);
      const previewEl = document.getElementById(previewId);
      if (!urlEl || !fileEl || !previewEl) return;

      const updatePreview = () => {
        if (fileEl.files && fileEl.files[0]) {
          // File takes precedence
          previewEl.src = URL.createObjectURL(fileEl.files[0]);
          previewEl.style.display = 'block';
        } else if (urlEl.value.trim()) {
          // URL fallback (with proxy for TikTok/YouTube)
          let srcUrl = urlEl.value.trim();
          if (audioProxyBase && srcUrl.match(/tiktok\.com|youtube\.com|youtu\.be/i)) {
            srcUrl = `${audioProxyBase}/api/audio?url=${encodeURIComponent(srcUrl)}`;
          }
          previewEl.src = srcUrl;
          previewEl.style.display = 'block';
        } else {
          // Nothing
          previewEl.src = '';
          previewEl.style.display = 'none';
        }

        // Auto-apply current volume to the player
        const isMixModal = previewId === 'mixBgmPreview';
        const volEl = document.getElementById(isMixModal ? 'mixBgmVol' : 'bgmVolume');
        if (volEl && previewEl.src) {
          previewEl.volume = Math.max(0, Math.min(1, parseInt(volEl.value || '25', 10) / 100));
        }
      };

      urlEl.addEventListener('input', updatePreview);
      fileEl.addEventListener('change', updatePreview);
    };

    bindPreview('bgmUrl', 'bgmFile', 'bgmPreview');
    bindPreview('mixBgmUrl', 'mixBgmFile', 'mixBgmPreview');
  }

  /**
   * Runs one start-up step. A step that fails or takes too long is noted and skipped (the rest of the app still starts);
   * only a step passed as `essential` can stop start-up.
   */
  async _stage(name, fn, { ms = 0, essential = false } = {}) {
    try {
      if (!ms) return await fn();
      let timer;
      const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${name} took too long`), { name: 'TimeoutError' })), ms); });
      try { return await Promise.race([fn(), limit]); } finally { clearTimeout(timer); }
    } catch (e) {
      diagnostics.add('startup', e, name);
      console.warn(`[App] ${name} failed:`, e);
      (this._startupIssues = this._startupIssues || []).push(name);
      if (essential) throw e;
      return undefined;
    }
  }

  async init() {
    installGlobalErrorHandlers({ notify });
    // The browser database. If it cannot be opened (damaged or locked storage for this address) this does NOT fail: the app
    // carries on in temporary mode and says so, instead of hanging on "Loading...".
    await db.open();
    db.onDegraded((f) => showStorageBanner(f, { db, notify }));
    // Before any screen reads the library: ask the browser to keep the data, and bring the library back from
    // the server if the browser lost it.
    await this._stage('saved-data backup', () => persistence.init());
    this.compatOk = this.checkCompatibility();
    await this._stage('navigation', () => this.setupNavigation(), { essential: true });
    await this._stage('sidebar', () => this.setupSidebarToggle());
    await this._stage('schedule dialog', () => this.setupScheduleModal());
    await this._stage('preview dialog', () => this.setupPreviewModal());
    await this._stage('audio previews', () => this.initAudioPreviews());
    await this._stage('upload screen', () => uploadUI.init());
    await this._stage('editor', () => editorUI.init());

    cronEngine.registerPlatform('tiktok', tiktokAPI);
    cronEngine.registerPlatform('instagram', instagramAPI);
    cronEngine.registerPlatform('youtube', youtubeAPI);

    cronEngine.onJobComplete = (job, result) => {
      if (job.platform === 'TikTok' && result?.status === 'SEND_TO_USER_INBOX') {
        notify.success('Sent to TikTok inbox. Open TikTok to review and post it.');
      } else {
        notify.success(`Posted to ${job.platform} successfully!`);
      }
      queueUI.refresh();
    };
    cronEngine.onJobFailed = (job, err) => {
      notify.error(`Failed to post to ${job.platform}`);
      queueUI.refresh();
    };

    // Sync global settings (including backend_base_url) from Firestore first
    // (each is given a few seconds: on a poor network they must not hold the whole app on "Loading...")
    await this._stage('settings from Firebase', async () => { const m = await import('./firebase.js'); return m.syncApiKeysFromFirebase(); }, { ms: 6000 });
    // The server's .env is the canonical config source, so let it override any Firestore-synced key
    await this._stage('settings from the server', () => syncApiKeysFromBackend(), { ms: 6000 });

    // Start scheduler after settings are available
    await this._stage('scheduler', () => cronEngine.start());

    // Rendering happens on the server, so a video that was still processing when this tab
    // was last closed or reloaded didn't lose any work — reconnect to it in the background
    // and pull in whatever finished (or is about to). Not awaited: this can take a while for
    // a long job, and the rest of the app shouldn't wait on it.
    // Restore the "processing" indicator right away (badge + Recent Uploads), then reconnect to the jobs.
    window.processingStatus = processingStatus;
    await this._stage('reload note', () => this._noteTabReload());
    await this._stage('processing status', () => processingStatus.init());
    this._resumeInterruptedUploads();

    await this._stage('dashboard', () => dashboard.refresh());
    await this._stage('account status', () => this.refreshAccountStatuses(), { ms: 8000 });
    await this._stage('platform status', () => this._updateDashPlatformStatus(), { ms: 8000 });
    await this._stage('queue badge', () => this._startQueueBadgeUpdater());
    if (this._startupIssues && this._startupIssues.length) {
      notify.warn(`Some parts did not load (${[...new Set(this._startupIssues)].slice(0, 3).join(', ')}). The rest works. Settings, Diagnostics has the details.`);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
    }

    window.app = this;
    console.log('[ClipperIQ] App initialized');
  }

  /** "Download my settings": everything set up, in one file that can be loaded in any session. */
  async saveSettingsFile() {
    try {
      const r = await settingsProfile.download();
      notify.success(`Saved your settings (${r.summary.parts.length} part${r.summary.parts.length === 1 ? '' : 's'}). Keep the file: loading it later restores them.`);
    } catch (e) { diagnostics.add('settings-file', e); notify.error(`Could not save the settings file: ${String((e && e.message) || e).slice(0, 140)}`); }
  }

  /** "Load settings from a file". */
  async loadSettingsFile() {
    try { await settingsProfile.pickAndLoad({ notify, confirmAction }); }
    catch (e) { diagnostics.add('settings-file', e); notify.error(`Could not load the settings file: ${String((e && e.message) || e).slice(0, 140)}`); }
  }

  async refreshDashboardSoon() { try { await dashboard.refresh(); } catch { /* shown in place */ } }

  async copyDiagnostics() {
    const { copyText } = await import('./core/errors.js');
    const extra = `Saved data in this browser: ${db.mode === 'memory' ? `TEMPORARY MODE (${db.failure ? `${db.failure.name}: ${db.failure.message}` : 'unknown reason'})` : 'working'}\nStart-up issues: ${(this._startupIssues || []).join(', ') || 'none'}`;
    const ok = await copyText(diagnostics.text(extra));
    notify[ok ? 'success' : 'warn'](ok ? 'Copied. Paste it into your message.' : 'Could not copy automatically. Select the text in the console (F12) instead.');
  }

  async retryDashboard() {
    const failed = await dashboard.refresh().catch(() => ['dashboard']);
    if (!failed.length) await this._updateDashPlatformStatus().catch(() => {});
  }

  checkCompatibility() {
    const issues = [];
    try {
      if (typeof MediaRecorder === 'undefined') {
        issues.push('MediaRecorder API is not available');
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        issues.push('Web Audio API (AudioContext) is not available');
      }
      const video = document.createElement('video');
      const canvas = document.createElement('canvas');
      const hasCanvasCapture = typeof canvas.captureStream === 'function';
      const hasVideoCapture = typeof video.captureStream === 'function' || typeof video.mozCaptureStream === 'function';
      if (!hasCanvasCapture || !hasVideoCapture) {
        issues.push('captureStream() is not supported on video/canvas elements');
      }
    } catch (e) {
      issues.push('Environment error while checking capabilities');
    }

    if (issues.length === 0) return true;

    console.warn('[ClipperIQ] Incompatible browser for clip generation:', issues.join('; '));
    try {
      notify.error('Your browser cannot generate clips reliably. Please use the latest Chrome, Edge, or Firefox.');
    } catch {}

    try {
      const processBtn = document.getElementById('processBtn');
      if (processBtn) {
        processBtn.disabled = true;
        processBtn.title = 'Browser not supported for clip generation';
        processBtn.style.opacity = '0.5';
      }
      const uploadZone = document.getElementById('uploadZone');
      if (uploadZone && !document.getElementById('uploadCompatWarning')) {
        const note = document.createElement('div');
        note.id = 'uploadCompatWarning';
        note.style.cssText = 'margin-top:8px;font-size:12px;color:var(--danger, #b00020);';
        note.textContent = 'Clip generation is not supported in this browser. Try the latest Chrome, Edge, or Firefox.';
        uploadZone.appendChild(note);
      }
    } catch {}

    return false;
  }

  navigate(view, triggerEl = null) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (triggerEl) {
      triggerEl.classList.add('active');
    } else {
      const navBtn = document.querySelector(`.nav-item[data-view="${view}"]`);
      if (navBtn) navBtn.classList.add('active');
    }

    const title = document.getElementById('pageTitle');
    if (title) title.textContent = PAGE_TITLES[view] || view;
    this.currentView = view;
    this.closeSidebar?.();

    if (view === 'dashboard') { dashboard.refresh(); this._updateDashPlatformStatus(); }
    else if (view === 'clips') { clipsUI.refresh(); }
    else if (view === 'queue') queueUI.refresh();
    else if (view === 'accounts') this.refreshAccountStatuses();
    else if (view === 'analytics') this.refreshAnalytics();
    else if (view === 'scheduler') this.refreshSchedulerView();
    else if (view === 'settings') this.refreshStorageCard();
  }

  /** The "Storage & backup" card on the Settings screen. */
  async refreshStorageCard() {
    const box = document.getElementById('storageStatus');
    if (!box) return;
    const mb = (n) => (n == null ? '—' : n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`);
    const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'not yet');
    box.textContent = 'Checking…';
    try {
      const st = await persistence.status();
      const rows = [
        ['Browser storage', st.supported ? (st.persisted ? 'Protected: the browser will not clear it automatically' : 'Not protected: the browser may clear it when space runs low') : 'Protection not supported by this browser'],
        ['Space used', st.usage != null ? `${mb(st.usage)} of ${mb(st.quota)}` : '—'],
        ['Backup on the server', st.server ? `${st.server.clips} clips, ${st.server.uploads} videos (saved ${when(st.server.savedAt)})` : (st.lastError ? `unavailable (${st.lastError})` : 'none yet')],
      ];
      box.innerHTML = rows.map(([k, v]) => `<div><strong style="color:var(--text)">${k}:</strong> ${String(v).replace(/[<>&]/g, '')}</div>`).join('');
    } catch (e) { box.textContent = 'Could not read the storage status.'; }
  }

  async backupNowClicked() {
    try { await persistence.backupNow(); notify.success('Library backed up to the server.'); }
    catch (e) { notify.error(`Backup failed: ${String((e && e.message) || e)}`); }
    this.refreshStorageCard();
  }

  async restoreMissingClicked() {
    try {
      const c = await persistence.restoreMissing();
      if (!c) notify.info('The server has no backup yet.');
      else {
        notify.success(c.clips + c.uploads + c.scheduled + c.history ? `Restored ${c.clips} clips and ${c.uploads} videos that were missing.` : 'Nothing was missing.');
        clipsUI.refresh?.(); dashboard.refresh?.();
      }
    } catch (e) { notify.error(`Restore failed: ${String((e && e.message) || e)}`); }
    this.refreshStorageCard();
  }

  setupNavigation() {
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => this.navigate(btn.dataset.view, btn));
    });
  }

  setupSidebarToggle() {
    const toggle = document.getElementById('sidebarToggle');
    const backdrop = document.getElementById('sidebarBackdrop');

    if (!toggle || !backdrop) return;

    const closeSidebar = () => {
      document.body.classList.remove('sidebar-open');
    };

    const updateAria = () => {
      const expanded = document.body.classList.contains('sidebar-open');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    };

    updateAria();

    this.closeSidebar = () => {
      closeSidebar();
      updateAria();
    };

    toggle.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-open');
      updateAria();
    });

    backdrop.addEventListener('click', () => {
      closeSidebar();
      updateAria();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const wasOpen = document.body.classList.contains('sidebar-open');
        closeSidebar();
        if (wasOpen) updateAria();
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) {
        const wasOpen = document.body.classList.contains('sidebar-open');
        closeSidebar();
        if (wasOpen) updateAria();
      }
    });
  }

  setupScheduleModal() {
    const modal = document.getElementById('scheduleModal');
    const form = document.getElementById('scheduleForm');
    const closeBtn = document.getElementById('scheduleModalClose');
    const platformEl = document.getElementById('schedulePlatform');
    const ttSection = document.getElementById('scheduleTikTokSection');
    if (!modal || !form) return;

    const updateTikTokVisibility = () => {
      if (!ttSection || !platformEl) return;
      const v = platformEl.value;
      ttSection.style.display = (v === '' || v === 'TikTok' || v === 'All') ? 'block' : 'none';
    };
    platformEl?.addEventListener('change', updateTikTokVisibility);

    const closeModal = () => { modal.classList.remove('show'); this._unlockBodyScroll(); };
    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const clipId = parseInt(form.dataset.clipId);
      const platform = document.getElementById('schedulePlatform').value;
      const scheduledAt = document.getElementById('scheduleTime').value;
      const caption = document.getElementById('scheduleCaption').value;

      if (!platform) { notify.warn('Select a platform'); return; }
      if (!scheduledAt) { notify.warn('Set a schedule time'); return; }
      if (new Date(scheduledAt) <= new Date()) { notify.warn('Schedule time must be in the future'); return; }

      const clip = clipsUI.clips.find(c => c.id === clipId);
      if (!clip) { notify.error('Clip not found'); return; }

      const privacy = document.getElementById('schedulePrivacy')?.value || 'PUBLIC_TO_EVERYONE';
      const disableComment = !!document.getElementById('tiktokDisableComment')?.checked;
      const disableDuet = !!document.getElementById('tiktokDisableDuet')?.checked;
      const disableStitch = !!document.getElementById('tiktokDisableStitch')?.checked;
      const brandedContent = !!document.getElementById('tiktokBrandedContent')?.checked;
      const allowPromotion = !!document.getElementById('tiktokAllowPromotion')?.checked;
      const postOptions = {
        privacy,
        allowComments: !disableComment,
        allowDuet: !disableDuet,
        allowStitch: !disableStitch,
        brandedContent,
        allowPromotion,
      };

      try {
        const submitBtn = form.querySelector('button[type="submit"], .btn.btn-primary');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Scheduling…'; }
        if (platform === 'All') {
          const candidates = [
            { name: 'TikTok', key: 'tiktok' },
            { name: 'Instagram', key: 'instagram' },
            { name: 'YouTube', key: 'youtube' },
          ];
          const targets = [];
          for (const p of candidates) {
            if (await authStore.isConnected(p.key)) targets.push(p.name);
          }
          if (targets.length === 0) {
            notify.warn('No connected platforms. Connect accounts in the Accounts tab.');
            return;
          }
          for (const name of targets) {
            await jobQueue.add({ clipId, blobId: clip.blobId, platform: name, caption, scheduledAt, options: { ...postOptions } });
          }
          modal.classList.remove('show');
          notify.success(`Scheduled on ${targets.join(', ')} for ${new Date(scheduledAt).toLocaleString()}`);
        } else {
          const connected = await authStore.isConnected(platform.toLowerCase());
          if (!connected) { notify.warn(`${platform} is not connected. Go to Accounts to connect.`); return; }
          await jobQueue.add({ clipId, blobId: clip.blobId, platform, caption, scheduledAt, options: { ...postOptions } });
          modal.classList.remove('show');
          notify.success(`Scheduled for ${new Date(scheduledAt).toLocaleString()}`);
        }

        await queueUI.refresh();

        const badge = document.querySelector('.nav-item[data-view="queue"] .nav-badge');
        if (badge) {
          const count = await jobQueue.getUpcomingCount();
          badge.textContent = count;
        }
      } catch (err) {
        if (/already scheduled/i.test(err?.message || '')) notify.warn('Already scheduled for that time');
        else notify.error('Failed to schedule. Please try again.');
      } finally {
        const submitBtn = form.querySelector('button[type="submit"], .btn.btn-primary');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Schedule'; }
      }
    });
  }

  openScheduleModal(clip) {
    const modal = document.getElementById('scheduleModal');
    const form = document.getElementById('scheduleForm');
    const platformEl = document.getElementById('schedulePlatform');
    const ttSection = document.getElementById('scheduleTikTokSection');
    if (!modal || !form) return;

    form.dataset.clipId = clip.id;
    const now = new Date(Date.now() + 3600000);
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const timeEl = document.getElementById('scheduleTime');
    if (timeEl) timeEl.value = local;
    const captionEl = document.getElementById('scheduleCaption');
    if (captionEl) captionEl.value = '';
    const privacyEl = document.getElementById('schedulePrivacy');
    if (privacyEl) privacyEl.value = 'PUBLIC_TO_EVERYONE';
    const dc = document.getElementById('tiktokDisableComment'); if (dc) dc.checked = false;
    const dd = document.getElementById('tiktokDisableDuet'); if (dd) dd.checked = true;
    const ds = document.getElementById('tiktokDisableStitch'); if (ds) ds.checked = false;
    const bc = document.getElementById('tiktokBrandedContent'); if (bc) bc.checked = false;
    const ap = document.getElementById('tiktokAllowPromotion'); if (ap) ap.checked = true;
    if (platformEl) platformEl.value = '';
    if (ttSection) ttSection.style.display = 'block';

    modal.classList.add('show');
    this._lockBodyScroll();
    this.navigate('clips');
  }

  setupPreviewModal() {
    const modal = document.getElementById('previewModal');
    const closeBtn = document.getElementById('previewModalClose');
    const video = document.getElementById('previewVideo');
    if (!modal) return;
    const closeModal = () => {
      if (!modal.classList.contains('show')) return; // already closed: don't release someone else's scroll lock
      modal.classList.remove('show'); video?.pause(); this._unlockBodyScroll();
    };
    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }


  async _resumeInterruptedUploads() {
    try {
      const pending = (await db.getAll(STORES.UPLOADS)).filter((u) => u.status === 'processing' && u.cloudJobId);
      if (pending.length === 1) notify.info(`Picking up where you left off with "${pending[0].title || pending[0].name || 'your video'}"...`);
      else if (pending.length > 1) notify.info(`Picking up ${pending.length} videos that were still processing...`);

      const outcomes = await clipGenerator.resumeInterruptedUploads();
      for (const o of outcomes) {
        const name = o.upload?.title || o.upload?.name || 'your video';
        if (o.error) {
          if (o.error.message !== 'offline') notify.error(`Couldn't finish processing "${name}". Please try uploading it again.`);
          continue;
        }
        const n = o.clips.length;
        notify.success(`Finished processing "${name}" — ${n} clip${n === 1 ? '' : 's'} ready!`);
      }
      if (outcomes.some((o) => !o.error)) clipsUI.refresh?.();
      try { await processingStatus.reload(); } catch {}
    } catch (e) {
      console.error('[App] Resuming interrupted uploads failed:', e);
    }
  }

  // Nothing in this app reloads the page by itself. When the browser does it (typically Chrome's Memory
  // Saver unloading a background tab and reloading it when you come back), say so: otherwise a sudden
  // refresh looks like the work was lost, when the server never stopped.
  _noteTabReload() {
    try {
      if (document.wasDiscarded) {
        console.info('[App] Chrome unloaded this tab to save memory and reloaded it.');
        notify.info('Chrome unloaded this tab to save memory, so the page reloaded. Your video keeps processing on the server. To stop this, add localhost:3000 under Chrome Settings > Performance > "Always keep these sites active".', 14000);
      }
    } catch {}
  }

  async refreshAccountStatuses() {
    const platforms = [
      { name: 'TikTok', key: 'tiktok', settingKey: 'tiktok_user', statusEl: 'tiktok-status', handleEl: 'tiktok-handle', connectBtn: 'tiktok-connect', disconnectBtn: 'tiktok-disconnect' },
      { name: 'Instagram', key: 'instagram', settingKey: 'instagram_user', statusEl: 'ig-status', handleEl: 'ig-handle', connectBtn: 'ig-connect', disconnectBtn: 'ig-disconnect' },
      { name: 'YouTube', key: 'youtube', settingKey: 'youtube_channel', statusEl: 'yt-status', handleEl: 'yt-handle', connectBtn: 'yt-connect', disconnectBtn: 'yt-disconnect' },
    ];

    for (const p of platforms) {
      const connected = await authStore.isConnected(p.key);
      const statusEl = document.getElementById(p.statusEl);
      const handleEl = document.getElementById(p.handleEl);
      const connectBtn = document.getElementById(p.connectBtn);
      const disconnectBtn = document.getElementById(p.disconnectBtn);

      if (statusEl) {
        statusEl.className = connected ? 'conn-status conn-ok' : 'conn-status conn-no';
        statusEl.textContent = connected ? 'Connected' : 'Not connected';
      }

      if (handleEl && connected) {
        try {
          if (p.key === 'tiktok') {
            await tiktokAPI.fetchUserInfo();
          }
        } catch {}
        const raw = await db.getSetting(p.settingKey);
        try {
          const info = JSON.parse(raw || '{}');
          let text = '';
          if (p.key === 'tiktok' || p.key === 'instagram') {
            if (info.username) text = `@${info.username}`;
            else if (info.display_name) text = info.display_name;
          }
          if (!text) {
            const base = info.username || info.display_name || info.snippet?.title || info.name || '';
            if (p.key === 'tiktok' && !base) {
              try { const tok = await authStore.getToken('tiktok'); if (tok?.open_id) text = `@${tok.open_id}`; } catch {}
            }
            if (!text) text = base || 'Connected';
          }
          handleEl.textContent = text;
        } catch { handleEl.textContent = 'Connected'; }
      } else if (handleEl) {
        handleEl.textContent = 'Not connected';
      }

      if (connectBtn) connectBtn.style.display = connected ? 'none' : '';
      if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
    }
  }

  async connectPlatform(platform) {
    if (this._connecting) return;
    this._connecting = true;
    const idMap = { TikTok: 'tiktok-connect', Instagram: 'ig-connect', YouTube: 'yt-connect' };
    const btn = document.getElementById(idMap[platform]);
    const prevText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try {
      notify.info(`Connecting to ${platform}...`);
      if (platform === 'TikTok') await tiktokAPI.connect();
      else if (platform === 'Instagram') await instagramAPI.connect();
      else if (platform === 'YouTube') await youtubeAPI.connect();
      await this.refreshAccountStatuses();
      await this._updateDashPlatformStatus();
      // Show connected identity for reassurance
      let handle = null;
      if (platform === 'TikTok') {
        try { const raw = await db.getSetting('tiktok_user'); const u = JSON.parse(raw||'{}'); if (u.username) handle = '@'+u.username; else if (u.display_name) handle = u.display_name; } catch {}
      } else if (platform === 'Instagram') {
        try { const raw = await db.getSetting('instagram_user'); const u = JSON.parse(raw||'{}'); if (u.username) handle = '@'+u.username; else if (u.name) handle = u.name; } catch {}
      } else if (platform === 'YouTube') {
        try { const raw = await db.getSetting('youtube_channel'); const ch = JSON.parse(raw||'{}'); handle = ch?.snippet?.title || null; } catch {}
      }
      if (handle) notify.success(`${platform} connected as ${handle}`); else notify.success(`${platform} connected!`);
    } catch (err) {
      // Only ever show the person our own pre-written, actionable messages verbatim — never
      // a raw error string, which could be anything from a network hiccup to a stack trace.
      const detail = err?.message || '';
      const isKnownFriendlyMessage = /isn't set up on this site yet|Couldn't reach the server/i.test(detail);
      notify.error(isKnownFriendlyMessage ? detail : `Couldn't connect to ${platform} right now. Please try again in a moment.`);
      console.error(`[Auth] ${platform} connect error:`, err);
    } finally {
      this._connecting = false;
      if (btn) { btn.disabled = false; btn.textContent = prevText; }
    }
  }

  async scheduleFromForm() {
    if (this._schedulingForm) return; // guard double clicks
    this._schedulingForm = true;
    const clipId = parseInt(document.getElementById('schedClipSelect')?.value);
    const platform = document.getElementById('schedPlatformSelect')?.value;
    const caption = document.getElementById('schedCaption')?.value || '';
    const scheduledAt = document.getElementById('schedTime')?.value;

    if (!clipId || isNaN(clipId)) { notify.warn('Select a clip first'); return; }
    if (!platform) { notify.warn('Select a platform'); return; }
    if (!scheduledAt) { notify.warn('Set a schedule time'); return; }
    if (new Date(scheduledAt) <= new Date()) { notify.warn('Schedule time must be in the future'); return; }

    const clips = await db.getAll(STORES.CLIPS);
    const clip = clips.find(c => c.id === clipId);
    if (!clip) { notify.error('Clip not found'); return; }

    const privacy = document.getElementById('schedPrivacy')?.value || 'PUBLIC_TO_EVERYONE';
    const disableComment = !!document.getElementById('schedDisableComment')?.checked;
    const disableDuet = !!document.getElementById('schedDisableDuet')?.checked;
    const disableStitch = !!document.getElementById('schedDisableStitch')?.checked;
    const brandedContent = !!document.getElementById('schedBrandedContent')?.checked;
    const allowPromotion = !!document.getElementById('schedAllowPromotion')?.checked;
    const postOptions = {
      privacy,
      allowComments: !disableComment,
      allowDuet: !disableDuet,
      allowStitch: !disableStitch,
      brandedContent,
      allowPromotion,
    };

    try {
      if (platform === 'All') {
        const candidates = [
          { name: 'TikTok', key: 'tiktok' },
          { name: 'Instagram', key: 'instagram' },
          { name: 'YouTube', key: 'youtube' },
        ];
        const targets = [];
        for (const p of candidates) {
          if (await authStore.isConnected(p.key)) targets.push(p.name);
        }
        if (targets.length === 0) { notify.warn('No connected platforms. Connect accounts in the Accounts tab.'); return; }
        for (const name of targets) {
          await jobQueue.add({ clipId, blobId: clip.blobId, platform: name, caption, scheduledAt, options: { ...postOptions } });
        }
        notify.success(`Scheduled on ${targets.join(', ')} for ${new Date(scheduledAt).toLocaleString()}`);
      } else {
        const connected = await authStore.isConnected(platform.toLowerCase());
        if (!connected) { notify.warn(`${platform} is not connected — go to Accounts to connect`); return; }
        await jobQueue.add({ clipId, blobId: clip.blobId, platform, caption, scheduledAt, options: { ...postOptions } });
        notify.success(`Scheduled on ${platform} for ${new Date(scheduledAt).toLocaleString()}`);
      }
      document.getElementById('schedClipSelect').value = '';
      document.getElementById('schedPlatformSelect').value = '';
      document.getElementById('schedCaption').value = '';
      document.getElementById('schedPrivacy').value = 'PUBLIC_TO_EVERYONE';
      const sdc = document.getElementById('schedDisableComment'); if (sdc) sdc.checked = false;
      const sdd = document.getElementById('schedDisableDuet'); if (sdd) sdd.checked = true;
      const sds = document.getElementById('schedDisableStitch'); if (sds) sds.checked = false;
      const sbc = document.getElementById('schedBrandedContent'); if (sbc) sbc.checked = false;
      const sap = document.getElementById('schedAllowPromotion'); if (sap) sap.checked = true;
      const stt = document.getElementById('schedTikTokSection'); if (stt) stt.style.display = 'block';
      await this._updateQueueBadge();
    } catch (err) {
      if (/already scheduled/i.test(err?.message || '')) notify.warn('Already scheduled for that time');
      else notify.error('Schedule failed. Please try again.');
    } finally {
      this._schedulingForm = false;
    }
  }

  async refreshSchedulerView() {
    await dashboard.buildCalendar();
    const calGrid2 = document.getElementById('calGrid2');
    const calGrid = document.getElementById('calGrid');
    if (calGrid2 && calGrid) calGrid2.innerHTML = calGrid.innerHTML;

    const platEl = document.getElementById('schedPlatformSelect');
    const ttSection = document.getElementById('schedTikTokSection');
    if (platEl && ttSection && !platEl.dataset.ttBound) {
      platEl.dataset.ttBound = '1';
      const updateVis = () => {
        const v = platEl.value;
        ttSection.style.display = (v === '' || v === 'TikTok' || v === 'All') ? 'block' : 'none';
      };
      platEl.addEventListener('change', updateVis);
      updateVis();
    }

    const select = document.getElementById('schedClipSelect');
    if (!select) return;
    const clips = await db.getAll(STORES.CLIPS);
    const byPart = [...clips].sort((a, b) => {
      const ap = (a.partNumber != null) ? a.partNumber : Infinity;
      const bp = (b.partNumber != null) ? b.partNumber : Infinity;
      if (a.uploadId === b.uploadId && ap !== bp) return ap - bp;
      if (ap !== bp) return ap - bp;
      return b.score - a.score;
    });
    const hasParts = byPart.some(c => c.partNumber != null);
    const ordered = hasParts ? byPart : [...clips].sort((a, b) => b.score - a.score);
    select.innerHTML = '<option value="">— Choose a clip —</option>' +
      ordered.map(c => `<option value="${c.id}">${c.title || 'Clip #' + c.id}</option>`)
             .join('');

    const now = new Date(Date.now() + 3600000);
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const timeEl = document.getElementById('schedTime');
    if (timeEl && !timeEl.value) timeEl.value = local;
  }

  async refreshAnalytics() {
    const [clips, posts] = await Promise.all([
      db.getAll(STORES.CLIPS),
      db.getAll(STORES.SCHEDULED_POSTS),
    ]);

    const posted  = posts.filter(p => p.status === 'posted');
    const pending = posts.filter(p => p.status === 'scheduled');
    const failed  = posts.filter(p => p.status === 'failed');

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('anaClips', clips.length);
    set('anaPosted', posted.length);
    set('anaPending', pending.length);
    set('anaFailed', failed.length);

    const platformCounts = {};
    for (const p of posted) {
      platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
    }
    const total = posted.length || 1;
    const colors = { TikTok: 'var(--tiktok)', Instagram: 'var(--insta)', YouTube: 'var(--youtube)' };
    const pb = document.getElementById('platformBars');
    if (pb) {
      if (posted.length === 0) {
        pb.innerHTML = '<div style="color:var(--muted);font-size:13px">No posts yet</div>';
      } else {
        pb.innerHTML = Object.entries(platformCounts).map(([p, c]) => `
          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
              <span style="color:${colors[p] || 'var(--accent)'};font-weight:600">${p}</span>
              <span style="color:var(--muted)">${c} posts · ${Math.round(c/total*100)}%</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${Math.round(c/total*100)}%;background:${colors[p] || 'var(--accent)'}"></div></div>
          </div>`).join('');
      }
    }

    const now = Date.now();
    const buckets = 14;
    const bucketMs = 86400000;
    const bucketCounts = new Array(buckets).fill(0);
    for (const p of [...posted, ...failed]) {
      const age = Math.floor((now - new Date(p.scheduledAt).getTime()) / bucketMs);
      if (age >= 0 && age < buckets) bucketCounts[buckets - 1 - age]++;
    }
    const maxB = Math.max(...bucketCounts, 1);
    const chart = document.getElementById('analyticsChart');
    if (chart) {
      chart.innerHTML = bucketCounts.map((v, i) => {
        const isLast = i === buckets - 1;
        return `<div style="flex:1;min-width:0;border-radius:3px 3px 0 0;background:${isLast ? 'var(--accent)' : 'rgba(124,92,252,0.25)'};height:${Math.max(4, Math.round(v/maxB*100))}%;transition:background .15s;cursor:pointer;" title="${v} posts" onmouseover="this.style.background='var(--accent)'" onmouseout="this.style.background='${isLast ? 'var(--accent)' : 'rgba(124,92,252,0.25)'}'"></div>`;
      }).join('');
    }

    const histEl = document.getElementById('postedHistory');
    if (histEl) {
      if (posted.length === 0) {
        histEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">No published posts yet</div>';
      } else {
        const recent = [...posted].sort((a, b) => new Date(b.postedAt || b.scheduledAt) - new Date(a.postedAt || a.scheduledAt)).slice(0, 10);
        histEl.innerHTML = `<table class="data-table"><thead><tr><th>Clip</th><th>Platform</th><th>Posted At</th><th>Result</th></tr></thead><tbody>${
          recent.map(p => {
            let link = '';
            let label = '✓ Posted';
            try {
              const r = JSON.parse(p.result||'{}');
              if (p.platform === 'TikTok' && r.status === 'SEND_TO_USER_INBOX') label = 'Inbox Review';
              if (r.url) link = ` <a href="${r.url}" target="_blank" rel="noopener" title="Open" style="color:var(--muted)">↗</a>`;
            } catch {}
            return `<tr>
              <td>Clip #${p.clipId}</td>
              <td style="color:${colors[p.platform]||'var(--accent)'};font-weight:600">${p.platform}</td>
              <td style="color:var(--muted);font-size:12px">${new Date(p.postedAt || p.scheduledAt).toLocaleString()}</td>
              <td><span class="badge badge-posted">${label}</span>${link}</td>
            </tr>`;
          }).join('')
        }</tbody></table>`;
      }
    }

    // Best-effort platform insights
    await this._refreshPlatformInsights();
  }

  async clearData() {
    await Promise.all([
      db.getAll(STORES.CLIPS).then(items => Promise.all(items.map(i => db.delete(STORES.CLIPS, i.id)))),
      db.getAll(STORES.SCHEDULED_POSTS).then(items => Promise.all(items.map(i => db.delete(STORES.SCHEDULED_POSTS, i.id)))),
      db.getAll(STORES.POSTED_HISTORY).then(items => Promise.all(items.map(i => db.delete(STORES.POSTED_HISTORY, i.id)))),
      db.getAll(STORES.VIDEO_BLOBS).then(items => Promise.all(items.map(i => db.delete(STORES.VIDEO_BLOBS, i.id)))),
      db.getAll(STORES.UPLOADS).then(items => Promise.all(items.map(i => db.delete(STORES.UPLOADS, i.id)))),
    ]);
    await videoStore.clearSources();
    await persistence.clearBackup(); // otherwise the server would put everything back on the next start
    notify.success('All data cleared');
    await dashboard.refresh();
    clipsUI.clips = [];
    clipsUI.renderGrid();
    queueUI.jobs = [];
    queueUI.render();
  }

  async confirmClearData() {
    const ok = await confirmAction({
      title: 'Clear all data?',
      message: 'This will permanently delete all clips, uploads, and scheduled posts, including the backup copy on the server.',
      confirmText: 'Yes, clear',
      cancelText: 'No',
      intent: 'danger',
    });
    if (!ok) return;
    await this.clearData();
  }

  _startQueueBadgeUpdater() {
    const update = async () => {
      const count = await jobQueue.getUpcomingCount();
      const badge = document.getElementById('queueBadge');
      if (badge) badge.textContent = count > 0 ? count : '0';
    };
    update();
    setInterval(update, 60000);
  }

  async _updateQueueBadge() {
    const count = await jobQueue.getUpcomingCount();
    const badge = document.getElementById('queueBadge');
    if (badge) badge.textContent = count;
  }

  async disconnectPlatform(platform) {
    const ok = await confirmAction({
      title: `Disconnect ${platform}?`,
      message: `You are about to disconnect ${platform}. You can reconnect later from Accounts.`,
      confirmText: 'Yes, disconnect',
      cancelText: 'No',
      intent: 'danger',
    });
    if (!ok) return;
    if (platform === 'TikTok') await tiktokAPI.disconnect();
    else if (platform === 'Instagram') await instagramAPI.disconnect();
    else if (platform === 'YouTube') await youtubeAPI.disconnect();
    notify.info(`${platform} disconnected`);
    await this.refreshAccountStatuses();
    this._updateDashPlatformStatus();
  }

  async _updateDashPlatformStatus() {
    const pairs = [
      ['tiktok', 'tiktok-status-dash'],
      ['instagram', 'ig-status-dash'],
      ['youtube', 'yt-status-dash'],
    ];
    for (const [key, elId] of pairs) {
      const el = document.getElementById(elId);
      if (!el) continue;
      const connected = await authStore.isConnected(key);
      el.className = connected ? 'conn-status conn-ok' : 'conn-status conn-no';
      el.textContent = connected ? 'Connected' : 'Not connected';
    }
  }
}

const app = new ClipperIQApp();
app.init().catch(err => {
  console.error('[ClipperIQ] Init failed:', err);
  showStartupFailure(err, { db, notify }); // says what went wrong and what to do about it (the reason used to be hidden)
});

window.app = app;
export default app;
