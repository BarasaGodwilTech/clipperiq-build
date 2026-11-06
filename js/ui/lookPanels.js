import { mountLtTimeline } from './ltTimeline.js';
// The two "look" panels of the designer: Framing (how the video sits in the frame, e.g. a 16:9 YouTube video
// inside a 9:16 TikTok frame) and the animated Lower third (ads / messages). They only edit data on the pad
// (pad.frame / pad.lt, see js/shared/); the pad draws the live preview and the server renders the same thing.
import { FRAME_MODES, FRAME_BGS, FRAME_PRESETS, defaultFrame } from '../shared/framing.js';
import {
  LT_STYLES, LT_IN, LT_OUT, LT_LOOPS, LT_FONTS, LT_FONT_FILES, LT_PRESETS, defaultLowerThird, normalizeLowerThird,
} from '../shared/lowerThird.js';

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
      $('LtAtEnd').checked = !!s.atEnd;
      $('LtStart').disabled = !!s.atEnd; $('LtRepeat').disabled = !!s.atEnd; // the end of the clip decides when it shows
      root.querySelectorAll('.ed-seg button').forEach((b) => b.classList.toggle('on', b.dataset.align === s.align));
    },
  };
}

export { normalizeLowerThird };
