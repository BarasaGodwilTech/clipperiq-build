// The overlay designer: a preview "stage" in the shape of the output video plus the tools to put text,
// stickers (emoji) and images on it. Used in two places - the Upload screen's Preview & Edit card and the
// Clips screen's Design window - so both look and behave the same and produce the same kind of layer.
//
// What it produces: a serialisable design (data you can reopen and edit) and, on demand, one transparent PNG
// drawn from it. The server lays that PNG over a clip, so the video matches the preview.
import { designStore } from '../core/designStore.js';
import { confirmAction } from './notifications.js';
import { normalizeFrame, isDefaultFrame, videoRect, defaultFrame, FRAME_PRESETS } from '../shared/framing.js';
import { normalizeAdjust, defaultAdjust, isDefaultAdjust, effectiveFrame, previewStyle, aspectPlan } from '../shared/adjust.js';
import {
  normalizeLowerThird, normalizeLowerThirds, defaultLowerThird, drawLowerThird, measureLowerThird, lowerThirdTimeline, autoY, resolveLowerThird, lowerThirdWindows, timingPatch, MAX_LOWER_THIRDS,
} from '../shared/lowerThird.js';
import { mountFramingPanel, mountLowerThirdPanel, ensureLowerThirdFonts } from './lookPanels.js';
import { mountAdjustPanel } from './adjustPanel.js';
import { mountCaptionsPanel } from './captionsPanel.js';
import { defaultCaptionStyle, normalizeCaptionStyle, normalizeCaptions, normalizeCues, pagesOf, pageAt, drawCaptionPage, ensureCaptionFonts } from '../shared/captions.js';

export const FONTS = [
  ['Impact', 'Impact, "Arial Narrow Bold", sans-serif'],
  ['Arial Black', '"Arial Black", Arial, sans-serif'],
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Segoe UI', '"Segoe UI", Roboto, Arial, sans-serif'],
  ['Georgia', 'Georgia, serif'],
  ['Trebuchet', '"Trebuchet MS", Arial, sans-serif'],
  ['Comic Sans', '"Comic Sans MS", "Comic Neue", cursive'],
  ['Courier', '"Courier New", monospace'],
];
const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const EMOJIS = ['🔥', '❤️', '😂', '😍', '😎', '🤯', '😱', '👀', '💯', '✅', '❌', '⚡', '⭐', '🌟', '💥', '🎬', '🍿', '🎵', '🎶', '🏆', '👑', '💎', '🚨', '⚠️', '❗', '❓', '➡️', '⬅️', '⬆️', '⬇️', '👉', '👈', '👆', '👇', '👍', '👎', '👏', '🙌', '🙏', '💪', '🤝', '😭', '🥵', '🥶', '😈', '💀', '👻', '🤡', '🎉', '🎁', '💰', '📈', '🔔', '📌', '✨', '🌈', '☀️', '🌙', '🔴', '🟢', '🔵', '▶️', '⏩', '⏭️'];
export const LAYER_WIDTH = 1080; // the layer PNG is drawn this wide; the server scales it to the clip
const MAX_IMAGE_PX = 1200;       // pictures added to a design are shrunk to this, to keep designs light
const HISTORY_LIMIT = 60;

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let uid = 0;
const newItem = (type, extra) => ({ id: `it${Date.now().toString(36)}${++uid}`, type, x: 0.5, y: 0.5, rot: 0, opacity: 1, ...extra });

/** Reads an image file into a (possibly shrunk) data URL, so designs are self-contained and can be saved. */
export function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('read failed'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('not an image'));
      img.onload = () => {
        const k = Math.min(1, MAX_IMAGE_PX / Math.max(img.naturalWidth, img.naturalHeight));
        if (k >= 1) { resolve({ url: String(fr.result), img }); return; }
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        const jpeg = /jpe?g/i.test(file.type);
        const url = cv.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92);
        const small = new Image();
        small.onload = () => resolve({ url, img: small });
        small.src = url;
      };
      img.src = String(fr.result);
    };
    fr.readAsDataURL(file);
  });
}

