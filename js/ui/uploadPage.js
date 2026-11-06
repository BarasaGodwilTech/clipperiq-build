// New Project screen: presentation layer only. All processing still runs through uploadUI (upload.js);
// every control keeps its original element id, so settings files, presets and the processing code are unaffected.
import { getBackendBaseUrl } from '../core/config.js';

const $ = (id) => document.getElementById(id);
const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec || 0)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};
const fmtBytes = (b) => b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
const SHAPES = { '9:16': '9:16 portrait', '4:5': '4:5 portrait', '1:1': '1:1 square', '16:9': '16:9 landscape', original: 'Original' };
const PRESETS = {
  shorts: { seriesMode: false, aspectRatio: '9:16', clipDuration: 30, maxClips: 6, overlayFormat: 'none' },
  series: { seriesMode: true, aspectRatio: '9:16', clipDuration: 60, overlayFormat: 'part-text' },
  square: { seriesMode: false, aspectRatio: '1:1', clipDuration: 30, maxClips: 6, overlayFormat: 'none' },
  wide:   { seriesMode: false, aspectRatio: '16:9', clipDuration: 120, maxClips: 5, overlayFormat: 'none' },
};

export const uploadPage = {
  file: null, duration: 0, serverOk: null, freeBytes: null, maxParts: 0, _thumbUrl: null, _timer: null, _inited: false,

  init() {
    if (this._inited || !$('view-upload')) return;
    this._inited = true;

    // sliders: live labels (the old inline handlers are gone)
    const bind = (id, fn) => { const e = $(id); if (e) { const run = () => { fn(e.value); this.refresh(); }; e.addEventListener('input', run); e.addEventListener('change', run); } };
    bind('maxClips', (v) => { $('maxClipsVal').textContent = v; });
    bind('seriesStartPart', (v) => { $('seriesStartPartVal').textContent = 'Part ' + v; });
    bind('clipDuration', (v) => { $('clipDurationVal').textContent = fmtClock(+v); });
    bind('origVolume', (v) => { $('origVolumeVal').textContent = v + '%'; });
    bind('bgmVolume', (v) => { $('bgmVolumeVal').textContent = v + '%'; const p = $('bgmPreview'); if (p) p.volume = Math.max(0, Math.min(1, v / 100)); });
    ['aspectRatio', 'overlayFormat', 'outputFormat', 'bgmUrl', 'bgmFile', 'fairUseCheck', 'seriesMode', 'uploadVideoTitle'].forEach((id) => {
      const e = $(id); if (e) { e.addEventListener('change', () => this.refresh()); e.addEventListener('input', () => this.refresh()); }
    });

    // zone keyboard access + the Change button
    const zone = $('uploadZone');
    zone?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput')?.click(); } });
    $('upFileChange')?.addEventListener('click', () => $('fileInput')?.click());
    // dropping a video anywhere on the page (not just the box) must not make the browser navigate away from the app
    ['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files') && !e.target.closest?.('#uploadZone')) { e.preventDefault(); } }));

    // series / smart mode switch (was inline JS in the HTML)
    $('seriesMode')?.addEventListener('change', () => this._applyMode());
    $('upMode')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]'); if (!b) return;
      const cb = $('seriesMode'); const want = b.dataset.mode === 'series';
      if (cb.checked !== want) { cb.checked = want; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    this._applyMode();

    // presets
    $('upPresets')?.addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) this.applyPreset(b.dataset.preset); });
    // duration chips
    $('upDurChips')?.addEventListener('click', (e) => { const b = e.target.closest('[data-sec]'); if (b) this._set('clipDuration', b.dataset.sec); });
    // aspect cards
    $('upAspects')?.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) this._set('aspectRatio', b.dataset.v); });

    // BGM preview
    $('bgmFile')?.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]; const a = $('bgmPreview'); if (!a) return;
      if (this._bgmUrl) { try { URL.revokeObjectURL(this._bgmUrl); } catch {} this._bgmUrl = null; }
      if (f) { this._bgmUrl = URL.createObjectURL(f); a.src = this._bgmUrl; a.style.display = 'block'; a.volume = Math.max(0, Math.min(1, ($('bgmVolume')?.value || 25) / 100)); } else { a.removeAttribute('src'); a.style.display = 'none'; }
    });

    $('speedProfile')?.addEventListener('change', () => this.refresh());
    window.addEventListener('online', () => this.checkServer());
    window.addEventListener('offline', () => this.checkServer());
    this.checkServer();
    this._timer = setInterval(() => { if (document.getElementById('view-upload')?.classList.contains('active') && !document.hidden) this.checkServer(); }, 15000);
    this.refresh();
  },

  _set(id, v) { const e = $(id); if (!e) return; e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); },

  applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    const cb = $('seriesMode'); if (cb && cb.checked !== p.seriesMode) { cb.checked = p.seriesMode; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    for (const [k, v] of Object.entries(p)) if (k !== 'seriesMode') this._set(k, v);
    this._activePreset = name; this.refresh();
  },

  _applyMode() {
    const series = !!$('seriesMode')?.checked;
    const show = (id, on) => { const e = $(id); if (e) e.style.display = on ? 'block' : 'none'; };
    show('smartClipsGroup', !series); show('seriesPartsGroup', series); show('seriesContinuationGroup', series);
    document.querySelectorAll('#upMode button').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.mode === 'series') === series)));
  },

  // called by uploadUI.handleFile
  setFile(file) {
    this.file = file; this.duration = 0;
    const zone = $('uploadZone'); zone?.classList.add('has-file');
    const t = zone?.querySelector('.upload-title'); const s = zone?.querySelector('.upload-sub');
    if (t) t.textContent = 'Drop a different video to replace it'; if (s) s.textContent = 'or click to browse';
    const card = $('upFile'); if (card) card.hidden = false;
    $('upFileName').textContent = file.name || 'video';          // textContent: file names can never inject markup
    $('upFileMeta').textContent = `${fmtBytes(file.size)} · reading…`;
    const warn = $('upFileWarn'); if (warn) { warn.hidden = true; warn.textContent = ''; }
    this._probe(file);
    this.refresh();
  },

  _probe(file) {
    const thumb = $('upFileThumb'); if (!thumb) return;
    if (this._thumbUrl) { try { URL.revokeObjectURL(this._thumbUrl); } catch {} this._thumbUrl = null; }
    const url = URL.createObjectURL(file); this._thumbUrl = url;
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
    const done = () => { v.removeAttribute('src'); try { v.load(); } catch {} };
    let settled = false;
    const fail = () => { if (settled) return; settled = true; $('upFileMeta').textContent = `${fmtBytes(file.size)} · preview unavailable in this browser (the server can still read it)`; done(); };
    const t = setTimeout(fail, 8000);
    v.addEventListener('error', () => { clearTimeout(t); fail(); });
    v.addEventListener('loadedmetadata', () => {
      if (settled) return; this.duration = Number.isFinite(v.duration) ? v.duration : 0;
      const dim = v.videoWidth && v.videoHeight ? ` · ${v.videoWidth}×${v.videoHeight}` : '';
      $('upFileMeta').textContent = `${fmtBytes(file.size)}${this.duration ? ' · ' + fmtClock(this.duration) : ''}${dim}`;
      if (this.duration && this.duration < 5) { const w = $('upFileWarn'); w.hidden = false; w.textContent = 'This video is very short. Clips need at least a few seconds to work with.'; }
      try { v.currentTime = Math.min(1, (this.duration || 2) / 2); } catch {}
      this.refresh();
    });
    v.addEventListener('seeked', () => {
      if (settled) return; settled = true; clearTimeout(t);
      try {
        const c = document.createElement('canvas'); c.width = 176; c.height = 100; c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        thumb.innerHTML = ''; const img = new Image(); img.alt = ''; img.src = c.toDataURL('image/jpeg', 0.7); thumb.appendChild(img);
      } catch { /* keep the placeholder */ }
      done();
    });
  },

  async checkServer() {
    const el = $('upServer'), txt = $('upServerText');
    if (!el || !txt) return;
    try {
      const base = await getBackendBaseUrl();
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${base}/healthz`, { cache: 'no-store', signal: ctrl.signal }); clearTimeout(to);
      this.serverOk = r.ok;
    } catch { this.serverOk = false; }
    if (this.serverOk) {
      // free disk space and the per-job clip limit, so a doomed run is caught BEFORE a long upload
      try {
        const base = await getBackendBaseUrl();
        const [st, cf] = await Promise.all([
          fetch(`${base}/api/storage`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
          fetch(`${base}/api/config/public`, { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
        ]);
        this.freeBytes = st && Number.isFinite(st.freeBytes) ? st.freeBytes : null;
        this.maxParts = cf && cf.maxClipsPerJob ? cf.maxClipsPerJob : 0;
      } catch { /* optional information */ }
    }
    el.classList.toggle('is-ok', this.serverOk === true); el.classList.toggle('is-bad', this.serverOk === false);
    txt.textContent = this.serverOk ? 'Server online' : 'Server not reachable';
    this.refresh();
  },

  // Problems that would make the run fail (or fill the disk), found before anything is uploaded.
  problem() {
    if (!this.file) return '';
    const series = !!$('seriesMode')?.checked; const dur = parseInt($('clipDuration')?.value || '30', 10);
    if (series && this.duration && this.maxParts) {
      const n = Math.ceil(this.duration / Math.max(1, dur - 3));
      if (n > this.maxParts) {
        const minLen = Math.ceil(this.duration / this.maxParts) + 3;
        return `That would make about ${n} parts, but the server allows ${this.maxParts} per run. Use clips of at least ${minLen} seconds, or raise MAX_CLIPS_PER_JOB.`;
      }
    }
    if (this.freeBytes != null && this.file.size > this.freeBytes * 0.9) {
      return `The server drive has only ${fmtBytes(this.freeBytes)} free and this video is ${fmtBytes(this.file.size)}. Free up space or choose a bigger drive in Settings > Storage location.`;
    }
    return '';
  },

  isReady() { return !!(this.file && $('fairUseCheck')?.checked && this.serverOk !== false && !this.problem()); },

  refresh() {
    if (!$('view-upload')) return;
    const series = !!$('seriesMode')?.checked;
    const dur = parseInt($('clipDuration')?.value || '30', 10);
    const max = parseInt($('maxClips')?.value || '6', 10);
    const start = parseInt($('seriesStartPart')?.value || '1', 10);
    const aspect = $('aspectRatio')?.value || '9:16';

    // summary
    $('sumFile').textContent = this.file ? this.file.name : 'None chosen yet';
    $('sumLen').textContent = this.duration ? fmtClock(this.duration) : '—';
    $('sumMode').textContent = series ? 'Series (whole video)' : 'Best moments';
    let clips = '—';
    if (series) { if (this.duration) { const n = Math.max(1, Math.ceil(this.duration / dur)); clips = `${n} part${n === 1 ? '' : 's'} (Part ${start}–${start + n - 1})`; } else clips = 'All parts'; }
    else clips = `Up to ${max}`;
    $('sumClips').textContent = clips;
    $('sumDur').textContent = fmtClock(dur);
    $('sumShape').textContent = SHAPES[aspect] || aspect;

    // chips / cards / presets reflect the real control values
    document.querySelectorAll('#upDurChips [data-sec]').forEach((b) => b.classList.toggle('is-on', +b.dataset.sec === dur));
    document.querySelectorAll('#upAspects [data-v]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === aspect)));
    document.querySelectorAll('#upPresets [data-preset]').forEach((b) => { const p = PRESETS[b.dataset.preset]; const on = p.seriesMode === series && p.aspectRatio === aspect && p.clipDuration === dur; b.classList.toggle('is-on', on); });

    // BGM hint
    const hasBgm = !!(($('bgmUrl')?.value || '').trim() || $('bgmFile')?.files?.[0]);
    const hint = $('upBgmHint'); if (hint) hint.hidden = hasBgm || !(parseInt($('bgmVolume')?.value || '0', 10) > 0);

    // checklist + button
    const rights = !!$('fairUseCheck')?.checked;
    const set = (k, state) => { const li = document.querySelector(`#upCheck [data-k="${k}"]`); if (li) { li.classList.toggle('ok', state === true); li.classList.toggle('bad', state === false); } };
    set('file', !!this.file); set('server', this.serverOk === null ? null : this.serverOk); set('rights', rights);
    const spLi = document.querySelector('#upCheck [data-k="space"]'); const prob = this.problem();
    if (spLi) { spLi.hidden = !(this.file && (this.freeBytes != null || this.maxParts)); set('space', !prob);
      const t = $('upSpaceTxt'); if (t) t.textContent = prob ? 'A problem to fix first' : (this.freeBytes != null ? `Enough disk space (${fmtBytes(this.freeBytes)} free)` : 'Settings look fine'); }
    const btn = $('processBtn'); const busy = !!window.uploadUI?.isProcessing;
    const ready = this.isReady() && !busy;
    if (btn) { btn.disabled = !ready; btn.style.opacity = ''; }
    const lbl = $('processBtnLabel'); if (lbl) lbl.textContent = busy ? 'Processing…' : (series ? 'Generate series' : 'Generate clips');
    const why = $('upWhy');
    if (why) why.textContent = busy ? 'A video is being processed. You can reopen its window from the badge at the bottom right.'
      : !this.file ? 'Choose a video to begin.'
      : prob ? prob
      : this.serverOk === false ? 'Start the ClipperIQ server (start.bat, or open the desktop app), then this button unlocks.'
      : !rights ? 'Confirm you have the rights to this video to continue.' : 'Ready. Your video is sent to the server and processed there.';

    // stepper
    const stage = !this.file ? 1 : (ready || busy ? 3 : 2);
    document.querySelectorAll('#upSteps .up-step').forEach((li) => { const n = +li.dataset.step; li.classList.toggle('is-active', n === stage); li.classList.toggle('is-done', n < stage); });
  },
};
window.uploadPage = uploadPage;
