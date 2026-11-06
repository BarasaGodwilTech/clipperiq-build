// Shows what is going on with videos that are being processed, even after the page was reloaded.
//
// Rendering happens on the server, so a reload never stops the work - but the page used to forget about
// it. This module rebuilds the picture from two sources:
//   - the uploads saved in this browser (status "processing"), so something is shown immediately after a reload
//   - live "clip:job-progress" events broadcast by clipGenerator while it watches the server job
// and uses them to drive (1) the "Processing in background" badge, (2) the live % on the Recent Uploads
// rows, and (3) the details window that opens when a Recent Uploads row is clicked.
import { db, STORES } from '../storage/db.js';
import { getBackendBaseUrl } from '../core/config.js';
import { dashboard } from './dashboard.js';
import { clipGenerator } from '../core/clipGenerator.js';
import { notify, confirmAction } from './notifications.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

function timeAgo(dateStr) {
  const m = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (!Number.isFinite(m) || m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const sameId = (a, b) => String(a) === String(b);

export const processingStatus = {
  _inited: false,
  _live: new Map(),      // uploadId -> latest progress event detail
  _server: new Map(),    // uploadId -> one-off job status fetched when the details window opened
  _active: [],           // uploads currently "processing"
  _openId: null,         // upload shown in the details window
  _renderTimer: null,
  _timing: new Map(),    // uploadId -> { t0, readySeen } for the time estimate
  _baseTitle: '',
  _notified: new Set(),
  _retrying: new Set(),   // uploads being retried by this tab right now
  _lastAuto: new Map(),   // uploadId -> when it was last picked up automatically

  async init() {
    if (this._inited) return;
    this._inited = true;
    this._t0 = Date.now();
    this._baseTitle = document.title || 'ClipperIQ Studio';

    window.addEventListener('clip:job-progress', (e) => this._onProgress(e.detail || {}));
    window.addEventListener('clip:saved', () => this._renderSoon());

    // Keep the badge in step with the other processing window, and visible on every screen.
    const badge = this._badgeEl();
    if (badge) {
      if (badge.parentElement !== document.body) document.body.appendChild(badge);
      badge.onclick = () => this.openActive();
    }
    try {
      const mo = new MutationObserver(() => this.refreshBadge());
      const procModal = document.getElementById('procModal');
      if (procModal) mo.observe(procModal, { attributes: true, attributeFilter: ['class'] });
    } catch {}

    setInterval(() => { if (!document.hidden) this.reload(); }, 4000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.reload(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeDetails(); });

    await this.reload();
  },

  // ── data ────────────────────────────────────────────────────────────────────────────
  async reload() {
    let uploads = [];
    try { uploads = await db.getAll(STORES.UPLOADS); } catch { return; }
    const prev = this._active.map((u) => String(u.id)).sort().join(',');
    this._active = (uploads || []).filter((u) => u.status === 'processing');
    const now = this._active.map((u) => String(u.id)).sort().join(',');
    for (const id of [...this._live.keys()]) {
      if (!this._active.some((u) => sameId(u.id, id))) this._live.delete(id);
    }
    // A video started or finished processing: refresh the Recent Uploads list and the stats.
    if (prev !== now) { try { await dashboard.refresh(); } catch {} }
    this.updateRows();
    this.refreshBadge();
    if (this._openId != null) this._renderDetails();
    this._autoResume();
  },

  /**
   * An upload that is "processing" on the server but that nothing in this tab is following (the server was switched off
   * for a while, the first reconnect failed, ...) is picked up again by itself every so often: as soon as the server is
   * back, it carries on and the finished clips are saved. Never forces anything: that is the person's call (Force resume).
   */
  _autoResume() {
    if (Date.now() - (this._t0 || 0) < 8000) return; // right after the page opens, the startup resume goes first
    for (const u of this._active) {
      const id = String(u.id);
      if (!u.cloudJobId || clipGenerator.isWatching(id) || this._retrying.has(id)) continue;
      if (Date.now() - (Number(u.cloudJobStartedAt) || 0) < 60000) continue; // just started by this very tab: it is being followed
      if (Date.now() - (this._lastAuto.get(id) || 0) < 20000) continue;
      this._lastAuto.set(id, Date.now());
      this.retry(u.id, { auto: true });
    }
  },

  /** Puts everything needed to understand a failure on the clipboard (what it was, which job, the technical details, recent errors). */
  async copyError(id) {
    const { copyText, diagnostics } = await import('../core/errors.js');
    const u = this._uploads ? this._uploads.get(String(id)) : null;
    const rec = u || (await db.get(STORES.UPLOADS, id).catch(() => null)) || {};
    const lines = [`Upload: ${rec.name || id} (${rec.size ? Math.round(rec.size / 1e6) : '?'} MB)`, `Status: ${rec.status}`, `Server job: ${rec.cloudJobId || 'none'}`, `Problem: ${rec.error || ''}`, `Technical details: ${rec.errorDetail || '(none)'}`];
    const ok = await copyText(diagnostics.text(lines.join('\n')));
    notify[ok ? 'success' : 'warn'](ok ? 'Copied. Paste it into your message.' : 'Could not copy automatically.');
  },

  /** Stops an upload after the person confirms (the finished clips are kept). */
  async stop(id) {
    const ok = await confirmAction({
      title: 'Stop processing this video?',
      message: 'The server stops working on it. Clips that are already finished are kept, and you can resume later.',
      confirmText: 'Yes, stop', cancelText: 'No, keep going', intent: 'danger',
    });
    if (!ok) return;
    try { await clipGenerator.cancelUpload(id); notify.info('Stopped. Clips that were already finished are kept.'); } catch (e) { notify.error(`Could not stop it: ${String((e && e.message) || e).slice(0, 160)}`); }
    await this.reload();
    if (this._openId != null) this._renderDetails();
    try { await dashboard.refresh(); } catch { /* shown in place */ }
  },

  /** Starts a failed or stalled upload again. The server keeps every clip that already finished. */
  async retry(id, { force = false, auto = false } = {}) {
    const key = String(id);
    if (this._retrying.has(key)) return;
    this._retrying.add(key);
    this._renderSoon();
    try {
      if (!auto) notify.info(force ? 'Forcing the job to continue…' : 'Retrying — clips that already finished are kept.');
      await clipGenerator.retryUpload(id, { force });
      if (!auto) notify.success('Done. Your clips are in the library.');
      try { await dashboard.refresh(); } catch {}
    } catch (e) {
      if (!auto || !(e && e.network)) {
        const msg = String((e && e.message) || e || '').slice(0, 200);
        if (!auto) notify.error(msg ? `Could not continue: ${msg}` : 'Could not continue.');
      }
    } finally {
      this._retrying.delete(key);
      await this.reload();
      if (this._openId != null) this._renderDetails();
    }
  },

  _onProgress(d) {
    if (d.uploadId == null) return;
    const key = String(d.uploadId);
    // Remember when we started watching and how many parts the server had finished, for the time estimate.
    const tm = this._timing.get(key) || { t0: Date.now(), firstReadyAt: null, firstReady: 0 };
    if (!this._timing.has(key)) this._timing.set(key, tm);
    if (tm.firstReadyAt == null && Number(d.ready) > 0) { tm.firstReadyAt = Date.now(); tm.firstReady = Number(d.ready); }
    // Tell the person when it finishes (or stops) if they are on another tab.
    if (d.status === 'done' && !this._notified.has(key)) { this._notified.add(key); this._desktopNotify('Your clips are ready', `${d.saved || d.total || ''} clip${(d.saved || d.total) === 1 ? '' : 's'} finished processing.`); }
    if (d.status === 'error' && !d.network && !this._notified.has(`${key}:err`)) { this._notified.add(`${key}:err`); this._desktopNotify('Processing stopped', d.error || 'Open ClipperIQ to see what happened.'); }
    this._live.set(String(d.uploadId), d);
    this.updateRows();
    this.refreshBadge();
    if (this._openId != null && sameId(this._openId, d.uploadId)) this._renderSoon();
    if (d.status === 'done') setTimeout(() => this.reload(), 900);
  },

  _pct(u) {
    const lv = this._live.get(String(u.id)) || this._server.get(String(u.id));
    if (!lv) return null;
    const total = Number(lv.total) || 0;
    const byClips = total ? ((Number(lv.saved) || 0) / total) * 100 : 0;
    const pct = Math.max(byClips, Number(lv.serverPct) || 0);
    return Math.max(0, Math.min(lv.status === 'done' ? 100 : 99, Math.round(pct)));
  },

  _stageText(u) {
    const lv = this._live.get(String(u.id));
    const sv = this._server.get(String(u.id));
    if (!u.cloudJobId) {
      if (window.uploadUI?.isProcessing) return 'Uploading and preparing the video…';
      return 'Waiting for the upload to finish. If this page was reloaded during the upload, it has to be started again.';
    }
    if (lv && lv.status === 'reconnecting') return 'Can\'t reach the server right now. Waiting for it to come back…';
    if (lv && lv.status === 'error') return lv.network
      ? 'The server isn\'t reachable. Start it again (start.bat). This continues by itself once it is back.'
      : `Stopped: ${lv.error || 'unknown error'}. Press Retry below.`;
    if (this._retrying.has(String(u.id))) return 'Picking the job up again…';
    const s = lv || sv;
    if (!s) return 'Checking on the server…';
    const total = Number(s.total) || 0;
    const ready = Number(s.ready) || 0;
    if (s.status === 'queued') return 'Waiting for the server to start';
    if (s.status === 'done') return 'Finished on the server. Saving the last clips…';
    if (total) return ready >= total ? 'All parts rendered. Saving them to your library…' : `Rendering part ${Math.min(ready + 1, total)} of ${total}`;
    return 'Analysing the video…';
  },

  // ── badge + dashboard rows ──────────────────────────────────────────────────────────
  _badgeEl() { return document.getElementById('bgProcBadge'); },

  /** Asks (once, from a click) to show a desktop notification when clips are ready. Never blocks anything. */
  requestNotifyPermission() {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch {}
  },

  _desktopNotify(title, body) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
      const n = new Notification(title, { body, tag: 'clipperiq-processing' });
      n.onclick = () => { try { window.focus(); } catch {} n.close(); };
    } catch {}
  },

  /** "(40%) ClipperIQ Studio" in the tab while something is processing, so progress is visible from other tabs. */
  _syncTitle() {
    if (!this._baseTitle) return;
    if (!this._active.length) { if (document.title !== this._baseTitle) document.title = this._baseTitle; return; }
    const p = this._active.length === 1 ? this._pct(this._active[0]) : null;
    document.title = `${p == null ? '⏳' : `(${p}%)`} ${this._baseTitle}`;
  },

  /** "About 6m left" from how long the server took for the parts it has finished so far. */
  _etaText(u) {
    const key = String(u.id);
    const tm = this._timing.get(key);
    const lv = this._live.get(key) || this._server.get(key) || {};
    const total = Number(lv.total) || 0; const ready = Number(lv.ready) || 0;
    if (!tm || !total) return '';
    const elapsed = Math.round((Date.now() - tm.t0) / 1000);
    const fmt = (sec) => { const m = Math.floor(sec / 60); const r = sec % 60; return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`; };
    let left = '';
    const doneSince = ready - tm.firstReady;
    if (tm.firstReadyAt && doneSince >= 1 && ready < total) {
      const perPart = (Date.now() - tm.firstReadyAt) / 1000 / doneSince;
      left = `<span>About <b>${fmt(Math.max(1, Math.round(perPart * (total - ready))))}</b> left</span>`;
    } else if (ready < total) left = '<span>Estimating time left…</span>';
    return `<div class="proc-eta"><span>Watching for <b>${fmt(elapsed)}</b></span>${left}</div>`;
  },

  refreshBadge() {
    this._syncTitle();
    const b = this._badgeEl();
    if (!b) return;
    const procOpen = document.getElementById('procModal')?.classList.contains('show');
    const detailOpen = document.getElementById('uploadDetailModal')?.classList.contains('show');
    if (!this._active.length || procOpen || detailOpen) { b.style.display = 'none'; return; }
    if (this._active.length === 1) {
      const p = this._pct(this._active[0]);
      b.textContent = p == null ? '⏳ Processing in background — View' : `⏳ Processing ${p}% — View`;
    } else {
      b.textContent = `⏳ ${this._active.length} videos processing — View`;
    }
    b.style.display = 'inline-flex';
  },

  updateRows() {
    for (const u of this._active) {
      const el = document.querySelector(`[data-proc-badge="${CSS.escape(String(u.id))}"]`);
      if (!el) continue;
      const p = this._pct(u);
      el.textContent = p == null ? '⚙ Processing' : `⚙ Processing ${p}%`;
    }
  },

  openActive() {
    if (window.uploadUI?.isProcessing && document.getElementById('procModal')) { window.uploadUI.reopenModal(); return; }
    const u = this._active[0];
    if (u) this.openUpload(u.id);
  },

  // ── details window ──────────────────────────────────────────────────────────────────
  _ensureModal() {
    let m = document.getElementById('uploadDetailModal');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'overlay-modal';
    m.id = 'uploadDetailModal';
    m.innerHTML = `
      <div class="modal-box" style="max-width:560px" role="dialog" aria-modal="true" aria-labelledby="udTitle">
        <div class="modal-header">
          <span class="modal-title" id="udTitle">Upload details</span>
          <button class="modal-close" id="udClose" aria-label="Close">✕</button>
        </div>
        <div id="udBody"></div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m) this.closeDetails(); });
    m.querySelector('#udClose').addEventListener('click', () => this.closeDetails());
    return m;
  },

  async openUpload(id) {
    if (id == null || id === '') return;
    this._openId = id;
    const m = this._ensureModal();
    m.classList.add('show');
    window.app?._lockBodyScroll?.();
    this.refreshBadge();
    await this._renderDetails();
    // Ask the server directly too, so the window is right even before the first progress event.
    try {
      const upload = await this._getUpload(id);
      if (upload && upload.status === 'processing' && upload.cloudJobId) {
        const base = (await getBackendBaseUrl()) || '';
        if (base) {
          const r = await fetch(`${base.replace(/\/+$/, '')}/api/cloud/jobs/${encodeURIComponent(upload.cloudJobId)}`, { cache: 'no-store' });
          if (r.ok) {
            const j = await r.json();
            const clips = Array.isArray(j.clips) ? j.clips : [];
            this._server.set(String(upload.id), { status: j.status, serverPct: Number(j.progress) || 0, total: Number(j.total) || 0, ready: clips.length, saved: 0, error: j.error });
          }
        }
      }
    } catch { /* offline: the window still shows what this browser knows */ }
    this._renderDetails();
    clearInterval(this._renderTimer);
    this._renderTimer = setInterval(() => this._renderDetails(), 3000);
  },

  closeDetails() {
    const m = document.getElementById('uploadDetailModal');
    if (!m || !m.classList.contains('show')) return;
    m.classList.remove('show');
    window.app?._unlockBodyScroll?.();
    clearInterval(this._renderTimer);
    this._renderTimer = null;
    this._openId = null;
    this.refreshBadge();
  },

  async _getUpload(id) {
    const all = await db.getAll(STORES.UPLOADS);
    return (all || []).find((u) => sameId(u.id, id)) || null;
  },

  _renderSoon() {
    if (this._openId == null || this._pending) return;
    this._pending = setTimeout(() => { this._pending = null; this._renderDetails(); }, 400);
  },

  async _renderDetails() {
    if (this._openId == null) return;
    const body = document.getElementById('udBody');
    if (!body) return;
    const u = await this._getUpload(this._openId);
    if (!u) { body.innerHTML = '<div style="color:var(--muted);padding:12px 0">This upload is no longer in your library.</div>'; return; }
    let clips = [];
    try { clips = ((await db.getAll(STORES.CLIPS)) || []).filter((c) => sameId(c.uploadId, u.id)); } catch {}
    clips.sort((a, b) => (a.partNumber ?? 1e9) - (b.partNumber ?? 1e9) || String(a.createdAt).localeCompare(String(b.createdAt)));

    const title = u.title || u.name || 'Video';
    document.getElementById('udTitle').textContent = 'Upload details';
    const badges = {
      uploaded: '<span class="badge badge-draft">Uploaded</span>',
      processing: '<span class="badge badge-processing">⚙ Processing</span>',
      done: '<span class="badge badge-scheduled">✓ Ready</span>',
      failed: '<span class="badge badge-failed">✕ Failed</span>',
      cancelled: '<span class="badge badge-draft">Stopped</span>',
    };
    const meta = [u.name && u.name !== title ? esc(u.name) : null, formatBytes(u.size), u.createdAt ? `uploaded ${timeAgo(u.createdAt)}` : null].filter(Boolean).join(' · ');

    let progressHtml = '';
    if (u.status === 'processing') {
      const lv = this._live.get(String(u.id)) || this._server.get(String(u.id)) || {};
      const total = Number(lv.total) || 0;
      const ready = Number(lv.ready) || 0;
      const saved = Math.max(Number(lv.saved) || 0, clips.length);
      const pct = this._pct(u);
      const hasJob = !!u.cloudJobId;
      const stepRow = (label, state) => `<div class="proc-step-item${state === 'done' ? ' done' : state === 'active' ? ' active' : ''}">
        <svg class="step-icon" viewBox="0 0 18 18" fill="none">${state === 'done'
          ? '<polyline points="4 9 7.5 12.5 14 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
          : state === 'active'
            ? '<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9" r="3" fill="currentColor"/>'
            : '<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>'}</svg>${label}</div>`;
      const cutting = hasJob && !(total && ready >= total);
      progressHtml = `
        <div style="margin:16px 0 6px">
          <div class="progress-track"><div class="progress-fill" style="width:${pct == null ? 4 : pct}%"></div></div>
          <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:12px;color:var(--muted)">
            <span>${esc(this._stageText(u))}</span><span>${pct == null ? '' : pct + '%'}</span>
          </div>
          ${this._etaText(u)}
        </div>
        <div class="proc-steps-list" style="margin:6px 0 4px">
          ${stepRow('Uploaded to the server', hasJob ? 'done' : 'active')}
          ${stepRow('Video analysed and split into parts', hasJob ? 'done' : 'pending')}
          ${stepRow(`Rendering parts on the server${total ? ` (${Math.min(ready, total)} of ${total})` : ''}`, hasJob ? (cutting ? 'active' : 'done') : 'pending')}
          ${stepRow(`Saving parts to your library${total ? ` (${Math.min(saved, total)} of ${total})` : ''}`, hasJob && total && ready >= total ? 'active' : 'pending')}
        </div>
        <div style="font-size:12px;color:var(--dim);line-height:1.5;margin-top:10px">
          Processing keeps running on the server. You can close this window, switch tabs or reload the page,
          and this picks up where it left off.
        </div>
        <div style="margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="window.processingStatus?.stop(${JSON.stringify(u.id).replace(/"/g, '&quot;')})">Stop processing</button></div>
        ${hasJob ? `<details class="proc-stuck" style="margin-top:12px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">Not moving? Server was switched off?</summary>
          <div style="font-size:12px;color:var(--dim);line-height:1.5;margin:8px 0">
            If the server computer shut down or restarted, the job continues by itself when the server is back (clips that were finished are kept).
            If the progress has not moved for several minutes, you can make it start over from the clips that are done.
          </div>
          <button class="btn btn-ghost btn-sm" ${this._retrying.has(String(u.id)) ? 'disabled' : ''} onclick="window.processingStatus?.retry(${JSON.stringify(u.id).replace(/"/g, '&quot;')}, { force: true })">Force resume</button>
        </details>` : ''}`;
    } else if (u.status === 'failed') {
      const canRetry = !!(u.cloudJobId || u.processOptions);
      const busy = this._retrying.has(String(u.id));
      progressHtml = `<div style="margin:16px 0;padding:12px 14px;border-radius:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);color:var(--text);font-size:13px;line-height:1.5">
        ${esc(u.error || 'Processing did not finish.')}
        <div style="color:var(--muted);margin-top:6px">${canRetry
          ? 'Retry carries on from where it stopped: clips that already finished are kept and only the rest is made.'
          : 'This one can\'t be continued automatically. Upload the video again. Clips that finished before the problem are kept below.'}</div>
        ${canRetry ? `<div style="margin-top:10px"><button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.processingStatus?.retry(${JSON.stringify(u.id).replace(/"/g, '&quot;')})">${busy ? 'Retrying…' : 'Retry'}</button></div>` : ''}</div>
        <details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">Technical details</summary>
          <pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;background:var(--bg2);padding:8px;border-radius:8px;margin:6px 0 8px;max-height:140px;overflow:auto">${esc(u.errorDetail || u.error || '')}</pre>
          <button class="btn btn-ghost btn-sm" onclick="window.processingStatus?.copyError(${JSON.stringify(u.id).replace(/"/g, '&quot;')})">Copy error details</button></details>`;
    } else if (u.status === 'cancelled') {
      const canResume = !!(u.cloudJobId || u.processOptions);
      const busy = this._retrying.has(String(u.id));
      progressHtml = `<div style="margin:16px 0;padding:12px 14px;border-radius:10px;background:rgba(148,163,184,0.08);border:1px solid rgba(148,163,184,0.25);color:var(--text);font-size:13px;line-height:1.5">
        Stopped. Clips that were already finished are kept (below).
        <div style="color:var(--muted);margin-top:6px">${canResume ? 'Resume carries on from where it stopped: only the clips that are still missing are made.' : 'This one cannot be resumed. Upload the video again.'}</div>
        ${canResume ? `<div style="margin-top:10px"><button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.processingStatus?.retry(${JSON.stringify(u.id).replace(/"/g, '&quot;')})">${busy ? 'Resuming...' : 'Resume'}</button></div>` : ''}</div>`;
    } else if (u.status === 'done') {
      progressHtml = `<div style="margin:16px 0;font-size:13px;color:var(--muted)">Finished${u.clipCount != null ? ` · ${esc(u.clipCount)} clip${u.clipCount === 1 ? '' : 's'}` : ''}${u.updatedAt ? ` · ${timeAgo(u.updatedAt)}` : ''}</div>`;
    }

    const clipsHtml = clips.length
      ? `<div style="font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.4px;text-transform:uppercase;margin:16px 0 6px">Clips so far (${clips.length})</div>
         <div style="max-height:200px;overflow:auto;border:1px solid var(--border);border-radius:10px">
           ${clips.slice(0, 80).map((c) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px">
             <span>${esc(c.title || 'Clip')}</span><span style="color:var(--muted);white-space:nowrap">${Math.round(Number(c.duration) || 0)}s</span></div>`).join('')}
         </div>`
      : (u.status === 'processing' ? '<div style="font-size:12px;color:var(--dim);margin-top:14px">No clips saved yet. They appear here as each part is finished.</div>' : '');

    const html = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="min-width:0">
          <div style="font-weight:600;font-size:15px;word-break:break-word">${esc(title)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px;word-break:break-word">${meta}</div>
        </div>
        <div style="flex-shrink:0">${badges[u.status] || esc(u.status)}</div>
      </div>
      ${progressHtml}
      ${clipsHtml}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
        <button class="btn btn-ghost" onclick="window.processingStatus?.closeDetails()">Close</button>
        ${clips.length ? '<button class="btn btn-primary" onclick="window.processingStatus?.closeDetails();window.app?.navigate(\'clips\')">View clips</button>' : ''}
      </div>`;
    if (body.dataset.last !== html) { body.innerHTML = html; body.dataset.last = html; }
  },
};
