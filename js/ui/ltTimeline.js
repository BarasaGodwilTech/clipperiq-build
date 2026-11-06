// A timeline for the lower thirds of a clip: one bar per lower third, on a ruler in seconds of the FINISHED clip.
//   - drag a bar to move it, drag its left / right edge to change when it comes in and when it is gone
//   - the ruler scrolls sideways and zooms (the slider, or Ctrl + mouse wheel), so a four-minute clip is as easy as a 20-second one
//   - click or drag on the ruler to see every lower third at that moment; "Play all" runs the whole clip's lower thirds in time
//   - with the keyboard: select a bar, arrow keys move it (Shift: a second at a time)
// It only changes data on the pad (pad.lts, see designer.js); the pad draws the preview and the server renders the same timing.
import { lowerThirdWindows } from '../shared/lowerThird.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mmss = (t) => { const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const ROW = 28;
const RULER = 24;

export function mountLtTimeline(pad, root) {
  const n = pad.ns;
  let zoom = 1;          // 1 = the whole clip fits the width
  let drag = null;       // { kind, i, startX, orig, el }
  let scrubbing = false;

  root.innerHTML = `
    <div class="lt-tl">
      <div class="lt-tl-head">
        <span class="lt-tl-title">Timeline <span class="lt-tl-len" id="${n}TlLen"></span></span>
        <label class="lt-tl-zoom">Zoom <input type="range" id="${n}TlZoom" min="1" max="24" step="0.1" value="1"></label>
        <button class="btn btn-ghost btn-sm" id="${n}TlPlay" type="button">&#9654; Play all</button>
        <button class="btn btn-ghost btn-sm" id="${n}TlStop" type="button" style="display:none">Back to editing</button>
      </div>
      <div class="lt-tl-scroll" id="${n}TlScroll"><div class="lt-tl-inner" id="${n}TlInner">
        <div class="lt-tl-ruler" id="${n}TlRuler" title="Click or drag to see the lower thirds at that moment"></div>
        <div class="lt-tl-rows" id="${n}TlRows"></div>
        <div class="lt-tl-head-line" id="${n}TlHead" style="display:none"></div>
      </div></div>
      <div class="ed-hint" id="${n}TlHint">Drag a bar to move it; drag its edges to change how long it stays. Click the ruler to see all of them at that moment.</div>
    </div>`;
  const $ = (id) => document.getElementById(n + id);

  const clipLen = () => { try { return Math.max(5, Number(pad._getClipLen && pad._getClipLen()) || 30); } catch { return 30; } };
  const partNo = () => { try { return Number(pad._getPart && pad._getPart()) || 1; } catch { return 1; } };
  const geom = () => {
    const L = clipLen(); const W = Math.max(160, $('TlScroll').clientWidth - 2);
    const fit = W / L; return { L, px: fit * zoom, fit };
  };
  const label = (x) => { const r = pad._ltResolved ? pad._ltResolved(x) : x; return String(r.title || r.subtitle || r.cta || r.tag || 'Lower third').slice(0, 26); };

  function render() {
    const { L, px } = geom();
    const inner = $('TlInner'); inner.style.width = `${Math.ceil(L * px)}px`;
    $('TlLen').textContent = `(clip length ${mmss(L)})`;
    // ruler
    const step = STEPS.find((s) => s * px >= 46) || STEPS[STEPS.length - 1];
    let ticks = '';
    for (let t = 0; t <= L + 1e-6; t += step) ticks += `<span class="lt-tick" style="left:${t * px}px"><i></i>${mmss(t).replace(/\.0$/, '')}</span>`;
    $('TlRuler').innerHTML = ticks;
    // bars
    const rows = pad.lts.map((x, i) => {
      const w = lowerThirdWindows(x, { part: partNo(), clipDuration: L });
      const accent = /^#[0-9a-f]{6}$/i.test(x.accent || '') ? x.accent : '#7c5cff';
      const first = `<div class="lt-bar${i === pad.ltSel ? ' sel' : ''}${x.enabled ? '' : ' off'}" data-i="${i}" tabindex="0" role="slider" aria-label="${esc(label(x))}: ${mmss(w.start)} to ${mmss(w.end)}"
        style="left:${w.start * px}px;width:${Math.max(10, (w.end - w.start) * px)}px;--c:${accent}" title="${esc(label(x))}: ${mmss(w.start)} to ${mmss(w.end)}${w.atEnd ? ' (near the end of every clip)' : ''}">
        <span class="lt-h lt-h-l" data-h="l"></span><span class="lt-bar-t">${w.atEnd ? '&#8677; ' : ''}${esc(label(x))}</span><span class="lt-h lt-h-r" data-h="r"></span></div>`;
      const ghosts = w.repeats.slice(1).map((r) => `<div class="lt-bar ghost" style="left:${r.start * px}px;width:${Math.max(8, (r.end - r.start) * px)}px;--c:${accent}" title="repeats"></div>`).join('');
      return `<div class="lt-row" style="height:${ROW}px">${ghosts}${first}</div>`;
    });
    $('TlRows').innerHTML = rows.join('');
    root.querySelector('.lt-tl').classList.toggle('lt-tl-scrub', pad._ltScrub != null);
    $('TlStop').style.display = pad._ltScrub != null ? '' : 'none';
    placeHead(pad._ltScrub);
  }

  function placeHead(t) {
    const h = $('TlHead');
    $('TlStop').style.display = t == null ? 'none' : ''; // "Back to editing" shows whenever the timeline is being shown or played
    if (t == null) { h.style.display = 'none'; return; }
    const { px } = geom();
    h.style.display = 'block'; h.style.left = `${t * px}px`; h.dataset.t = mmss(t);
    const sc = $('TlScroll');
    if (!scrubbing && t * px > sc.scrollLeft + sc.clientWidth - 30) sc.scrollLeft = t * px - 40; // keep the playhead in view while it plays
  }
  pad._onLtTime = (t) => placeHead(t);

  // ── zoom ──
  const setZoom = (z) => {
    const sc = $('TlScroll'); const { px: before } = geom(); const centre = (sc.scrollLeft + sc.clientWidth / 2) / before;
    zoom = Math.max(1, Math.min(24, z)); $('TlZoom').value = String(zoom);
    render();
    const { px } = geom(); sc.scrollLeft = Math.max(0, centre * px - sc.clientWidth / 2);
  };
  $('TlZoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
  $('TlScroll').addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); } }, { passive: false });

  // ── play / scrub ──
  $('TlPlay').addEventListener('click', () => pad.previewTimeline());
  $('TlStop').addEventListener('click', () => { cancelAnimationFrame(pad._ltRaf); pad._ltAnimating = false; pad.setLtScrub(null); render(); });
  const timeAt = (e) => { const r = $('TlInner').getBoundingClientRect(); const { px, L } = geom(); return Math.max(0, Math.min(L, (e.clientX - r.left) / px)); };
  $('TlRuler').addEventListener('pointerdown', (e) => {
    cancelAnimationFrame(pad._ltRaf); pad._ltAnimating = false;
    scrubbing = true; e.currentTarget.setPointerCapture(e.pointerId);
    pad.setLtScrub(Math.round(timeAt(e) * 10) / 10); render();
  });
  $('TlRuler').addEventListener('pointermove', (e) => { if (scrubbing) { pad.setLtScrub(Math.round(timeAt(e) * 10) / 10); placeHead(pad._ltScrub); } });
  $('TlRuler').addEventListener('pointerup', () => { scrubbing = false; });

  // ── bars: select and drag ──
  const rowsEl = $('TlRows');
  rowsEl.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('.lt-bar'); if (!bar || bar.classList.contains('ghost')) return;
    const i = Number(bar.dataset.i);
    if (i !== pad.ltSel || pad._ltScrub != null) { pad.selectLowerThird(i); }
    const { L, px } = geom();
    const w = lowerThirdWindows(pad.lts[i], { part: partNo(), clipDuration: L });
    drag = { kind: e.target.dataset.h || 'move', i, startX: e.clientX, orig: { start: w.start, end: w.end }, L, px, moved: false };
    const el = rowsEl.querySelector(`.lt-bar[data-i="${i}"]`);
    drag.el = el; try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  rowsEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dt = (e.clientX - drag.startX) / drag.px;
    if (Math.abs(e.clientX - drag.startX) > 2) drag.moved = true;
    const o = drag.orig; const dur = o.end - o.start; let start = o.start; let end = o.end;
    if (drag.kind === 'move') { start = Math.max(0, Math.min(drag.L - dur, o.start + dt)); end = start + dur; }
    else if (drag.kind === 'l') { start = Math.max(0, Math.min(o.end - 0.8, o.start + dt)); }
    else { end = Math.max(o.start + 0.8, Math.min(drag.L, o.end + dt)); }
    start = Math.round(start * 10) / 10; end = Math.round(end * 10) / 10;
    pad.setLowerThirdTiming(drag.i, { start, end }, { commit: false });
    // move the bar under the finger without rebuilding it
    drag.el.style.left = `${start * drag.px}px`; drag.el.style.width = `${Math.max(10, (end - start) * drag.px)}px`;
    drag.el.title = `${mmss(start)} to ${mmss(end)}`;
  });
  const endDrag = () => { if (!drag) return; const moved = drag.moved; drag = null; if (moved) pad._commitSoon(); render(); };
  rowsEl.addEventListener('pointerup', endDrag);
  rowsEl.addEventListener('pointercancel', endDrag);
  rowsEl.addEventListener('keydown', (e) => {
    const bar = e.target.closest('.lt-bar'); if (!bar) return;
    const d = e.key === 'ArrowLeft' ? -1 : (e.key === 'ArrowRight' ? 1 : 0); if (!d) return;
    e.preventDefault();
    const i = Number(bar.dataset.i); const { L } = geom();
    const w = lowerThirdWindows(pad.lts[i], { part: partNo(), clipDuration: L });
    const step = e.shiftKey ? 1 : 0.1; const dur = w.end - w.start;
    const start = Math.max(0, Math.min(L - dur, w.start + d * step));
    pad.setLowerThirdTiming(i, { start, end: start + dur });
    render(); const again = rowsEl.querySelector(`.lt-bar[data-i="${i}"]`); if (again) again.focus();
  });

  return {
    sync() { if (drag) return; render(); },
    resize() { if (!drag) render(); },
  };
}
