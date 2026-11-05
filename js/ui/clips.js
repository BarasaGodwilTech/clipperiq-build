import { db, STORES } from '../storage/db.js';
import { videoStore } from '../storage/videoStore.js';
import { videoProcessor } from '../core/videoProcessor.js';
import { jobQueue } from '../scheduler/jobQueue.js';
import { notify, confirmAction } from './notifications.js';
import { authStore } from '../storage/authStore.js';
import { getBackendBaseUrl } from '../core/config.js';
import { clipGenerator } from '../core/clipGenerator.js';
import { designStore } from '../core/designStore.js';
import { DesignerPad, esc } from './designer.js';
import { describeAdjust } from '../shared/adjust.js';

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const ASPECT_CSS = { '9:16': '9/16', '16:9': '16/9', '1:1': '1/1', '4:5': '4/5' };
function previewRatioStyle(clip) {
  const r = ASPECT_CSS[clip.aspectRatio];
  return r ? `aspect-ratio:${r}` : 'aspect-ratio:16/9';
}

export const clipsUI = {
  clips: [],
  previewUrls: {},
  thumbCache: {},   // blobId -> { url, ratio } once a thumbnail exists, or 'failed'
  _thumbJobs: {},   // blobId -> in-flight thumbnail promise (so repeated re-renders don't redo the work)
  _renderPromise: null,
  _seriesPlan: null,
  filter: { q: '', upload: 'all', sort: 'part' },
  selectMode: false,
  selected: new Set(),
  _uploads: [],

  async refresh() {
    try {
      this.clips = await db.getAll(STORES.CLIPS);
      console.log('[ClipsUI] refresh loaded clips', { count: this.clips.length });
    } catch (err) {
      console.error('[ClipsUI] refresh failed to load clips', err);
      this.clips = [];
    }
    this.renderGrid();
  },

  openSeriesScheduler() {
    const groups = {};
    for (const c of this.clips) {
      if (c.partNumber == null) continue;
      if (!groups[c.uploadId]) groups[c.uploadId] = [];
      groups[c.uploadId].push(c);
    }
    const uploadIds = Object.keys(groups).filter(id => groups[id].length >= 2);
    if (uploadIds.length === 0) { notify.warn('No multi-part series found'); return; }

    const pickId = uploadIds.sort((a, b) => groups[b].length - groups[a].length)[0];
    const parts = groups[pickId].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));

    let host = document.getElementById('seriesScheduleModal');
    if (!host) {
      host = document.createElement('div');
      host.className = 'overlay-modal';
      host.id = 'seriesScheduleModal';
      host.innerHTML = `
        <div class="modal-box" style="max-width:820px">
          <div class="modal-header">
            <span class="modal-title">Schedule Series</span>
            <button class="modal-close" onclick="document.getElementById('seriesScheduleModal').classList.remove('show');window.app?._unlockBodyScroll?.()">✕</button>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Upload</label>
              <select class="form-input" id="seriesUploadSelect"></select>
            </div>
            <div class="form-group">
              <label class="form-label">Platforms</label>
              <select class="form-input" id="seriesPlatform">
                <option value="All">All connected</option>
                <option value="TikTok">TikTok</option>
                <option value="Instagram">Instagram</option>
                <option value="YouTube">YouTube</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Base Title</label>
              <input class="form-input" id="seriesBaseTitle" placeholder="My Video Title">
            </div>
            <div class="form-group">
              <label class="form-label">Start Date/Time</label>
              <input type="datetime-local" class="form-input" id="seriesStartTime">
            </div>
            <div class="form-group">
              <label class="form-label">Privacy</label>
              <select class="form-input form-select" id="seriesPrivacy">
                <option value="PUBLIC_TO_EVERYONE">Public</option>
                <option value="MUTUAL_FOLLOW_FRIENDS">Friends only (mutual follows)</option>
                <option value="SELF_ONLY">Self only (TikTok draft)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Max Posts per Day</label>
              <input type="number" class="form-input" id="seriesMaxPerDay" min="1" max="6" value="2">
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="seriesBestTimes" checked>
              <label class="form-label" for="seriesBestTimes" style="margin:0">Use best-time windows</label>
            </div>
          </div>
          <div id="seriesTikTokSection" style="margin:14px -8px 0;padding:14px 14px 4px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg3)">
            <div class="card-title" style="margin:0 0 2px;font-size:13px;color:var(--tiktok)">🎵 TikTok Post Settings</div>
            <div style="font-size:11px;color:var(--muted);margin-bottom:6px">These settings apply to TikTok posts only.</div>
            <div class="toggle-row">
              <div class="toggle-info">
                <div class="toggle-title">Disable Comments</div>
                <div class="toggle-desc">Prevent viewers from leaving comments on this video</div>
              </div>
              <label class="toggle-switch"><input type="checkbox" id="seriesDisableComment"><span class="toggle-slider"></span></label>
            </div>
            <div class="toggle-row">
              <div class="toggle-info">
                <div class="toggle-title">Disable Duet</div>
                <div class="toggle-desc">Prevent other creators from making a duet with this video</div>
              </div>
              <label class="toggle-switch"><input type="checkbox" id="seriesDisableDuet" checked><span class="toggle-slider"></span></label>
            </div>
            <div class="toggle-row">
              <div class="toggle-info">
                <div class="toggle-title">Disable Stitch</div>
                <div class="toggle-desc">Prevent other creators from stitching clips of this video</div>
              </div>
              <label class="toggle-switch"><input type="checkbox" id="seriesDisableStitch"><span class="toggle-slider"></span></label>
            </div>
            <div class="toggle-row">
              <div class="toggle-info">
                <div class="toggle-title">Branded Content</div>
                <div class="toggle-desc">Disclose that this video contains a paid partnership or brand placement</div>
              </div>
              <label class="toggle-switch"><input type="checkbox" id="seriesBrandedContent"><span class="toggle-slider"></span></label>
            </div>
            <div class="toggle-row" style="border:none;padding-bottom:4px">
              <div class="toggle-info">
                <div class="toggle-title">Allow Promotion</div>
                <div class="toggle-desc">Permit this post to be promoted via TikTok Ads / Boost</div>
              </div>
              <label class="toggle-switch"><input type="checkbox" id="seriesAllowPromotion" checked><span class="toggle-slider"></span></label>
            </div>
          </div>
          <div id="seriesPlanTable" style="max-height:300px;overflow:auto;margin-top:14px;border:1px solid var(--bg3);border-radius:var(--radius)"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button class="btn btn-ghost" onclick="document.getElementById('seriesScheduleModal').classList.remove('show');window.app?._unlockBodyScroll?.()">Close</button>
            <button class="btn btn-ghost" onclick="window.clipsUI.generateSeriesPlan()">Generate</button>
            <button class="btn btn-primary" onclick="window.clipsUI.confirmSeriesSchedule()">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(host);

      const platEl = host.querySelector('#seriesPlatform');
      const ttSec = host.querySelector('#seriesTikTokSection');
      if (platEl && ttSec) {
        const upd = () => {
          const v = platEl.value;
          ttSec.style.display = (v === '' || v === 'TikTok' || v === 'All') ? 'block' : 'none';
        };
        platEl.addEventListener('change', upd);
        upd();
      }
    }

    const upSel = document.getElementById('seriesUploadSelect');
    upSel.innerHTML = uploadIds.map(id => {
      const any = groups[id][0];
      return `<option value="${id}">Upload ${id} · ${groups[id].length} parts</option>`;
    }).join('');
    upSel.value = pickId;

    const st = new Date(Date.now() + 60 * 60 * 1000);
    const local = new Date(st.getTime() - st.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('seriesStartTime').value = local;

    db.get(STORES.UPLOADS, parseInt(pickId, 10)).then(upload => {
      const name = upload?.name || 'Video';
      const base = String(name).replace(/\.[^.]+$/, '');
      document.getElementById('seriesBaseTitle').value = base;
    }).catch(() => { document.getElementById('seriesBaseTitle').value = 'Video'; });

    this._seriesPlan = { uploadId: pickId, parts };
    document.getElementById('seriesScheduleModal').classList.add('show');
    window.app?._lockBodyScroll?.();
    this.generateSeriesPlan();
  },

  _getBestWindows(platform) {
    const p = (platform || 'All').toLowerCase();
    if (p === 'tiktok') return [11, 15, 19];
    if (p === 'instagram') return [12, 18];
    if (p === 'youtube') return [12, 16];
    return [11, 15, 19];
  },

  generateSeriesPlan() {
    const plat = document.getElementById('seriesPlatform')?.value || 'All';
    const upSel = document.getElementById('seriesUploadSelect');
    const uploadId = upSel?.value || this._seriesPlan?.uploadId;
    const maxPerDay = Math.max(1, parseInt(document.getElementById('seriesMaxPerDay')?.value || '2', 10));
    const useBest = !!document.getElementById('seriesBestTimes')?.checked;
    const startStr = document.getElementById('seriesStartTime')?.value;
    if (!startStr) { notify.warn('Choose a start time'); return; }
    const start = new Date(startStr);
    if (isNaN(start.getTime())) { notify.warn('Invalid start time'); return; }

    const parts = this.clips
      .filter(c => String(c.uploadId) === String(uploadId) && c.partNumber != null)
      .sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
    if (parts.length === 0) { notify.warn('No parts found for this upload'); return; }

    const windows = useBest ? this._getBestWindows(plat) : [start.getHours()];
    const plan = [];
    let cursor = new Date(start);
    let i = 0;
    while (i < parts.length) {
      let postsToday = 0;
      for (const hour of windows) {
        if (i >= parts.length) break;
        if (postsToday >= maxPerDay) break;
        const dt = new Date(cursor);
        dt.setHours(hour, start.getMinutes(), 0, 0);
        if (dt < start) continue;
        plan.push({ clip: parts[i], when: dt });
        i++; postsToday++;
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    this._seriesPlan = { uploadId, platform: plat, items: plan };

    const rows = plan.map((p, idx) => {
      const local = new Date(p.when.getTime() - p.when.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      return `<div style="display:grid;grid-template-columns:90px 1fr 220px;gap:8px;align-items:center;padding:6px 8px;border-top:1px solid var(--bg3)">
        <div style="font-weight:600">Part ${p.clip.partNumber}</div>
        <div style="color:var(--muted);font-size:12px">${p.clip.title || ''}</div>
        <input type="datetime-local" class="form-input" id="seriesWhen-${idx}" value="${local}">
      </div>`;
    }).join('');
    const head = `<div style="display:grid;grid-template-columns:90px 1fr 220px;gap:8px;padding:6px 8px;background:var(--bg3);font-size:12px;color:var(--muted)">
      <div>Part</div><div>Title</div><div>When</div></div>`;
    document.getElementById('seriesPlanTable').innerHTML = head + rows;
  },

  async confirmSeriesSchedule() {
    const plan = this._seriesPlan;
    if (!plan || !plan.items || plan.items.length === 0) { notify.warn('No plan to schedule'); return; }
    const base = (document.getElementById('seriesBaseTitle')?.value || 'Video').trim();
    const plat = document.getElementById('seriesPlatform')?.value || 'All';

    const privacy = document.getElementById('seriesPrivacy')?.value || 'PUBLIC_TO_EVERYONE';
    const disableComment = !!document.getElementById('seriesDisableComment')?.checked;
    const disableDuet = !!document.getElementById('seriesDisableDuet')?.checked;
    const disableStitch = !!document.getElementById('seriesDisableStitch')?.checked;
    const brandedContent = !!document.getElementById('seriesBrandedContent')?.checked;
    const allowPromotion = !!document.getElementById('seriesAllowPromotion')?.checked;
    const postOptions = {
      privacy,
      allowComments: !disableComment,
      allowDuet: !disableDuet,
      allowStitch: !disableStitch,
      brandedContent,
      allowPromotion,
    };

    const platforms = async () => {
      if (plat !== 'All') return [plat];
      const out = [];
      if (await authStore.isConnected('tiktok')) out.push('TikTok');
      if (await authStore.isConnected('instagram')) out.push('Instagram');
      if (await authStore.isConnected('youtube')) out.push('YouTube');
      return out;
    };

    const targets = await platforms();
    if (targets.length === 0) { notify.warn('No connected platforms. Connect accounts first.'); return; }

    try {
      for (let i = 0; i < plan.items.length; i++) {
        const p = plan.items[i];
        const val = document.getElementById(`seriesWhen-${i}`)?.value;
        const when = val ? new Date(val) : p.when;
        for (const name of targets) {
          const caption = `${base} — Part ${p.clip.partNumber}`;
          await jobQueue.add({ clipId: p.clip.id, blobId: p.clip.blobId, platform: name, caption, scheduledAt: when.toISOString(), options: { ...postOptions } });
        }
      }
      notify.success(`Scheduled ${plan.items.length} part(s) on ${targets.join(', ')}`);
      document.getElementById('seriesScheduleModal')?.classList.remove('show');
      window.app?._unlockBodyScroll?.();
      try { window.queueUI?.refresh?.(); } catch {}
    } catch (err) {
      console.error('[Clips] Failed to schedule series:', err);
      notify.error('Could not schedule these posts. Please try again.');
    }
  },

  // Saving a clip fires several refresh/render calls in a row; coalescing them into one render
  // stops the grid from being rebuilt (and thumbnails restarted) over and over mid-processing.
  renderGrid() {
    if (!this._renderPromise) {
      this._renderPromise = new Promise((resolve) => {
        setTimeout(() => { this._renderPromise = null; resolve(this._renderGridNow()); }, 60);
      });
    }
    return this._renderPromise;
  },

  async _renderGridNow() {
    const grid = document.getElementById('clipGrid');
    if (!grid) return;
    try { this._uploads = await db.getAll(STORES.UPLOADS); } catch { this._uploads = []; }
    this._ensureToolbar(grid);

    if (this.clips.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--muted)">
          <div style="font-size:48px;margin-bottom:12px">🎬</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">No clips yet</div>
          <div style="font-size:14px">Upload a video to generate clips automatically</div>
        </div>`;
      this._syncToolbar(0);
      return;
    }

    const byPart = [...this.clips].sort((a, b) => {
      const ap = (a.partNumber != null) ? a.partNumber : Infinity;
      const bp = (b.partNumber != null) ? b.partNumber : Infinity;
      if (a.uploadId === b.uploadId && ap !== bp) return ap - bp;
      if (ap !== bp) return ap - bp;
      const at = new Date(a.createdAt || 0).getTime();
      const bt = new Date(b.createdAt || 0).getTime();
      if (at !== bt) return at - bt;
      return b.score - a.score;
    });
    const hasParts = byPart.some(c => c.partNumber != null);
    let sorted = hasParts ? byPart : [...this.clips].sort((a, b) => b.score - a.score);
    if (this.filter.sort === 'score') sorted = [...sorted].sort((a, b) => (b.score || 0) - (a.score || 0));
    else if (this.filter.sort === 'newest') sorted = [...sorted].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

    const q = this.filter.q.trim().toLowerCase();
    const shown = sorted.filter((c) => {
      if (this.filter.upload !== 'all' && String(c.uploadId) !== String(this.filter.upload)) return false;
      if (!q) return true;
      const hay = `${c.title || ''} part ${c.partNumber ?? ''} ${formatTime(c.startTime)}`.toLowerCase();
      return hay.includes(q);
    });
    this._shownIds = shown.map((c) => c.id);

    if (!shown.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--muted)">
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">No clips match</div>
        <div style="font-size:13px">Try a different search or choose "All videos".</div></div>`;
    } else {
      grid.innerHTML = shown.map(clip => this.renderClipCard(clip)).join('');
      for (const clip of shown) this.generateThumbnail(clip);
    }
    this._syncToolbar(shown.length);
  },

  // ── search / sort / filter / select toolbar ─────────────────────────────────────────
  _ensureToolbar(grid) {
    let bar = document.getElementById('clipsToolbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'clipsToolbar';
      bar.className = 'clips-toolbar';
      bar.innerHTML = `
        <input class="form-input" id="clipSearch" type="search" placeholder="Search clips (e.g. part 3)…" aria-label="Search clips">
        <select class="form-input form-select" id="clipUploadFilter" aria-label="Filter by video"></select>
        <select class="form-input form-select" id="clipSort" aria-label="Sort clips">
          <option value="part">Part order</option><option value="score">Best score first</option><option value="newest">Newest first</option>
        </select>
        <button class="btn btn-ghost btn-sm" id="clipSelectToggle" type="button">☑ Select</button>
        <span class="clips-count" id="clipCount"></span>
        <div class="clips-bulk" id="clipsBulk" style="display:none">
          <span id="clipsBulkCount"></span>
          <button class="btn btn-ghost btn-sm" id="clipSelAll" type="button">All shown</button>
          <button class="btn btn-ghost btn-sm" id="clipSelNone" type="button">None</button>
          <button class="btn btn-primary btn-sm" id="clipBulkDesign" type="button">🎨 Apply design</button>
          <button class="btn btn-danger btn-sm" id="clipBulkDelete" type="button">Delete</button>
        </div>`;
      grid.parentNode.insertBefore(bar, grid);
      let t = null;
      bar.querySelector('#clipSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { this.filter.q = e.target.value; this.renderGrid(); }, 160); });
      bar.querySelector('#clipUploadFilter').addEventListener('change', (e) => { this.filter.upload = e.target.value; this.renderGrid(); });
      bar.querySelector('#clipSort').addEventListener('change', (e) => { this.filter.sort = e.target.value; this.renderGrid(); });
      bar.querySelector('#clipSelectToggle').addEventListener('click', () => { this.selectMode = !this.selectMode; if (!this.selectMode) this.selected.clear(); this.renderGrid(); });
      bar.querySelector('#clipSelAll').addEventListener('click', () => { (this._shownIds || []).forEach((id) => this.selected.add(id)); this.renderGrid(); });
      bar.querySelector('#clipSelNone').addEventListener('click', () => { this.selected.clear(); this.renderGrid(); });
      bar.querySelector('#clipBulkDelete').addEventListener('click', () => this.deleteSelected());
      bar.querySelector('#clipBulkDesign').addEventListener('click', () => this.openDesignForSelection());
    }
    const sel = bar.querySelector('#clipUploadFilter');
    const withClips = this._uploads.filter((u) => this.clips.some((c) => String(c.uploadId) === String(u.id)));
    const opts = `<option value="all">All videos</option>` + withClips.map((u) => `<option value="${esc(u.id)}">${esc(u.title || u.name || 'Video')}</option>`).join('');
    if (sel.dataset.sig !== opts) { sel.innerHTML = opts; sel.dataset.sig = opts; }
    sel.value = withClips.some((u) => String(u.id) === String(this.filter.upload)) ? String(this.filter.upload) : 'all';
    if (sel.value === 'all') this.filter.upload = 'all';
    bar.querySelector('#clipSort').value = this.filter.sort;
  },

  _syncToolbar(shownCount) {
    const bar = document.getElementById('clipsToolbar');
    if (!bar) return;
    const total = this.clips.length;
    bar.querySelector('#clipCount').textContent = total ? (shownCount === total ? `${total} clip${total === 1 ? '' : 's'}` : `${shownCount} of ${total}`) : '';
    bar.querySelector('#clipSelectToggle').textContent = this.selectMode ? '✕ Done' : '☑ Select';
    const bulk = bar.querySelector('#clipsBulk');
    bulk.style.display = this.selectMode ? 'flex' : 'none';
    bar.querySelector('#clipsBulkCount').textContent = `${this.selected.size} selected`;
    bar.querySelector('#clipBulkDelete').disabled = this.selected.size === 0;
    bar.querySelector('#clipBulkDesign').disabled = this.selected.size === 0;
  },

  toggleSelect(clipId, on) {
    if (on) this.selected.add(clipId); else this.selected.delete(clipId);
    document.getElementById(`clip-card-${clipId}`)?.classList.toggle('is-selected', !!on);
    this._syncToolbar((this._shownIds || []).length);
  },

  async deleteSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    const ok = await confirmAction({ title: `Delete ${ids.length} clip${ids.length === 1 ? '' : 's'}?`, message: 'This permanently deletes the selected clips from this browser. It cannot be undone.', confirmText: 'Yes, delete', cancelText: 'No', intent: 'danger' });
    if (!ok) return;
    for (const id of ids) {
      const clip = this.clips.find((c) => c.id === id);
      if (!clip) continue;
      try {
        await db.delete(STORES.CLIPS, id);
        await videoStore.deleteBlob(clip.blobId);
        delete this.thumbCache[clip.blobId];
        if (this.previewUrls[clip.blobId]) { URL.revokeObjectURL(this.previewUrls[clip.blobId]); delete this.previewUrls[clip.blobId]; }
      } catch (e) { console.warn('delete failed', id, e); }
    }
    this.clips = this.clips.filter((c) => !ids.includes(c.id));
    this.selected.clear();
    notify.success(`Deleted ${ids.length} clip${ids.length === 1 ? '' : 's'}`);
    this.renderGrid();
  },

  renderClipCard(clip) {
    const scoreColor = clip.score > 80 ? 'var(--success)' : clip.score > 60 ? 'var(--warn)' : 'var(--muted)';
    // The part number is stored when the clip is saved. (It used to be re-derived from
    // startTime/duration, which gives wrong numbers for the shorter final part.)
    const displayPart = clip.partNumber;
    const titleText = (displayPart != null)
      ? `Part ${displayPart} (${formatTime(clip.startTime)} \u2013 ${formatTime(clip.startTime + clip.duration)})`
      : (clip.title || `Clip (${formatTime(clip.startTime)})`);
    const clipUpload = this._uploads.find((u) => String(u.id) === String(clip.uploadId));
    const hasDesign = this._designIdFor(clip, clipUpload);
    const look = this._lookFor(clip, clipUpload);
    const picked = this.selected.has(clip.id);
    return `
      <div class="clip-card${picked ? ' is-selected' : ''}" id="clip-card-${clip.id}">
        ${this.selectMode ? `<label class="clip-pick" title="Select this clip"><input type="checkbox" ${picked ? 'checked' : ''} onchange="window.clipsUI.toggleSelect(${clip.id}, this.checked)"></label>` : ''}
        <div class="clip-preview" id="clip-preview-${clip.id}" style="${previewRatioStyle(clip)}">
          <div class="clip-placeholder" style="font-size:28px">🎬</div>
          <div class="clip-timeline">
            <div class="clip-time">${formatTime(clip.startTime)} → ${formatTime(clip.startTime + clip.duration)} · ${Math.round(clip.outputDuration || clip.duration)}s</div>
          </div>
        </div>
        <div class="clip-meta">
          <div class="clip-title">${titleText}${hasDesign ? ' <span class="clip-chip" title="This clip has a custom design (text / stickers / images)">🎨 Custom design</span>' : ''}${look && look.lowerThird ? ' <span class="clip-chip" title="This clip has an animated lower third">🎞 Lower third</span>' : ''}${look && look.frame ? ' <span class="clip-chip" title="The video is placed in the frame (not the default crop)">▣ Framed</span>' : ''}${look && look.adjust ? ` <span class="clip-chip" title="Clip adjustments: ${describeAdjust(look.adjust).replace(/"/g, '')}">🎚 Adjusted</span>` : ''}</div>
          <div class="clip-score">
            <span style="font-size:11px;color:var(--muted)">Score</span>
            <div class="score-bar"><div class="score-fill" style="width:${clip.score}%"></div></div>
            <span style="font-weight:600;color:${scoreColor}">${clip.score}</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
            <button class="btn btn-success btn-sm" onclick="window.clipsUI.scheduleClip(${clip.id})">📅 Schedule</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.previewClip(${clip.id})">▶ Preview</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.downloadClip(${clip.id})">⬇ Download</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.openDesign(${clip.id})">🎨 Design</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.openEdit(${clip.id})">✏️ Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.openMix(${clip.id})">🎧 Mix Audio</button>
            <button class="btn btn-danger btn-sm" onclick="window.clipsUI.deleteClip(${clip.id})">✕</button>
          </div>
        </div>
      </div>`;
  },

  /** Frees the file of a clip that was just replaced by a re-render (it used to be left behind). */
  _dropOldClipFile(blobId) {
    if (!blobId) return;
    videoStore.deleteBlob(blobId).catch(() => {});
    delete this.thumbCache[blobId];
    if (this.previewUrls[blobId]) { try { URL.revokeObjectURL(this.previewUrls[blobId]); } catch {} delete this.previewUrls[blobId]; }
  },

  // ── Design window: edit a clip's custom overlay and re-render from the original video ─────────
  // The effective design of a clip: its own (set when it was restyled), else the one its video was
  // generated with. `{ id: null }` on a clip means the design was deliberately removed from it.
  _designIdFor(clip, upload) {
    if (clip && clip.design !== undefined) return clip.design ? (clip.design.id || null) : null;
    return (upload && upload.design && upload.design.id) || null;
  },

  // The framing / lower third of a clip: its own (set when it was restyled), else the one its video was
  // generated with. `null` on a clip means they were deliberately removed from it.
  _lookFor(clip, upload) {
    if (clip && clip.look !== undefined) return clip.look || null;
    return (upload && upload.look) || null;
  },

  _bgmOf(clip) {
    if (!(clip.bgmEnabled && clip.bgmSource)) return null;
    const volume = typeof clip.bgmVolume === 'number' ? clip.bgmVolume : 0.25;
    if (clip.bgmSource.type === 'blob' && clip.bgmSource.blobId) return { type: 'blob', blobId: clip.bgmSource.blobId, volume, loop: true, restart: !!clip.bgmRestart };
    if (clip.bgmSource.type === 'url' && clip.bgmSource.url) return { type: 'url', url: clip.bgmSource.url, volume, loop: true, restart: !!clip.bgmRestart };
    return null;
  },

  /** Re-renders one clip on the server from the original video with ALL of its stored settings. */
  /**
   * How many seconds of the SOURCE video a clip is cut from. New clips store that as `duration` (and their finished length as
   * `outputDuration`). A clip made before that with a changed playback speed stored its finished length in `duration`, so the
   * speed is put back in.
   */
  _sourceSpan(clip, upload) {
    if (clip.outputDuration) return Number(clip.duration) || 0;
    const sp = Number(this._lookFor(clip, upload)?.adjust?.speed) || 1;
    return (Number(clip.duration) || 0) * (sp > 0 ? sp : 1);
  },

  /** Which server job and which clip of it this clip came from, so its re-render is filed inside that job (older clips: none). */
  _jobRef(clip, upload) {
    return upload && upload.cloudJobId && Number.isInteger(clip && clip.jobClipIndex)
      ? { parentJobId: upload.cloudJobId, clipIndex: clip.jobClipIndex } : {};
  },

  async _rerenderWithSettings(t, upload, designId, bgmRefs, look = undefined) {
    const base = await getBackendBaseUrl();
    const bgm = this._bgmOf(t);
    let bgmRef = null;
    if (bgm) {
      const key = JSON.stringify(bgm);
      if (!bgmRefs.has(key)) bgmRefs.set(key, await clipGenerator._cloudRegisterBgm(base, bgm));
      bgmRef = bgmRefs.get(key);
      if (!bgmRef) throw new Error('The background music could not be loaded, so nothing was changed.');
    }
    const { blob } = await clipGenerator.renderCloudClip(base, upload.cloudUploadId, {
      start: t.startTime, duration: this._sourceSpan(t, upload), totalScore: t.score || 0, audioScore: t.audioScore || 0, sceneScore: t.sceneScore || 0, sources: t.sources || [],
    }, {
      aspectRatio: t.aspectRatio || 'original', overlayFormat: t.overlayFormat || 'none',
      partNumber: t.partNumber != null ? t.partNumber : 1,
      originalVolume: typeof t.originalVolume === 'number' ? t.originalVolume : 1,
      bgmRef, overlayStartSec: t.overlayStartSec || 0, designId: designId || null,
      look: look !== undefined ? look : this._lookFor(t, upload),
      ...this._jobRef(t, upload),
    });
    return blob;
  },

  openDesignForSelection() {
    const first = [...this.selected][0];
    if (first == null) { notify.warn('Select at least one clip first.'); return; }
    return this.openDesign(first, { scope: 'selected' });
  },

  async openDesign(clipId, { scope = 'one' } = {}) {
    const clip = this.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const upload = await db.get(STORES.UPLOADS, clip.uploadId);
    if (!upload || !upload.cloudUploadId) {
      notify.warn('Designs can be changed on clips that were processed on the server. This one was made in the browser.');
      return;
    }
    this._designCtx = { clipId, upload };
    let m = document.getElementById('clipDesignModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'overlay-modal'; m.id = 'clipDesignModal';
      m.innerHTML = `
        <div class="modal-box" style="max-width:820px;width:94vw" role="dialog" aria-modal="true" aria-labelledby="cdTitle">
          <div class="modal-header"><span class="modal-title" id="cdTitle">Design</span><button class="modal-close" id="cdClose" aria-label="Close">✕</button></div>
          <div class="cd-note" id="cdNote"></div>
          <div id="cdPadRoot"></div>
          <div class="cd-footer">
            <label class="cd-scope">Apply to
              <select class="form-input form-select" id="cdScope"></select></label>
            <span class="cd-progress" id="cdProgress"></span>
            <button class="btn btn-ghost" id="cdCancel" type="button">Cancel</button>
            <button class="btn btn-primary" id="cdApply" type="button">Apply &amp; re-render</button>
          </div>
        </div>`;
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m && !this._designBusy) this._closeDesign(); });
      m.querySelector('#cdClose').addEventListener('click', () => { if (!this._designBusy) this._closeDesign(); });
      m.querySelector('#cdCancel').addEventListener('click', () => { if (!this._designBusy) this._closeDesign(); });
      m.querySelector('#cdApply').addEventListener('click', () => this._applyDesign());
    }
    const peers = this.clips.filter((c) => c.uploadId === clip.uploadId);
    const following = peers.filter((c) => (c.partNumber || 0) >= (clip.partNumber || 0));
    const opts = [`<option value="one">This clip only</option>`];
    if (peers.length > 1) opts.push(`<option value="all">All ${peers.length} clips from this video</option>`);
    if (clip.partNumber != null && following.length > 1 && following.length < peers.length) opts.push(`<option value="following">This and the ${following.length - 1} following part${following.length - 1 === 1 ? '' : 's'}</option>`);
    if (this.selected.size > 1) opts.push(`<option value="selected">The ${this.selected.size} selected clips</option>`);
    const sel = m.querySelector('#cdScope');
    sel.innerHTML = opts.join('');
    sel.value = [...sel.options].some((o) => o.value === scope) ? scope : 'one';
    m.querySelector('#cdTitle').textContent = clip.partNumber != null ? `Design — Part ${clip.partNumber}` : 'Design';
    m.querySelector('#cdProgress').textContent = '';
    m.querySelector('#cdApply').disabled = false;
    m.classList.add('show');
    window.app?._lockBodyScroll?.();

    const ASPECTS = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1, '4:5': 4 / 5 };
    this._designPad?.destroy?.();
    this._designPad = new DesignerPad(m.querySelector('#cdPadRoot'), {
      ns: 'cd',
      getAspect: () => ASPECTS[clip.aspectRatio] || (this._designPad?.$('Img')?.naturalWidth ? this._designPad.$('Img').naturalWidth / this._designPad.$('Img').naturalHeight : 16 / 9),
      framingEnabled: () => !!clip.aspectRatio && clip.aspectRatio !== 'original',
      // captions of a finished clip: the words live on the server next to the video; changes are kept there as they are made
      captions: {
        autoSave: !!upload.cloudUploadId,
        getUploadId: () => upload.cloudUploadId || null,
        save: (cues) => clipGenerator.saveCaptions(upload.cloudUploadId, cues),
        getRange: () => ({ start: Math.max(0, clip.startTime - 1), end: clip.startTime + (this._sourceSpan(clip, upload) || 30) + 1 }),
        previewTime: () => {
          const cues = (this._designPad && this._designPad.capCues) || [];
          const a = clip.startTime; const b = a + (this._sourceSpan(clip, upload) || 30);
          const c = cues.find((x) => x.e > a && x.s < b);
          return c ? Math.max(a, c.s) + 0.4 : a + 1; // show a moment that actually has a caption
        },
        api: {
          engine: () => clipGenerator.captionEngine(),
          load: (id) => clipGenerator.loadCaptions(id),
          transcribe: (o, onP, signal) => (upload.cloudUploadId ? clipGenerator.transcribeCaptions(upload.cloudUploadId, o, onP, signal) : Promise.reject(new Error('This clip was not processed on the server, so captions cannot be made for it.'))),
        },
      },
      getPartNumber: () => Number(clip.partNumber) || 1,                         // this clip's own part: {part} / {next} in the lower third
      getClipLength: () => Number(clip.outputDuration || clip.duration) || 0,
      notify: (type, msg) => (notify[type] || notify.info).call(notify, msg),
    });
    const pad = this._designPad;
    pad.setGhost(clip.overlayFormat || 'none');
    pad.applyAspect();

    // current design
    const ref = this._designIdFor(clip, upload);
    const note = m.querySelector('#cdNote');
    note.textContent = '';
    if (ref) {
      const rec = await designStore.get(ref);
      if (rec) await pad.load(rec.data, { resetHistory: true });
      else note.textContent = 'This clip\'s saved design was not found in this browser, so you are starting from an empty design.';
    }
    pad.loadLook(this._lookFor(clip, upload)); // framing, lower third, adjustments, captions (they have no layer picture of their own)
    if (upload.cloudUploadId && pad.cap.enabled) clipGenerator.loadCaptions(upload.cloudUploadId).then((cues) => { if (this._designPad === pad) pad.setCaptionCues(cues, { save: false, draft: false }); }).catch(() => {}); // the words kept on the server

    // a clean picture from the original video (the clip itself already has the old design baked in)
    pad.setStatus('Loading a picture from the video…');
    try {
      const t = (clip.startTime || 0) + Math.min(1.5, (clip.duration || 2) / 2);
      const blob = await clipGenerator.previewFrame(upload.cloudUploadId, t, 540);
      const img = pad.$('Img');
      if (this._designFrameUrl) URL.revokeObjectURL(this._designFrameUrl);
      this._designFrameUrl = URL.createObjectURL(blob);
      img.onload = () => { pad.applyAspect(); pad.setStatus(''); };
      img.src = this._designFrameUrl;
      img.style.display = 'block';
    } catch (e) {
      pad.setStatus('');
      note.textContent = 'The original video is no longer on the server, so there is no picture to design on and the clip cannot be re-rendered. Upload the video again to change this design.';
      m.querySelector('#cdApply').disabled = true;
    }
  },

  _closeDesign() {
    const m = document.getElementById('clipDesignModal');
    if (!m) return;
    m.classList.remove('show');
    window.app?._unlockBodyScroll?.();
    try { this._designPad?.destroy?.(); } catch {}
    this._designPad = null;
    if (this._designFrameUrl) { URL.revokeObjectURL(this._designFrameUrl); this._designFrameUrl = null; }
  },

  async _applyDesign() {
    const ctx = this._designCtx; const pad = this._designPad;
    if (!ctx || !pad || this._designBusy) return;
    const clip = this.clips.find((c) => c.id === ctx.clipId);
    if (!clip) return;
    const m = document.getElementById('clipDesignModal');
    const scope = m.querySelector('#cdScope').value;
    const progress = m.querySelector('#cdProgress'); const applyBtn = m.querySelector('#cdApply');

    const peers = this.clips.filter((c) => c.uploadId === clip.uploadId);
    let targets = [clip];
    if (scope === 'all') targets = peers;
    else if (scope === 'following') targets = peers.filter((c) => (c.partNumber || 0) >= (clip.partNumber || 0));
    else if (scope === 'selected') targets = this.clips.filter((c) => this.selected.has(c.id));
    if (!targets.length) targets = [clip];
    const uploads = new Map(); for (const u of this._uploads.length ? this._uploads : await db.getAll(STORES.UPLOADS)) uploads.set(String(u.id), u);

    this._designBusy = true; applyBtn.disabled = true;
    try {
      const hasItems = pad.hasItems();
      const look = pad.getLook(); // { frame, lowerThird, adjust } or null: stored on every clip that is re-rendered
      let newId = null;
      if (hasItems) {
        const layerBlob = await pad.renderLayerBlob();
        const aspect = clip.aspectRatio || '9:16';
        newId = (await designStore.save({ data: pad.serialize(), aspect, layerBlob })).id;
      }
      let done = 0; let failed = 0; let firstErr = '';
      const bgmRefs = new Map();
      const queue = [...targets];
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift();
          try {
            const up = uploads.get(String(t.uploadId));
            if (!up || !up.cloudUploadId) throw new Error('this clip was not processed on the server');
            const blob = await this._rerenderWithSettings(t, up, newId, bgmRefs, look);
            const newBlobId = videoStore.generateId('clip');
            await videoStore.saveBlob(newBlobId, blob, { clipIndex: t.partNumber != null ? t.partNumber - 1 : 0 });
            const updated = { ...t, blobId: newBlobId, design: { id: newId }, look, updatedAt: new Date().toISOString() };
            await db.put(STORES.CLIPS, updated);
            const ix = this.clips.findIndex((c) => c.id === t.id); if (ix >= 0) this.clips[ix] = updated;
            this._dropOldClipFile(t.blobId); // the old file is no longer used by anything
            done++;
          } catch (e) { failed++; if (!firstErr) firstErr = String((e && e.message) || e); console.warn('Design re-render failed for clip', t.id, e); }
          progress.textContent = `Re-rendering… ${done + failed} of ${targets.length}`;
        }
      };
      progress.textContent = `Re-rendering… 0 of ${targets.length}`;
      await Promise.all([worker(), worker()]);
      this.renderGrid();
      if (done) notify.success(`${hasItems || look ? 'Design applied' : 'Design removed'} on ${done} clip${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`);
      if (failed) notify.error(`${failed} clip${failed === 1 ? '' : 's'} could not be re-rendered: ${firstErr}`, 9000);
      if (done || !failed) this._closeDesign();
    } catch (e) {
      console.error('Apply design failed', e);
      notify.error(`Could not apply the design: ${String((e && e.message) || e)}`);
    } finally {
      this._designBusy = false; applyBtn.disabled = false; progress.textContent = '';
    }
  },

  // Basic editor for start/duration/overlay timing
  async openEdit(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      const modal = document.getElementById('audioMixModal'); // reuse structure styles; create lightweight inline form
      // Build a simple ephemeral editor modal next to Audio Mix modal
      let m = document.getElementById('editClipModal');
      if (!m) {
        const host = document.createElement('div');
        host.className = 'overlay-modal'; host.id = 'editClipModal';
        host.innerHTML = `
          <div class="modal-box" style="max-width:460px">
            <div class="modal-header"><span class="modal-title">Edit Clip</span><button class="modal-close" onclick="document.getElementById('editClipModal').classList.remove('show');window.app?._unlockBodyScroll?.()">✕</button></div>
            <div class="form-group"><label class="form-label">Start Time (seconds)</label><input class="form-input" id="editStart" type="number" step="0.1" min="0"></div>
            <div class="form-group"><label class="form-label">Duration (seconds of the source video)</label><input class="form-input" id="editDuration" type="number" step="0.1" min="1"><div class="form-hint" id="editDurationHint" style="font-size:11px;color:var(--muted);margin-top:4px"></div></div>
            <div class="form-group"><label class="form-label">Overlay Start (seconds)</label><input class="form-input" id="editOverlayStart" type="number" step="0.1" min="0"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
              <button class="btn btn-ghost" onclick="document.getElementById('editClipModal').classList.remove('show');window.app?._unlockBodyScroll?.()">Close</button>
              <button class="btn btn-primary" onclick="window.clipsUI.saveEdit()">Save</button>
            </div>
          </div>`;
        document.body.appendChild(host);
      }
      document.getElementById('editStart').value = String(clip.startTime.toFixed(1));
      const _up = await db.get(STORES.UPLOADS, clip.uploadId).catch(() => null);
      const _span = this._sourceSpan(clip, _up);
      const _sp = Number(this._lookFor(clip, _up)?.adjust?.speed) || 1;
      document.getElementById('editDuration').value = String(Number(_span).toFixed(1));
      document.getElementById('editDurationHint').textContent = Math.abs(_sp - 1) > 0.001 ? `Playback speed is ${_sp}x, so the finished clip is this divided by ${_sp} (${(_span / _sp).toFixed(1)} s).` : '';
      document.getElementById('editOverlayStart').value = String((clip.overlayStartSec || 0).toFixed(1));
      document.getElementById('editClipModal').dataset.clipId = String(clipId);
      document.getElementById('editClipModal').classList.add('show');
      window.app?._lockBodyScroll?.();
    } catch {}
  },

  async saveEdit() {
    const clipId = parseInt(document.getElementById('editClipModal')?.dataset?.clipId || '-1', 10);
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      const start = Math.max(0, parseFloat(document.getElementById('editStart')?.value || clip.startTime));
      const duration = Math.max(1, parseFloat(document.getElementById('editDuration')?.value || clip.duration));
      const overlayStartSec = Math.max(0, parseFloat(document.getElementById('editOverlayStart')?.value || 0));

      const upload = await db.get(STORES.UPLOADS, clip.uploadId);
      const useCloud = !!(upload && upload.cloudUploadId);
      const originalBlob = useCloud ? null : await videoStore.getBlob(upload.blobId);
      if (!useCloud && !originalBlob) { notify.error('Original video not found'); return; }

      const overlay = { format: clip.overlayFormat || 'none', partNumber: clip.partNumber, overlayStartSec };
      const aspect = clip.aspectRatio || 'original';
      // Preserve existing audio mix (if any) when re-generating the clip
      let newBlob;
      let bgm = null;
      const originalVolume = typeof clip.originalVolume === 'number' ? clip.originalVolume : 1;
      const bgmVolume = typeof clip.bgmVolume === 'number' ? clip.bgmVolume : 0.25;
      const restartAtClipStart = !!clip.bgmRestart;

      if (clip.bgmEnabled && clip.bgmSource) {
        if (clip.bgmSource.type === 'blob' && clip.bgmSource.blobId) {
          bgm = { type: 'blob', blobId: clip.bgmSource.blobId, volume: bgmVolume, loop: true };
        } else if (clip.bgmSource.type === 'url' && clip.bgmSource.url) {
          bgm = { type: 'url', url: clip.bgmSource.url, volume: bgmVolume, loop: true };
        }
      }

      if (useCloud) {
        // The full video lives on the server, so the clip is re-cut there with its saved settings.
        if (bgm) bgm.restart = restartAtClipStart;
        const { blob } = await clipGenerator.renderCloudClip(await getBackendBaseUrl(), upload.cloudUploadId, {
          start, duration, totalScore: clip.score || 0, audioScore: clip.audioScore || 0, sceneScore: clip.sceneScore || 0, sources: clip.sources || [],
        }, {
          aspectRatio: aspect, overlayFormat: clip.overlayFormat || 'none',
          partNumber: clip.partNumber != null ? clip.partNumber : 1, originalVolume, bgm, overlayStartSec,
          designId: this._designIdFor(clip, upload),
          look: this._lookFor(clip, upload),
          ...this._jobRef(clip, upload),
        });
        newBlob = blob;
      } else if (bgm) {
        newBlob = await videoProcessor._extractClipWithAudioMix(
          originalBlob,
          start,
          duration,
          null,
          overlay,
          aspect,
          { bgm, originalVolume, restartAtClipStart, bindSliders: false }
        );
      } else {
        newBlob = await videoProcessor._extractClipMediaRecorder(originalBlob, start, duration, null, overlay, aspect);
      }

      const newBlobId = videoStore.generateId('clip');
      await videoStore.saveBlob(newBlobId, newBlob, { clipIndex: clip.partNumber != null ? clip.partNumber - 1 : 0 });

      const spd = Number(this._lookFor(clip, upload)?.adjust?.speed) || 1;
      const updated = { ...clip, blobId: newBlobId, startTime: start, duration, outputDuration: useCloud ? duration / (spd > 0 ? spd : 1) : duration, overlayStartSec, updatedAt: new Date().toISOString() };
      await db.put(STORES.CLIPS, updated);
      this._dropOldClipFile(clip.blobId);
      const ix = this.clips.findIndex(c => c.id === clip.id); if (ix >= 0) this.clips[ix] = updated;
      document.getElementById('editClipModal')?.classList.remove('show');
      window.app?._unlockBodyScroll?.();
      this.renderGrid();
      notify.success('Clip updated');
    } catch (e) {
      notify.error(`Edit failed${e && e.message ? `: ${e.message}` : ''}`);
    }
  },

  openMix(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      document.getElementById('mixClipId').value = String(clip.id);
      const en = document.getElementById('mixBgmEnable');
      const srcRow = document.getElementById('mixBgmSrcRow');
      const volRow = document.getElementById('mixBgmVolRow');
      const restartRow = document.getElementById('mixRestartRow');
      const ovol = document.getElementById('mixOrigVol');
      const bvol = document.getElementById('mixBgmVol');
      if (ovol) {
        ovol.value = String(Math.round((clip.originalVolume != null ? clip.originalVolume : 1) * 100));
        try { ovol.dispatchEvent(new Event('input')); } catch {}
      }
      if (bvol) {
        bvol.value = String(Math.round((clip.bgmVolume != null ? clip.bgmVolume : 0.25) * 100));
        try { bvol.dispatchEvent(new Event('input')); } catch {}
      }
      if (en) en.checked = !!clip.bgmEnabled;
      const urlEl = document.getElementById('mixBgmUrl');
      if (urlEl && clip.bgmSource && clip.bgmSource.type === 'url' && clip.bgmSource.url) urlEl.value = clip.bgmSource.url;
      // Add a small note to show what BGM source is currently linked (cannot prefill file input)
      const oldNote = document.getElementById('mixBgmNote');
      if (oldNote) oldNote.remove();
      if (srcRow && (clip.bgmSource || en?.checked)) {
        let note = '';
        if (clip.bgmSource?.type === 'url' && clip.bgmSource.url) {
          try { const u = new URL(clip.bgmSource.url); note = `Using URL: ${u.host}`; } catch { note = 'Using URL source'; }
        } else if (clip.bgmSource?.type === 'blob') {
          note = 'Using uploaded audio (stored)';
        }
        if (note) {
          const el = document.createElement('div');
          el.id = 'mixBgmNote';
          el.style.cssText = 'margin-top:6px;font-size:11px;color:var(--muted)';
          el.textContent = note;
          srcRow.appendChild(el);
        }
      }
      
      // Trigger the preview update logic
      const fakeEvent = new Event('input');
      document.getElementById('mixBgmUrl')?.dispatchEvent(fakeEvent);

      if (srcRow) srcRow.style.display = en && en.checked ? 'block' : 'none';
      if (volRow) volRow.style.display = en && en.checked ? 'block' : 'none';
      if (restartRow) restartRow.style.display = en && en.checked ? 'block' : 'none';
      if (en) en.onchange = () => {
        const on = !!en.checked;
        if (srcRow) srcRow.style.display = on ? 'block' : 'none';
        if (volRow) volRow.style.display = on ? 'block' : 'none';
        if (restartRow) restartRow.style.display = on ? 'block' : 'none';
        const note = document.getElementById('mixBgmNote');
        if (note) note.style.display = on ? 'block' : 'none';
      };
      document.getElementById('audioMixModal')?.classList.add('show');
      window.app?._lockBodyScroll?.();
    } catch {}
  },

  async previewMix() {
    // Non-destructive WebAudio preview to speakers
    const id = parseInt(document.getElementById('mixClipId')?.value || '-1', 10);
    const clip = this.clips.find(c => c.id === id);
    if (!clip) return;
    try {
      if (this._mixPreviewCleanup) {
        try { this._mixPreviewCleanup(); } catch {}
        this._mixPreviewCleanup = null;
      }
      const origVolPct = parseInt(document.getElementById('mixOrigVol')?.value || '100');
      const originalVolume = Math.max(0, Math.min(1, origVolPct / 100));
      const en = !!document.getElementById('mixBgmEnable')?.checked;
      const url = (document.getElementById('mixBgmUrl')?.value || '').trim();
      const bgmFileEl = document.getElementById('mixBgmFile');
      const bgmFile = bgmFileEl && bgmFileEl.files && bgmFileEl.files[0] ? bgmFileEl.files[0] : null;
      const bgmVolPct = parseInt(document.getElementById('mixBgmVol')?.value || '25');
      const bgmVolume = Math.max(0, Math.min(1, bgmVolPct / 100));
      const restart = !!document.getElementById('mixBgmRestart')?.checked;

      let processedUrl = url;
      if (processedUrl && processedUrl.match(/tiktok\.com|youtube\.com|youtu\.be/i)) {
        try {
          const base = await getBackendBaseUrl();
          if (base) processedUrl = `${base}/api/audio?url=${encodeURIComponent(processedUrl)}`;
        } catch {}
      }

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.destination;
      const clipBlob = await videoStore.getBlob(clip.blobId);
      const clipObjUrl = URL.createObjectURL(clipBlob);
      const v = document.createElement('video');
      v.src = clipObjUrl;
      v.muted = true; v.playsInline = true;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
      await v.play().catch(()=>{});
      const vSrc = ctx.createMediaElementSource(v);
      const vGain = ctx.createGain(); vGain.gain.value = originalVolume; vSrc.connect(vGain).connect(dest);

      if (en) {
        const bGain = ctx.createGain(); bGain.gain.value = bgmVolume; bGain.connect(dest);
        try {
          if (bgmFile) {
            const buf = await ctx.decodeAudioData(await bgmFile.arrayBuffer());
            const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.connect(bGain); n.start(0, restart ? 0 : 0);
            this._mixPreviewCleanup = () => { try { n.stop(); } catch {}; try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
          } else if (processedUrl) {
            try {
              const res = await fetch(processedUrl); const arr = await res.arrayBuffer();
              const buf = await ctx.decodeAudioData(arr); const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.connect(bGain); n.start(0, restart ? 0 : 0);
              this._mixPreviewCleanup = () => { try { n.stop(); } catch {}; try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
            } catch {
              const el = document.createElement('audio'); el.crossOrigin = 'anonymous'; el.src = processedUrl; if (restart) { try { el.currentTime = 0; } catch {} } await el.play().catch(()=>{});
              const m = ctx.createMediaElementSource(el); m.connect(bGain);
              this._mixPreviewCleanup = () => { try { el.pause(); } catch {}; try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
            }
          }
        } catch {}
      }
      if (!this._mixPreviewCleanup) {
        this._mixPreviewCleanup = () => { try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
      }
    } catch (e) {
      console.warn('Preview mix failed', e);
      notify.error('Preview failed');
    }
  },

  async saveMix() {
    const id = parseInt(document.getElementById('mixClipId')?.value || '-1', 10);
    const clip = this.clips.find(c => c.id === id);
    if (!clip) return;
    try {
      const upload = await db.get(STORES.UPLOADS, clip.uploadId);
      if (!upload) { notify.error('Upload not found'); return; }
      const useCloud = !!upload.cloudUploadId;
      // Cloud-processed uploads never keep the full source video locally (that's the point
      // of cloud processing), so remixing re-renders on the backend from the same source
      // instead of requiring a local copy that was never saved.
      const originalBlob = useCloud ? null : await videoStore.getBlob(upload.blobId);
      if (!useCloud && !originalBlob) { notify.error('Original video not found'); return; }

      const bgmEnabled = !!document.getElementById('mixBgmEnable')?.checked;
      const origVolPct = parseInt(document.getElementById('mixOrigVol')?.value || '100');
      const originalVolume = Math.max(0, Math.min(1, origVolPct / 100));
      const bgmVolPct = parseInt(document.getElementById('mixBgmVol')?.value || '25');
      const bgmVolume = Math.max(0, Math.min(1, bgmVolPct / 100));
      const restart = !!document.getElementById('mixBgmRestart')?.checked;
      const url = (document.getElementById('mixBgmUrl')?.value || '').trim();
      const bgmFileEl = document.getElementById('mixBgmFile');
      const bgmFile = bgmFileEl && bgmFileEl.files && bgmFileEl.files[0] ? bgmFileEl.files[0] : null;

      let bgm = null;
      if (bgmEnabled) {
        if (bgmFile) {
          const idb = videoStore.generateId('bgm');
          await videoStore.saveBlob(idb, bgmFile, { name: bgmFile.name, type: bgmFile.type || 'audio' });
          bgm = { type: 'blob', blobId: idb, volume: bgmVolume, loop: true, restart };
        } else if (url) {
          bgm = { type: 'url', url, volume: bgmVolume, loop: true, restart };
        } else if (clip.bgmSource) {
          if (clip.bgmSource.type === 'blob') bgm = { type: 'blob', blobId: clip.bgmSource.blobId, volume: bgmVolume, loop: true, restart };
          else if (clip.bgmSource.type === 'url') bgm = { type: 'url', url: clip.bgmSource.url, volume: bgmVolume, loop: true, restart };
        }
        if (!bgm) {
          // Music is switched on but there is nothing to play. Say so instead of quietly rendering without it.
          notify.warn('Choose a music file or paste a link first, or switch "Include background music" off.');
          return;
        }
      }

      // Register the music with the server once, then reuse it for every clip being re-rendered.
      let bgmRef = null;
      if (useCloud && bgm) {
        bgmRef = await clipGenerator._cloudRegisterBgm(await getBackendBaseUrl(), bgm);
        if (!bgmRef) { notify.error('The background music could not be loaded. Check the file or link and try again.'); return; }
      }

      // Renders one clip with the chosen mix, on the backend for a cloud-processed upload
      // (re-rendering from the still-on-server source) or locally otherwise — same options,
      // same result, just a different engine underneath.
      const renderOne = async (t) => {
        if (useCloud) {
          const { blob } = await clipGenerator.renderCloudClip(await getBackendBaseUrl(), upload.cloudUploadId, {
            start: t.startTime, duration: this._sourceSpan(t, upload),
            totalScore: t.score || 0, audioScore: t.audioScore || 0, sceneScore: t.sceneScore || 0, sources: t.sources || [],
          }, {
            aspectRatio: t.aspectRatio || 'original', overlayFormat: t.overlayFormat || 'none',
            partNumber: t.partNumber != null ? t.partNumber : 1, originalVolume, bgmRef,
            overlayStartSec: t.overlayStartSec || 0,
            designId: this._designIdFor(t, upload),
            look: this._lookFor(t, upload),
            ...this._jobRef(t, upload),
          });
          return blob;
        }
        const overlay = { format: t.overlayFormat || 'none', partNumber: t.partNumber != null ? t.partNumber : null, overlayStartSec: t.overlayStartSec || 0 };
        const tAspect = t.aspectRatio || 'original';
        return bgm
          ? videoProcessor._extractClipWithAudioMix(originalBlob, t.startTime, t.duration, null, overlay, tAspect, { bgm, originalVolume, restartAtClipStart: restart, originalVolumeId: 'mixOrigVol', bgmVolumeId: 'mixBgmVol' })
          : videoProcessor._extractClipMediaRecorder(originalBlob, t.startTime, t.duration, null, overlay, tAspect);
      };

      const newBlob = await renderOne(clip);

      const newBlobId = videoStore.generateId('clip');
      await videoStore.saveBlob(newBlobId, newBlob, { clipIndex: clip.partNumber != null ? clip.partNumber - 1 : 0 });

      const updated = {
        ...clip,
        blobId: newBlobId,
        originalVolume,
        bgmVolume,
        bgmEnabled: !!bgm,
        bgmSource: bgm ? (bgm.type === 'blob' ? { type: 'blob', blobId: bgm.blobId } : { type: 'url', url: bgm.url }) : null,
        bgmRestart: restart,
        updatedAt: new Date().toISOString(),
      };
      await db.put(STORES.CLIPS, updated);
      this._dropOldClipFile(clip.blobId);
      const ix = this.clips.findIndex(c => c.id === clip.id);
      if (ix >= 0) this.clips[ix] = updated;
      try { window.dispatchEvent(new CustomEvent('clip:saved', { detail: updated })); } catch {}
      notify.success('Audio mix saved');
      document.getElementById('audioMixModal')?.classList.remove('show');
      window.app?._unlockBodyScroll?.();
      this.renderGrid();

      // Apply scope
      const scope = document.getElementById('mixScope')?.value || 'one';
      if (scope !== 'one') {
        const peers = this.clips.filter(c => c.uploadId === clip.uploadId);
        const targets = scope === 'all' ? peers : peers.filter(c => (c.partNumber || 0) > (clip.partNumber || 0));
        for (const t of targets) {
          if (t.id === clip.id) continue;
          try {
            const tBlob = await renderOne(t);
            const tBlobId = videoStore.generateId('clip');
            await videoStore.saveBlob(tBlobId, tBlob, { clipIndex: t.partNumber != null ? t.partNumber - 1 : 0 });
            const upd = { ...t, blobId: tBlobId, originalVolume, bgmVolume, bgmEnabled: !!bgm, bgmSource: updated.bgmSource, bgmRestart: restart, updatedAt: new Date().toISOString() };
            await db.put(STORES.CLIPS, upd);
            this._dropOldClipFile(t.blobId);
            const j = this.clips.findIndex(c => c.id === t.id); if (j >= 0) this.clips[j] = upd;
            try { window.dispatchEvent(new CustomEvent('clip:saved', { detail: upd })); } catch {}
          } catch (e) { console.warn('Apply mix failed for clip', t.id, e); }
        }
        this.renderGrid();
      }
    } catch (e) {
      console.error('Save mix failed', e);
      notify.error('Save failed');
    }
  },

  // Draws a still from the clip into its card. Each step is guarded so a clip that can't be
  // decoded ends up with a visible "can't preview" state instead of a permanent blank card.
  async generateThumbnail(clip) {
    try {
      const cached = this.thumbCache[clip.blobId];
      if (cached) { this._paintThumb(clip, cached); return; }
      if (!this._thumbJobs[clip.blobId]) {
        this._thumbJobs[clip.blobId] = this._makeThumb(clip.blobId)
          .then((res) => { this.thumbCache[clip.blobId] = res || 'failed'; return this.thumbCache[clip.blobId]; })
          .finally(() => { delete this._thumbJobs[clip.blobId]; });
      }
      const result = await this._thumbJobs[clip.blobId];
      this._paintThumb(clip, result);
    } catch (e) {
      console.warn('[ClipsUI] thumbnail failed', e);
      this._paintThumb(clip, 'failed');
    }
  },

  _paintThumb(clip, result) {
    // Look the card up now, not when the work started: the grid may have been rebuilt since.
    const preview = document.getElementById(`clip-preview-${clip.id}`);
    if (!preview || preview.querySelector('img.clip-thumb')) return;
    const ph = preview.querySelector('.clip-placeholder');
    if (result === 'failed' || !result) {
      if (ph) ph.innerHTML = '<div style="font-size:28px">⚠️</div><div style="font-size:11px;margin-top:6px;color:var(--muted);text-align:center;padding:0 12px">Preview not available.<br>Try Preview or Download.</div>';
      return;
    }
    if (ph) ph.remove();
    const img = document.createElement('img');
    img.className = 'clip-thumb';
    img.alt = '';
    img.src = result.url;
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block';
    preview.insertBefore(img, preview.firstChild);
    if (result.ratio > 0) preview.style.aspectRatio = String(result.ratio);
  },

  _makeThumb(blobId) {
    return (async () => {
      const blob = await videoStore.getBlob(blobId);
      if (!blob || !blob.size) return null;
      const objUrl = URL.createObjectURL(blob);
      try {
        return await new Promise((resolve) => {
          const v = document.createElement('video');
          v.muted = true; v.playsInline = true; v.preload = 'auto';
          let done = false;
          const finish = (val) => {
            if (done) return; done = true; clearTimeout(timer);
            v.removeAttribute('src'); try { v.load(); } catch {}
            resolve(val);
          };
          const timer = setTimeout(() => finish(null), 15000);
          const draw = () => {
            try {
              const vw = v.videoWidth; const vh = v.videoHeight;
              if (!vw || !vh) return finish(null);
              const k = Math.min(1, 480 / Math.max(vw, vh));
              const canvas = document.createElement('canvas');
              canvas.width = Math.max(2, Math.round(vw * k)); canvas.height = Math.max(2, Math.round(vh * k));
              canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
              finish({ url: canvas.toDataURL('image/jpeg', 0.8), ratio: vw / vh });
            } catch { finish(null); }
          };
          let seeked = false;
          v.addEventListener('loadedmetadata', () => {
            const d = Number.isFinite(v.duration) ? v.duration : 0;
            try { v.currentTime = d > 0 ? Math.min(1, d / 4) : 0.5; } catch { /* draw on loadeddata */ }
          }, { once: true });
          v.addEventListener('seeked', () => { seeked = true; draw(); }, { once: true });
          // If seeking never completes (some browsers), the first decoded frame is good enough.
          v.addEventListener('loadeddata', () => { setTimeout(() => { if (!seeked && !done && v.readyState >= 2) draw(); }, 1500); }, { once: true });
          v.addEventListener('error', () => finish(null), { once: true });
          v.src = objUrl;
        });
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    })();
  },

  async previewClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const blob = await videoStore.getBlob(clip.blobId);
    if (!blob) { notify.error('Clip blob not found'); return; }

    let url = this.previewUrls[clip.blobId];
    if (!url) { url = URL.createObjectURL(blob); this.previewUrls[clip.blobId] = url; }

    const modal = document.getElementById('previewModal');
    const vidEl = document.getElementById('previewVideo');
    if (modal && vidEl) {
      vidEl.onerror = () => notify.error("This clip can't be played in the browser. Try Download, or re-generate it.");
      vidEl.src = url;
      if (!modal.classList.contains('show')) window.app?._lockBodyScroll?.();
      modal.classList.add('show');
      vidEl.play().catch(() => {});
    }
  },

  async downloadClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const blob = await videoStore.getBlob(clip.blobId);
    if (!blob) { notify.error('Clip file not found'); return; }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : 'mp4';
    a.download = `clip_${clip.id}_${formatTime(clip.startTime).replace(':', 'm')}s.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  async scheduleClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    window.app?.openScheduleModal(clip);
  },

  async deleteClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const ok = await confirmAction({
      title: 'Delete this clip?',
      message: `You are about to permanently delete Clip #${clip.id}. This cannot be undone.`,
      confirmText: 'Yes, delete',
      cancelText: 'No',
      intent: 'danger',
    });
    if (!ok) return;

    await db.delete(STORES.CLIPS, clipId);
    await videoStore.deleteBlob(clip.blobId);
    delete this.thumbCache[clip.blobId];
    if (this.previewUrls[clip.blobId]) {
      URL.revokeObjectURL(this.previewUrls[clip.blobId]);
      delete this.previewUrls[clip.blobId];
    }

    this.clips = this.clips.filter(c => c.id !== clipId);
    document.getElementById(`clip-card-${clipId}`)?.remove();
    notify.success('Clip deleted');
  },
};

window.clipsUI = clipsUI;

// Live refresh + toast when a new clip is persisted
try {
  window.addEventListener('clip:saved', async (e) => {
    const clip = e?.detail;
    console.log('[ClipsUI] clip:saved event received', clip);
    try {
      await clipsUI.refresh();
      console.log('[ClipsUI] refresh after clip:saved completed');
    } catch (err) {
      console.error('[ClipsUI] refresh after clip:saved failed', err);
    }
    try {
      const name = clip?.title || `Clip (${clip?.id || ''})`;
      notify.success(`Saved: ${name}`);
    } catch {}
  });
} catch {}
