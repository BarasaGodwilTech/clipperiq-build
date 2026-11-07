// Settings > Diagnostics > "Test processing": runs the server's self-test and shows each step in plain words.
import { getBackendBaseUrl } from '../core/config.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, method = 'GET') {
  const base = (await getBackendBaseUrl()) || '';
  const r = await fetch(`${base}/api/diagnostics${path}`, { method, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || `The server answered ${r.status}`);
  return j;
}

let timer = null; let last = null;

function render(v) {
  const out = $('stTestOut'); if (!out) return;
  last = v;
  const icon = (s) => s === 'ok' ? '<span style="color:var(--success)">&#10003;</span>' : s === 'fail' ? '<span style="color:var(--danger)">&#10007;</span>' : '<span style="color:var(--muted)">&hellip;</span>';
  let html = v.steps.map((s) => `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
      <div style="width:18px;text-align:center">${icon(s.status)}</div>
      <div style="flex:1;min-width:0"><div style="color:var(--text)">${esc(s.name)}${s.ms ? ` <span style="color:var(--dim)">(${(s.ms / 1000).toFixed(1)}s)</span>` : ''}</div>
      ${s.detail ? `<div style="color:${s.status === 'fail' ? 'var(--danger)' : 'var(--muted)'};word-break:break-word">${esc(s.detail)}</div>` : ''}
      ${s.advice ? `<div style="color:var(--warn);margin-top:2px">${esc(s.advice)}</div>` : ''}</div></div>`).join('');
  if (v.status === 'finished') {
    html += v.ok
      ? '<div style="margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(34,211,160,.1);border:1px solid rgba(34,211,160,.35);color:var(--text)">Everything works: uploading, best moments and series all produced correct clips on this computer. If a particular video still fails, the problem is in that video, and its error message will say so.</div>'
      : '<div style="margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.35);color:var(--text)">Something is wrong on this computer. Fix what is marked above, or copy this report and send it along.</div><button class="btn btn-ghost btn-sm" id="stCopy" style="margin-top:8px">Copy this report</button>';
  }
  out.innerHTML = html;
  $('stCopy')?.addEventListener('click', async () => {
    const text = `ClipperIQ self-test ${new Date().toISOString()}\n` + v.steps.map((s) => `[${s.status}] ${s.name}: ${s.detail || ''}${s.advice ? ' | ' + s.advice : ''}`).join('\n');
    try { await navigator.clipboard.writeText(text); $('stCopy').textContent = 'Copied'; } catch { $('stCopy').textContent = 'Could not copy'; }
  });
}

async function run() {
  const btn = $('stRun'); if (!btn) return;
  btn.disabled = true; btn.textContent = 'Testing…'; clearInterval(timer);
  try {
    let v = await api('/selftest', 'POST'); render(v);
    timer = setInterval(async () => {
      try { v = await api(`/selftest/${encodeURIComponent(v.testId)}`); render(v); if (v.status === 'finished') done(); }
      catch (e) { done(); $('stTestOut').innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
    }, 700);
  } catch (e) { done(); $('stTestOut').innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
  function done() { clearInterval(timer); btn.disabled = false; btn.textContent = 'Test processing'; }
}

function init() { $('stRun')?.addEventListener('click', run); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
