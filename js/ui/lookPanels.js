import { mountLtTimeline } from './ltTimeline.js';
// The two "look" panels of the designer: Framing (how the video sits in the frame, e.g. a 16:9 YouTube video
// inside a 9:16 TikTok frame) and the animated Lower third (ads / messages). They only edit data on the pad
// (pad.frame / pad.lt, see js/shared/); the pad draws the live preview and the server renders the same thing.
import { FRAME_MODES, FRAME_BGS, FRAME_PRESETS, defaultFrame } from '../shared/framing.js';
import {
  LT_STYLES, LT_IN, LT_OUT, LT_LOOPS, LT_LAST, LT_FONTS, LT_FONT_FILES, LT_PRESETS, defaultLowerThird, normalizeLowerThird,
} from '../shared/lowerThird.js';
import {
  SQ_TEMPLATES, SQ_TRANSITIONS, SQ_LOOPS, SQ_MAX_IMAGE_BYTES, defaultSqueeze, normalizeSqueeze, squeezeTimeline, squeezeWindow, squeezeRect, drawSqueeze,
} from '../shared/squeeze.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const opts = (list, cur) => list.map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

/** Loads the lower-third fonts (declared in css/editor.css) so the preview draws with the same fonts as the server. */
export async function ensureLowerThirdFonts() {
  if (!document.fonts || !document.fonts.load) return;
  await Promise.all(LT_FONT_FILES.map((f) => document.fonts.load(`${f.weight} 24px "${f.family}"`).catch(() => {})));
}

const sameFrame = (a, b) => a.mode === b.mode && (a.mode === 'fill' || a.bg === b.bg) && Math.abs(a.zoom - b.zoom) < 0.005 && Math.abs(a.x - b.x) < 0.005 && Math.abs(a.y - b.y) < 0.005;

// ── Framing ─────────────────────────────────────────────────────────────────────────────
export function mountFramingPanel(pad, root) {
  const n = pad.ns;
  root.innerHTML = `
    <details class="ed-sec" open>
      <summary>Framing <span class="ed-sec-sub">where the video sits in the frame</span></summary>
      <div class="ed-sec-body" id="${n}FrBody">
        <div class="ed-row"><label for="${n}FrPreset">Layout</label>
          <select class="form-input form-select" id="${n}FrPreset"></select></div>
        <div class="ed-row ed-row-inline">
          <label>Mode <select class="form-input form-select" id="${n}FrMode">${opts(FRAME_MODES, 'fill')}</select></label>
          <label id="${n}FrBgWrap">Background <select class="form-input form-select" id="${n}FrBg">${opts(FRAME_BGS, 'blur')}</select>
            <input type="color" id="${n}FrColor" value="#000000" style="display:none" aria-label="Background colour"></label>
        </div>
        <div class="ed-row"><label for="${n}FrZoom">Zoom <span id="${n}FrZoomVal"></span></label>
          <input type="range" id="${n}FrZoom" min="30" max="400" value="100"></div>
        <div class="ed-hint" id="${n}FrHint">Drag the video in the preview to move it. Pinch, or hold Ctrl and scroll, to zoom.</div>
        <div class="ed-row ed-row-inline"><button class="btn btn-ghost btn-sm" id="${n}FrReset" type="button">Reset framing</button></div>
      </div>
    </details>`;
  const $ = (id) => document.getElementById(n + id);
  const preset = $('FrPreset');
  preset.innerHTML = FRAME_PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('') + '<option value="custom">Custom (moved or zoomed)</option>';

  preset.addEventListener('change', () => {
    const p = FRAME_PRESETS.find((x) => x.id === preset.value);
    if (p) pad.setFrame({ ...defaultFrame(), ...p.frame });
  });
  $('FrMode').addEventListener('change', (e) => pad.setFrame({ mode: e.target.value, zoom: 1, x: 0.5, y: 0.5 }));
  $('FrBg').addEventListener('change', (e) => pad.setFrame({ bg: e.target.value }));
  $('FrColor').addEventListener('input', (e) => pad.setFrame({ color: e.target.value }));
  $('FrZoom').addEventListener('input', (e) => pad.setFrame({ zoom: Number(e.target.value) / 100 }));
  $('FrReset').addEventListener('click', () => pad.setFrame(defaultFrame()));

  return {
    sync() {
      const f = pad.frame;
      const on = pad.framingEnabled();
      $('FrBody').style.opacity = on ? '1' : '0.45';
      $('FrBody').style.pointerEvents = on ? '' : 'none';
      $('FrHint').textContent = on
        ? 'Drag the video in the preview to move it. Pinch, or hold Ctrl and scroll, to zoom.'
        : 'Framing applies when an output aspect ratio is chosen (not "Original").';
      const match = FRAME_PRESETS.find((p) => sameFrame({ ...defaultFrame(), ...p.frame }, f));
      preset.value = match ? match.id : 'custom';
      $('FrMode').value = f.mode;
      $('FrBg').value = f.bg;
      $('FrBgWrap').style.display = f.mode === 'fit' ? '' : 'none';
      $('FrColor').style.display = f.mode === 'fit' && f.bg === 'color' ? '' : 'none';
      $('FrColor').value = f.color;
      const z = $('FrZoom');
      z.min = f.mode === 'fit' ? '30' : '100';
      z.value = String(Math.round(f.zoom * 100));
      $('FrZoomVal').textContent = `${Math.round(f.zoom * 100)}%`;
    },
  };
}

