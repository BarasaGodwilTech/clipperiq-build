// Settings > Storage location: see where videos and clips are kept, and move them to a bigger drive.
import { getBackendBaseUrl } from '../core/config.js';

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (b) => b == null ? '?' : b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(0) + ' MB';

async function api(path, opts = {}) {
  const base = (await getBackendBaseUrl()) || '';
  const r = await fetch(`${base}/api/storage${path}`, {
    method: opts.method || 'GET', cache: 'no-store',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || `The server answered ${r.status}`);
  return j;
}

const ui = {
  info: null, poll: null, open: false,

  async load() {
    const body = $('stBody'); if (!body) return;
    try { this.info = await api(''); this.render(); }
    catch (e) { body.innerHTML = `<span style="color:var(--danger)">Could not read the storage settings: ${esc(e.message)}</span>`; }
  },

  render() {
    const i = this.info; const body = $('stBody'); if (!i || !body) return;
    const usedPct = i.totalBytes ? Math.min(100, Math.round(((i.totalBytes - i.freeBytes) / i.totalBytes) * 100)) : 0;
    const low = i.freeBytes != null && i.freeBytes < 10 * 1073741824;
    const desktop = !!(window.clipperiqDesktop && window.clipperiqDesktop.chooseFolder);
    let html = '';
    if (i.fallback) html += `<div style="padding:10px 12px;border-radius:8px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.35);color:var(--text);margin-bottom:12px">The folder you chose (<b>${esc(i.fallback.wanted)}</b>) is not available right now: ${esc(i.fallback.reason)} ClipperIQ is using its normal folder until it comes back.</div>`;
    html += `<div style="margin-bottom:10px">Videos, clips and the library are kept in:</div>
      <div style="padding:10px 12px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text);font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all">${esc(i.dataDir)}</div>
      <div style="margin:12px 0 4px;display:flex;justify-content:space-between"><span>${fmt(i.usedBytes)} used by ClipperIQ</span><span style="${low ? 'color:var(--warn)' : ''}">${fmt(i.freeBytes)} free on this drive</span></div>
      <div style="height:6px;border-radius:99px;background:var(--bg3);overflow:hidden"><div style="height:100%;width:${usedPct}%;background:${low ? 'var(--warn)' : 'var(--accent)'}"></div></div>
      ${low ? '<div style="margin-top:8px;color:var(--warn)">This drive is nearly full. Long videos need several times their own size while being processed. Moving to a bigger drive is a good idea.</div>' : ''}`;
    if (!i.canChange) {
      html += `<div style="margin-top:12px">The location can only be changed on the computer that runs ClipperIQ, or when this server has a password.</div>`;
    } else if (i.task && i.task.state === 'running') {
      const pct = i.task.total ? Math.round((i.task.done / i.task.total) * 100) : 0;
      html += `<div style="margin-top:14px;color:var(--text)">Copying your files to <b>${esc(i.task.target)}</b>… ${pct}% (${fmt(i.task.done)} of ${fmt(i.task.total)})</div>
        <div style="height:6px;border-radius:99px;background:var(--bg3);overflow:hidden;margin:8px 0"><div style="height:100%;width:${pct}%;background:var(--accent)"></div></div>
        <button class="btn btn-ghost btn-sm" id="stCancel">Cancel</button>`;
    } else if (i.task && i.task.state === 'done') {
      html += `<div style="margin-top:14px;padding:12px;border-radius:8px;background:rgba(34,211,160,.1);border:1px solid rgba(34,211,160,.35);color:var(--text)">Ready. Your files are now at <b>${esc(i.task.target)}</b>. ClipperIQ must restart once to start using it.
        <div style="margin-top:10px"><button class="btn btn-primary btn-sm" id="stRestart">${i.supervised ? 'Restart now' : 'I will restart it myself'}</button></div>
        <div style="margin-top:8px;font-size:12px">${i.supervised ? '' : 'Close ClipperIQ and start it again (start.bat). '}Your old files were not deleted. After checking that everything looks right you can remove the old folder to free that space.</div></div>`;
    } else {
      if (i.task && (i.task.state === 'failed' || i.task.state === 'cancelled')) html += `<div style="margin-top:12px;color:var(--danger)">${i.task.state === 'cancelled' ? 'Cancelled. Nothing was changed.' : 'That did not work: ' + esc(i.task.error || 'unknown error') + ' Nothing was changed.'}</div>`;
      html += `<div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px"><button class="btn btn-primary btn-sm" id="stChange">Change location…</button>${i.chosenDir ? '<button class="btn btn-ghost btn-sm" id="stReset">Use the default folder</button>' : ''}</div>`;
      if (this.open) {
        html += `<div style="margin-top:14px;padding:14px;border-radius:10px;background:var(--bg3);border:1px solid var(--border)">
          <label class="form-label" for="stPath">New folder (on the drive with more space)</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><input class="form-input" id="stPath" placeholder="D:\\ClipperIQ" style="flex:1;min-width:200px" autocomplete="off" spellcheck="false">${desktop ? '<button class="btn btn-ghost btn-sm" id="stBrowse">Browse…</button>' : ''}</div>
          <label style="display:flex;gap:8px;margin-top:12px;color:var(--text);align-items:flex-start"><input type="checkbox" id="stMove" checked style="margin-top:3px;accent-color:var(--accent)"><span>Move my existing videos and clips there <span style="color:var(--muted)">(recommended. Your library keeps working and nothing is deleted from the old folder.)</span></span></label>
          <div id="stMsg" style="margin-top:10px;min-height:20px" aria-live="polite"></div>
          <div style="display:flex;gap:8px;margin-top:6px"><button class="btn btn-primary btn-sm" id="stApply">Use this folder</button><button class="btn btn-ghost btn-sm" id="stClose">Cancel</button></div>
        </div>`;
      }
    }
    if (i.busy && i.canChange && !(i.task && i.task.state === 'running')) html += `<div style="margin-top:10px;font-size:12px">Videos are being processed right now, so the location cannot be changed until they finish.</div>`;
    body.innerHTML = html;
    this.wire();
  },

  wire() {
    const on = (id, fn) => { const e = $(id); if (e) e.addEventListener('click', fn); };
    on('stChange', () => { this.open = true; this.render(); $('stPath')?.focus(); });
    on('stClose', () => { this.open = false; this.render(); });
    on('stBrowse', async () => { try { const p = await window.clipperiqDesktop.chooseFolder(); if (p) { $('stPath').value = p; this.check(); } } catch { /* cancelled */ } });
    $('stPath')?.addEventListener('change', () => this.check());
    $('stMove')?.addEventListener('change', () => this.check());
    on('stApply', () => this.apply());
    on('stCancel', async () => { try { await api('/cancel', { method: 'POST', body: {} }); } catch { /* ignore */ } this.load(); });
    on('stReset', async () => {
      if (!confirm('Go back to the default folder? Files already moved elsewhere stay where they are and will not be shown until you point ClipperIQ back at them.')) return;
      try { await api('/reset', { method: 'POST', body: {} }); await this.load(); } catch (e) { alert(e.message); }
    });
    on('stRestart', () => this.restart());
  },

  say(html, kind) { const m = $('stMsg'); if (m) m.innerHTML = `<span style="color:${kind === 'bad' ? 'var(--danger)' : kind === 'ok' ? 'var(--success)' : 'var(--muted)'}">${html}</span>`; },

  async check() {
    const p = ($('stPath')?.value || '').trim(); if (!p) return null;
    this.say('Checking…');
    try {
      const r = await api('/check', { method: 'POST', body: { path: p, move: !!$('stMove')?.checked } });
      if (!r.ok) { this.say(esc(r.error), 'bad'); return r; }
      this.say(`OK. ${fmt(r.free)} free there${r.hasData ? '. <b>This folder already holds ClipperIQ data, which will then be used as it is.</b>' : ''}${r.needBytes ? `. Moving needs about ${fmt(r.needBytes)}.` : ''}`, 'ok');
      return r;
    } catch (e) { this.say(esc(e.message), 'bad'); return null; }
  },

  async apply() {
    const r = await this.check(); if (!r || !r.ok) return;
    try {
      await api('/apply', { method: 'POST', body: { path: $('stPath').value.trim(), move: !!$('stMove')?.checked } });
      this.open = false; await this.load(); this.startPoll();
    } catch (e) { this.say(esc(e.message), 'bad'); }
  },

  startPoll() {
    clearInterval(this.poll);
    this.poll = setInterval(async () => {
      try { this.info = await api(''); } catch { return; }
      if (!this.info.task || this.info.task.state !== 'running') { clearInterval(this.poll); this.poll = null; }
      this.render();
    }, 1000);
  },

  async restart() {
    try {
      const r = await api('/restart', { method: 'POST', body: {} });
      if (r.manual) { $('stBody').insertAdjacentHTML('beforeend', '<div style="margin-top:10px;color:var(--text)">Close ClipperIQ and start it again to finish.</div>'); return; }
      $('stBody').innerHTML = '<div style="color:var(--text)">Restarting…</div>';
      const base = (await getBackendBaseUrl()) || '';
      const t0 = Date.now();
      const tick = async () => {
        try { const h = await fetch(`${base}/healthz`, { cache: 'no-store' }); if (h.ok && Date.now() - t0 > 1200) { location.reload(); return; } } catch { /* still down */ }
        if (Date.now() - t0 > 60000) { $('stBody').innerHTML = '<div style="color:var(--danger)">ClipperIQ did not come back. Close it and open it again.</div>'; return; }
        setTimeout(tick, 800);
      };
      setTimeout(tick, 1500);
    } catch (e) { alert(e.message); }
  },
};

function init() {
  const v = $('view-settings'); if (!v) return;
  const refreshIfShown = () => { if (v.classList.contains('active')) ui.load().then(() => { if (ui.info && ui.info.task && ui.info.task.state === 'running') ui.startPoll(); }); };
  new MutationObserver(refreshIfShown).observe(v, { attributes: true, attributeFilter: ['class'] });
  refreshIfShown();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
window.storageSettings = ui;
