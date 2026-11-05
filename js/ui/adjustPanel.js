// The Clip Adjustments panel of the designer: speed, pitch, flip, zoom, colour and reverb for every clip, plus
// presets. Like the Framing and Lower third panels it only edits data on the pad (pad.adj, see js/shared/adjust.js);
// the pad draws the live preview and the server renders the same thing.
//
// All ranges, defaults and the built-in presets come from config/clip-adjustments.json. Presets saved here are
// kept in this browser; the built-in ones cannot be deleted.
import { db } from '../storage/db.js';
import {
  getAdjustConfig, loadAdjustConfig, normalizeAdjust, isDefaultAdjust, normalizeUserPresets, systemPresets,
} from '../shared/adjust.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PRESET_KEY = 'clip_adjust_presets';
const AUTO_KEY = 'clip_adjust_auto_aspect';

async function readUserPresets() {
  try { const raw = await db.getSetting(PRESET_KEY); return normalizeUserPresets(raw ? JSON.parse(raw) : []); } catch { return []; }
}
async function writeUserPresets(list) {
  try { await db.setSetting(PRESET_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

const same = (a, b) => {
  const x = normalizeAdjust(a); const y = normalizeAdjust(b);
  return Object.keys(x).every((k) => (typeof x[k] === 'number' ? Math.abs(x[k] - y[k]) < 1e-6 : x[k] === y[k]));
};

export function mountAdjustPanel(pad, root) {
  const n = pad.ns;
  let user = [];
  root.innerHTML = `
    <details class="ed-sec" id="${n}AdSec">
      <summary>Clip adjustments <span class="ed-sec-sub" id="${n}AdSub">speed, pitch, flip, zoom, colour</span></summary>
      <div class="ed-sec-body" id="${n}AdBody">
        <div class="ed-row"><label for="${n}AdPreset">Preset</label>
          <select class="form-input form-select" id="${n}AdPreset"></select>
          <div class="ed-hint" id="${n}AdPresetNote"></div></div>
        <div class="ed-row ed-row-inline">
          <button class="btn btn-ghost btn-sm" id="${n}AdSave" type="button">Save as preset</button>
          <button class="btn btn-ghost btn-sm" id="${n}AdDel" type="button" disabled title="Built-in presets cannot be deleted">Delete preset</button>
          <button class="btn btn-ghost btn-sm" id="${n}AdReset" type="button">Reset</button></div>
        <div class="ed-tpl-name" id="${n}AdNameRow" style="display:none">
          <input class="form-input" id="${n}AdName" placeholder="Name, e.g. Gaming vertical" maxlength="60">
          <button class="btn btn-primary btn-sm" id="${n}AdNameOk" type="button">Save</button></div>

        <div class="ed-sec-title" style="margin-top:6px">Sound and timing</div>
        <div class="ed-row"><label for="${n}AdSpeed">Speed <span id="${n}AdSpeedVal"></span></label>
          <input type="range" id="${n}AdSpeed"></div>
        <div class="ed-hint" id="${n}AdLenHint"></div>
        <div class="ed-row ed-row-inline"><label class="ed-check"><input type="checkbox" id="${n}AdKeep"> Keep the original pitch when the speed changes</label></div>
        <div class="ed-row"><label for="${n}AdPitch">Pitch shift <span id="${n}AdPitchVal"></span> <small>(semitones)</small></label>
          <input type="range" id="${n}AdPitch"></div>
        <div class="ed-row"><label for="${n}AdReverb">Reverb <span id="${n}AdReverbVal"></span></label>
          <input type="range" id="${n}AdReverb"></div>
        <div class="ed-row ed-row-inline"><label class="ed-check" title="When background music is added, it dips under the voice"><input type="checkbox" id="${n}AdDuck"> Background music ducks under the voice</label></div>

        <div class="ed-sec-title" style="margin-top:6px">Picture</div>
        <div class="ed-row ed-row-inline">
          <label class="ed-check"><input type="checkbox" id="${n}AdFlipH"> Flip horizontally</label>
          <label class="ed-check"><input type="checkbox" id="${n}AdFlipV"> Flip vertically</label></div>
        <div class="ed-row"><label for="${n}AdScale">Zoom <span id="${n}AdScaleVal"></span></label>
          <input type="range" id="${n}AdScale"></div>
        <div class="ed-row"><label for="${n}AdBri">Brightness <span id="${n}AdBriVal"></span></label><input type="range" id="${n}AdBri"></div>
        <div class="ed-row"><label for="${n}AdCon">Contrast <span id="${n}AdConVal"></span></label><input type="range" id="${n}AdCon"></div>
        <div class="ed-row"><label for="${n}AdSat">Saturation <span id="${n}AdSatVal"></span></label><input type="range" id="${n}AdSat"></div>

        <div class="ed-sec-title" style="margin-top:6px">Aspect ratio</div>
        <div class="ed-row ed-row-inline"><label class="ed-check" title="9:16 with a 16:9 video: fit it on a blurred background. 1:1 and 4:5: centre crop. Only changes a framing you have not set yourself."><input type="checkbox" id="${n}AdAuto"> Choose the framing from the aspect ratio</label></div>
        <div class="ed-hint" id="${n}AdAutoNote"></div>
        <div class="ed-hint" id="${n}AdHint">Drawn by the server, so cloud processing must be on. Zoom, flip, colour and speed show in the preview; pitch and reverb are heard in the finished clip. The colour preview is approximate.</div>
      </div>
    </details>`;
  const $ = (id) => document.getElementById(n + id);

  const sliders = [
    // [element id, field, limit key, format]
    ['AdSpeed', 'speed', 'speed', (v) => `${v.toFixed(2)}x`],
    ['AdPitch', 'pitch', 'pitch', (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`],
    ['AdReverb', 'reverb', 'reverb', (v) => `${Math.round(v)}%`],
    ['AdScale', 'scale', 'scale', (v) => `${Math.round(v)}%`],
    ['AdBri', 'brightness', 'color', (v) => `${v > 0 ? '+' : ''}${Math.round(v)}%`],
    ['AdCon', 'contrast', 'color', (v) => `${v > 0 ? '+' : ''}${Math.round(v)}%`],
    ['AdSat', 'saturation', 'color', (v) => `${v > 0 ? '+' : ''}${Math.round(v)}%`],
  ];
  for (const [id, field] of sliders) $(id).addEventListener('input', (e) => { const v = Number(e.target.value); if (Number.isFinite(v)) pad.setAdjust({ [field]: v }); });
  $('AdKeep').addEventListener('change', (e) => pad.setAdjust({ preservePitch: e.target.checked }));
  $('AdDuck').addEventListener('change', (e) => pad.setAdjust({ duck: e.target.checked }));
  $('AdFlipH').addEventListener('change', (e) => pad.setAdjust({ flipH: e.target.checked }));
  $('AdFlipV').addEventListener('change', (e) => pad.setAdjust({ flipV: e.target.checked }));
  $('AdReset').addEventListener('click', () => pad.setAdjust(getAdjustConfig().defaults));
  $('AdAuto').addEventListener('change', (e) => {
    pad.autoAspect = e.target.checked;
    try { localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0'); } catch { /* storage blocked */ }
    pad.applyAspectRules();
    pad._syncPanels();
  });
  try { if (localStorage.getItem(AUTO_KEY) === '0') pad.autoAspect = false; } catch { /* storage blocked */ }

  const allPresets = () => [...systemPresets(), ...user];
  const fillPresets = () => {
    const sel = $('AdPreset');
    if (!sel) return; // the editor was closed while presets were loading
    sel.innerHTML = `<option value="custom">Custom</option>
      <optgroup label="Built-in">${systemPresets().map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</optgroup>
      ${user.length ? `<optgroup label="Saved by you">${user.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</optgroup>` : ''}`;
  };
  $('AdPreset').addEventListener('change', (e) => {
    const p = allPresets().find((x) => x.id === e.target.value);
    if (p) pad.setAdjust(p.values);
  });
  $('AdSave').addEventListener('click', () => {
    if (user.length >= getAdjustConfig().userPresetLimit) { pad.notify('warn', `You can keep up to ${getAdjustConfig().userPresetLimit} saved presets. Delete one first.`); return; }
    $('AdNameRow').style.display = 'flex'; $('AdName').focus();
  });
  const doSave = async () => {
    const label = $('AdName').value.trim();
    if (!label) return;
    if (allPresets().some((p) => p.label.toLowerCase() === label.toLowerCase())) { pad.notify('warn', 'A preset with that name already exists.'); return; }
    const next = normalizeUserPresets([...user, { id: `u${Date.now().toString(36)}`, label, values: pad.adj }]);
    if (!(await writeUserPresets(next))) { pad.notify('error', 'Could not save the preset in this browser.'); return; }
    user = next; $('AdName').value = ''; $('AdNameRow').style.display = 'none';
    fillPresets(); pad._syncPanels();
    pad.notify('success', `Preset "${label}" saved.`);
  };
  $('AdNameOk').addEventListener('click', doSave);
  $('AdName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  $('AdDel').addEventListener('click', async () => {
    const p = user.find((x) => x.id === $('AdPreset').value);
    if (!p) return; // built-in presets (config/clip-adjustments.json) are never deleted from the app
    const next = user.filter((x) => x.id !== p.id);
    if (await writeUserPresets(next)) { user = next; fillPresets(); pad._syncPanels(); }
  });

  fillPresets();
  readUserPresets().then((list) => { user = list; fillPresets(); pad._syncPanels(); }).catch(() => {});
  loadAdjustConfig().then(() => { if ($('AdPreset')) { pad.setAdjust({}, { commit: false }); fillPresets(); } }).catch(() => {}); // limits / presets from config/clip-adjustments.json

  return {
    sync() {
      const a = pad.adj; const cfg = getAdjustConfig();
      for (const [id, field, lim, fmt] of sliders) {
        const el = $(id); const l = cfg.limits[lim];
        el.min = String(l.min); el.max = String(l.max); el.step = String(l.step);
        el.value = String(a[field]);
        $(`${id}Val`).textContent = fmt(a[field]);
      }
      // the clip length setting is the FINISHED length; a faster clip is cut from a longer stretch of the video
      const target = parseInt(document.getElementById('clipDuration')?.value || '0', 10) || 0;
      const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
      $('AdLenHint').textContent = target && Math.abs(a.speed - 1) > 0.001
        ? `Clips stay ${mmss(target)} long: each one is cut from ${mmss(target * a.speed)} of the video.` : '';
      $('AdKeep').checked = a.preservePitch; $('AdDuck').checked = a.duck;
      $('AdFlipH').checked = a.flipH; $('AdFlipV').checked = a.flipV;
      $('AdAuto').checked = pad.autoAspect;
      $('AdAuto').disabled = !cfg.aspectRules.enabled;
      $('AdAutoNote').textContent = pad.autoAspect ? (pad.aspectNote || '') : '';
      const match = allPresets().find((p) => same(p.values, a));
      $('AdPreset').value = match ? match.id : 'custom';
      const isUser = !!match && !match.system;
      $('AdDel').disabled = !isUser;
      $('AdDel').title = isUser ? 'Delete this saved preset' : 'Built-in presets cannot be deleted';
      $('AdPresetNote').textContent = match && match.description ? match.description : '';
      const on = !isDefaultAdjust(a);
      $('AdSub').textContent = on ? `${a.speed !== 1 ? `${a.speed}x · ` : ''}on` : 'speed, pitch, flip, zoom, colour';
      $('AdSec').classList.toggle('on', on);
      // zoom has no effect when the output keeps the original shape (same rule as framing)
      $('AdScale').disabled = !pad.framingEnabled();
      $('AdScale').title = pad.framingEnabled() ? '' : 'Zoom applies when an output aspect ratio is chosen (not "Original").';
    },
  };
}