// ── Lower third ─────────────────────────────────────────────────────────────────────────
export function mountLowerThirdPanel(pad, root) {
  const n = pad.ns;
  root.innerHTML = `
    <details class="ed-sec" id="${n}LtSec">
      <summary>Lower third <span class="ed-sec-sub">animated ad or message</span>
        <label class="ed-switch" title="Show an animated lower third on every clip"><input type="checkbox" id="${n}LtOn"> On</label></summary>
      <div class="ed-sec-body" id="${n}LtBody">
        <div class="lt-items" id="${n}LtItems"></div>
        <div id="${n}LtTlRoot"></div>
        <div class="ed-row"><label for="${n}LtPreset">Start from</label>
          <select class="form-input form-select" id="${n}LtPreset"><option value="">Choose a ready-made one…</option>${LT_PRESETS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></div>
        <div class="ed-row"><label for="${n}LtStyle">Style</label>
          <select class="form-input form-select" id="${n}LtStyle">${opts(LT_STYLES, 'bar')}</select></div>
        <div class="ed-row"><label for="${n}LtTitle">Main text</label>
          <input class="form-input" id="${n}LtTitle" maxlength="70" placeholder="e.g. UP TO 50% OFF">
          <div class="ed-hint">Type <b>{part}</b> for each clip's own part number and <b>{next}</b> for the next one: "Follow for Part {next}" becomes Part 4 on Part 3.</div></div>
        <div class="ed-row"><label for="${n}LtSub">Second line</label>
          <input class="form-input" id="${n}LtSub" maxlength="110" placeholder="e.g. This weekend only"></div>
        <div class="ed-row ed-row-inline">
          <label>Label <input class="form-input" id="${n}LtTag" maxlength="24" placeholder="SALE" style="width:110px"></label>
          <label>Button <input class="form-input" id="${n}LtCta" maxlength="26" placeholder="SHOP NOW" style="width:130px"></label></div>
        <div class="ed-row ed-row-inline">
          <label>Accent <input type="color" id="${n}LtAccent" value="#ff2d55"></label>
          <label>Background <input type="color" id="${n}LtBg" value="#0f172a"></label>
          <label>Text <input type="color" id="${n}LtText" value="#ffffff"></label></div>
        <div class="ed-row ed-row-inline">
          <label>Font <select class="form-input form-select" id="${n}LtFont">${opts(LT_FONTS, 'archivo')}</select></label>
          <span class="ed-seg" role="group" aria-label="Alignment">
            <button type="button" data-align="left" title="Left">&#8676;</button><button type="button" data-align="center" title="Centre">&#8596;</button><button type="button" data-align="right" title="Right">&#8677;</button></span></div>
        <div class="ed-row"><label for="${n}LtSize">Size <span id="${n}LtSizeVal"></span></label>
          <input type="range" id="${n}LtSize" min="50" max="180" value="100"></div>
        <div class="ed-row"><label for="${n}LtY">Height in the frame <span id="${n}LtYVal"></span>
          <button type="button" class="ed-link" id="${n}LtYAuto">Auto</button></label>
          <input type="range" id="${n}LtY" min="5" max="95" value="70"></div>
        <div class="ed-sec-title" style="margin-top:6px">Motion</div>
        <div class="ed-row ed-row-inline">
          <label>In <select class="form-input form-select" id="${n}LtIn">${opts(LT_IN, 'slide')}</select></label>
          <label>Out <select class="form-input form-select" id="${n}LtOut">${opts(LT_OUT, 'same')}</select></label>
          <label>While showing <select class="form-input form-select" id="${n}LtLoop">${opts(LT_LOOPS, 'shine')}</select></label></div>
        <div class="ed-row"><label for="${n}LtSpeed">Animation speed <span id="${n}LtSpeedVal"></span></label>
          <input type="range" id="${n}LtSpeed" min="50" max="200" value="100"></div>
        <div class="ed-sec-title" style="margin-top:6px">Timing (seconds from the start of each clip)</div>
        <div class="ed-row ed-row-inline">
          <label>Appears at <input class="form-input ed-time" id="${n}LtStart" type="number" min="0" step="0.5" value="2"></label>
          <label>Stays for <input class="form-input ed-time" id="${n}LtHold" type="number" min="0.5" max="120" step="0.5" value="6"></label>
          <label>Repeat every <input class="form-input ed-time" id="${n}LtRepeat" type="number" min="0" step="1" value="0" title="0 = show once"></label></div>
        <div class="ed-row ed-row-inline"><label class="ed-check" title="Shows it once, just before each clip ends: right for 'Follow for the next part'"><input type="checkbox" id="${n}LtAtEnd"> Show near the end of every clip</label></div>
        <div class="ed-sec-title" style="margin-top:6px">On the last part</div>
        <div class="ed-row"><label for="${n}LtLast">What it does on the final part of a run</label>
          <select class="form-input form-select" id="${n}LtLast">${opts(LT_LAST, 'same')}</select>
          <div class="ed-hint">Made for "Follow for Part {next}": the last part has no next part. If more parts will follow in a later run, untick "This run ends the series" on the Upload screen.</div></div>
        <div id="${n}LtLastBox" style="display:none">
          <div class="ed-row"><label for="${n}LtLastTitle">Closing text</label><input class="form-input" id="${n}LtLastTitle" maxlength="70" placeholder="Thanks for watching!"></div>
          <div class="ed-row"><label for="${n}LtLastSub">Second line</label><input class="form-input" id="${n}LtLastSub" maxlength="110"></div>
          <div class="ed-row ed-row-inline">
            <label>Label <input class="form-input" id="${n}LtLastTag" maxlength="24" style="width:110px"></label>
            <label>Button <input class="form-input" id="${n}LtLastCta" maxlength="26" style="width:130px"></label></div></div>
        <div class="ed-row ed-row-inline"><label class="ed-check" title="Shows the preview the way the final part will look"><input type="checkbox" id="${n}LtPrevLast"> Preview as the last part</label></div>
        <div class="ed-row ed-row-inline"><button class="btn btn-ghost btn-sm" id="${n}LtPlay" type="button">&#9654; Preview animation</button>
          <label class="ed-check" title="Plays the animation again by itself a moment after you change its motion, style or timing"><input type="checkbox" id="${n}LtAuto"> Replay automatically</label></div>
        <div class="ed-hint">Drag it in the preview to move it. The preview stays in view while you scroll.</div>
      </div>
    </details>`;
  const $ = (id) => document.getElementById(n + id);
  const set = (patch) => pad.setLowerThird(patch);
  const bindText = (id, key) => $(id).addEventListener('input', (e) => set({ [key]: e.target.value }));
  const bindSel = (id, key) => $(id).addEventListener('change', (e) => set({ [key]: e.target.value }));
  const bindNum = (id, key, scale = 1) => $(id).addEventListener('input', (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set({ [key]: v / scale }); });

  // The lower thirds of the clip, as buttons; the controls below edit the selected one, the timeline places them all in time.
  const timeline = mountLtTimeline(pad, $('LtTlRoot'));
  $('LtItems').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'add') pad.addLowerThird();
    else if (b.dataset.act === 'dup') pad.duplicateLowerThird();
    else if (b.dataset.act === 'del') pad.removeLowerThird();
    else if (b.dataset.i != null) pad.selectLowerThird(Number(b.dataset.i));
  });
  const itemLabel = (x) => { const r = pad._ltResolved ? pad._ltResolved(x) : x; return String(r.title || r.subtitle || r.cta || r.tag || 'empty').slice(0, 18); };

  $('LtOn').addEventListener('click', (e) => e.stopPropagation()); // don't fold the section when toggling
  $('LtOn').addEventListener('change', (e) => {
    if (e.target.checked && !pad.lt.title && !pad.lt.subtitle && !pad.lt.cta && !pad.lt.tag) {
      // switching it on with nothing written yet: start from the first ready-made one so something shows
      const p = LT_PRESETS[0];
      pad.setLowerThird({ ...p.spec, enabled: true, start: pad.lt.start, hold: pad.lt.hold });
    } else set({ enabled: e.target.checked });
    if (e.target.checked) $('LtSec').open = true;
  });
  $('LtPreset').addEventListener('change', (e) => {
    const p = LT_PRESETS.find((x) => x.id === e.target.value);
    if (p) pad.setLowerThird({ ...defaultLowerThird(), ...p.spec, enabled: true, y: pad.lt.y, start: p.spec.start ?? pad.lt.start, hold: p.spec.hold ?? pad.lt.hold });
    e.target.value = '';
  });
  bindSel('LtStyle', 'style'); bindText('LtTitle', 'title'); bindText('LtSub', 'subtitle'); bindText('LtTag', 'tag'); bindText('LtCta', 'cta');
  bindText('LtAccent', 'accent'); bindText('LtBg', 'bg'); bindText('LtText', 'text');
  bindSel('LtFont', 'font'); bindSel('LtIn', 'in'); bindSel('LtOut', 'out'); bindSel('LtLoop', 'loop');
  bindNum('LtSize', 'size', 100); bindNum('LtY', 'y', 100); bindNum('LtSpeed', 'speed', 100);
  bindNum('LtStart', 'start'); bindNum('LtHold', 'hold'); bindNum('LtRepeat', 'repeat');
  bindSel('LtLast', 'last'); bindText('LtLastTitle', 'lastTitle'); bindText('LtLastSub', 'lastSubtitle'); bindText('LtLastTag', 'lastTag'); bindText('LtLastCta', 'lastCta');
  $('LtPrevLast').addEventListener('change', (e) => pad.setPreviewLast(e.target.checked));
  $('LtAtEnd').addEventListener('change', (e) => pad.setLowerThird({ atEnd: e.target.checked }));
  $('LtYAuto').addEventListener('click', () => set({ y: null }));
  root.querySelectorAll('.ed-seg button').forEach((b) => b.addEventListener('click', () => set({ align: b.dataset.align })));
  $('LtPlay').addEventListener('click', () => pad.previewLowerThird());
  $('LtAuto').checked = !!pad.autoLtPlay;
  $('LtAuto').addEventListener('change', (e) => {
    pad.autoLtPlay = e.target.checked;
    try { localStorage.setItem('clipperiq.ltAutoPlay', e.target.checked ? '1' : '0'); } catch { /* storage blocked */ }
  });

  return {
    sync() {
      const s = pad.lt;
      const typing = (id) => document.activeElement === $(id);
      $('LtItems').innerHTML = `${pad.lts.map((x, i) => `<button type="button" class="lt-chip${i === pad.ltSel ? ' sel' : ''}${x.enabled ? '' : ' off'}" data-i="${i}" title="Edit this lower third">${i + 1}. ${esc(itemLabel(x))}</button>`).join('')}`
        + `<button type="button" class="lt-chip act" data-act="add" title="Add another lower third to every clip">+ Add</button>`
        + `<button type="button" class="lt-chip act" data-act="dup" title="Copy this one">Duplicate</button>`
        + `<button type="button" class="lt-chip act" data-act="del" title="${pad.lts.length > 1 ? 'Remove this one' : 'Clear this one'}">${pad.lts.length > 1 ? 'Remove' : 'Clear'}</button>`;
      const on = pad.lts.filter((x) => x.enabled).length;
      const subEl = document.querySelector(`#${n}LtSec .ed-sec-sub`); if (subEl) subEl.textContent = on > 1 ? `${on} lower thirds` : 'animated ad or message';
      timeline.sync();
      $('LtOn').checked = s.enabled;
      $('LtBody').style.opacity = s.enabled ? '1' : '0.55';
      $('LtStyle').value = s.style;
      if (!typing('LtTitle')) $('LtTitle').value = s.title;
      if (!typing('LtSub')) $('LtSub').value = s.subtitle;
      if (!typing('LtTag')) $('LtTag').value = s.tag;
      if (!typing('LtCta')) $('LtCta').value = s.cta;
      $('LtAccent').value = s.accent; $('LtBg').value = s.bg; $('LtText').value = s.text;
      $('LtFont').value = s.font; $('LtIn').value = s.in; $('LtOut').value = s.out; $('LtLoop').value = s.loop;
      $('LtSize').value = String(Math.round(s.size * 100)); $('LtSizeVal').textContent = `${Math.round(s.size * 100)}%`;
      const y = s.y == null ? pad.lowerThirdAutoY() : s.y;
      $('LtY').value = String(Math.round(y * 100)); $('LtYVal').textContent = s.y == null ? 'Auto' : `${Math.round(y * 100)}%`;
      $('LtSpeed').value = String(Math.round(s.speed * 100)); $('LtSpeedVal').textContent = `${s.speed.toFixed(2)}x`;
      if (!typing('LtStart')) $('LtStart').value = String(s.start);
      if (!typing('LtHold')) $('LtHold').value = String(s.hold);
      if (!typing('LtRepeat')) $('LtRepeat').value = String(s.repeat);
      $('LtLast').value = s.last || 'same'; $('LtLastBox').style.display = s.last === 'text' ? '' : 'none';
      if (!typing('LtLastTitle')) $('LtLastTitle').value = s.lastTitle || '';
      if (!typing('LtLastSub')) $('LtLastSub').value = s.lastSubtitle || '';
      if (!typing('LtLastTag')) $('LtLastTag').value = s.lastTag || '';
      if (!typing('LtLastCta')) $('LtLastCta').value = s.lastCta || '';
      $('LtPrevLast').checked = !!pad.previewLast;
      $('LtAtEnd').checked = !!s.atEnd;
      $('LtStart').disabled = !!s.atEnd; $('LtRepeat').disabled = !!s.atEnd; // the end of the clip decides when it shows
      root.querySelectorAll('.ed-seg button').forEach((b) => b.classList.toggle('on', b.dataset.align === s.align));
    },
  };
}

