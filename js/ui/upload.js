import { videoStore } from '../storage/videoStore.js';
import { clipGenerator } from '../core/clipGenerator.js';
import { editorUI } from './editor.js';
import { notify, confirmAction } from './notifications.js';
import { db, STORES } from '../storage/db.js';
import { uploadPage } from './uploadPage.js';

function formatBytes(b) {
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

export const uploadUI = {
  currentFile: null,
  currentUploadId: null,
  isProcessing: false,
  _seriesIndex: null,
  _titleDebounce: null,

  init() {
    const zone = document.getElementById('uploadZone');
    const input = document.getElementById('fileInput');
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => {
      if (e.target.files[0]) this.handleFile(e.target.files[0]);
      try { e.target.value = ''; } catch {} // lets the same file be chosen again after a Change
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag');
      const file = e.dataTransfer.files[0];
      // Files from stream downloaders (.ts, .mkv, ...) often arrive with a blank MIME type, so the
      // extension counts too, otherwise they'd be refused here even though the picker accepts them.
      const looksLikeVideo = file && (String(file.type).startsWith('video/') || /\.(mp4|m4v|mov|mkv|webm|avi|ts|mts|m2ts|mpg|mpeg|wmv|flv|3gp)$/i.test(file.name || ''));
      if (looksLikeVideo) this.handleFile(file);
      else notify.error('Please drop a video file (MP4, MOV, MKV, WebM, TS)');
    });

    const processBtn = document.getElementById('processBtn');
    if (processBtn) processBtn.addEventListener('click', () => this.startProcessing());
    const speedSel = document.getElementById('speedProfile');
    if (speedSel) { try { const v = localStorage.getItem('cliq_speedProfile'); if (v && [...speedSel.options].some((o) => o.value === v)) speedSel.value = v; } catch {} }

    const titleEl = document.getElementById('uploadVideoTitle');
    if (titleEl) titleEl.addEventListener('input', () => {
      if (this._titleDebounce) clearTimeout(this._titleDebounce);
      this._titleDebounce = setTimeout(() => this._recalcNextPartFromTitle(), 200);
    });

    const contSel = document.getElementById('continueSeriesSelect');
    if (contSel) contSel.addEventListener('change', () => this._applyContinuationSelection());

    const seriesCb = document.getElementById('seriesMode');
    if (seriesCb) seriesCb.addEventListener('change', () => this._recalcNextPartFromTitle());

    this._buildSeriesIndex().catch(()=>{});
    try { uploadPage.init(); } catch (e) { console.warn('[Upload] page enhancements failed:', e); }
  },

  // Allow processing to continue while modal is hidden
  runInBackground() {
    const modal = document.getElementById('procModal');
    if (modal) modal.classList.remove('show');
    window.app?._unlockBodyScroll?.();
    const badge = document.getElementById('bgProcBadge');
    if (badge) badge.style.display = 'inline-flex';
  },

  async cancelOrClose() {
    // Cancel now really stops the work (it used to only hide this window). The person has to confirm first.
    const ok = await confirmAction({
      title: 'Stop processing this video?',
      message: 'This stops the work: nothing more is sent or made, and the server stops too. Clips that are already finished are kept, and you can resume later from Recent Uploads on the dashboard. If you only want this window out of the way, use "Run in background" instead.',
      confirmText: 'Yes, stop',
      cancelText: 'No, keep going',
      intent: 'danger',
    });
    if (!ok) return;
    const id = this._activeUploadId;
    if (id != null) { try { await clipGenerator.cancelUpload(id); } catch (e) { console.warn('[Upload] stop failed:', e); } }
    const modal = document.getElementById('procModal');
    if (modal) modal.classList.remove('show');
    window.app?._unlockBodyScroll?.();
    const badge = document.getElementById('bgProcBadge');
    if (badge) badge.style.display = 'none';
  },

  reopenModal() {
    const modal = document.getElementById('procModal');
    if (modal) modal.classList.add('show');
    window.app?._lockBodyScroll?.();
    const badge = document.getElementById('bgProcBadge');
    if (badge) badge.style.display = 'none';
  },

  handleFile(file) {
    this.currentFile = file;
    // The file card is filled with textContent (a file name can never inject markup); the drop zone itself stays intact.
    try { uploadPage.setFile(file); } catch (e) { console.warn('[Upload] file card failed:', e); }

    // Preview & Edit card: choose where to start, add overlays (never blocks the upload flow if it fails)
    try { editorUI.setFile(file); } catch (e) { console.warn('[Upload] editor preview failed:', e); }

    try { uploadPage.refresh(); } catch {}

    try {
      const base = String(file.name || '').replace(/\.[^.]+$/, '');
      const words = base.replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
      const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const titleEl = document.getElementById('uploadVideoTitle');
      if (titleEl) titleEl.value = title;
      this._recalcNextPartFromTitle();
    } catch {}
  },

  async startProcessing() {
    if (!this.currentFile) { notify.warn('Please select a video file first'); return; }
    if (this.isProcessing) return;

    const fairUse = document.getElementById('fairUseCheck');
    if (fairUse && !fairUse.checked) {
      notify.warn('Please confirm fair use compliance before processing');
      return;
    }

    this.isProcessing = true;
    try { uploadPage.refresh(); } catch {}
    this.showModal();
    const badge = document.getElementById('bgProcBadge');
    if (badge) badge.style.display = 'none';

    let cloudProcessing = false;
    try {
      cloudProcessing = document.getElementById('cloudProcessing')?.checked || false;
      this._cloudSteps = cloudProcessing;
      this.updateStepsList(this._stepNames(), 0);
      this.setModalStep(cloudProcessing ? 'Preparing cloud processing...' : 'Saving video to storage...', 2);

      // Cloud processing has no local recording canvas to show, so give it an equivalent
      // live preview instead: as each clip finishes rendering on the backend, show it here.
      // (Local/browser processing keeps its existing live recording preview, untouched.)
      if (cloudProcessing) {
        // Only show clips from THIS upload: a job left over from an earlier session can resume in
        // the background and save its own clips, which must not appear in this window.
        this._onClipSavedForPreview = (e) => {
          const c = e.detail;
          if (c && this._activeUploadId != null && c.uploadId === this._activeUploadId) this._showLivePreview(c);
        };
        this._onClipNotify = (e) => {
          const d = e.detail || {};
          if (d.type === 'error') notify.error(d.message); else if (d.type === 'info') (notify.info || notify.success || notify.warn).call(notify, d.message); else notify.warn(d.message, 14000);
        };
        window.addEventListener('clip:saved', this._onClipSavedForPreview);
        window.addEventListener('clip:notify', this._onClipNotify);
      }
      const upload = cloudProcessing
        ? await videoStore.saveUploadMetaOnly(this.currentFile)
        : await videoStore.saveUpload(this.currentFile);
      this._activeUploadId = upload.id;
      this.currentUploadId = upload.id;

      try {
        const titleEl = document.getElementById('uploadVideoTitle');
        const userTitle = (titleEl?.value || '').trim();
        if (userTitle) {
          const seriesKey = userTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          if (upload.title !== userTitle || upload.seriesKey !== seriesKey) {
            await videoStore.updateUploadMeta(upload.id, { title: userTitle, seriesKey });
          }
        }
      } catch {}

      if (cloudProcessing) this.setModalStep('Uploading to the ClipperIQ server...', 5);
      else this.setModalStep('Loading FFmpeg (first load may take 30s)...', 5);

      const targetDuration = parseInt(document.getElementById('clipDuration')?.value || '30');
      const maxClips = parseInt(document.getElementById('maxClips')?.value || '6');
      const reEncode = document.getElementById('outputFormat')?.value === 'reencode';
      const speedProfile = document.getElementById('speedProfile')?.value || 'balanced';
      try { localStorage.setItem('cliq_speedProfile', speedProfile); } catch {}
      const seriesMode = document.getElementById('seriesMode')?.checked || false;
      const seriesStartPart = parseInt(document.getElementById('seriesStartPart')?.value || '1');
      const endsSeries = document.getElementById('endsSeries') ? document.getElementById('endsSeries').checked : true;
      const overlayFormat = document.getElementById('overlayFormat')?.value || 'part-text';
      const aspectRatio = document.getElementById('aspectRatio')?.value || '9:16';
      // Optional audio mix (only applied when BGM provided)
      const bgmUrl = (document.getElementById('bgmUrl')?.value || '').trim();
      const bgmFileEl = document.getElementById('bgmFile');
      const bgmFile = bgmFileEl && bgmFileEl.files && bgmFileEl.files[0] ? bgmFileEl.files[0] : null;
      const ovPct = parseInt(document.getElementById('origVolume')?.value || '100');
      const originalVolume = Math.max(0, Math.min(1, ovPct / 100));
      const bvPct = parseInt(document.getElementById('bgmVolume')?.value || '25');
      const bgmVolume = Math.max(0, Math.min(1, bvPct / 100));

      let bgm = null;
      if (bgmFile) {
        const id = videoStore.generateId('bgm');
        await videoStore.saveBlob(id, bgmFile, { name: bgmFile.name, type: bgmFile.type || 'audio' });
        bgm = { type: 'blob', blobId: id, volume: bgmVolume, loop: true };
      } else if (bgmUrl) {
        bgm = { type: 'url', url: bgmUrl, volume: bgmVolume, loop: true };
      }

      if (!bgm && bgmVolume > 0.0001) {
        try { notify.warn('Background music volume is set, but no audio source is selected. Select a BGM file to enable mixing.'); } catch {}
      }

      try { window.processingStatus?.requestNotifyPermission?.(); } catch {}
    // Start / end chosen on the timeline, the custom overlay layer, and a server copy of the video if one
      // was already sent for the preview. All empty when the editor wasn't used, so nothing changes then.
      let editOpts = { rangeStart: 0, rangeEnd: 0, customOverlayBlob: null, design: null, look: null, preUploadId: null };
      try {
        editOpts = await editorUI.getGenerateOptions((p) => {
          if (p && p.phase === 'uploading') this._onProgress(p, { cloudProcessing });
        });
      } catch (e) { console.warn('[Upload] editor options failed, using defaults:', e); }

      if (editOpts.look && !cloudProcessing) {
        // A framing the aspect-ratio rules chose by themselves is not something the person asked for: no warning for it alone.
        const lk = editOpts.look;
        const asked = !!(lk.lowerThird || lk.adjust || lk.captions || (lk.frame && !lk.frameAuto));
        if (asked) { try { notify.warn('The framing, lower third, captions and clip adjustments are drawn by the server. Turn on cloud processing to include them in your clips.'); } catch {} }
        editOpts = { ...editOpts, look: null };
      }

      await clipGenerator.processUpload(
        upload.id,
        (progress) => this._onProgress(progress, { seriesMode, seriesStartPart, cloudProcessing }),
        { targetDuration, maxClips, reEncode, speedProfile, seriesMode, seriesStartPart, endsSeries, overlayFormat, aspectRatio, bgm, originalVolume, cloudProcessing, videoBlob: cloudProcessing ? this.currentFile : null, ...editOpts }
      );

      this.hideModal();
      const b = document.getElementById('bgProcBadge'); if (b) b.style.display = 'none';
      notify.success('Clips generated successfully!');
      window.app?.navigate('clips');
    } catch (err) {
      if (err && err.cancelled) { // the person stopped it: that is not a failure
        this.hideModal();
        const bg = document.getElementById('bgProcBadge'); if (bg) bg.style.display = 'none';
        notify.info('Stopped. Clips that were already finished are kept; resume any time from Recent Uploads on the dashboard.');
        try { await window.app?.refreshDashboardSoon?.(); } catch { /* ignore */ }
        return;
      }
      console.error('[Upload] Processing failed:', err);
      this.hideModal();
      try { if (this._activeUploadId != null && !(err && err.network)) await clipGenerator.markUploadFailed(this._activeUploadId, err); } catch {}
      const reason = String((err && err.message) || '').slice(0, 220);
      notify.error(reason ? `Processing failed: ${reason}. Open Recent Uploads on the dashboard to retry; finished clips are kept.` : 'Processing failed. Open Recent Uploads on the dashboard to retry.');
    } finally {
      this.isProcessing = false;
      try { uploadPage.refresh(); } catch {}
      this._activeUploadId = null;
      this._cloudSteps = false;
      this._lengthNote = '';
      if (this._onClipSavedForPreview) { window.removeEventListener('clip:saved', this._onClipSavedForPreview); this._onClipSavedForPreview = null; }
      if (this._onClipNotify) { window.removeEventListener('clip:notify', this._onClipNotify); this._onClipNotify = null; }
      if (this._previewObjUrl) { try { URL.revokeObjectURL(this._previewObjUrl); } catch {} this._previewObjUrl = null; }
      const preview = document.getElementById('procLivePreview');
      if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
    }
  },

  // Shows the most recently completed clip inside the processing modal while cloud
  // rendering continues in the background — the equivalent of the old live recording
  // preview, for a pipeline that no longer records anything in the browser.
  async _showLivePreview(clip) {
    try {
      const preview = document.getElementById('procLivePreview');
      if (!preview || !clip || !clip.blobId) return;
      const blob = await videoStore.getBlob(clip.blobId);
      if (!blob) return;
      if (this._previewObjUrl) { try { URL.revokeObjectURL(this._previewObjUrl); } catch {} }
      this._previewObjUrl = URL.createObjectURL(blob);
      preview.style.display = 'block';
      const label = (clip.title || 'Clip ready').replace(/[<>]/g, '');
      preview.innerHTML = `
        <div style="position:absolute;top:6px;left:6px;z-index:2;background:rgba(34,211,160,0.92);color:#0a0a0f;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;letter-spacing:.5px;pointer-events:none">✓ ${label}</div>
        <video src="${this._previewObjUrl}" muted autoplay loop playsinline style="width:100%;max-height:160px;object-fit:contain;display:block;background:#0a0a0f"></video>
      `;
    } catch (e) { console.warn('[Upload] live preview update failed', e); }
  },

  // ── Progress model ────────────────────────────────────────────────────────────────────
  // One honest bar for the whole run. Each stage owns a fixed slice, the bar never goes backwards, and the
  // text says what is happening and (once there is enough to go on) roughly how long the current step has left.
  _STAGES: {
    uploading: { from: 0, to: 38, step: 1, label: 'Uploading video to the server' },
    analyzing: { from: 38, to: 55, step: 2, label: 'Finding the best moments' },
    generating: { from: 55, to: 98, step: 3, label: 'Cutting clips' },
  },

  _fmtEta(sec) {
    if (!(sec > 0) || !isFinite(sec)) return '';
    if (sec < 45) return 'less than a minute left';
    const m = Math.round(sec / 60);
    if (m < 60) return `about ${m} min left`;
    return `about ${Math.floor(m / 60)} h ${m % 60} min left`;
  },

  _onProgress(progress, ctx = {}) {
    const ph = progress.phase;
    const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
    let stage = null; let frac = 0; let label = '';
    const fmtLen = (t) => { const s = Math.round(t); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60; return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; };

    if (ph === 'uploading') { stage = 'uploading'; frac = clamp(progress.pct) / 100; label = progress.reused ? 'This video is already on the server' : this._STAGES.uploading.label; }
    else if (ph === 'analyzing' || ph === 'audio' || ph === 'scene' || ph === 'scoring') {
      stage = 'analyzing';
      // the generator reports analysis as 0-60; the real range of this stage is 0-100
      frac = ph === 'analyzing' ? clamp(progress.pct / 0.6) / 100 : clamp(progress.pct) / 100;
      label = this._STAGES.analyzing.label;
    } else if (ph === 'series-skip') { stage = 'analyzing'; frac = 0.3; label = 'Planning the parts'; }
    else if (ph === 'series-plan') {
      stage = 'analyzing'; frac = 1; this._lengthNote = `video ${fmtLen(progress.duration)}`;
      label = `Video is ${fmtLen(progress.duration)}, so ${progress.parts} part${progress.parts === 1 ? '' : 's'}`;
    } else if (ph === 'generating' || ph === 'extracting') {
      stage = 'generating'; frac = clamp(progress.pct) / 100;
      const total = progress.total || 0; const idx = (progress.clipIndex || 0) + 1;
      const startPart = ctx.seriesStartPart || 1;
      const what = ctx.seriesMode ? `part ${startPart + (progress.clipIndex || 0)}` : `clip ${idx}`;
      label = total ? `Cutting ${what} of ${ctx.seriesMode ? startPart + total - 1 : total}` : this._STAGES.generating.label;
    } else if (ph === 'done') {
      this._stageIdx = 4; this._setBar(100, `${progress.clips?.length || 0} clip${progress.clips?.length === 1 ? '' : 's'} ready`); return;
    } else { return; }

    const st = this._STAGES[stage];
    const now = Date.now();
    this._stageClock = this._stageClock || {};
    const c = this._stageClock[stage] || (this._stageClock[stage] = { t0: now });
    const overall = st.from + (st.to - st.from) * Math.max(0, Math.min(1, frac));
    this._stageIdx = st.step;

    // time left in THIS step, from how fast it has gone so far (needs a few seconds and a few percent to mean anything)
    let eta = '';
    const elapsed = (now - c.t0) / 1000;
    if (frac >= 0.04 && frac < 0.995 && elapsed >= 4) eta = this._fmtEta(elapsed * (1 - frac) / frac);
    const note = this._lengthNote && stage === 'generating' ? ` · ${this._lengthNote}` : '';
    this._setBar(overall, `${label}${note}${eta ? ' · ' + eta : ''}`);
  },

  _setBar(pct, label) {
    this._pctMax = Math.max(this._pctMax || 0, pct); // never backwards
    this.setModalProgress(this._pctMax, label, true);
  },

  getPhaseLabel(progress) {
    const labels = {
      audio: 'Analyzing audio peaks...',
      scene: `Detecting scene changes (${Math.round(progress.pct || 0)}%)...`,
      scoring: 'Scoring clip candidates...',
      done: 'Analysis complete',
      analyzing: 'Analyzing video content...',
      generating: 'Generating clips with FFmpeg...',
    };
    return labels[progress.phase] || progress.phase;
  },

  showModal() {
    const modal = document.getElementById('procModal');
    if (modal) modal.classList.add('show');
    window.app?._lockBodyScroll?.();
    this._pctMax = 0; this._stageIdx = 0; this._stageClock = {}; this._lengthNote = '';
    this.setModalProgress(0, 'Starting…');
    this.updateStepsList(this._stepNames(), 0);
  },

  // Cloud processing has different stages from the in-browser pipeline, so it gets its own list
  // (it used to show "Load FFmpeg" while the video was still uploading).
  _stepNames() {
    return this._cloudSteps
      ? ['Save to storage', 'Upload to server', 'Analyze video', 'Cut clips', 'Save clips']
      : ['Save to storage', 'Load FFmpeg', 'Analyze audio', 'Detect scenes', 'Score segments', 'Extract clips'];
  },

  _stepIndex(pct) {
    if (this._cloudSteps) return this._stageIdx != null ? this._stageIdx : 0;
    return pct < 5 ? 0 : pct < 30 ? 1 : pct < 50 ? 2 : pct < 57 ? 3 : pct < 60 ? 4 : 5;
  },

  hideModal() {
    const modal = document.getElementById('procModal');
    if (modal) {
      setTimeout(() => {
        modal.classList.remove('show');
        window.app?._unlockBodyScroll?.();
      }, 1200);
    }
  },

  setModalProgress(pct, label, fromModel = false) {
    if (!fromModel) { pct = Math.max(pct, this._pctMax || 0); this._pctMax = pct; }
    const bar = document.getElementById('procProgress');
    const pctEl = document.getElementById('procPct');
    const sub = document.getElementById('procSub');
    if (bar) bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    if (sub) sub.textContent = label;
    this.updateStepsList(this._stepNames(), this._stepIndex(pct));
  },

  setModalStep(label, pct) {
    const sub = document.getElementById('procSub');
    if (sub) sub.textContent = label;
    const bar = document.getElementById('procProgress');
    if (bar) bar.style.width = `${pct}%`;
  },

  updateStepsList(steps, activeIndex) {
    const list = document.getElementById('procSteps');
    if (!list) return;
    list.innerHTML = steps.map((s, i) => {
      const done = i < activeIndex;
      const active = i === activeIndex;
      return `<div class="proc-step-item${done ? ' done' : active ? ' active' : ''}">
        <svg class="step-icon" viewBox="0 0 18 18" fill="none">
          ${done
            ? `<polyline points="4 9 7.5 12.5 14 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
            : active
            ? `<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9" r="3" fill="currentColor"/>`
            : `<circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>`
          }
        </svg>
        ${s}
      </div>`;
    }).join('');
  },

  async _buildSeriesIndex() {
    try {
      const uploads = await videoStore.getAllUploads();
      const clips = await db.getAll(STORES.CLIPS);
      const map = new Map();
      for (const u of uploads) {
        const key = (u.seriesKey && typeof u.seriesKey === 'string' && u.seriesKey) || String(u.name || '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!key) continue;
        let entry = map.get(key);
        if (!entry) { entry = { title: u.title || String(u.name || '').replace(/\.[^.]+$/, ''), uploads: new Set(), lastPart: 0 }; map.set(key, entry); }
        entry.uploads.add(u.id);
      }
      for (const c of clips) {
        if (c.partNumber == null) continue;
        const upId = c.uploadId;
        for (const [key, entry] of map.entries()) {
          if (entry.uploads.has(upId)) {
            if (c.partNumber > entry.lastPart) entry.lastPart = c.partNumber;
            break;
          }
        }
      }
      this._seriesIndex = map;
      const contSel = document.getElementById('continueSeriesSelect');
      if (contSel) {
        const items = Array.from(map.entries()).map(([key, e]) => ({ key, title: e.title, lastPart: e.lastPart }));
        items.sort((a, b) => a.title.localeCompare(b.title));
        contSel.innerHTML = '<option value="">— Select existing title —</option>' +
          items.map(it => `<option value="${it.key}">${it.title}${it.lastPart ? ` (last Part ${it.lastPart})` : ''}</option>`).join('');
      }
    } catch (e) {}
  },

  _applyContinuationSelection() {
    try {
      const sel = document.getElementById('continueSeriesSelect');
      const key = sel?.value || '';
      if (!key || !this._seriesIndex) return;
      const entry = this._seriesIndex.get(key);
      if (!entry) return;
      const titleEl = document.getElementById('uploadVideoTitle');
      if (titleEl) titleEl.value = entry.title;
      const start = Math.max(1, (entry.lastPart || 0) + 1);
      const sp = document.getElementById('seriesStartPart');
      if (sp) { sp.value = String(start); try { sp.dispatchEvent(new Event('input')); } catch {} }
    } catch {}
  },

  _recalcNextPartFromTitle() {
    try {
      const sm = !!document.getElementById('seriesMode')?.checked;
      if (!sm) return;
      const titleEl = document.getElementById('uploadVideoTitle');
      const t = (titleEl?.value || '').trim();
      if (!t) return;
      const key = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!this._seriesIndex) return;
      const entry = this._seriesIndex.get(key);
      const next = Math.max(1, ((entry?.lastPart) || 0) + 1);
      const sp = document.getElementById('seriesStartPart');
      if (sp) { sp.value = String(next); try { sp.dispatchEvent(new Event('input')); } catch {} }
    } catch {}
  },
};

// Expose for inline handlers in index.html (Run in background / Cancel / Reopen)
try { window.uploadUI = uploadUI; } catch {}
