// The Look (framing + adjustments) and Lower thirds screens of the phone app.
import {
  LT_STYLES, LT_IN, LT_OUT, LT_LOOPS, LT_FONTS, LT_PRESETS, LT_LAST, MAX_LOWER_THIRDS,
  defaultLowerThird, normalizeLowerThird, resolveLowerThird, lowerThirdTimeline, drawLowerThird,
} from './shared/lowerThird.js';
import { normalizeAdjust, defaultAdjust, getAdjustConfig, isDefaultAdjust } from './shared/adjust.js';
import { normalizeFrame, defaultFrame, videoRect } from './shared/framing.js';

function el(tag, props, kids) {
  const e = document.createElement(tag); props = props || {};
  Object.keys(props).forEach((k) => { if (k === 'text') e.textContent = props[k]; else if (k === 'class') e.className = props[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]); else e.setAttribute(k, props[k]); });
  (kids || []).forEach((c) => { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}
const opts = (list, cur) => list.map((o) => el('option', { value: o.id, text: o.label, ...(o.id === cur ? { selected: '' } : {}) }));
const PREVIEW = { '9:16': [270, 480], '4:5': [288, 360], '1:1': [300, 300], '16:9': [320, 180], original: [320, 180] };

/**
 * state: { frame, adjust, lts, sel, ... } is owned by the page; this builds the controls and calls onChange() after every edit.
 * ctx: { state(), onChange(), frameImage(), src(), aspect(), part(), clipLen() }
 */
export function mountFxUi(lookEl, ltEl, ctx) {
  const S = ctx.state();
  let raf = 0; let previewLast = false; let canvas = null; let ltSelBox = null;

  // ───────────── Look: framing + adjustments ─────────────
  function row(label, control, valueEl) { return el('div', {}, [el('div', { class: 'lbl' }, [el('span', { text: label }), valueEl || el('span')]), control]); }
  function slider(id, min, max, step, value, onInput) { const i = el('input', { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(value) }); i.addEventListener('input', () => onInput(Number(i.value))); return i; }
  function toggle(label, id, on, onClick) { const b = el('button', { type: 'button', class: 'sw', id, role: 'switch', 'aria-checked': String(!!on), 'aria-label': label }); b.addEventListener('click', () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onClick(v); }); return el('div', { class: 'row', style: 'margin-top:12px' }, [el('span', { text: label }), b]); }

  function buildLook() {
    lookEl.textContent = '';
    const lim = getAdjustConfig().limits; const f = S.frame; const a = S.adjust;
    // framing
    lookEl.appendChild(el('div', { class: 'lbl', style: 'margin-top:0' }, [el('span', { text: 'Framing' })]));
    const seg = el('div', { class: 'seg', role: 'radiogroup' }, [
      el('button', { type: 'button', role: 'radio', 'aria-checked': String(f.mode === 'fill'), onclick: () => { S.frame = normalizeFrame({ ...S.frame, mode: 'fill' }); change(true); } }, [el('strong', { text: 'Fill' }), el('span', { text: 'Crop to fill the shape' })]),
      el('button', { type: 'button', role: 'radio', 'aria-checked': String(f.mode === 'fit'), onclick: () => { S.frame = normalizeFrame({ ...S.frame, mode: 'fit' }); change(true); } }, [el('strong', { text: 'Fit' }), el('span', { text: 'Whole picture, with bars' })]),
    ]);
    lookEl.appendChild(seg);
    const zv = el('b', { text: Math.round(f.zoom * 100) + '%' });
    lookEl.appendChild(row('Zoom', slider('fxZoom', f.mode === 'fit' ? 30 : 100, 400, 1, Math.round(f.zoom * 100), (v) => { S.frame = normalizeFrame({ ...S.frame, zoom: v / 100 }); zv.textContent = v + '%'; change(false); }), zv));
    if (f.mode === 'fill') {
      const xv = el('b', { text: Math.round(f.x * 100) + '%' }); const yv = el('b', { text: Math.round(f.y * 100) + '%' });
      lookEl.appendChild(row('Move picture left / right', slider('fxX', 0, 100, 1, Math.round(f.x * 100), (v) => { S.frame = normalizeFrame({ ...S.frame, x: v / 100 }); xv.textContent = v + '%'; change(false); }), xv));
      lookEl.appendChild(row('Move picture up / down', slider('fxY', 0, 100, 1, Math.round(f.y * 100), (v) => { S.frame = normalizeFrame({ ...S.frame, y: v / 100 }); yv.textContent = v + '%'; change(false); }), yv));
    } else lookEl.appendChild(el('div', { class: 'help', text: 'A blurred background is not available on the phone yet: black bars are used.' }));

    // adjustments
    lookEl.appendChild(el('div', { class: 'lbl', style: 'margin-top:18px' }, [el('span', { text: 'Adjust the picture and sound' }), el('button', { type: 'button', class: 'btn sm', id: 'adjReset', text: 'Reset', onclick: () => { S.adjust = defaultAdjust(); change(true); } })]));
    const num = (key, label, L, unit, dec) => { const v = el('b', { text: fmt(a[key], unit, dec) }); lookEl.appendChild(row(label, slider('adj_' + key, L.min, L.max, L.step, a[key], (x) => { S.adjust = normalizeAdjust({ ...S.adjust, [key]: x }); v.textContent = fmt(S.adjust[key], unit, dec); change(false); }), v)); };
    num('brightness', 'Brightness', lim.color, '', 0); num('contrast', 'Contrast', lim.color, '', 0); num('saturation', 'Colour strength (saturation)', lim.color, '', 0);
    num('speed', 'Speed', lim.speed, 'x', 2); num('pitch', 'Voice pitch (semitones)', lim.pitch, '', 1); num('scale', 'Extra zoom', lim.scale, '%', 0);
    lookEl.appendChild(toggle('Keep the voice pitch when the speed changes', 'adjKeep', a.preservePitch, (v) => { S.adjust = normalizeAdjust({ ...S.adjust, preservePitch: v }); change(false); }));
    lookEl.appendChild(toggle('Flip left / right', 'adjFH', a.flipH, (v) => { S.adjust = normalizeAdjust({ ...S.adjust, flipH: v }); change(false); }));
    lookEl.appendChild(toggle('Flip upside down', 'adjFV', a.flipV, (v) => { S.adjust = normalizeAdjust({ ...S.adjust, flipV: v }); change(false); }));
    lookEl.appendChild(el('div', { class: 'help', text: 'Reverb is not available on the phone yet.' }));
  }
  function fmt(v, unit, dec) { const n = Number(v); const t = dec ? n.toFixed(dec) : String(Math.round(n)); return (n > 0 && unit === '' ? '+' : '') + t + unit; }

  // ───────────── Lower thirds ─────────────
  const cur = () => S.lts[S.sel] || null;
  function patch(p) { const c = cur(); if (!c) return; S.lts[S.sel] = normalizeLowerThird({ ...c, ...p }); change(false, true); }

  function buildLt() {
    ltEl.textContent = '';
    ltEl.appendChild(el('div', { class: 'help', style: 'margin:0 0 10px', text: 'The same lower thirds as on the computer: they appear on every clip, with the part number filled in. Type {part} for the clip’s own part number and {next} for the next one.' }));
    // chips
    const chips = el('div', { class: 'chips', style: 'margin-bottom:10px' });
    S.lts.forEach((x, i) => { const r = resolveLowerThird(x, { part: ctx.part(), clipDuration: ctx.clipLen() }); chips.appendChild(el('button', { type: 'button', class: i === S.sel ? 'on' : '', text: (i + 1) + '. ' + String(r.title || r.subtitle || r.cta || r.tag || 'empty').slice(0, 14), onclick: () => { S.sel = i; buildLt(); } })); });
    if (S.lts.length < MAX_LOWER_THIRDS) {
      const add = el('select', { id: 'ltAdd', 'aria-label': 'Add a lower third', style: 'width:auto;display:inline-block' }, [el('option', { value: '', text: '+ Add a lower third…' })].concat(LT_PRESETS.map((p) => el('option', { value: p.id, text: p.label }))));
      add.addEventListener('change', () => { const p = LT_PRESETS.find((x) => x.id === add.value); if (!p) return; S.lts.push(normalizeLowerThird({ ...defaultLowerThird(), ...p.spec, enabled: true })); S.sel = S.lts.length - 1; change(false, false); buildLt(); });
      chips.appendChild(add);
    }
    ltEl.appendChild(chips);
    const c = cur();
    if (!c) { ltEl.appendChild(el('div', { class: 'empty', text: 'No lower thirds yet. Add one above to show a name, a message or “Follow for Part {next}” on every clip.' })); canvas = null; return; }

    // preview
    const [pw, ph] = PREVIEW[ctx.aspect()] || PREVIEW['9:16'];
    canvas = el('canvas', { id: 'ltCanvas', width: String(pw), height: String(ph), style: `width:${Math.min(pw, 300)}px;max-width:100%;border-radius:10px;background:#000;display:block;margin:0 auto` });
    ltEl.appendChild(canvas);
    ltEl.appendChild(el('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' }, [
      el('button', { type: 'button', class: 'btn sm', text: '▶ Replay', onclick: () => play() }),
      el('label', { class: 'row', style: 'gap:8px;font-size:12px;color:var(--muted)' }, [el('input', { type: 'checkbox', id: 'ltPrevLast', ...(previewLast ? { checked: '' } : {}) }), 'Preview as the last part']),
    ]));
    ltEl.querySelector('#ltPrevLast').addEventListener('change', (e) => { previewLast = e.target.checked; play(); });

    const f = (label, child) => el('div', {}, [el('div', { class: 'lbl' }, [el('span', { text: label })]), child]);
    const text = (key, ph, max) => { const i = el('input', { type: 'text', maxlength: String(max), placeholder: ph, value: c[key] || '' }); i.addEventListener('input', () => { S.lts[S.sel] = normalizeLowerThird({ ...cur(), [key]: i.value }); change(false, true, true); }); return i; };
    const sel = (key, list) => { const s = el('select', {}, opts(list, c[key])); s.addEventListener('change', () => patch({ [key]: s.value })); return s; };
    const color = (key) => { const i = el('input', { type: 'color', value: c[key], style: 'width:100%;height:42px;padding:2px' }); i.addEventListener('input', () => { S.lts[S.sel] = normalizeLowerThird({ ...cur(), [key]: i.value }); change(false, true, true); }); return i; };
    const num = (key, min, max, step, scale) => { const i = el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(scale ? Math.round(c[key] * scale) : c[key]) }); i.addEventListener('change', () => { const v = Number(i.value); if (Number.isFinite(v)) patch({ [key]: scale ? v / scale : v }); }); return i; };
    const range = (key, min, max, scale, suffix) => { const out = el('b', { text: Math.round(c[key] * scale) + suffix }); const i = el('input', { type: 'range', min: String(min), max: String(max), value: String(Math.round(c[key] * scale)) }); i.addEventListener('input', () => { out.textContent = i.value + suffix; S.lts[S.sel] = normalizeLowerThird({ ...cur(), [key]: Number(i.value) / scale }); change(false, true, true); }); return [i, out]; };

    const on = el('div', { class: 'row', style: 'margin-top:12px' }, [el('span', { text: 'Show this lower third' }), el('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(!!c.enabled), 'aria-label': 'Show this lower third', onclick: (e) => { const v = e.currentTarget.getAttribute('aria-checked') !== 'true'; patch({ enabled: v }); buildLt(); } })]);
    ltEl.appendChild(on);
    ltEl.appendChild(f('Style', sel('style', LT_STYLES)));
    ltEl.appendChild(f('Main line', text('title', 'e.g. Follow for Part {next}', 70)));
    ltEl.appendChild(f('Second line', text('subtitle', 'e.g. New part every day', 110)));
    ltEl.appendChild(el('div', { class: 'seg' }, [f('Label', text('tag', 'SALE', 24)), f('Button', text('cta', 'SHOP NOW', 26))]));
    ltEl.appendChild(el('div', { class: 'seg', style: 'grid-template-columns:1fr 1fr 1fr' }, [f('Accent', color('accent')), f('Background', color('bg')), f('Text', color('text'))]));
    ltEl.appendChild(el('div', { class: 'seg' }, [f('Font', sel('font', LT_FONTS)), f('Alignment', sel('align', [{ id: 'left', label: 'Left' }, { id: 'center', label: 'Centre' }, { id: 'right', label: 'Right' }]))]));
    let r = range('size', 50, 180, 100, '%'); ltEl.appendChild(row('Size', r[0], r[1]));
    const autoY = c.y == null; const yv = el('b', { text: autoY ? 'Auto' : Math.round(c.y * 100) + '%' });
    const yi = el('input', { type: 'range', min: '5', max: '95', value: String(Math.round((c.y == null ? 0.7 : c.y) * 100)) }); yi.addEventListener('input', () => { yv.textContent = yi.value + '%'; S.lts[S.sel] = normalizeLowerThird({ ...cur(), y: Number(yi.value) / 100 }); change(false, true, true); });
    ltEl.appendChild(row('Height in the picture', yi, el('span', {}, [yv, ' ', el('button', { type: 'button', class: 'btn sm', text: 'Auto', onclick: () => { patch({ y: null }); buildLt(); } })])));
    ltEl.appendChild(el('div', { class: 'lbl', style: 'margin-top:16px' }, [el('b', { text: 'Motion' })]));
    ltEl.appendChild(el('div', { class: 'seg', style: 'grid-template-columns:1fr 1fr 1fr' }, [f('In', sel('in', LT_IN)), f('Out', sel('out', LT_OUT)), f('While showing', sel('loop', LT_LOOPS))]));
    r = range('speed', 50, 200, 100, '%'); ltEl.appendChild(row('Animation speed', r[0], r[1]));
    ltEl.appendChild(el('div', { class: 'lbl', style: 'margin-top:16px' }, [el('b', { text: 'Timing (seconds in each clip)' })]));
    ltEl.appendChild(el('div', { class: 'seg', style: 'grid-template-columns:1fr 1fr 1fr' }, [f('Appears at', num('start', 0, 600, 0.5)), f('Stays for', num('hold', 0.5, 120, 0.5)), f('Repeat every', num('repeat', 0, 600, 1))]));
    ltEl.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, [el('span', { text: 'Show near the end of every clip' }), el('button', { type: 'button', class: 'sw', role: 'switch', 'aria-checked': String(!!c.atEnd), 'aria-label': 'Show near the end', onclick: (e) => { patch({ atEnd: e.currentTarget.getAttribute('aria-checked') !== 'true' }); buildLt(); } })]));

    // the last part
    ltEl.appendChild(el('div', { class: 'lbl', style: 'margin-top:16px' }, [el('b', { text: 'On the last part' })]));
    ltEl.appendChild(f('What it does on the final part of a run', sel('last', LT_LAST)));
    ltEl.appendChild(el('div', { class: 'help', text: 'Made for “Follow for Part {next}”: the last part has no next part. Switch off “This run ends the series” in Studio if more parts will follow later.' }));
    if (c.last === 'text') {
      ltEl.appendChild(f('Closing text', text('lastTitle', 'Thanks for watching!', 70)));
      ltEl.appendChild(f('Second line', text('lastSubtitle', '', 110)));
      ltEl.appendChild(el('div', { class: 'seg' }, [f('Label', text('lastTag', '', 24)), f('Button', text('lastCta', '', 26))]));
    }
    ltEl.appendChild(el('div', { style: 'display:flex;gap:8px;margin-top:16px;flex-wrap:wrap' }, [
      el('button', { type: 'button', class: 'btn sm', text: 'Duplicate', onclick: () => { if (S.lts.length < MAX_LOWER_THIRDS) { S.lts.push(normalizeLowerThird({ ...cur() })); S.sel = S.lts.length - 1; change(false, false); buildLt(); } } }),
      el('button', { type: 'button', class: 'btn sm danger', text: 'Remove', onclick: () => { S.lts.splice(S.sel, 1); S.sel = Math.max(0, S.sel - 1); change(false, false); buildLt(); } }),
    ]));
    play();
  }

  // ───────────── preview ─────────────
  function drawFrame(ctx2, W, H, t) {
    ctx2.clearRect(0, 0, W, H); ctx2.fillStyle = '#10131a'; ctx2.fillRect(0, 0, W, H);
    const img = ctx.frameImage(); const src = ctx.src();
    if (img && img.complete && img.naturalWidth && src) {
      const adj = normalizeAdjust(S.adjust); const fr = normalizeFrame(S.frame);
      const r = videoRect(src.w, src.h, W, H, { ...fr, zoom: fr.zoom * (adj.scale / 100) });
      ctx2.save(); ctx2.beginPath(); ctx2.rect(0, 0, W, H); ctx2.clip();
      ctx2.filter = `brightness(${1 + adj.brightness / 100}) contrast(${1 + adj.contrast / 100}) saturate(${1 + adj.saturation / 100})`;
      const cx = r.x + r.w / 2; const cy = r.y + r.h / 2; ctx2.translate(cx, cy); ctx2.scale(adj.flipH ? -1 : 1, adj.flipV ? -1 : 1);
      ctx2.drawImage(img, -r.w / 2, -r.h / 2, r.w, r.h); ctx2.restore(); ctx2.filter = 'none';
    } else { const g = ctx2.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#26304a'); g.addColorStop(1, '#0d1220'); ctx2.fillStyle = g; ctx2.fillRect(0, 0, W, H); }
    const c = cur(); if (!c || !c.enabled) return;
    const speed = normalizeAdjust(S.adjust).speed;
    const spec = resolveLowerThird(c, { part: ctx.part(), clipDuration: ctx.clipLen() / speed, isLast: previewLast });
    if (spec.enabled) drawLowerThird(ctx2, W, H, spec, t);
  }
  function play() {
    cancelAnimationFrame(raf); if (!canvas) return;
    const c = cur(); const c2 = canvas.getContext('2d'); const W = canvas.width; const H = canvas.height;
    if (!c) return;
    const spec = resolveLowerThird(c, { part: ctx.part(), clipDuration: ctx.clipLen() / normalizeAdjust(S.adjust).speed, isLast: previewLast });
    if (!spec.enabled) { drawFrame(c2, W, H, 0); return; }
    const tl = lowerThirdTimeline(spec); const t0 = performance.now(); const span = Math.max(1.5, tl.total || (spec.start + spec.hold + 1.5));
    const tick = () => { if (!document.body.contains(canvas)) return; const t = spec.start + ((performance.now() - t0) / 1000) % (span - spec.start + 1.2); drawFrame(c2, W, H, t); raf = requestAnimationFrame(tick); };
    tick();
  }

  function change(rebuildLook, replay, keepFocus) { ctx.onChange(); if (rebuildLook) buildLook(); if (replay) play(); }

  return {
    rebuild() { buildLook(); buildLt(); },
    refreshPreview() { if (canvas) play(); },
  };
}
export { isDefaultAdjust };
