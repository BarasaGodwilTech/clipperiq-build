// The Captions panel of the designer: turn speech into captions (or import an .srt / .vtt file), correct the words and their
// timing, pick a look (ready-made, or your own saved ones) and see it on the preview as the video plays.
//
// It edits data on the pad (pad.cap = the look, pad.capCues = the words, see js/shared/captions.js); the pad draws the
// preview and the server burns the same thing into every clip. Where the words come from and where they are kept is up to
// whoever owns the pad (pad._capCfg.api), so the same panel works before generating (the editor) and afterwards (Design).
import { db } from '../storage/db.js';
import {
  CAPTION_FONTS, ANIM_IN, ANIM_OUT, HIGHLIGHTS, captionTemplates, loadCaptionTemplates, normalizeCaptionStyle, normalizeUserTemplates,
  userTemplateLimit, parseSubtitles, cuesToSrt, cueWords, setCueText, splitCue, mergeCues, replaceInCues, normalizeCues,
} from '../shared/captions.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY = 'caption_user_templates';
const LANGS = [['auto', 'Detect the language'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'],
  ['sw', 'Swahili'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['tr', 'Turkish'], ['ru', 'Russian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['id', 'Indonesian']];
const MAX_ROWS = 120;

const fmt = (t) => { const s = Math.max(0, Number(t) || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
function parseTime(v) {
  const s = String(v || '').trim().replace(',', '.');
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return NaN;
  return parts.reduce((a, x) => a * 60 + x, 0);
}
async function readUser() { try { const raw = await db.getSetting(KEY); return normalizeUserTemplates(raw ? JSON.parse(raw) : []); } catch { return []; } }
async function writeUser(list) { try { await db.setSetting(KEY, JSON.stringify(list)); return true; } catch { return false; } }
const same = (a, b) => JSON.stringify(normalizeCaptionStyle(a)) === JSON.stringify(normalizeCaptionStyle(b));

export function mountCaptionsPanel(pad, root) {
  const n = pad.ns;
  let user = [];
  let showAll = false;
  let busy = null; // { abort } while words are being found
  let engine = null;
  const cfg = () => pad._capCfg || {};
  const api = () => cfg().api || null;

  root.innerHTML = `
    <details class="ed-sec" id="${n}CpSec">
      <summary>Captions <span class="ed-sec-sub" id="${n}CpSub">auto subtitles in your own look</span>
        <label class="ed-switch" title="Add captions to every clip"><input type="checkbox" id="${n}CpOn"> On</label></summary>
      <div class="ed-sec-body" id="${n}CpBody">
        <div class="ed-hint" id="${n}CpEngine"></div>

        <div class="ed-sec-title">1. The words</div>
        <div class="ed-row"><label for="${n}CpLang">Spoken language</label>
          <select class="form-input form-select" id="${n}CpLang">${LANGS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
        <div class="ed-row ed-row-inline"><label class="ed-check" id="${n}CpRangeWrap" title="Quicker: only the stretch you chose to generate from"><input type="checkbox" id="${n}CpRange" checked> Only the part I chose to generate from</label></div>
        <div class="ed-row ed-row-inline">
          <button class="btn btn-primary btn-sm" id="${n}CpGen" type="button">Generate from speech</button>
          <button class="btn btn-ghost btn-sm" id="${n}CpStop" type="button" style="display:none">Stop</button>
          <button class="btn btn-ghost btn-sm" id="${n}CpImport" type="button" title="Use captions you already have (.srt or .vtt)">Import .srt / .vtt</button>
          <input type="file" id="${n}CpFile" accept=".srt,.vtt,text/vtt,application/x-subrip" style="display:none"></div>
        <div class="ed-hint" id="${n}CpProg"></div>

        <div class="ed-sec-title" style="margin-top:6px">2. Look</div>
        <div class="ed-row"><label for="${n}CpTpl">Style</label>
          <select class="form-input form-select" id="${n}CpTpl"></select>
          <div class="ed-hint" id="${n}CpTplNote"></div></div>
        <div class="ed-row ed-row-inline">
          <button class="btn btn-ghost btn-sm" id="${n}CpSave" type="button">Save this look</button>
          <button class="btn btn-ghost btn-sm" id="${n}CpDel" type="button" disabled title="Built-in looks cannot be deleted">Delete look</button></div>
        <div class="ed-tpl-name" id="${n}CpNameRow" style="display:none">
          <input class="form-input" id="${n}CpName" placeholder="Name, e.g. My podcast look" maxlength="60">
          <button class="btn btn-primary btn-sm" id="${n}CpNameOk" type="button">Save</button></div>
        <details class="ed-sec" id="${n}CpCustom" style="margin:0"><summary>Customize <span class="ed-sec-sub">font, colours, motion</span></summary>
          <div class="ed-sec-body">
            <div class="ed-row ed-row-inline">
              <label>Font <select class="form-input form-select" id="${n}CpFont" style="width:auto">${CAPTION_FONTS.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('')}</select></label>
              <label class="ed-check"><input type="checkbox" id="${n}CpUpper"> CAPITALS</label></div>
            <div class="ed-row"><label for="${n}CpSize">Size <span id="${n}CpSizeVal"></span></label><input type="range" id="${n}CpSize" min="2.5" max="16" step="0.1"></div>
            <div class="ed-row"><label for="${n}CpY">Height in the frame <span id="${n}CpYVal"></span></label><input type="range" id="${n}CpY" min="6" max="94" step="1"></div>
            <div class="ed-row"><label for="${n}CpWords">Words at a time <span id="${n}CpWordsVal"></span></label><input type="range" id="${n}CpWords" min="1" max="10" step="1"></div>
            <div class="ed-row ed-row-inline">
              <label>Lines <select class="form-input form-select" id="${n}CpLines" style="width:auto"><option>1</option><option>2</option><option>3</option></select></label>
              <label>Text <input type="color" id="${n}CpColor"></label>
              <label>Edge <input type="color" id="${n}CpStrokeColor"></label></div>
            <div class="ed-row"><label for="${n}CpStroke">Edge thickness <span id="${n}CpStrokeVal"></span></label><input type="range" id="${n}CpStroke" min="0" max="0.4" step="0.01"></div>
            <div class="ed-row ed-row-inline">
              <label>Spoken word <select class="form-input form-select" id="${n}CpHl" style="width:auto"><option value="none">no change</option><option value="color">changes colour</option><option value="pop">colour and swell</option></select></label>
              <label>Colour <input type="color" id="${n}CpHlColor"></label></div>
            <div class="ed-row ed-row-inline">
              <label class="ed-check"><input type="checkbox" id="${n}CpBox"> Box behind the text</label>
              <label>Box <input type="color" id="${n}CpBoxColor"></label></div>
            <div class="ed-row"><label for="${n}CpBoxOp">Box strength <span id="${n}CpBoxOpVal"></span></label><input type="range" id="${n}CpBoxOp" min="0" max="1" step="0.05"></div>
            <div class="ed-row ed-row-inline">
              <label>Appears <select class="form-input form-select" id="${n}CpIn" style="width:auto">${ANIM_IN.map((a) => `<option value="${a}">${{ none: 'at once', fade: 'fading in', pop: 'popping in', slide: 'sliding up', bounce: 'bouncing in' }[a]}</option>`).join('')}</select></label>
              <label>Leaves <select class="form-input form-select" id="${n}CpOut" style="width:auto">${ANIM_OUT.map((a) => `<option value="${a}">${a === 'fade' ? 'fading out' : 'at once'}</option>`).join('')}</select></label></div>
            <div class="ed-row ed-row-inline"><label class="ed-check" title="Words appear one by one as they are spoken"><input type="checkbox" id="${n}CpReveal"> Words appear as they are spoken</label></div>
          </div></details>

        <div class="ed-sec-title" style="margin-top:6px">3. Fix the words <span id="${n}CpCount" style="text-transform:none;letter-spacing:0;font-weight:400"></span></div>
        <div class="ed-row ed-row-inline">
          <input class="form-input" id="${n}CpFind" placeholder="Find" style="flex:1;min-width:90px">
          <input class="form-input" id="${n}CpRepl" placeholder="Replace with" style="flex:1;min-width:90px">
          <button class="btn btn-ghost btn-sm" id="${n}CpReplAll" type="button">Replace all</button></div>
        <div class="cp-list" id="${n}CpList"></div>
        <div class="ed-row ed-row-inline">
          <button class="btn btn-ghost btn-sm" id="${n}CpAdd" type="button" title="A new line starting at the point you are looking at">+ Add line here</button>
          <button class="btn btn-ghost btn-sm" id="${n}CpExport" type="button">Save as .srt</button>
          <button class="btn btn-ghost btn-sm" id="${n}CpClear" type="button">Clear all</button></div>
        <div class="ed-hint">Captions are drawn on the finished clips by the server, so cloud processing must be on. The preview is drawn by your browser and the clips by the server: they match, give or take a pixel.</div>
      </div>
    </details>`;
  const $ = (id) => document.getElementById(n + id);

  // ── on / off ──
  $('CpOn').addEventListener('click', (e) => e.stopPropagation());
  $('CpOn').addEventListener('change', (e) => {
    pad.setCaptions({ enabled: e.target.checked });
    if (e.target.checked) $('CpSec').open = true;
    if (e.target.checked && !pad.capCues.length) loadFromServer();
  });

  // ── look ──
  const allTemplates = () => [...captionTemplates(), ...user];
  const fillTemplates = () => {
    $('CpTpl').innerHTML = `<option value="custom">Custom</option><optgroup label="Built-in">${captionTemplates().map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')}</optgroup>`
      + (user.length ? `<optgroup label="Saved by you">${user.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')}</optgroup>` : '');
  };
  $('CpTpl').addEventListener('change', (e) => {
    const t = allTemplates().find((x) => x.id === e.target.value);
    if (t) pad.setCaptions({ template: t.id, style: t.style });
  });
  const st = (patch) => pad.setCaptions({ style: patch, template: '' });
  const bind = (id, field, conv = (v) => v, ev = 'input') => $(id).addEventListener(ev, (e) => st({ [field]: conv(e.target.type === 'checkbox' ? e.target.checked : e.target.value) }));
  bind('CpFont', 'font', String, 'change'); bind('CpUpper', 'uppercase', Boolean, 'change'); bind('CpSize', 'size', Number); bind('CpY', 'y', Number);
  bind('CpWords', 'wordsPerPage', Number); bind('CpLines', 'maxLines', Number, 'change'); bind('CpColor', 'color', String); bind('CpStrokeColor', 'strokeColor', String);
  bind('CpStroke', 'stroke', Number); bind('CpHl', 'highlight', String, 'change'); bind('CpHlColor', 'highlightColor', String);
  bind('CpBox', 'box', Boolean, 'change'); bind('CpBoxColor', 'boxColor', String); bind('CpBoxOp', 'boxOpacity', Number);
  bind('CpIn', 'animIn', String, 'change'); bind('CpOut', 'animOut', String, 'change');
  $('CpReveal').addEventListener('change', (e) => st({ reveal: e.target.checked ? 'word' : 'page' }));

  $('CpSave').addEventListener('click', () => {
    if (user.length >= userTemplateLimit()) { pad.notify('warn', `You can keep up to ${userTemplateLimit()} saved looks. Delete one first.`); return; }
    $('CpNameRow').style.display = 'flex'; $('CpName').focus();
  });
  const doSave = async () => {
    const label = $('CpName').value.trim();
    if (!label) return;
    if (allTemplates().some((t) => t.label.toLowerCase() === label.toLowerCase())) { pad.notify('warn', 'A look with that name already exists.'); return; }
    const next = normalizeUserTemplates([...user, { id: `u${Date.now().toString(36)}`, label, style: pad.cap.style }]);
    if (!(await writeUser(next))) { pad.notify('error', 'Could not save the look in this browser.'); return; }
    user = next; $('CpName').value = ''; $('CpNameRow').style.display = 'none';
    fillTemplates(); pad._syncPanels(); pad.notify('success', `Look "${label}" saved.`);
  };
  $('CpNameOk').addEventListener('click', doSave);
  $('CpName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
  $('CpDel').addEventListener('click', async () => {
    const t = user.find((x) => x.id === $('CpTpl').value);
    if (!t) return; // built-in looks (config/caption-templates.json) are never deleted from the app
    const next = user.filter((x) => x.id !== t.id);
    if (await writeUser(next)) { user = next; fillTemplates(); pad._syncPanels(); }
  });

  // ── the words: where they come from ──
  const progress = (msg) => { $('CpProg').textContent = msg || ''; };
  const setBusy = (b) => { busy = b; $('CpGen').disabled = !!b; $('CpImport').disabled = !!b; $('CpStop').style.display = b ? '' : 'none'; };

  async function loadFromServer() {
    try {
      const id = cfg().getUploadId && cfg().getUploadId();
      if (!id || !api() || !api().load) return;
      const cues = await api().load(id);
      if (cues && cues.length && !pad.capCues.length) pad.setCaptionCues(cues, { save: false });
    } catch { /* nothing saved yet */ }
  }

  $('CpGen').addEventListener('click', async () => {
    if (!api() || !api().transcribe) { pad.notify('warn', 'Auto captions are not available here.'); return; }
    if (pad.capCues.length && !window.confirm('Replace the caption words you already have?')) return;
    const ac = new AbortController();
    setBusy({ abort: () => ac.abort() });
    try {
      const range = $('CpRange').checked && cfg().getRange ? cfg().getRange() : null;
      progress('Starting…');
      const cues = await api().transcribe({ language: $('CpLang').value, rangeStart: range ? range.start : 0, rangeEnd: range ? range.end : 0 },
        (p) => progress(p.text), ac.signal);
      pad.setCaptionCues(cues, { save: false });
      if (!pad.cap.enabled) pad.setCaptions({ enabled: true });
      progress(cues.length ? `Done: ${cues.length} caption lines. Read through them below and fix any mistakes.` : 'No speech was found in that part of the video.');
    } catch (e) {
      progress('');
      if (!(e && (e.name === 'AbortError' || e.code === 'cancelled'))) pad.notify('error', String((e && e.message) || e).slice(0, 400));
    } finally { setBusy(null); render(); }
  });
  $('CpStop').addEventListener('click', () => { if (busy) busy.abort(); });

  $('CpImport').addEventListener('click', () => $('CpFile').click());
  $('CpFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const cues = parseSubtitles(await file.text());
      if (!cues.length) { pad.notify('warn', 'No captions were found in that file. It should be an .srt or .vtt file.'); return; }
      if (pad.capCues.length && !window.confirm(`Replace your ${pad.capCues.length} caption lines with the ${cues.length} from this file?`)) return;
      pad.setCaptionCues(cues);
      if (!pad.cap.enabled) pad.setCaptions({ enabled: true });
      progress(`Imported ${cues.length} caption lines. The times must match your video: fix any that do not below.`);
    } catch { pad.notify('error', 'That file could not be read.'); }
  });

  // ── the words: editing ──
  const winOf = () => { try { const r = cfg().getRange && cfg().getRange(); return r && r.end > r.start ? r : null; } catch { return null; } };
  const edit = (fn, { save = true } = {}) => { const next = fn(pad.getCaptionCues()); pad.setCaptionCues(next, { save }); render(); };

  $('CpReplAll').addEventListener('click', () => {
    const f = $('CpFind').value; if (!f.trim()) return;
    const r = replaceInCues(pad.getCaptionCues(), f, $('CpRepl').value);
    if (!r.count) { pad.notify('info', 'Nothing matched.'); return; }
    pad.setCaptionCues(r.cues); render(); pad.notify('success', `Replaced ${r.count}.`);
  });
  $('CpAdd').addEventListener('click', () => {
    const t = Math.max(0, Number(pad._capTime()) || 0);
    edit((cues) => [...cues, { s: t, e: t + 2, text: 'New caption' }]);
    showAll = true; render();
  });
  $('CpClear').addEventListener('click', () => { if (pad.capCues.length && window.confirm('Remove every caption line?')) { pad.setCaptionCues([]); render(); } });
  $('CpExport').addEventListener('click', () => {
    if (!pad.capCues.length) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([cuesToSrt(pad.capCues)], { type: 'application/x-subrip' })); a.download = 'captions.srt';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  const list = $('CpList');
  list.addEventListener('change', (e) => {
    const row = e.target.closest('.cp-row'); if (!row) return;
    const i = Number(row.dataset.i); const cues = pad.getCaptionCues(); const c = cues[i]; if (!c) return;
    if (e.target.classList.contains('cp-text')) cues[i] = { ...setCueText(c, e.target.value), s: c.s, e: c.e };
    else if (e.target.dataset.f) {
      const v = parseTime(e.target.value);
      if (!Number.isFinite(v)) { render(); return; }
      cues[i] = { ...c, [e.target.dataset.f]: v }; if (cues[i].words) delete cues[i].words; // the times were changed by hand: spread the words again
    }
    pad.setCaptionCues(cues); render();
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.cp-row'); if (!row) return;
    const i = Number(row.dataset.i); const cues = pad.getCaptionCues(); const c = cues[i]; if (!c) return;
    const act = e.target.closest('button') && e.target.closest('button').dataset.act;
    if (act === 'del') { cues.splice(i, 1); pad.setCaptionCues(cues); render(); return; }
    if (act === 'merge' && cues[i + 1]) { cues.splice(i, 2, mergeCues(c, cues[i + 1])); pad.setCaptionCues(cues); render(); return; }
    if (act === 'split') { const parts = splitCue(c, Math.ceil(cueWords(c).length / 2)); cues.splice(i, 1, ...parts); pad.setCaptionCues(cues); render(); return; }
    if (e.target.closest('.cp-t, .cp-text, button')) return;
    if (pad.player && pad.player.seek) pad.player.seek(c.s + 0.05); // a click on the row shows that moment
  });

  // ── drawing the panel ──
  function render() {
    const cues = pad.capCues; const w = winOf();
    const idx = []; cues.forEach((c, i) => { if (!w || (c.e > w.start && c.s < w.end) || showAll) idx.push(i); });
    const shown = idx.slice(0, showAll ? 5000 : MAX_ROWS);
    list.innerHTML = shown.length ? shown.map((i) => {
      const c = cues[i];
      return `<div class="cp-row" data-i="${i}"><div class="cp-times"><input class="form-input cp-t" data-f="s" value="${fmt(c.s)}" aria-label="Starts"><input class="form-input cp-t" data-f="e" value="${fmt(c.e)}" aria-label="Ends"></div>
        <textarea class="form-input cp-text" rows="2" spellcheck="true">${esc(c.text)}</textarea>
        <div class="cp-acts"><button type="button" data-act="split" title="Split into two lines">&#9986;</button><button type="button" data-act="merge" title="Join with the next line">&#10549;</button><button type="button" data-act="del" title="Delete this line">&#128465;</button></div></div>`;
    }).join('') : `<div class="ed-hint">${cues.length ? 'No caption lines in the part you chose. ' : 'No captions yet. Generate them from speech, or import an .srt / .vtt file.'}</div>`;
    if (idx.length > shown.length || (w && !showAll && cues.length > idx.length)) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'btn btn-ghost btn-sm'; more.textContent = w && !showAll ? `Show all ${cues.length} lines` : `Show more (${idx.length - shown.length})`;
      more.addEventListener('click', () => { showAll = true; render(); }); list.appendChild(more);
    }
    $('CpCount').textContent = cues.length ? `(${cues.length} lines${w && !showAll ? `, ${idx.length} in your part` : ''})` : '';
  }

  // ── engine status ──
  async function showEngine() {
    try {
      if (!api() || !api().engine) { $('CpEngine').textContent = ''; return; }
      engine = await api().engine();
      $('CpEngine').textContent = engine.ready ? `Speech to text: ${engine.engine}.` : (engine.hint || 'No speech-to-text engine is set up on the server yet.');
      $('CpGen').title = engine.ready ? '' : 'Needs a speech-to-text engine on the server (see the note above). Importing a file works without one.';
    } catch (e) { $('CpEngine').textContent = 'The server could not be reached, so speech to text is not available right now. Importing a file still works.'; }
  }

  fillTemplates();
  readUser().then((l) => { user = l; fillTemplates(); pad._syncPanels(); }).catch(() => {});
  loadCaptionTemplates().then(() => { if ($('CpTpl')) { fillTemplates(); if (!pad.cap.template && !pad.capCues.length && same(pad.cap.style, normalizeCaptionStyle({}))) { const t = captionTemplates()[0]; if (t) pad.setCaptions({ template: t.id, style: t.style }, { commit: false }); } pad._syncPanels(); } }).catch(() => {});
  $('CpSec').addEventListener('toggle', () => { if ($('CpSec').open) { showEngine(); loadFromServer(); } });

  return {
    sync() {
      const c = pad.cap; const s = c.style;
      $('CpOn').checked = c.enabled;
      $('CpSub').textContent = c.enabled ? (pad.capCues.length ? `${pad.capCues.length} lines` : 'no words yet') : 'auto subtitles in your own look';
      $('CpSec').classList.toggle('on', c.enabled);
      const match = allTemplates().find((t) => same(t.style, s));
      $('CpTpl').value = match ? match.id : 'custom';
      const isUser = !!match && !match.system;
      $('CpDel').disabled = !isUser; $('CpDel').title = isUser ? 'Delete this saved look' : 'Built-in looks cannot be deleted';
      $('CpTplNote').textContent = match && match.description ? match.description : '';
      const val = (id, v, f = (x) => x) => { const el = $(id); if (el && document.activeElement !== el) el.value = String(v); const o = $(`${id}Val`); if (o) o.textContent = f(v); };
      $('CpFont').value = s.font; $('CpUpper').checked = s.uppercase; val('CpSize', s.size, (x) => `${x}%`); val('CpY', s.y, (x) => `${x}%`); val('CpWords', s.wordsPerPage);
      $('CpLines').value = String(s.maxLines); $('CpColor').value = s.color; $('CpStrokeColor').value = s.strokeColor; val('CpStroke', s.stroke, (x) => (x ? `${Math.round(x * 100)}%` : 'none'));
      $('CpHl').value = s.highlight; $('CpHlColor').value = s.highlightColor; $('CpBox').checked = s.box; $('CpBoxColor').value = s.boxColor; val('CpBoxOp', s.boxOpacity, (x) => `${Math.round(x * 100)}%`);
      $('CpIn').value = s.animIn; $('CpOut').value = s.animOut; $('CpReveal').checked = s.reveal === 'word';
      const hasRange = !!(cfg().getRange && winOf());
      $('CpRangeWrap').style.display = hasRange ? '' : 'none';
      if (!busy && !list.contains(document.activeElement)) render(); // never rebuild the list under someone who is typing in it
    },
    refreshWindow() { render(); },
  };
}
