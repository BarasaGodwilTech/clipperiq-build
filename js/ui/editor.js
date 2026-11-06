// Preview & Edit card on the Upload screen.
//
//  1. Where to start: a draggable start / end on the video's timeline, with a live picture of the frame
//     you are on, so clips are generated from the part of the video you actually want.
//  2. Custom overlays: the shared designer (js/ui/designer.js) - text, stickers and your own images placed on
//     a preview of the output frame. The finished layer is one transparent PNG the server lays over every
//     clip, and the design itself is saved with the upload so it can be edited again from the Clips screen.
//     Your last design is also kept as a draft, so a page reload never loses it.
//
// The picture comes from the browser when it can play the file (instant), otherwise from the server
// (needed for formats like .ts that browsers can't play): the video is then sent to the server while you
// edit, and generation reuses that copy instead of uploading it again.
import { clipGenerator, buildSeriesCandidates } from '../core/clipGenerator.js';
import { designStore } from '../core/designStore.js';
import { DesignerPad } from './designer.js';
import { isDefaultFrame } from '../shared/framing.js';
import { isDefaultAdjust } from '../shared/adjust.js';
import { notify } from './notifications.js';
import { db } from '../storage/db.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
function fmtLong(sec) {
  const s = Math.max(0, Math.round(sec)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
// "83:20", "1:23:20" or plain seconds -> seconds (NaN if unreadable)
function parseTime(str) {
  const t = String(str || '').trim();
  if (!t) return NaN;
  const parts = t.split(':').map((x) => Number(x));
  if (parts.some((x) => !Number.isFinite(x) || x < 0)) return NaN;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

export const editorUI = {
  state: {
    file: null, mode: 'none', // none | probing | local | server | manual
    duration: 0, start: 0, end: 0, playhead: 0,
  },
  pad: null,
  _video: null, _img: null, _frameUrl: null, _frameAbort: null, _frameTimer: null,
  _seeking: false, _pendingSeek: null, _objUrl: null, _token: 0,

  $(id) { return document.getElementById(id); },

  init() {
    const card = this.$('editorCard');
    if (!card || card.dataset.ready) return;
    card.dataset.ready = '1';
    card.innerHTML = `
      <div class="card-title">Preview &amp; Edit</div>
      <div class="ed-sec-title">Where to start generating</div>
      <div class="ed-timeline-wrap">
        <div class="ed-timeline" id="edTimeline" aria-label="Video timeline">
          <div class="ed-track"></div>
          <div class="ed-range" id="edRange"></div>
          <div class="ed-playhead" id="edPlayhead"></div>
          <div class="ed-handle" id="edHStart" data-which="start" tabindex="0" role="slider" aria-label="Start point"><span>START</span></div>
          <div class="ed-handle ed-handle-end" id="edHEnd" data-which="end" tabindex="0" role="slider" aria-label="End point"><span>END</span></div>
        </div>
        <div class="ed-scale"><span>0:00</span><span id="edDurLabel"></span></div>
      </div>
      <div class="ed-times">
        <label>Start <input class="form-input ed-time" id="edStartIn" placeholder="0:00"></label>
        <label>End <input class="form-input ed-time" id="edEndIn" placeholder="end"></label>
        <button class="btn btn-ghost btn-sm" id="edSetStart" type="button" title="Use the frame shown in the preview as the start">Set start here</button>
        <button class="btn btn-ghost btn-sm" id="edSetEnd" type="button">Set end here</button>
        <button class="btn btn-ghost btn-sm" id="edReset" type="button">Reset</button>
      </div>
      <div class="ed-summary" id="edSummary"></div>
      <div id="edPadRoot"></div>`;

    this.pad = new DesignerPad(this.$('edPadRoot'), {
      ns: 'ed',
      getAspect: () => this._outputAspect(),
      // framing only applies when the output is reshaped; "original" keeps the video exactly as it is
      framingEnabled: () => (this.$('aspectRatio')?.value || '9:16') !== 'original',
      onAdjust: () => this._updateSummary(),
      captions: {
        // the words stay in the browser until Generate (they are sent with the job); the server only has them after "Generate from speech"
        autoSave: false,
        getUploadId: () => (this.state.file ? clipGenerator.getPreUploadId(this.state.file) : null),
        getRange: () => { const st = this.state; return st.file && st.end > st.start + 1 && (st.start > 0.5 || (st.duration && st.end < st.duration - 0.5)) ? { start: st.start, end: st.end } : null; },
        api: {
          engine: () => clipGenerator.captionEngine(),
          load: (id) => clipGenerator.loadCaptions(id),
          transcribe: async (o, onP, signal) => {
            const file = this.state.file;
            if (!file) throw new Error('Choose a video first.');
            let id = clipGenerator.getPreUploadId(file);
            if (!id) { // the server needs the video to listen to it
              onP({ text: 'Sending the video to the server… 0%' });
              id = await clipGenerator.waitPreUpload(file, (p) => { if (p && p.phase === 'uploading') onP({ text: `Sending the video to the server… ${Math.round(p.pct || 0)}%` }); });
            }
            return clipGenerator.transcribeCaptions(id, o, onP, signal);
          },
        },
      },
      // the caption words are kept as a draft for THIS video (name, size, date), so a reload does not lose corrections
      onCaptionCues: (cues) => { const k = this._capKey(); if (k) db.setSetting('caption_draft', JSON.stringify({ key: k, cues })).catch(() => {}); },
      getPartNumber: () => parseInt(this.$('seriesStartPart')?.value || '1', 10) || 1,
      getClipLength: () => parseInt(this.$('clipDuration')?.value || '30', 10) || 30,
      getAspectId: () => this.$('aspectRatio')?.value || '9:16', // lets the aspect-ratio rules (config/clip-adjustments.json) pick the framing
      // lets the preview behave like a TikTok player: tap to pause, scrub bar, sound
      player: {
        toggle: () => this.togglePlay(),
        isPlaying: () => !!this._video && !this._video.paused && this.state.mode === 'local',
        seek: (t) => this._showAt(t),
        time: () => this.state.playhead,
        duration: () => (this.state.mode === 'local' || this.state.mode === 'server' ? this.state.duration : 0),
      },
      onChange: (data) => designStore.saveDraft(data), // keeps the design through a page reload
      notify: (type, msg) => (notify[type] || notify.info).call(notify, msg),
    });
    this._video = this.pad.$('Video');
    this._img = this.pad.$('Img');
    this._bindTimeline();
    this._bindControls();
    this._bindPlay();

    // things outside the card that change what the preview / summary should show
    this.$('aspectRatio')?.addEventListener('change', () => this._applyAspect());
    this.$('overlayFormat')?.addEventListener('change', () => this.pad.setGhost(this.$('overlayFormat').value));
    for (const id of ['seriesMode', 'clipDuration', 'maxClips', 'cloudProcessing', 'seriesStartPart']) {
      this.$(id)?.addEventListener('change', () => { this._updateSummary(); this.pad?._syncPanels(); this.pad?._drawLT(); this.pad?.setGhost(this.$('overlayFormat')?.value || 'none'); });
      this.$(id)?.addEventListener('input', () => { this._updateSummary(); this.pad?._syncPanels(); this.pad?._drawLT(); this.pad?.setGhost(this.$('overlayFormat')?.value || 'none'); });
    }
    this._applyAspect();
    this.pad.setGhost(this.$('overlayFormat')?.value || 'none');

    // bring back the design that was being worked on before a reload
    designStore.loadDraft().then(async (d) => {
      const hasLook = d && ((Array.isArray(d.lowerThirds) ? d.lowerThirds.some((x) => x && x.enabled) : (d.lowerThird && d.lowerThird.enabled)) || (d.frame && !isDefaultFrame(d.frame)) || (d.adjust && !isDefaultAdjust(d.adjust)) || (d.captions && d.captions.enabled));
      if (d && ((Array.isArray(d.items) && d.items.length) || hasLook) && this.pad && !this.pad.hasItems() && !this.pad.getLook()) {
        await this.pad.load(d, { resetHistory: true });
        notify.info('Restored the design you were working on.');
      }
    }).catch(() => {});
  },

  // ── file ────────────────────────────────────────────────────────────────────────────
  _capKey() { const f = this.state && this.state.file; return f ? `${f.name}|${f.size}|${f.lastModified || 0}` : ''; },

  async _restoreCaptionDraft() {
    try {
      const raw = await db.getSetting('caption_draft'); const d = raw ? JSON.parse(raw) : null;
      if (d && d.key && d.key === this._capKey() && Array.isArray(d.cues) && d.cues.length && !this.pad.capCues.length) {
        this.pad.setCaptionCues(d.cues, { save: false, draft: false });
        notify.info('Your caption words for this video were restored.');
      }
    } catch { /* no draft */ }
  },

  async setFile(file) {
    this.init();
    const token = ++this._token;
    const st = this.state;
    this._clearMedia();
    Object.assign(st, { file, mode: 'probing', duration: 0, start: 0, end: 0, playhead: 0 });
    this.pad.setCaptionCues([], { save: false, draft: false }); // the previous video's words do not belong to this one
    this._restoreCaptionDraft();
    this.$('editorCard').style.display = 'block';
    this.pad.setStatus('Loading preview…');
    this._syncTimeline();
    this._updateSummary();

    // 1) the browser's own player (instant, no upload)
    const localOk = await this._tryLocal(file, token);
    if (token !== this._token) return;
    if (localOk) {
      st.mode = 'local';
      st.duration = this._video.duration;
      st.end = st.duration;
      this._img.style.display = 'none'; this._video.style.display = 'block';
      this.pad.$('Play').style.display = 'inline-flex';
      this.pad.setStatus('');
      this._applyAspect();
      this._afterReady();
      return;
    }

    // 2) the browser can't play this format: build the preview on the server
    st.mode = 'server';
    this._video.removeAttribute('src');
    this._video.style.display = 'none';
    this.pad.setStatus('This format can\'t play in the browser, so the preview is built on the server. Sending the video… 0%');
    try {
      const res = await clipGenerator.preUpload(file, (p) => {
        if (token !== this._token) return;
        if (p && p.phase === 'uploading') this.pad.setStatus(`Sending the video to the server for the preview… ${Math.round(p.pct || 0)}%`);
      });
      if (token !== this._token) return;
      if (!(res.duration > 0)) throw new Error('the server could not read how long this video is');
      st.duration = res.duration;
      st.end = res.duration;
      this.pad.setStatus('');
      this._afterReady();
    } catch (e) {
      if (token !== this._token) return;
      st.mode = 'manual';
      this.pad.setStatus(`Preview unavailable (${String((e && e.message) || e).slice(0, 120)}). You can still type a start time and design overlays.`);
      this._afterReady();
    }
  },

  _tryLocal(file, token) {
    return new Promise((resolve) => {
      const v = this._video;
      let done = false;
      const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); v.onloadeddata = v.onerror = null; resolve(ok); };
      const timer = setTimeout(() => finish(false), 4000);
      v.onerror = () => finish(false);
      v.onloadeddata = () => finish(v.videoWidth > 0 && Number.isFinite(v.duration) && v.duration > 0);
      try {
        this._objUrl = URL.createObjectURL(file);
        v.src = this._objUrl;
        v.load();
      } catch { finish(false); }
      if (token !== this._token) finish(false);
    });
  },

  _afterReady() {
    this._syncTimeline();
    this._updateSummary();
    this._showAt(this.state.start);
    this.pad.render();
  },

  _clearMedia() {
    clearTimeout(this._frameTimer);
    try { this._frameAbort?.abort(); } catch {}
    if (this._frameUrl) { try { URL.revokeObjectURL(this._frameUrl); } catch {} this._frameUrl = null; }
    if (this._objUrl) { try { URL.revokeObjectURL(this._objUrl); } catch {} this._objUrl = null; }
    if (this._video) { try { this._video.pause(); } catch {} this._video.removeAttribute('src'); this._video.load?.(); }
    if (this._img) { this._img.removeAttribute('src'); this._img.style.display = 'none'; }
    this._seeking = false; this._pendingSeek = null;
    const play = this.pad?.$('Play'); if (play) { play.style.display = 'none'; play.textContent = '▶ Play'; }
  },

  // ── preview picture ─────────────────────────────────────────────────────────────────
  _showAt(t) {
    const st = this.state;
    st.playhead = clamp(t, 0, st.duration || t);
    this._syncPlayhead();
    const cap = this.pad.$('Caption'); if (cap) cap.textContent = st.mode === 'manual' || st.mode === 'probing' ? '' : `Preview at ${fmtTime(st.playhead)}`;
    if (st.mode === 'local') {
      if (this._seeking) { this._pendingSeek = st.playhead; return; }
      this._seeking = true;
      this._video.onseeked = () => {
        this._seeking = false;
        if (this._pendingSeek != null) { const p = this._pendingSeek; this._pendingSeek = null; this._video.currentTime = p; this._seeking = true; }
      };
      try { this._video.currentTime = st.playhead; } catch { this._seeking = false; }
    } else if (st.mode === 'server') {
      clearTimeout(this._frameTimer);
      this._frameTimer = setTimeout(() => this._fetchFrame(st.playhead), 140);
    }
  },

  async _fetchFrame(t) {
    const id = clipGenerator.getPreUploadId(this.state.file);
    if (!id) return;
    try { this._frameAbort?.abort(); } catch {}
    const ctrl = new AbortController();
    this._frameAbort = ctrl;
    try {
      const blob = await clipGenerator.previewFrame(id, t, 540, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const old = this._frameUrl;
      this._img.onload = () => { this._applyAspect(); };
      this._img.src = url;
      this._img.style.display = 'block';
      this._frameUrl = url;
      if (old) setTimeout(() => { try { URL.revokeObjectURL(old); } catch {} }, 500);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      this.pad.setStatus('Couldn\'t load a preview picture for that moment.');
      setTimeout(() => this.pad.setStatus(''), 2500);
    }
  },

  _sourceAspect() {
    if (this.state.mode === 'local' && this._video && this._video.videoWidth) return this._video.videoWidth / this._video.videoHeight;
    if (this._img && this._img.naturalWidth) return this._img.naturalWidth / this._img.naturalHeight;
    return 16 / 9;
  },

  _outputAspect() {
    const v = this.$('aspectRatio')?.value || '9:16';
    const m = /^(\d+):(\d+)$/.exec(v);
    return m ? Number(m[1]) / Number(m[2]) : this._sourceAspect();
  },

  _applyAspect() { this.pad?.applyAspect(); },

  // ── timeline ────────────────────────────────────────────────────────────────────────
  _bindTimeline() {
    const tl = this.$('edTimeline');
    const timeAt = (clientX) => {
      const r = tl.getBoundingClientRect();
      return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * (this.state.duration || 0);
    };
    let drag = null;
    tl.addEventListener('pointerdown', (e) => {
      if (!(this.state.duration > 0)) return;
      const h = e.target.closest('.ed-handle');
      if (h) { drag = h.dataset.which; h.setPointerCapture(e.pointerId); e.preventDefault(); return; }
      this._showAt(timeAt(e.clientX)); // click the bar: look at that moment
    });
    tl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this._setBound(drag, timeAt(e.clientX), true);
    });
    const end = () => { drag = null; };
    tl.addEventListener('pointerup', end);
    tl.addEventListener('pointercancel', end);
    for (const h of [this.$('edHStart'), this.$('edHEnd')]) {
      h.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault(); e.stopPropagation();
          const w = h.dataset.which;
          this._setBound(w, this.state[w] + (e.key === 'ArrowLeft' ? -step : step), true);
        }
      });
    }
  },

  /** Moves the start or end, keeping them at least a second apart. */
  _setBound(which, t, preview) {
    const st = this.state;
    const dur = st.duration || Math.max(t, st.end, 1);
    if (which === 'start') st.start = clamp(t, 0, Math.max(0, (st.end || dur) - 1));
    else st.end = clamp(t, Math.min(dur, st.start + 1), dur);
    this._syncTimeline();
    this._updateSummary();
    if (preview) this._showAt(st[which]);
  },

  _syncTimeline() {
    const st = this.state;
    const dur = st.duration || 0;
    const pct = (t) => (dur > 0 ? (clamp(t, 0, dur) / dur) * 100 : 0);
    const hs = this.$('edHStart'); const he = this.$('edHEnd'); const rg = this.$('edRange');
    if (!hs) return;
    const on = dur > 0;
    this.$('edTimeline').classList.toggle('disabled', !on);
    hs.style.left = `${pct(st.start)}%`;
    he.style.left = `${on ? pct(st.end) : 100}%`;
    rg.style.left = `${pct(st.start)}%`;
    rg.style.width = `${on ? pct(st.end) - pct(st.start) : 100}%`;
    hs.setAttribute('aria-valuenow', String(Math.round(st.start)));
    he.setAttribute('aria-valuenow', String(Math.round(st.end)));
    this.$('edDurLabel').textContent = on ? fmtTime(dur) : '';
    const si = this.$('edStartIn'); const ei = this.$('edEndIn');
    if (document.activeElement !== si) si.value = fmtTime(st.start);
    if (document.activeElement !== ei) ei.value = on || st.end ? fmtTime(st.end) : '';
    this._syncPlayhead();
  },

  _syncPlayhead() {
    const st = this.state; const ph = this.$('edPlayhead');
    if (!ph) return;
    ph.style.display = st.duration > 0 ? 'block' : 'none';
    ph.style.left = `${st.duration > 0 ? (clamp(st.playhead, 0, st.duration) / st.duration) * 100 : 0}%`;
    this.pad?.updateTransport();
  },

  _updateSummary() {
    const el = this.$('edSummary');
    if (!el) return;
    const st = this.state;
    if (st.mode === 'probing' || st.mode === 'none') { el.textContent = ''; return; }
    const dur = st.duration;
    const end = st.end || dur;
    const whole = st.start < 0.5 && (!dur || end >= dur - 0.5);
    if (!dur && !st.end) {
      el.textContent = st.start > 0.5 ? `Clips will start at ${fmtTime(st.start)} and run to the end of the video.` : '';
      return;
    }
    const span = Math.max(0, end - st.start);
    let txt = whole ? `Using the whole video (${fmtLong(dur)}).` : `Clips will be made from ${fmtTime(st.start)} to ${fmtTime(end)} (${fmtLong(span)}).`;
    if (this.$('seriesMode')?.checked) {
      const target = parseInt(this.$('clipDuration')?.value || '30', 10) || 30;
      // with a playback-speed change each finished clip is cut from (length x speed) of the video
      const spd = this.$('cloudProcessing')?.checked ? (Number(this.pad?.adj?.speed) || 1) : 1;
      const parts = buildSeriesCandidates(span, target * spd, { minClipSec: 1 }).length;
      txt += ` ≈ ${parts} part${parts === 1 ? '' : 's'}.`;
    }
    el.textContent = txt;
  },

  _bindControls() {
    const reset = () => { this.state.start = 0; this.state.end = this.state.duration; this._syncTimeline(); this._updateSummary(); this._showAt(0); };
    this.$('edReset').addEventListener('click', reset);
    this.$('edSetStart').addEventListener('click', () => this._setBound('start', this.state.playhead, false));
    this.$('edSetEnd').addEventListener('click', () => this._setBound('end', this.state.playhead, false));
    const commit = (which) => (e) => {
      const v = parseTime(e.target.value);
      if (Number.isFinite(v)) this._setBound(which, v, true);
      else this._syncTimeline();
    };
    this.$('edStartIn').addEventListener('change', commit('start'));
    this.$('edEndIn').addEventListener('change', (e) => {
      if (!String(e.target.value).trim()) { this.state.end = this.state.duration; this._syncTimeline(); this._updateSummary(); return; }
      commit('end')(e);
    });
  },

  /** Play / pause the preview (the button under it, a tap on the picture and the space bar all come here). */
  togglePlay() {
    const v = this._video;
    if (this.state.mode !== 'local' || !v) return;
    if (v.paused) {
      if (v.currentTime >= (this.state.end || v.duration) - 0.2) v.currentTime = this.state.start;
      v.play().catch(() => {});
    } else v.pause();
  },

  _bindPlay() {
    const btn = this.pad.$('Play');
    const v = this._video;
    btn.addEventListener('click', () => this.togglePlay());
    v.addEventListener('play', () => { btn.textContent = '❚❚ Pause'; });
    v.addEventListener('pause', () => { btn.textContent = '▶ Play'; this.pad.updateTransport(); });
    v.addEventListener('timeupdate', () => {
      if (v.paused && this._seeking) return;
      this.state.playhead = v.currentTime; this._syncPlayhead();
      this.pad.$('Caption').textContent = `Preview at ${fmtTime(v.currentTime)}`;
      if (!v.paused && this.state.end && v.currentTime >= this.state.end) v.pause();
    });
  },

  // ── output for generation ───────────────────────────────────────────────────────────
  /** Draws every item into one transparent PNG at the output frame's shape (null if there are none). */
  async renderLayerBlob() { return this.pad ? this.pad.renderLayerBlob() : null; },

  /**
   * Everything generation needs from this card: the chosen window, the overlay layer (and the design it was
   * drawn from, so it can be edited again later) and the server copy of the source if one was sent for the
   * preview.
   */
  async getGenerateOptions(onProgress = null) {
    const st = this.state;
    const out = { rangeStart: 0, rangeEnd: 0, customOverlayBlob: null, design: null, look: null, captionCues: null, preUploadId: null };
    if (!st.file) return out;
    if (st.start > 0.5) out.rangeStart = st.start;
    if (st.end > st.start + 1 && (!st.duration || st.end < st.duration - 0.5)) out.rangeEnd = st.end;
    out.customOverlayBlob = await this.renderLayerBlob();
    out.look = this.pad.getLook(); // { frame, lowerThird, adjust, captions } or null
    out.captionCues = out.look && out.look.captions ? this.pad.getCaptionCues() : null;
    if (out.customOverlayBlob || out.look) out.design = { data: this.pad.serialize(), aspect: this.$('aspectRatio')?.value || '9:16' };
    out.preUploadId = clipGenerator.getPreUploadId(st.file) || (await clipGenerator.waitPreUpload(st.file, onProgress));
    return out;
  },
};