export { normalizeLowerThird };


// ── Squeeze screen ──────────────────────────────────────────────────────────────────────
/** A picture chosen for a squeeze slot, shrunk and compressed until it is small enough to travel with the design. */
export function squeezePictureFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) { reject(new Error('Choose a picture file (PNG, JPG or WebP).')); return; }
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      let max = 640;
      for (let tries = 0; tries < 6; tries++) {
        const k = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.width * k)); c.height = Math.max(1, Math.round(im.height * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        let out = c.toDataURL('image/png');                                   // PNG keeps a logo's transparent edges
        if (out.length > SQ_MAX_IMAGE_BYTES * 1.3) out = c.toDataURL('image/webp', 0.82);
        if (out.length <= SQ_MAX_IMAGE_BYTES * 1.3 && /^data:image\/(png|webp|jpeg)/.test(out)) { resolve(out); return; }
        max = Math.round(max * 0.75);
      }
      reject(new Error('That picture is too detailed to use. Try a smaller one.'));
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be read.')); };
    im.src = url;
  });
}

export function mountSqueezePanel(pad, root) {
  const n = pad.ns;
  root.innerHTML = `
    <details class="ed-sec" id="${n}SqSec">
      <summary>Squeeze screen <span class="ed-sec-sub">shrink the video into an animated frame with your offer</span>
        <label class="ed-check" style="margin-left:auto" onclick="event.stopPropagation()"><input type="checkbox" id="${n}SqOn"> On</label></summary>
      <div class="ed-sec-body" id="${n}SqBody">
        <div class="ed-hint" style="margin-top:0">Like a TV ad break: the picture squeezes into a window, your frame slides in around it, and later the picture returns to full screen. Lower thirds, captions and overlays are drawn on top.</div>
        <div class="sq-gal" id="${n}SqGal" role="radiogroup" aria-label="Squeeze templates"></div>
        <div class="ed-row ed-row-inline"><label>Brand <input class="form-input" id="${n}SqBrand" maxlength="40"></label><label>Label <input class="form-input" id="${n}SqBadge" maxlength="14" placeholder="LIVE, NEW…" style="width:110px"></label></div>
        <div class="ed-row ed-row-inline"><label>Big number <input class="form-input" id="${n}SqHead" maxlength="14" style="width:100px" placeholder="36%"></label><label>Small word <input class="form-input" id="${n}SqSub" maxlength="22" style="width:110px" placeholder="OFF"></label></div>
        <div class="ed-row"><label for="${n}SqTitle">Title</label><input class="form-input" id="${n}SqTitle" maxlength="60"></div>
        <div class="ed-row"><label for="${n}SqCap">Description</label><input class="form-input" id="${n}SqCap" maxlength="110"></div>
        <div class="ed-row"><label for="${n}SqCta">Button / call to action</label><input class="form-input" id="${n}SqCta" maxlength="40"></div>
        <div class="ed-row" id="${n}SqTickRow"><label for="${n}SqTick">Scrolling ticker text</label><input class="form-input" id="${n}SqTick" maxlength="220"></div>
        <div class="ed-hint">Type {part} for this clip's part number and {next} for the next one.</div>

        <div class="ed-sec-title" style="margin-top:8px">Pictures</div>
        <div class="sq-pics">
          ${['logo', 'product', 'qr'].map((k) => `<div class="sq-pic" id="${n}SqPic_${k}"><img id="${n}SqImg_${k}" alt="" style="display:none"><div>${k === 'qr' ? 'QR code' : k === 'logo' ? 'Logo' : 'Product'}</div>
            <button type="button" class="btn btn-ghost btn-sm" data-pick="${k}">Choose…</button> <button type="button" class="btn btn-ghost btn-sm" data-clear="${k}" style="display:none">Remove</button></div>`).join('')}
        </div>
        <input type="file" id="${n}SqFile" accept="image/*" style="display:none">
        <div class="ed-hint">An empty picture slot shows a sample in this preview only: nothing is drawn there in the finished clip.</div>

        <div class="ed-sec-title" style="margin-top:8px">Look</div>
        <div class="ed-row ed-row-inline"><label>Main <input type="color" id="${n}SqC1"></label><label>Dark <input type="color" id="${n}SqC2"></label><label>Accent <input type="color" id="${n}SqC3"></label><label>Text <input type="color" id="${n}SqC4"></label></div>
        <div class="ed-row ed-row-inline"><label>Font <select class="form-input form-select" id="${n}SqFont">${opts(LT_FONTS, 'archivo')}</select></label>
          <label>Window size <input type="range" id="${n}SqScale" min="80" max="115" value="100" style="width:110px"></label>
          <label class="ed-check"><input type="checkbox" id="${n}SqMirror"> Flip sides</label></div>

        <div class="ed-sec-title" style="margin-top:8px">Motion</div>
        <div class="ed-row ed-row-inline"><label>Transition <select class="form-input form-select" id="${n}SqTrans">${opts(SQ_TRANSITIONS, 'ease')}</select></label>
          <label>While showing <select class="form-input form-select" id="${n}SqLoop"></select></label></div>
        <div class="ed-row"><label for="${n}SqSpeed">Speed <span id="${n}SqSpeedVal"></span></label><input type="range" id="${n}SqSpeed" min="50" max="200" value="100"></div>
        <div class="ed-sec-title" style="margin-top:8px">Timing (seconds in each clip)</div>
        <div class="ed-row ed-row-inline"><label>Appears at <input class="form-input" type="number" id="${n}SqStart" min="0" max="600" step="0.5" style="width:80px"></label>
          <label>Stays for <input class="form-input" type="number" id="${n}SqHold" min="1.5" max="300" step="0.5" style="width:80px"></label>
          <label>Repeat every <input class="form-input" type="number" id="${n}SqRepeat" min="0" max="600" step="1" style="width:80px"></label></div>
        <div class="ed-row ed-row-inline"><label class="ed-check"><input type="checkbox" id="${n}SqAtEnd"> Show near the end of every clip</label></div>
        <div class="ed-row ed-row-inline"><button class="btn btn-ghost btn-sm" id="${n}SqPlay" type="button">&#9654; Preview animation</button>
          <button class="btn btn-ghost btn-sm" id="${n}SqReset" type="button">Reset</button></div>
      </div>
    </details>`;
  const $ = (id) => document.getElementById(n + id);
  const bindText = (id, key) => $(id).addEventListener('input', (e) => pad.setSqueeze({ [key]: e.target.value }));
  const bindNum = (id, key) => $(id).addEventListener('change', (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) pad.setSqueeze({ [key]: v }); });
  $('SqOn').addEventListener('change', (e) => pad.setSqueeze({ enabled: e.target.checked }));
  bindText('SqBrand', 'brand'); bindText('SqBadge', 'badge'); bindText('SqHead', 'headline'); bindText('SqSub', 'sub');
  bindText('SqTitle', 'title'); bindText('SqCap', 'caption'); bindText('SqCta', 'cta'); bindText('SqTick', 'ticker');
  [['SqC1', 'primary'], ['SqC2', 'secondary'], ['SqC3', 'accent'], ['SqC4', 'text']].forEach(([id, k]) => $(id).addEventListener('input', (e) => pad.setSqueeze({ [k]: e.target.value })));
  $('SqFont').addEventListener('change', (e) => pad.setSqueeze({ font: e.target.value }));
  $('SqTrans').addEventListener('change', (e) => pad.setSqueeze({ transition: e.target.value }));
  $('SqLoop').addEventListener('change', (e) => pad.setSqueeze({ loop: e.target.value }));
  $('SqSpeed').addEventListener('input', (e) => pad.setSqueeze({ speed: Number(e.target.value) / 100 }));
  $('SqScale').addEventListener('input', (e) => pad.setSqueeze({ scale: Number(e.target.value) / 100 }));
  $('SqMirror').addEventListener('change', (e) => pad.setSqueeze({ mirror: e.target.checked }));
  bindNum('SqStart', 'start'); bindNum('SqHold', 'hold'); bindNum('SqRepeat', 'repeat');
  $('SqAtEnd').addEventListener('change', (e) => pad.setSqueeze({ atEnd: e.target.checked }));
  $('SqPlay').addEventListener('click', () => pad.previewSqueeze());
  $('SqReset').addEventListener('click', () => pad.setSqueeze({ ...defaultSqueeze(pad.sq.template), enabled: pad.sq.enabled, images: pad.sq.images }));

  // pictures
  let pickSlot = null;
  root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { pickSlot = b.dataset.pick; $('SqFile').value = ''; $('SqFile').click(); }));
  root.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => pad.setSqueeze({ images: { ...pad.sq.images, [b.dataset.clear]: '' } })));
  $('SqFile').addEventListener('change', async () => {
    const f = $('SqFile').files && $('SqFile').files[0]; if (!f || !pickSlot) return;
    try { pad.setSqueeze({ images: { ...pad.sq.images, [pickSlot]: await squeezePictureFromFile(f) } }); } catch (e) { pad.notify?.('error', e.message); }
  });

  // template gallery: each card is a small drawing of that template (in the shape of the current output), held
  const gal = $('SqGal'); let galKey = '';
  function buildGallery() {
    const ar = pad.getAspect ? pad.getAspect() : 9 / 16; const key = `${Math.round(ar * 100)}`;
    if (key === galKey && gal.children.length) return; galKey = key;
    const tw = 150; const th = Math.round(tw / ar); gal.innerHTML = '';
    for (const t of SQ_TEMPLATES) {
      const card = document.createElement('div'); card.className = 'sq-card'; card.setAttribute('role', 'radio'); card.dataset.id = t.id; card.tabIndex = 0; card.title = t.desc;
      const c = document.createElement('canvas'); c.width = tw; c.height = th; card.appendChild(c); card.appendChild(document.createTextNode(t.label));
      const draw = () => {
        const spec = normalizeSqueeze({ enabled: true, template: t.id, loop: 'none', start: 0, hold: 4 }); const tl = squeezeTimeline(spec);
        const layer = document.createElement('canvas'); layer.width = tw; layer.height = th;
        const r = drawSqueeze(layer.getContext('2d'), tw, th, spec, tl.inDur + 1, { demo: true });
        const cx = c.getContext('2d'); cx.fillStyle = '#000'; cx.fillRect(0, 0, tw, th);
        const g = cx.createLinearGradient(0, 0, tw, th); g.addColorStop(0, '#38bdf8'); g.addColorStop(1, '#f472b6');
        if (r.rect) { cx.fillStyle = g; cx.fillRect(r.rect.x, r.rect.y, r.rect.w, r.rect.h); } cx.drawImage(layer, 0, 0);
      };
      draw(); const pick = () => pad.setSqueeze({ template: t.id, ...t.colors }); // a template brings its own colours; texts and pictures stay
      card.addEventListener('click', pick); card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      gal.appendChild(card); card._redraw = draw;
    }
  }
  $('SqSec').addEventListener('toggle', () => { if ($('SqSec').open) buildGallery(); });
  ensureLowerThirdFonts().then(() => { if ($('SqSec').open) { galKey = ''; buildGallery(); } });

  return {
    sync() {
      const q = pad.sq; const typing = (id) => document.activeElement === $(id);
      $('SqOn').checked = q.enabled; $('SqBody').style.opacity = q.enabled ? '1' : '0.5';
      if ($('SqSec').open) buildGallery();
      gal.querySelectorAll('.sq-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === q.template)));
      [['SqBrand', 'brand'], ['SqBadge', 'badge'], ['SqHead', 'headline'], ['SqSub', 'sub'], ['SqTitle', 'title'], ['SqCap', 'caption'], ['SqCta', 'cta'], ['SqTick', 'ticker']].forEach(([id, k]) => { if (!typing(id)) $(id).value = q[k]; });
      $('SqTickRow').style.display = q.template === 'news' ? '' : 'none';
      [['SqC1', 'primary'], ['SqC2', 'secondary'], ['SqC3', 'accent'], ['SqC4', 'text']].forEach(([id, k]) => { $(id).value = q[k]; });
      $('SqFont').value = q.font; $('SqTrans').value = q.transition; $('SqMirror').checked = q.mirror; $('SqAtEnd').checked = q.atEnd;
      const tpl = SQ_TEMPLATES.find((t) => t.id === q.template) || SQ_TEMPLATES[0];
      $('SqLoop').innerHTML = opts(SQ_LOOPS.filter((l) => tpl.loops.includes(l.id)), q.loop);
      $('SqSpeed').value = Math.round(q.speed * 100); $('SqSpeedVal').textContent = `${Math.round(q.speed * 100)}%`; $('SqScale').value = Math.round(q.scale * 100);
      [['SqStart', 'start'], ['SqHold', 'hold'], ['SqRepeat', 'repeat']].forEach(([id, k]) => { if (!typing(id)) $(id).value = q[k]; });
      for (const k of ['logo', 'product', 'qr']) {
        const im = $(`SqImg_${k}`); const has = !!q.images[k]; im.style.display = has ? '' : 'none'; if (has) im.src = q.images[k];
        root.querySelector(`[data-clear="${k}"]`).style.display = has ? '' : 'none';
      }
    },
  };
}