export class DesignerPad {
  /**
   * @param {HTMLElement} root   element to build the designer in
   * @param {object} opts
   *   ns         id prefix for the elements (must differ between two pads on the page)
   *   getAspect  () => width/height of the output frame
   *   onChange   (serialised design) called (debounced) after every edit
   *   notify     (type, message) for small messages
   *   player     optional { toggle(), isPlaying(), seek(sec), time(), duration() }: lets the preview behave like a
   *              TikTok player (tap to pause, scrub bar). Without it the player controls stay hidden.
   *   framingEnabled  () => bool; false when the output keeps the original shape (framing has no effect then)
   *   getAspectId     optional () => '9:16' | '1:1' | ... | 'original': the chosen aspect ratio (for the aspect-ratio rules)
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.ns = opts.ns || 'dz';
    this.getAspect = opts.getAspect || (() => 9 / 16);
    this.onChange = opts.onChange || null;
    this.notify = opts.notify || (() => {});
    this.player = opts.player || null;
    this._framingEnabled = opts.framingEnabled || (() => true);
    this.getAspectId = opts.getAspectId || null;
    this._onAdjust = opts.onAdjust || null;
    // opts.captions: { getUploadId() -> server upload id or null, ensureUploadId(onProgress) -> id (sends the video if needed), getRange() -> { start, end } seconds,
    //                  previewTime() -> source second to show a caption for (when there is no player), save(cues) + autoSave: keep the words on the server as they change }
    this._capCfg = opts.captions || {};
    this._onCues = opts.onCaptionCues || null; // called (after a short pause) with the caption words whenever they change
    this._getPart = opts.getPartNumber || null;     // the part number of the first clip: what {part} / {next} in the lower third show
    this._getClipLen = opts.getClipLength || null;  // how long a finished clip is (seconds): where "near the end" is
    this.frame = defaultFrame();          // how the video sits in the frame (js/shared/framing.js)
    this.lts = [defaultLowerThird()];     // the animated lower thirds of a clip (js/shared/lowerThird.js); `lt` is the one being edited
    this.ltSel = 0;
    this._ltScrub = null;                 // a moment of the clip (s) the preview shows ALL lower thirds at, or null (the edited one in its showing pose)
    this.adj = defaultAdjust();           // clip adjustments: speed, pitch, flip, scale, colour, reverb (js/shared/adjust.js)
    this.cap = { enabled: false, template: '', style: defaultCaptionStyle() }; // auto captions: the look (the words are capCues)
    this.capCues = [];                    // the caption words on the SOURCE video's timeline: [{ s, e, text, words? }]
    this._capKey = ''; this._capPages = [];
    this.autoLtPlay = true;               // replay the lower third's animation by itself when its motion or timing changes
    try { if (localStorage.getItem('clipperiq.ltAutoPlay') === '0') this.autoLtPlay = false; } catch { /* storage blocked */ }
    this.autoAspect = true;               // let the aspect ratio choose the framing (config/clip-adjustments.json: aspectRules)
    this._autoFrameKey = null;            // the framing the aspect rules put in place (so a framing the person set is never overwritten)
    this.aspectNote = '';
    this.items = [];
    this.selected = null;
    this._hist = []; this._histIdx = -1; this._histTimer = null; this._changeTimer = null;
    this._templates = [];
    this._mount();
  }

  $(name) { return document.getElementById(this.ns + name); }

  // ── layout ──────────────────────────────────────────────────────────────────────────
  _mount() {
    const n = this.ns;
    this.root.innerHTML = `
      <div class="ed-grid">
        <div class="ed-left">
          <div class="ed-stage" id="${n}Stage">
            <canvas class="ed-bg" id="${n}Bg" width="64" height="114"></canvas>
            <video id="${n}Video" muted playsinline preload="auto"></video>
            <img id="${n}Img" alt="" draggable="false">
            <canvas class="ed-lt" id="${n}LT"></canvas>
            <canvas class="ed-cap" id="${n}Cap"></canvas>
            <div class="ed-lt-handle" id="${n}LTHandle" title="Drag to move the lower third"></div>
            <div class="ed-safe" id="${n}Safe" style="display:none" title="Approximate area TikTok keeps free of its own buttons and caption"></div>
            <div class="ed-ghost" id="${n}Ghost"></div>
            <div class="ed-layer" id="${n}Layer">
              <div class="ed-guide ed-guide-v" id="${n}GuideV"></div><div class="ed-guide ed-guide-h" id="${n}GuideH"></div>
            </div>
            <div class="ed-tt" id="${n}TT" style="display:none" aria-hidden="true">
              <div class="ed-tt-top"><span>Following</span><b>For You</b></div>
              <div class="ed-tt-rail"><i class="ed-tt-av"></i><span>&#9829;<small>1.2M</small></span><span>&#128172;<small>8,431</small></span><span>&#10150;<small>Share</small></span></div>
              <div class="ed-tt-cap"><b>@yourchannel</b><span class="ed-tt-l1"></span><span class="ed-tt-l2"></span></div>
              <div class="ed-tt-nav"><span></span><span></span><span></span><span></span><span></span></div>
            </div>
            <div class="ed-flash" id="${n}Flash"></div>
            <div class="ed-ctl" id="${n}Ctl" style="display:none">
              <button type="button" class="ed-ctl-btn" id="${n}Mute" title="Sound on / off" aria-label="Sound on or off">&#128263;</button>
              <span class="ed-ctl-time" id="${n}CtlTime">0:00</span>
              <div class="ed-scrub" id="${n}Scrub" role="slider" aria-label="Seek" tabindex="0"><div class="ed-scrub-fill" id="${n}ScrubFill"></div><div class="ed-scrub-knob" id="${n}ScrubKnob"></div></div>
            </div>
            <div class="ed-status" id="${n}Status"></div>
          </div>
          <div class="ed-caption" id="${n}Caption"></div>
          <div class="ed-under">
            <button class="btn btn-ghost btn-sm" id="${n}LtReplay" type="button" style="display:none" title="Play the lower third's animation again">&#9654; Lower third</button>
            <button class="btn btn-ghost btn-sm" id="${n}Play" type="button" style="display:none">▶ Play</button>
            <label class="ed-check" title="Shows the area TikTok usually keeps clear of its buttons and caption (approximate)"><input type="checkbox" id="${n}SafeToggle"> Safe area</label>
            <label class="ed-check" title="Overlays a mock TikTok screen (buttons, caption, tabs) so you can judge the layout"><input type="checkbox" id="${n}TTToggle"> TikTok view</label>
          </div>
        </div>
        <div class="ed-right">
          <div id="${n}FrRoot"></div>
          <div id="${n}AdRoot"></div>
          <div id="${n}LtRoot"></div>
          <div id="${n}CpRoot"></div>
          <div class="ed-sec-title" style="margin-top:12px">Custom overlays</div>
          <div class="ed-add">
            <button class="btn btn-ghost btn-sm" id="${n}AddText" type="button">T&nbsp; Text</button>
            <button class="btn btn-ghost btn-sm" id="${n}AddImage" type="button">🖼&nbsp; Image</button>
            <button class="btn btn-ghost btn-sm" id="${n}AddEmoji" type="button">😀&nbsp; Sticker</button>
            <span class="ed-spacer"></span>
            <button class="btn btn-ghost btn-sm" id="${n}Undo" type="button" title="Undo (Ctrl+Z)" disabled>↶</button>
            <button class="btn btn-ghost btn-sm" id="${n}Redo" type="button" title="Redo (Ctrl+Y)" disabled>↷</button>
            <input type="file" id="${n}ImageFile" accept="image/*" style="display:none">
          </div>
          <div class="ed-emoji" id="${n}EmojiPanel" style="display:none">${EMOJIS.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('')}</div>
          <div class="ed-tpl">
            <select class="form-input form-select" id="${n}Tpl" aria-label="Saved designs"><option value="">Saved designs…</option></select>
            <button class="btn btn-ghost btn-sm" id="${n}TplApply" type="button" disabled>Use</button>
            <button class="btn btn-ghost btn-sm" id="${n}TplDel" type="button" disabled title="Delete this saved design">🗑</button>
            <button class="btn btn-ghost btn-sm" id="${n}TplSave" type="button">Save this design</button>
          </div>
          <div class="ed-tpl-name" id="${n}TplNameRow" style="display:none">
            <input class="form-input" id="${n}TplName" placeholder="Name, e.g. Channel watermark" maxlength="40">
            <button class="btn btn-primary btn-sm" id="${n}TplOk" type="button">Save</button>
          </div>
          <div class="ed-props" id="${n}Props"></div>
          <div class="ed-hint" id="${n}Hint">Add text, stickers or your own images (a logo, a watermark). Drag them on the preview to place them; they appear on every clip.</div>
        </div>
      </div>`;
    this._bindStage();
    this._bindPlayer();
    this._bindControls();
    this._panels = [mountFramingPanel(this, this.$('FrRoot')), mountAdjustPanel(this, this.$('AdRoot')), mountLowerThirdPanel(this, this.$('LtRoot')), mountCaptionsPanel(this, this.$('CpRoot'))];
    this._syncPanels();
    ensureLowerThirdFonts().then(() => this._drawLT());
    ensureCaptionFonts().then(() => this._drawCaps());
    this.refreshTemplates();
    this.applyAspect();
    this._hist = [this._snapshot()]; this._histIdx = 0; this._syncHistBtns(); // the empty design is the first undo state
  }

  destroy() {
    clearTimeout(this._histTimer); clearTimeout(this._changeTimer); clearTimeout(this._ltAutoT); clearTimeout(this._capSaveT); clearTimeout(this._capCueT);
    cancelAnimationFrame(this._ltRaf); cancelAnimationFrame(this._bgRaf);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('keydown', this._keyHandler);
    this.root.innerHTML = '';
  }

  // ── stage ───────────────────────────────────────────────────────────────────────────
  applyAspect() {
    const stage = this.$('Stage');
    if (!stage) return;
    const ar = this.getAspect();
    stage.style.aspectRatio = String(ar);
    // the preview is sized for the screen: full size beside the controls on a wide screen, a small pinned one on a phone
    const maxW = this._maxStageW();
    stage.style.width = `${Math.round(ar >= 1 ? maxW * Math.min(1.6, ar) : Math.min(maxW, maxW * (ar / (9 / 16))))}px`;
    stage.style.setProperty('--ed-w', `${stage.clientWidth || 250}px`);
    this.render();
    this._layoutMedia();
    this._drawLT();
    this.applyAspectRules();
    this._syncPanels();
  }

  setStatus(msg) {
    const el = this.$('Status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'flex' : 'none';
  }

  setGhost(fmt) {
    const g = this.$('Ghost');
    if (!g) return;
    if (fmt === 'part-text') { g.style.display = 'block'; g.className = 'ed-ghost ed-ghost-part'; g.textContent = `PART ${(() => { try { return Number(this._getPart && this._getPart()) || 1; } catch { return 1; } })()}`; g.title = 'Where the PART number appears (first seconds of each clip)'; }
    else if (fmt === 'styled-number') { g.style.display = 'block'; g.className = 'ed-ghost ed-ghost-num'; g.textContent = '1'; }
    else g.style.display = 'none';
  }

  stageW() { return this.$('Stage')?.clientWidth || 230; }

  _bindStage() {
    const stage = this.$('Stage');
    stage.addEventListener('pointerdown', (e) => {
      if (['Stage', 'Video', 'Img', 'Layer', 'Ghost', 'Safe', 'LT', 'Bg'].some((s) => e.target.id === this.ns + s)) this.select(null);
    });
    this.$('LtReplay').addEventListener('click', () => this.previewLowerThird());
    this.$('SafeToggle').addEventListener('change', (e) => { this.$('Safe').style.display = e.target.checked ? 'block' : 'none'; });
    // keyboard: delete, nudge, undo/redo. Only while this pad is on screen and not typing in a field.
    this._keyHandler = (e) => {
      if (!this.$('Stage')?.offsetParent) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !typing && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (mod && !typing && (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); this.redo(); return; }
      if (typing || !this.selected) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.remove(this.selected); return; }
      const it = this.get(this.selected);
      const step = e.shiftKey ? 0.02 : 0.004;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (it && moves[e.key] && !document.activeElement?.classList?.contains('ed-handle')) {
        e.preventDefault(); it.x = clamp(it.x + moves[e.key][0], 0, 1); it.y = clamp(it.y + moves[e.key][1], 0, 1); this.render(); this._commitSoon();
      }
    };
    document.addEventListener('keydown', this._keyHandler);
    this._onResize = () => { if (this.$('Stage')?.offsetParent) this.applyAspect(); };
    window.addEventListener('resize', this._onResize);
  }

  // ── look: framing, lower third, TikTok-style player ────────────────────────────────────
  framingEnabled() { try { return !!this._framingEnabled(); } catch { return true; } }
  lowerThirdAutoY() { const s = this.$('Stage'); return autoY(s?.clientWidth || 9, s?.clientHeight || 16); }
  _syncPanels() { for (const p of this._panels || []) { try { p.sync(); } catch { /* a panel must never break the pad */ } } }

  /** Changes the framing: any of { mode, bg, color, zoom, x, y }. */
  setFrame(patch, { commit = true } = {}) {
    this.frame = normalizeFrame({ ...this.frame, ...patch });
    this._layoutMedia(); this._syncPanels();
    if (commit) this._commitSoon();
  }

  // ── auto captions ──────────────────────────────────────────────────────────────────────

  /** Changes the caption look / switches captions on or off (see js/shared/captions.js for the fields). */
  setCaptions(patch, { commit = true } = {}) {
    const next = { ...this.cap, ...patch };
    if (patch && patch.style) next.style = normalizeCaptionStyle({ ...this.cap.style, ...patch.style });
    this.cap = { enabled: !!next.enabled, template: String(next.template || ''), style: normalizeCaptionStyle(next.style) };
    this._drawCaps(); this._syncPanels();
    if (commit) this._commitSoon();
  }

  /** Replaces the caption words (source timeline). `save`: also keep them on the server when that is wanted. */
  setCaptionCues(cues, { save = true, draft = true } = {}) {
    this.capCues = normalizeCues(cues);
    this._capVer = (this._capVer || 0) + 1;
    this._drawCaps(); this._syncPanels();
    if (save) this._saveCaptionsSoon();
    if (this._onCues && draft) { clearTimeout(this._capCueT); this._capCueT = setTimeout(() => { try { this._onCues(this.getCaptionCues()); } catch { /* a draft is only a convenience */ } }, 600); }
  }
  getCaptionCues() { return this.capCues.map((c) => ({ ...c })); }

  _saveCaptionsSoon() {
    if (!this._capCfg.autoSave || !this._capCfg.save) return;
    clearTimeout(this._capSaveT);
    this._capSaveT = setTimeout(() => { Promise.resolve(this._capCfg.save(this.getCaptionCues())).catch(() => {}); }, 900);
  }

  _capPagesList() {
    const key = `${this._capVer || 0}|${this.capCues.length}|${JSON.stringify(this.cap.style)}`;
    if (key !== this._capKey) { this._capKey = key; this._capPages = pagesOf(this.capCues, this.cap.style); }
    return this._capPages;
  }

  /** The source second the caption preview shows (the playhead; a still preview uses previewTime()). */
  _capTime() {
    try {
      if (this._capCfg.previewTime) { const t = Number(this._capCfg.previewTime()); if (Number.isFinite(t)) return t; }
      if (this.player) return Number(this.player.time()) || 0;
    } catch { /* fall through */ }
    const v = this.$('Video');
    return v ? v.currentTime || 0 : 0;
  }

  /** Paints the caption showing at the playhead (the same drawing code the export is checked against). */
  _drawCaps() {
    const cv = this.$('Cap'); const stage = this.$('Stage');
    if (!cv || !stage) return;
    const W = stage.clientWidth; const H = stage.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(W * dpr); const ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, pw, ph);
    if (!this.cap.enabled || !this.capCues.length) return;
    const t = this._capTime();
    const page = pageAt(this._capPagesList(), t);
    if (page) drawCaptionPage(ctx, pw, ph, page, this.cap.style, t, { speed: this.adj.speed });
  }

  // ── several lower thirds ─────────────────────────────────────────────────────────────

  /** The lower third being edited. */
  get lt() { return this.lts[this.ltSel] || this.lts[0]; }
  set lt(v) { this.lts[this.ltSel] = v; }

  selectLowerThird(i) {
    const n = Math.max(0, Math.min(this.lts.length - 1, Number(i) || 0));
    this.ltSel = n; this._ltScrub = null;
    this._drawLT(); this._syncPanels();
  }

  /** Adds a blank lower third after the last one's showing (a free spot on the timeline). */
  addLowerThird() {
    if (this.lts.length >= MAX_LOWER_THIRDS) { this.notify('warn', `A clip can have up to ${MAX_LOWER_THIRDS} lower thirds.`); return; }
    // the first free stretch of the clip that is long enough for it (it may overlap another one only if nothing is free)
    let start = 2;
    try {
      const len = this._getClipLen ? Number(this._getClipLen()) || 0 : 0;
      const need = lowerThirdWindows(defaultLowerThird(), { part: 1, clipDuration: len }).total || 7;
      const taken = this.lts.map((x) => lowerThirdWindows(x, { part: 1, clipDuration: len })).sort((a, b) => a.start - b.start);
      let t = 2;
      for (const w of taken) if (t < w.end && t + need > w.start) t = w.end + 0.5;
      start = len > 0 && t + need > len - 0.3 ? 2 : t;
    } catch { /* the default start */ }
    const blank = normalizeLowerThird({ ...defaultLowerThird(), title: 'New lower third', start: Math.round(start * 10) / 10 });
    this.lts.push({ ...blank, enabled: true });
    this.ltSel = this.lts.length - 1; this._ltScrub = null;
    this._drawLT(); this._syncPanels(); this._commitSoon();
  }

  duplicateLowerThird() {
    if (this.lts.length >= MAX_LOWER_THIRDS) { this.notify('warn', `A clip can have up to ${MAX_LOWER_THIRDS} lower thirds.`); return; }
    const copy = { ...this.lt, start: Math.round(((this.lt.start || 0) + 1) * 10) / 10 };
    this.lts.splice(this.ltSel + 1, 0, copy);
    this.ltSel += 1; this._ltScrub = null;
    this._drawLT(); this._syncPanels(); this._commitSoon();
  }

  removeLowerThird() {
    if (this.lts.length <= 1) { this.lt = defaultLowerThird(); }  // the last one is emptied instead
    else { this.lts.splice(this.ltSel, 1); this.ltSel = Math.max(0, Math.min(this.ltSel, this.lts.length - 1)); }
    this._ltScrub = null;
    this._drawLT(); this._syncPanels(); this._commitSoon();
  }

  /** Puts lower third `i` between `start` and `end` seconds of the clip (dragging a bar on the timeline). */
  setLowerThirdTiming(i, { start, end }, { commit = true } = {}) {
    const spec = this.lts[i]; if (!spec) return;
    this.lts[i] = normalizeLowerThird({ ...spec, ...timingPatch(spec, { start, end }) });
    this._drawLT(); this._syncPanels();
    if (commit) this._commitSoon();
  }

  /** Shows every lower third as it is at second `t` of the clip (null: back to the one being edited). */
  setLtScrub(t) {
    this._ltScrub = t == null ? null : Math.max(0, Number(t) || 0);
    this._drawLT();
    if (this._onLtTime) this._onLtTime(this._ltScrub);
  }

  /** Plays all the lower thirds of the clip, in time, once on the preview. */
  previewTimeline() {
    const on = this.lts.filter((x) => x.enabled);
    if (!on.length) { this.notify('info', 'Turn a lower third on first.'); return; }
    cancelAnimationFrame(this._ltRaf);
    let len = 0; try { len = this._getClipLen ? Number(this._getClipLen()) || 0 : 0; } catch { /* ignore */ }
    const part = (() => { try { return this._getPart ? Number(this._getPart()) || 1 : 1; } catch { return 1; } })();
    const ends = on.map((x) => lowerThirdWindows(x, { part, clipDuration: len }).end);
    const end = Math.min(len > 0 ? len : Infinity, Math.max(...ends) + 0.6);
    const began = performance.now();
    this._ltAnimating = true;
    const step = (now) => {
      const t = (now - began) / 1000;
      if (t >= end) { this._ltAnimating = false; this.setLtScrub(null); return; }
      this._ltScrub = t; this._ltAnimating = false; this._drawLT(); this._ltAnimating = true;
      if (this._onLtTime) this._onLtTime(t);
      this._ltRaf = requestAnimationFrame(step);
    };
    this._ltRaf = requestAnimationFrame(step);
  }

  /** Width of a 9:16 preview that suits this screen (the other shapes are scaled from it). */
  _maxStageW() {
    const vw = window.innerWidth || 1024; const vh = window.innerHeight || 800;
    if (vw <= 720) { // phone: a small preview pinned at the top, the controls scroll beneath it
      if (vh < 500) return 190; // landscape phone: no room to pin it, it just scrolls with the page
      return Math.round(Math.max(96, Math.min(150, vw * 0.34, vh * 0.34 * (9 / 16) * 1.35)));
    }
    return Math.round(Math.max(170, Math.min(250, (vh - 190) * (9 / 16))));
  }

  /** Changes the lower third: any of its fields (see js/shared/lowerThird.js). */
  setLowerThird(patch, { commit = true } = {}) {
    this.lt = normalizeLowerThird({ ...this.lt, ...patch });
    this._drawLT(); this._syncPanels();
    if (commit) this._commitSoon();
    this._autoPlayLowerThird(patch);
  }

  /**
   * When the motion, style or timing of the lower third changes, its animation plays by itself shortly afterwards, so the
   * result is seen right where the change was made (no need to find the Preview button and scroll back to the picture).
   */
  _autoPlayLowerThird(patch) {
    if (!this.autoLtPlay || !this.lt.enabled || !patch) return;
    if (!['enabled', 'style', 'in', 'out', 'loop', 'speed', 'start', 'hold', 'repeat'].some((k) => k in patch)) return;
    clearTimeout(this._ltAutoT);
    this._ltAutoT = setTimeout(() => { if (this.$('Stage')) this.previewLowerThird(); }, 550);
  }

  /**
   * Changes the clip adjustments: any of the fields in js/shared/adjust.js. The picture part (flip, colour, zoom) and
   * the speed show in the preview at once; pitch and reverb only change the sound of the finished clip.
   */
  setAdjust(patch, { commit = true } = {}) {
    this.adj = normalizeAdjust({ ...this.adj, ...patch });
    this._layoutMedia(); this._applyAdjustPreview(); this._syncPanels();
    if (commit) this._commitSoon();
    try { this._onAdjust?.(); } catch { /* the summary is only a hint */ }
  }

  /** Flip / colour on the picture and the speed of playback, in the preview. */
  _applyAdjustPreview() {
    const st = previewStyle(this.adj);
    for (const id of ['Video', 'Img']) {
      const el = this.$(id); if (!el) continue;
      el.style.transform = st.transform; el.style.filter = st.filter;
    }
    const bg = this.$('Bg'); // the blurred background has its own CSS (blur / scale): the adjustments are added to it
    if (bg) { bg.style.filter = `blur(14px) brightness(.8) ${st.filter}`.trim(); bg.style.transform = `scale(1.25) ${st.transform}`.trim(); }
    const v = this.$('Video');
    if (v) { try { v.defaultPlaybackRate = st.playbackRate; v.playbackRate = st.playbackRate; v.preservesPitch = st.preservesPitch; } catch { /* not supported */ } }
  }

  /**
   * Aspect-ratio rules (config/clip-adjustments.json, built on the Update 10 framing presets):
   *   9:16 + a landscape source -> "fit + blurred background";  1:1 / 4:5 -> centre crop from the source box.
   * A framing the person chose themselves is never replaced: only a framing the rules put there is changed or undone.
   */
  applyAspectRules() {
    const id = this.getAspectId ? this.getAspectId() : null;
    const m = this._media();
    const key = (f) => this._frameKey(f);
    const mine = this._autoFrameKey && key(this.frame) === this._autoFrameKey;
    const isDefault = isDefaultFrame(this.frame);
    let note = '';
    if (!id || !m || !this.framingEnabled() || !this.autoAspect) {
      this.aspectNote = '';
      if (mine && !this.autoAspect) { this._autoFrameKey = null; }
      return;
    }
    const plan = aspectPlan(id, m.w, m.h, FRAME_PRESETS);
    if (!plan) {
      if (mine) { this._autoFrameKey = null; this.frame = defaultFrame(); this._layoutMedia(); this._commitSoon(); }
      this.aspectNote = '';
      return;
    }
    let changed = false;
    if (isDefault || mine) {
      const next = normalizeFrame({ ...defaultFrame(), ...plan.ruleFrame });
      this._autoFrameKey = isDefaultFrame(next) ? null : key(next);
      if (key(next) !== key(this.frame)) { this.frame = next; this._layoutMedia(); changed = true; }
      const exact = m.el === this.$('Video'); // a server-built preview picture is not the real size of the source
      note = plan.crop && exact ? `${plan.note ? `${plan.note[0].toUpperCase()}${plan.note.slice(1)}: ` : ''}${plan.crop.w}\u00d7${plan.crop.h} from your ${m.w}\u00d7${m.h} video.` : (plan.note ? `${plan.note[0].toUpperCase()}${plan.note.slice(1)}.` : '');
    } else {
      note = 'Framing left as you set it.';
    }
    this.aspectNote = note;
    if (changed) this._commitSoon();
  }

  _frameKey(f) { return `${f.mode}|${f.bg}|${Math.round(f.zoom * 100)}|${Math.round(f.x * 100)}|${Math.round(f.y * 100)}`; }

  /** What generation needs besides the overlay picture: { frame, lowerThird, adjust }, or null when all are off. */
  getLook() {
    const frame = this.framingEnabled() && !isDefaultFrame(this.frame) ? { ...this.frame } : null;
    const lts = this.lts.filter((x) => x.enabled).map((x) => ({ ...x }));
    const lowerThird = lts[0] || null;           // (the first one, for older readers)
    const lowerThirds = lts.length ? lts : null; // all of them
    const adjust = isDefaultAdjust(this.adj) ? null : { ...this.adj };
    const captions = this.cap.enabled && this.capCues.length ? { enabled: true, template: this.cap.template, style: { ...this.cap.style } } : null;
    // frameAuto: the framing was chosen by the aspect-ratio rules, not by the person (so it alone never asks for cloud processing)
    const frameAuto = !!(frame && this._autoFrameKey && this._frameKey(this.frame) === this._autoFrameKey);
    return frame || lowerThird || adjust || captions ? { frame, lowerThird, lowerThirds, adjust, captions, ...(frameAuto ? { frameAuto: true } : {}) } : null;
  }

  /** Puts a stored look back ({ frame, lowerThird, adjust } or null). */
  loadLook(look) {
    this.frame = normalizeFrame(look && look.frame);
    this.lts = normalizeLowerThirds(look && (look.lowerThirds || look.lowerThird)); this.ltSel = 0; this._ltScrub = null;
    this.adj = normalizeAdjust(look && look.adjust);
    this.cap = look && look.captions ? normalizeCaptions(look.captions) : { enabled: false, template: '', style: this.cap.style };
    this._autoFrameKey = null;
    this._layoutMedia(); this._applyAdjustPreview(); this._drawLT(); this._drawCaps(); this._syncPanels();
  }

  _media() {
    const v = this.$('Video'); const i = this.$('Img');
    if (v && v.style.display !== 'none' && v.videoWidth) return { el: v, w: v.videoWidth, h: v.videoHeight };
    if (i && i.style.display !== 'none' && i.naturalWidth) return { el: i, w: i.naturalWidth, h: i.naturalHeight };
    return null;
  }

  _canMoveVideo() { return this.framingEnabled() && !!this._media() && (this.frame.mode === 'fit' || this.frame.zoom * (this.adj.scale / 100) > 1.001); }

  /** Sizes and places the picture in the stage exactly as the server will in the output (js/shared/framing.js). */
  _layoutMedia() {
    const stage = this.$('Stage');
    if (!stage) return;
    const W = stage.clientWidth; const H = stage.clientHeight;
    if (!W || !H) return;
    const f = this.framingEnabled() ? this.frame : defaultFrame();
    stage.style.background = f.mode === 'fit' && f.bg === 'color' ? f.color : '#000';
    const bg = this.$('Bg');
    const m = this._media();
    if (!m) { bg.style.display = 'none'; return; }
    // the adjustments' zoom is folded into the framing zoom: the same placement the server uses
    const r = videoRect(m.w, m.h, W, H, this.framingEnabled() ? effectiveFrame(f, this.adj) : f);
    if (f.mode === 'fill' && this.framingEnabled()) { // dragging past the edge is not allowed: remember where it really sits
      // Only a real clamp is written back. Writing back every time let pixel rounding nudge an untouched centred framing to
      // 0.504, which made it look "customised" (wrongly asking for cloud processing, and blocking the aspect-ratio rules).
      const cx = (r.x + r.w / 2) / W; const cy = (r.y + r.h / 2) / H;
      if (Math.abs(cx - this.frame.x) > 0.02) this.frame.x = cx;
      if (Math.abs(cy - this.frame.y) > 0.02) this.frame.y = cy;
    }
    for (const el of [this.$('Video'), this.$('Img')]) Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const showBg = f.mode === 'fit' && f.bg === 'blur' && !r.covers;
    bg.style.display = showBg ? 'block' : 'none';
    if (showBg) { bg.width = 64; bg.height = Math.max(2, Math.round(64 * H / W)); this._drawBg(); }
    this._applyAdjustPreview();
    this._drawCaps();
  }

  /** The blurred copy behind a "fit" video: a tiny canvas of the current picture, blurred and enlarged by CSS. */
  _drawBg() {
    const bg = this.$('Bg'); const m = this._media();
    if (!bg || !m || bg.style.display === 'none') return;
    const ctx = bg.getContext('2d'); const k = Math.max(bg.width / m.w, bg.height / m.h);
    try { ctx.drawImage(m.el, (bg.width - m.w * k) / 2, (bg.height - m.h * k) / 2, m.w * k, m.h * k); } catch { /* picture not ready yet */ }
  }

  /** Paints the lower third on its canvas: at time `t`, or (by default) as it looks while it is showing. */
  _drawLT(t = null) {
    const cv = this.$('LT'); const stage = this.$('Stage'); const handle = this.$('LTHandle');
    if (!cv || !stage) return;
    if (this._ltAnimating && t == null && this._ltScrub == null) return; // an animation preview is drawing
    const W = stage.clientWidth; const H = stage.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(W * dpr); const ph = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, pw, ph);
    const rb = this.$('LtReplay'); if (rb) rb.style.display = this.lts.some((x) => x.enabled) ? '' : 'none';
    // Timeline mode: every lower third as it is at one moment of the clip (the handle for dragging is hidden)
    const at = t != null ? null : this._ltScrub;
    if (at != null) {
      handle.style.display = 'none';
      for (const spec of this.lts) { if (spec.enabled) drawLowerThird(ctx, pw, ph, this._ltResolved(spec), at); }
      return;
    }
    if (!this.lt.enabled) { handle.style.display = 'none'; return; }
    const lt = this._ltForClip();
    const tl = lowerThirdTimeline(lt);
    drawLowerThird(ctx, pw, ph, lt, t == null ? lt.start + tl.inDur + Math.min(0.5, lt.hold * 0.4) : t);
    const m = measureLowerThird(ctx, pw, ph, lt);
    Object.assign(handle.style, { display: 'block', left: `${m.x / dpr}px`, top: `${m.y / dpr}px`, width: `${m.w / dpr}px`, height: `${m.h / dpr}px` });
  }

  /** The lower third as the first clip will have it: part-number text filled in, "near the end" worked out. */
  _ltForClip() {
    let part = 1; let len = 0;
    try { part = this._getPart ? Number(this._getPart()) || 1 : 1; len = this._getClipLen ? Number(this._getClipLen()) || 0 : 0; } catch { /* the preview falls back to part 1 */ }
    return resolveLowerThird(this.lt, { part, clipDuration: len, isLast: !!this.previewLast });
  }

  /** Shows the preview the way the final part will look (its closing text, or nothing if it is set to hide). */
  setPreviewLast(on) { this.previewLast = !!on; this.setLowerThird({}); }

  /** Any lower third of the clip as the first clip will have it. */
  _ltResolved(spec) {
    let part = 1; let len = 0;
    try { part = this._getPart ? Number(this._getPart()) || 1 : 1; len = this._getClipLen ? Number(this._getClipLen()) || 0 : 0; } catch { /* part 1 */ }
    return resolveLowerThird(spec, { part, clipDuration: len, isLast: !!this.previewLast });
  }

  /** Plays the lower third's animation once on the preview. */
  previewLowerThird() {
    if (!this.lt.enabled) { this.notify('info', 'Turn the lower third on first.'); return; }
    cancelAnimationFrame(this._ltRaf);
    const lt = this._ltForClip();
    const tl = lowerThirdTimeline(lt);
    const t0 = lt.start - 0.35; const end = lt.start + tl.total + 0.35; const began = performance.now();
    this._ltAnimating = true;
    const step = (now) => {
      const t = t0 + (now - began) / 1000;
      if (t >= end) { this._ltAnimating = false; this._drawLT(); return; }
      this._drawLT(t);
      this._ltRaf = requestAnimationFrame(step);
    };
    this._ltRaf = requestAnimationFrame(step);
  }

  _flash(text) {
    const f = this.$('Flash');
    if (!f) return;
    f.textContent = text; f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }

  _toggle() {
    if (!this.player) return;
    const was = this.player.isPlaying();
    this.player.toggle();
    this._flash(was ? '❚❚' : '▶');
  }

  _skip(sec) {
    const p = this.player;
    if (!p) return;
    p.seek(Math.max(0, Math.min(p.duration() || 0, (p.time() || 0) + sec)));
    this._flash(sec < 0 ? '⏪ 5s' : '5s ⏩');
  }

  /** A tap on the picture: play / pause; a double tap on the left or right side jumps 5 s back / forward. */
  _tap(e) {
    if (!this.player || !(this.player.duration() > 0)) return;
    const r = this.$('Stage').getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const side = fx < 0.35 ? 'l' : fx > 0.65 ? 'r' : 'c';
    clearTimeout(this._tapT);
    if (this._lastTap && Date.now() - this._lastTap.t < 300 && this._lastTap.side === side) {
      this._lastTap = null;
      if (side === 'l') this._skip(-5); else if (side === 'r') this._skip(5);
      return;
    }
    this._lastTap = { t: Date.now(), side };
    this._tapT = setTimeout(() => { this._lastTap = null; this._toggle(); }, 260);
  }

  /** Brings the seek bar and time label up to date (the owner calls this whenever the position changes). */
  updateTransport() {
    const p = this.player; const ctl = this.$('Ctl');
    if (!p || !ctl) return;
    const dur = p.duration() || 0;
    ctl.style.display = dur > 0 ? 'flex' : 'none';
    if (!(dur > 0)) return;
    const t = Math.max(0, Math.min(dur, p.time() || 0)); const frac = t / dur;
    this.$('ScrubFill').style.width = `${frac * 100}%`;
    this.$('ScrubKnob').style.left = `${frac * 100}%`;
    const fmt = (x) => { const s = Math.round(x); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
    this.$('CtlTime').textContent = `${fmt(t)} / ${fmt(dur)}`;
    const v = this.$('Video'); const mute = this.$('Mute');
    mute.style.display = v && v.style.display !== 'none' && v.videoWidth ? '' : 'none';
    mute.textContent = v && !v.muted ? '🔊' : '🔇';
  }

  _bindPlayer() {
    const stage = this.$('Stage'); const video = this.$('Video');
    // the blurred background follows the picture while it plays or is scrubbed
    let lastBg = 0;
    for (const ev of ['loadedmetadata', 'loadeddata', 'seeked']) video.addEventListener(ev, () => { this._layoutMedia(); this.updateTransport(); });
    // the video's real size is known now: let the aspect-ratio rules choose the framing (16:9 in 9:16 -> fit + blurred background)
    video.addEventListener('loadedmetadata', () => { this.applyAspectRules(); this._syncPanels(); });
    video.addEventListener('timeupdate', () => { this.updateTransport(); this._drawCaps(); if (Date.now() - lastBg > 120) { lastBg = Date.now(); this._drawBg(); } });
    video.addEventListener('seeked', () => this._drawCaps());
    video.addEventListener('play', () => {
      const loop = () => { if (video.paused || video.ended) return; this._drawBg(); this._drawCaps(); this._bgRaf = requestAnimationFrame(loop); };
      loop();
    });
    this.$('Img').addEventListener('load', () => this._layoutMedia());

    // drag the video to move it, pinch (or Ctrl + scroll) to zoom, tap to play / pause
    const pts = new Map(); let drag = null; let pinch = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ed-item, .ed-ctl, .ed-lt-handle')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, fx: this.frame.x, fy: this.frame.y, moved: false };
      else if (pts.size === 2) {
        drag = null; const [a, b] = [...pts.values()];
        pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), z: this.frame.zoom };
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        if (!this.framingEnabled()) return;
        const [a, b] = [...pts.values()];
        this.setFrame({ zoom: pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d }, { commit: false });
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      if (this._canMoveVideo()) {
        const r = stage.getBoundingClientRect();
        this.setFrame({ x: drag.fx + dx / r.width, y: drag.fy + dy / r.height }, { commit: false });
      }
    });
    const release = (e, cancelled) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pinch && pts.size < 2) { pinch = null; drag = null; if (!cancelled) this._commitSoon(); return; }
      if (drag && pts.size === 0) {
        const d = drag; drag = null;
        if (cancelled) return;
        if (d.moved) { if (this._canMoveVideo()) this._commitSoon(); } else this._tap(e);
      }
    };
    stage.addEventListener('pointerup', (e) => release(e, false));
    stage.addEventListener('pointercancel', (e) => release(e, true));
    stage.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.altKey) || !this._canMoveVideo() && !(this.framingEnabled() && this._media())) return;
      e.preventDefault();
      this.setFrame({ zoom: this.frame.zoom * Math.exp(-e.deltaY * 0.0015) }, { commit: false });
      clearTimeout(this._wheelT); this._wheelT = setTimeout(() => this._commitSoon(), 250);
    }, { passive: false });

    // drag the lower third (up / down; sideways past a third of the frame changes its alignment)
    const handle = this.$('LTHandle');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      const r = stage.getBoundingClientRect(); const hr = handle.getBoundingClientRect();
      const grab = e.clientY - (hr.top + hr.height / 2); const x0 = e.clientX; let moved = false;
      const move = (ev) => {
        moved = true;
        const patch = { y: clamp((ev.clientY - grab - r.top) / r.height, 0.05, 0.95) };
        if (Math.abs(ev.clientX - x0) > r.width * 0.12) { const fx = (ev.clientX - r.left) / r.width; patch.align = fx < 0.38 ? 'left' : fx > 0.62 ? 'right' : 'center'; }
        this.setLowerThird(patch, { commit: false });
      };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); if (moved) this._commit(); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });

    // seek bar and sound
    const scrub = this.$('Scrub');
    const seekTo = (clientX) => {
      const p = this.player; if (!p) return;
      const r = scrub.getBoundingClientRect();
      p.seek(clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * (p.duration() || 0));
    };
    scrub.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); scrub.setPointerCapture(e.pointerId); scrub.classList.add('on'); seekTo(e.clientX);
      const move = (ev) => seekTo(ev.clientX);
      const up = () => { scrub.classList.remove('on'); scrub.removeEventListener('pointermove', move); scrub.removeEventListener('pointerup', up); scrub.removeEventListener('pointercancel', up); };
      scrub.addEventListener('pointermove', move); scrub.addEventListener('pointerup', up); scrub.addEventListener('pointercancel', up);
    });
    scrub.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this._skip(e.key === 'ArrowLeft' ? -1 : 1); }
    });
    this.$('Mute').addEventListener('click', (e) => { e.stopPropagation(); video.muted = !video.muted; this.updateTransport(); });
    this.$('TTToggle').addEventListener('change', (e) => { this.$('TT').style.display = e.target.checked ? 'block' : 'none'; });
  }

  // ── items ───────────────────────────────────────────────────────────────────────────
  get(id) { return this.items.find((i) => i.id === id); }
  hasItems() { return this.items.length > 0; }

  select(id) {
    if (this.selected === id) return;
    this.selected = id;
    this.render(); this._renderProps();
  }

  add(it) {
    this.items.push(it);
    this.selected = it.id;
    this.render(); this._renderProps(); this._commit();
  }

  remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
    if (this.selected === id) this.selected = null;
    this.render(); this._renderProps(); this._commit();
  }

  render() {
    const layer = this.$('Layer');
    if (!layer) return;
    const W = this.stageW();
    const seen = new Set();
    for (const it of this.items) {
      seen.add(it.id);
      let el = layer.querySelector(`[data-id="${it.id}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ed-item';
        el.dataset.id = it.id;
        el.addEventListener('pointerdown', (e) => this._startDrag(e, it.id));
        layer.appendChild(el);
      }
      el.style.left = `${it.x * 100}%`;
      el.style.top = `${it.y * 100}%`;
      el.style.transform = `translate(-50%,-50%) rotate(${it.rot}deg)`;
      el.style.opacity = String(it.opacity);
      el.style.zIndex = String(10 + this.items.indexOf(it));
      el.classList.toggle('selected', this.selected === it.id);
      let body = el.querySelector('.ed-body');
      if (!body) { body = document.createElement('div'); body.className = 'ed-body'; el.appendChild(body); }
      if (it.type === 'text') {
        const px = it.fs * W;
        Object.assign(body.style, {
          fontFamily: it.font, fontWeight: it.bold ? '800' : '400', fontSize: `${px}px`, lineHeight: '1.2', color: it.color,
          whiteSpace: 'pre', textAlign: 'center', padding: it.bg ? '0.15em 0.4em' : '0', borderRadius: '0.25em',
          background: it.bg || 'transparent',
          webkitTextStroke: it.strokeW > 0 ? `${it.strokeW * px}px ${it.strokeColor}` : '0',
          paintOrder: 'stroke fill', width: '', height: '',
        });
        body.textContent = it.content || ' ';
      } else if (it.type === 'emoji') {
        const px = it.w * W;
        Object.assign(body.style, { fontFamily: EMOJI_FONT, fontSize: `${px}px`, lineHeight: '1', whiteSpace: 'nowrap', width: '', height: '' });
        body.textContent = it.emoji;
      } else {
        Object.assign(body.style, { width: `${it.w * W}px`, height: 'auto', fontSize: '0', lineHeight: '0' });
        let img = body.querySelector('img');
        if (!img) { img = document.createElement('img'); img.draggable = false; img.style.cssText = 'width:100%;display:block'; body.appendChild(img); }
        if (img.getAttribute('src') !== it.url) img.src = it.url;
      }
      let hs = el.querySelector('.ed-handles');
      if (this.selected === it.id) {
        if (!hs) {
          hs = document.createElement('div');
          hs.className = 'ed-handles';
          hs.innerHTML = '<div class="ed-h ed-h-resize" title="Drag to resize"></div><div class="ed-h ed-h-rot" title="Drag to rotate"></div><div class="ed-h ed-h-del" title="Delete">✕</div>';
          el.appendChild(hs);
          hs.querySelector('.ed-h-resize').addEventListener('pointerdown', (e) => this._startResize(e, it.id));
          hs.querySelector('.ed-h-rot').addEventListener('pointerdown', (e) => this._startRotate(e, it.id));
          hs.querySelector('.ed-h-del').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.remove(it.id); });
        }
      } else if (hs) hs.remove();
    }
    for (const el of [...layer.querySelectorAll('.ed-item')]) if (!seen.has(el.dataset.id)) el.remove();
    const hint = this.$('Hint'); if (hint) hint.style.display = this.items.length ? 'none' : 'block';
  }

  _guides(x, y) {
    const v = this.$('GuideV'); const h = this.$('GuideH');
    if (v) v.style.display = x == null ? 'none' : 'block';
    if (h) h.style.display = y == null ? 'none' : 'block';
  }

  _startDrag(e, id) {
    if (e.target.closest('.ed-h')) return;
    e.preventDefault(); e.stopPropagation();
    this.select(id);
    const it = this.get(id); const stage = this.$('Stage').getBoundingClientRect();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const dx = e.clientX - (stage.left + it.x * stage.width); const dy = e.clientY - (stage.top + it.y * stage.height);
    let moved = false;
    const move = (ev) => {
      moved = true;
      let nx = clamp((ev.clientX - dx - stage.left) / stage.width, 0, 1);
      let ny = clamp((ev.clientY - dy - stage.top) / stage.height, 0, 1);
      // snap to the middle of the frame (hold Alt to move freely)
      const sx = !ev.altKey && Math.abs(nx - 0.5) < 0.02; const sy = !ev.altKey && Math.abs(ny - 0.5) < 0.02;
      if (sx) nx = 0.5; if (sy) ny = 0.5;
      this._guides(sx ? 1 : null, sy ? 1 : null);
      it.x = nx; it.y = ny;
      el.style.left = `${it.x * 100}%`; el.style.top = `${it.y * 100}%`;
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      this._guides(null, null);
      if (moved) this._commit();
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }

  _startResize(e, id) {
    e.preventDefault(); e.stopPropagation();
    const it = this.get(id); const stage = this.$('Stage').getBoundingClientRect();
    const h = e.currentTarget; h.setPointerCapture(e.pointerId);
    const cx = stage.left + it.x * stage.width; const cy = stage.top + it.y * stage.height;
    const d0 = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
    const s0 = it.type === 'text' ? it.fs : it.w;
    const move = (ev) => {
      const k = Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0;
      if (it.type === 'text') it.fs = clamp(s0 * k, 0.02, 0.4); else it.w = clamp(s0 * k, 0.04, 1.2);
      this.render(); this._syncProps();
    };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); this._commit(); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  }

  _startRotate(e, id) {
    e.preventDefault(); e.stopPropagation();
    const it = this.get(id); const stage = this.$('Stage').getBoundingClientRect();
    const h = e.currentTarget; h.setPointerCapture(e.pointerId);
    const cx = stage.left + it.x * stage.width; const cy = stage.top + it.y * stage.height;
    const move = (ev) => {
      let a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      if (a > 180) a -= 360;
      if (Math.abs(a) < 4) a = 0;
      it.rot = Math.round(a);
      this.render(); this._syncProps();
    };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); this._commit(); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  }

  // ── add controls, templates ─────────────────────────────────────────────────────────
  _bindControls() {
    this.$('AddText').addEventListener('click', () => {
      this.add(newItem('text', { y: 0.78, content: 'Your text', font: FONTS[0][1], bold: true, color: '#ffffff', strokeColor: '#000000', strokeW: 0.12, bg: null, fs: 0.1 }));
    });
    this.$('AddImage').addEventListener('click', () => this.$('ImageFile').click());
    this.$('ImageFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) { this.notify('warn', 'Please choose an image file (PNG, JPG, WebP).'); return; }
      try {
        const { url, img } = await imageFileToDataUrl(f);
        this.add(newItem('image', { url, img, w: img.naturalWidth > img.naturalHeight ? 0.4 : 0.3, y: 0.15, name: f.name }));
      } catch { this.notify('warn', 'That image could not be read.'); }
    });
    const panel = this.$('EmojiPanel');
    this.$('AddEmoji').addEventListener('click', () => { panel.style.display = panel.style.display === 'none' ? 'grid' : 'none'; });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-emoji]');
      if (!b) return;
      this.add(newItem('emoji', { emoji: b.dataset.emoji, w: 0.2, y: 0.3 }));
      panel.style.display = 'none';
    });
    this.$('Undo').addEventListener('click', () => this.undo());
    this.$('Redo').addEventListener('click', () => this.redo());

    const sel = this.$('Tpl');
    const syncBtns = () => { const has = !!sel.value; this.$('TplApply').disabled = !has; this.$('TplDel').disabled = !has; };
    sel.addEventListener('change', syncBtns);
    this.$('TplApply').addEventListener('click', async () => {
      const t = this._templates.find((x) => x.id === sel.value);
      if (!t) return;
      await this.load(t.data);
      this._commit();
      this.notify('success', `Applied "${t.name}"`);
    });
    this.$('TplDel').addEventListener('click', async () => {
      const t = this._templates.find((x) => x.id === sel.value);
      if (!t) return;
      const ok = await confirmAction({ title: 'Delete saved design', message: `Delete "${t.name}"? Videos already made with it are not affected.`, confirmText: 'Delete' });
      if (!ok) return;
      await designStore.remove(t.id);
      await this.refreshTemplates();
    });
    const row = this.$('TplNameRow');
    this.$('TplSave').addEventListener('click', () => {
      if (!this.items.length) { this.notify('warn', 'Add something to the design first.'); return; }
      row.style.display = row.style.display === 'none' ? 'flex' : 'none';
      if (row.style.display === 'flex') this.$('TplName').focus();
    });
    const doSave = async () => {
      const name = this.$('TplName').value.trim();
      if (!name) { this.$('TplName').focus(); return; }
      await designStore.save({ name, template: true, data: this.serialize(), aspect: this._aspectStr() });
      this.$('TplName').value = ''; row.style.display = 'none';
      await this.refreshTemplates();
      this.notify('success', `Saved "${name}". Use it on any video from the "Saved designs" list.`);
    };
    this.$('TplOk').addEventListener('click', doSave);
    this.$('TplName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  }

  async refreshTemplates() {
    const sel = this.$('Tpl');
    if (!sel) return;
    this._templates = await designStore.listTemplates();
    const cur = sel.value;
    sel.innerHTML = `<option value="">${this._templates.length ? 'Saved designs…' : 'No saved designs yet'}</option>` +
      this._templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    if (this._templates.some((t) => t.id === cur)) sel.value = cur;
    this.$('TplApply').disabled = !sel.value; this.$('TplDel').disabled = !sel.value;
  }

  _aspectStr() { return String(this.getAspect().toFixed(4)); }

  // ── properties panel ────────────────────────────────────────────────────────────────
  _renderProps() {
    const box = this.$('Props');
    if (!box) return;
    const n = this.ns;
    const it = this.get(this.selected);
    if (!it) { box.innerHTML = this.items.length ? '<div class="ed-hint">Click an item on the preview to edit it. Arrow keys nudge it; hold Alt while dragging to skip the centre snap.</div>' : ''; return; }
    const row = (label, inner) => `<div class="ed-row"><label>${label}</label>${inner}</div>`;
    let html = '';
    if (it.type === 'text') {
      html += `<textarea class="form-input" id="${n}pText" rows="2" placeholder="Your text">${esc(it.content)}</textarea>`;
      html += row('Font', `<select class="form-input form-select" id="${n}pFont">${FONTS.map(([nm, v]) => `<option value="${esc(v)}"${v === it.font ? ' selected' : ''}>${nm}</option>`).join('')}</select>`);
      html += `<div class="ed-row ed-row-inline">
        <label><input type="checkbox" id="${n}pBold"${it.bold ? ' checked' : ''}> Bold</label>
        <label>Text <input type="color" id="${n}pColor" value="${it.color}"></label>
        <label>Outline <input type="color" id="${n}pStrokeColor" value="${it.strokeColor}"></label>
        <label><input type="checkbox" id="${n}pBgOn"${it.bg ? ' checked' : ''}> Box <input type="color" id="${n}pBg" value="${it.bg || '#000000'}"></label></div>`;
      html += row('Outline thickness', `<input type="range" id="${n}pStrokeW" min="0" max="25" value="${Math.round(it.strokeW * 100)}">`);
      html += row('Size', `<input type="range" id="${n}pSize" min="2" max="40" value="${Math.round(it.fs * 100)}">`);
    } else {
      html += row('Size', `<input type="range" id="${n}pSizeW" min="4" max="100" value="${Math.round(it.w * 100)}">`);
    }
    html += row('Rotation', `<input type="range" id="${n}pRot" min="-180" max="180" value="${it.rot}">`);
    html += row('Opacity', `<input type="range" id="${n}pOpacity" min="10" max="100" value="${Math.round(it.opacity * 100)}">`);
    html += `<div class="ed-row ed-row-inline">
      <button class="btn btn-ghost btn-sm" id="${n}pCenter" type="button" title="Centre horizontally">⇔ Centre</button>
      <button class="btn btn-ghost btn-sm" id="${n}pFront" type="button">Bring to front</button>
      <button class="btn btn-ghost btn-sm" id="${n}pBack" type="button">Send back</button>
      <button class="btn btn-ghost btn-sm" id="${n}pDup" type="button">Duplicate</button>
      <button class="btn btn-ghost btn-sm" id="${n}pDel" type="button" style="color:var(--danger,#ef4444)">Delete</button></div>`;
    box.innerHTML = html;
    const on = (id, ev, fn) => { const el = document.getElementById(n + id); if (el) el.addEventListener(ev, fn); };
    const upd = (fn) => (e) => { fn(e.target); this.render(); this._commitSoon(); };
    on('pText', 'input', upd((t) => { it.content = t.value; }));
    on('pFont', 'change', upd((t) => { it.font = t.value; }));
    on('pBold', 'change', upd((t) => { it.bold = t.checked; }));
    on('pColor', 'input', upd((t) => { it.color = t.value; }));
    on('pStrokeColor', 'input', upd((t) => { it.strokeColor = t.value; }));
    on('pBgOn', 'change', upd((t) => { it.bg = t.checked ? (document.getElementById(n + 'pBg').value || '#000000') : null; }));
    on('pBg', 'input', upd((t) => { if (document.getElementById(n + 'pBgOn').checked) it.bg = t.value; }));
    on('pStrokeW', 'input', upd((t) => { it.strokeW = Number(t.value) / 100; }));
    on('pSize', 'input', upd((t) => { it.fs = Number(t.value) / 100; }));
    on('pSizeW', 'input', upd((t) => { it.w = Number(t.value) / 100; }));
    on('pRot', 'input', upd((t) => { it.rot = Number(t.value); }));
    on('pOpacity', 'input', upd((t) => { it.opacity = Number(t.value) / 100; }));
    on('pCenter', 'click', () => { it.x = 0.5; this.render(); this._commit(); });
    on('pFront', 'click', () => { this.items = this.items.filter((i) => i !== it).concat(it); this.render(); this._commit(); });
    on('pBack', 'click', () => { this.items = [it].concat(this.items.filter((i) => i !== it)); this.render(); this._commit(); });
    on('pDup', 'click', () => { this.add({ ...it, id: `it${Date.now().toString(36)}${++uid}`, x: clamp(it.x + 0.05, 0, 1), y: clamp(it.y + 0.05, 0, 1) }); });
    on('pDel', 'click', () => this.remove(it.id));
  }

  _syncProps() {
    const it = this.get(this.selected);
    if (!it) return;
    const set = (id, v) => { const el = document.getElementById(this.ns + id); if (el) el.value = String(v); };
    set('pRot', it.rot); set('pSize', Math.round((it.fs || 0) * 100)); set('pSizeW', Math.round((it.w || 0) * 100));
  }

  // ── history ─────────────────────────────────────────────────────────────────────────
  // One undo step covers everything the pad edits: the items, the framing and the lower third.
  _snapshot() { return JSON.stringify({ items: this.items.map((i) => { const { img, ...rest } = i; return rest; }), frame: this.frame, lts: this.lts, ltSel: this.ltSel, adj: this.adj, cap: this.cap }); }

  /** Records the current state as an undo step (call after a finished edit). */
  _commit() {
    clearTimeout(this._histTimer);
    const snap = this._snapshot();
    if (this._hist[this._histIdx] !== snap) {
      this._hist = this._hist.slice(0, this._histIdx + 1);
      this._hist.push(snap);
      if (this._hist.length > HISTORY_LIMIT) this._hist.shift();
      this._histIdx = this._hist.length - 1;
    }
    this._syncHistBtns();
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => { try { this.onChange?.(this.serialize()); } catch {} }, 500);
  }

  /** Like _commit but waits for a pause, so dragging a slider is one undo step, not hundreds. */
  _commitSoon() { clearTimeout(this._histTimer); this._histTimer = setTimeout(() => this._commit(), 450); }

  _syncHistBtns() {
    const u = this.$('Undo'); const r = this.$('Redo');
    if (u) u.disabled = this._histIdx <= 0;
    if (r) r.disabled = this._histIdx >= this._hist.length - 1;
  }

  _restore(snap) {
    const parsed = JSON.parse(snap);
    const list = Array.isArray(parsed) ? parsed : (parsed.items || []); // (older snapshots were just the items)
    if (!Array.isArray(parsed)) { this.frame = normalizeFrame(parsed.frame); this.lts = normalizeLowerThirds(parsed.lts || parsed.lt); this.ltSel = Math.min(Math.max(0, Number(parsed.ltSel) || 0), this.lts.length - 1); this.adj = normalizeAdjust(parsed.adj); if (parsed.cap) this.cap = normalizeCaptions(parsed.cap); this._layoutMedia(); this._drawLT(); this._drawCaps(); this._syncPanels(); }
    this.items = list.map((i) => this._hydrate(i));
    if (!this.items.some((i) => i.id === this.selected)) this.selected = null;
    this.render(); this._renderProps(); this._syncHistBtns();
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => { try { this.onChange?.(this.serialize()); } catch {} }, 500);
  }

  undo() { clearTimeout(this._histTimer); this._commit(); if (this._histIdx > 0) { this._histIdx--; this._restore(this._hist[this._histIdx]); } }
  redo() { if (this._histIdx < this._hist.length - 1) { this._histIdx++; this._restore(this._hist[this._histIdx]); } }

  // ── save / load / draw ──────────────────────────────────────────────────────────────
  _hydrate(i) {
    const it = { ...i };
    if (it.type === 'image' && it.url) {
      it.img = new Image();
      it._loaded = new Promise((res) => { it.img.onload = () => res(); it.img.onerror = () => res(); });
      it.img.src = it.url;
    }
    return it;
  }

  /** The design as plain data (images are data URLs), ready to store and reopen later. */
  serialize() {
    return {
      v: 4,
      items: this.items.map((i) => { const { img, _loaded, ...rest } = i; return JSON.parse(JSON.stringify(rest)); }),
      frame: { ...this.frame },
      lowerThird: { ...this.lts[0] },                    // (the first one, for older readers)
      lowerThirds: this.lts.map((x) => ({ ...x })),
      adjust: { ...this.adj },
      captions: { ...this.cap, style: { ...this.cap.style } },
    };
  }

  /** Replaces the design with a stored one. */
  async load(data, { resetHistory = false } = {}) {
    const list = (data && Array.isArray(data.items)) ? data.items : [];
    this.items = list.map((i) => this._hydrate({ ...i, id: i.id || `it${Date.now().toString(36)}${++uid}` }));
    this.frame = normalizeFrame(data && data.frame);
    this.lts = normalizeLowerThirds(data && (data.lowerThirds || data.lowerThird)); this.ltSel = 0; this._ltScrub = null;
    this.adj = normalizeAdjust(data && data.adjust);
    if (data && data.captions) this.cap = normalizeCaptions(data.captions);
    this._autoFrameKey = null;
    this._layoutMedia(); this._drawLT(); this._drawCaps(); this._syncPanels();
    this.selected = null;
    this.render(); this._renderProps();
    if (resetHistory) { this._hist = [this._snapshot()]; this._histIdx = 0; this._syncHistBtns(); }
    await Promise.all(this.items.map((i) => i._loaded).filter(Boolean));
    this.render();
  }

  /** Draws every item into one transparent PNG (LAYER_WIDTH px wide) in the shape of the output frame. */
  async renderLayerBlob() {
    if (!this.items.length) return null;
    const W = LAYER_WIDTH; const H = Math.round(W / this.getAspect());
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
    await Promise.all(this.items.map((i) => i._loaded).filter(Boolean));
    for (const it of this.items) {
      ctx.save();
      ctx.translate(it.x * W, it.y * H);
      ctx.rotate((it.rot * Math.PI) / 180);
      ctx.globalAlpha = it.opacity;
      if (it.type === 'text') {
        const px = it.fs * W; const lh = px * 1.2;
        ctx.font = `${it.bold ? '800' : '400'} ${px}px ${it.font}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
        const lines = String(it.content || '').split('\n');
        const widths = lines.map((l) => ctx.measureText(l).width);
        const m = ctx.measureText('Hg');
        const asc = m.fontBoundingBoxAscent ?? px * 0.9; const desc = m.fontBoundingBoxDescent ?? px * 0.25;
        const padX = it.bg ? px * 0.4 : 0; const padY = it.bg ? px * 0.15 : 0;
        const boxW = Math.max(...widths, 1) + padX * 2; const boxH = lines.length * lh + padY * 2;
        if (it.bg) {
          ctx.fillStyle = it.bg;
          const r = px * 0.25;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, r); else ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH);
          ctx.fill();
        }
        lines.forEach((line, i) => {
          const top = -boxH / 2 + padY + i * lh;
          const y = top + (lh - (asc + desc)) / 2 + asc; // the same baseline the browser uses for the preview
          if (it.strokeW > 0) { ctx.lineWidth = it.strokeW * px; ctx.strokeStyle = it.strokeColor; ctx.strokeText(line, 0, y); }
          ctx.fillStyle = it.color; ctx.fillText(line, 0, y);
        });
      } else if (it.type === 'emoji') {
        const px = it.w * W;
        ctx.font = `${px}px ${EMOJI_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        const m = ctx.measureText(it.emoji);
        const asc = m.fontBoundingBoxAscent ?? px * 0.9; const desc = m.fontBoundingBoxDescent ?? px * 0.25;
        ctx.fillText(it.emoji, 0, -px / 2 + (px - (asc + desc)) / 2 + asc);
      } else if (it.img && it.img.naturalWidth) {
        const w = it.w * W; const h = w * (it.img.naturalHeight / it.img.naturalWidth);
        ctx.drawImage(it.img, -w / 2, -h / 2, w, h);
      }
      ctx.restore();
    }
    return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
  }
}
