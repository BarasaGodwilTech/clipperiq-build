// Errors people can see and act on.
//
//  - A banner that says WHAT went wrong and offers a way out (try again, repair, copy the details), in place of a one-line
//    "something went wrong" that hides the reason.
//  - A small log of recent errors (Settings > Diagnostics) so a problem can be reported with its real message.
//  - Global handlers, so an unexpected error anywhere is noted and shown once instead of being lost in the console.

const KEEP = 40;
const ring = [];
let lastToastAt = 0;

const short = (e) => String((e && (e.message || e.reason || e)) || 'Unknown error').replace(/\s+/g, ' ').slice(0, 220);

export const diagnostics = {
  add(kind, err, context = '') {
    const e = err && err.reason ? err.reason : err;
    ring.push({
      at: new Date().toISOString(), kind, context: String(context || '').slice(0, 120),
      name: (e && e.name) || '', message: short(e), stack: String((e && e.stack) || '').split('\n').slice(0, 5).join('\n'),
    });
    if (ring.length > KEEP) ring.shift();
    try { localStorage.setItem('clipperiq_error_log', JSON.stringify(ring.slice(-KEEP))); } catch { /* storage may be blocked */ }
  },
  entries() { return ring.slice(); },
  /** Plain text for "Copy details". */
  text(extra = '') {
    const head = [`ClipperIQ diagnostics ${new Date().toISOString()}`, `Address: ${typeof location !== 'undefined' ? location.origin : ''}`, `Browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`];
    if (extra) head.push(extra);
    const body = ring.length ? ring.map((r) => `[${r.at}] ${r.kind}${r.context ? ` (${r.context})` : ''}: ${r.name ? `${r.name}: ` : ''}${r.message}${r.stack ? `\n${r.stack}` : ''}`).join('\n\n') : '(no errors recorded in this session)';
    return `${head.join('\n')}\n\n${body}\n`;
  },
};

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
export { copyText };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Shows (or replaces) a banner at the top of the screen.
 *   { id, tone: 'error' | 'warn' | 'info', title, message, details, actions: [{ label, primary, onClick }], dismissible }
 */
export function showBanner({ id = 'cq-banner', tone = 'error', title, message = '', details = '', actions = [], dismissible = true }) {
  hideBanner(id);
  const el = document.createElement('div');
  el.id = id; el.className = `cq-banner cq-banner-${tone}`; el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `<div class="cq-banner-main"><div class="cq-banner-title">${esc(title)}</div>
    ${message ? `<div class="cq-banner-msg">${message}</div>` : ''}
    ${details ? `<details class="cq-banner-det"><summary>Technical details</summary><pre>${esc(details)}</pre></details>` : ''}
    <div class="cq-banner-actions"></div></div>
    ${dismissible ? '<button class="cq-banner-x" type="button" aria-label="Dismiss">&times;</button>' : ''}`;
  const row = el.querySelector('.cq-banner-actions');
  for (const a of actions) {
    const b = document.createElement('button'); b.type = 'button'; b.className = `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'}`; b.textContent = a.label;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await a.onClick(el, b); } catch (e) { diagnostics.add('banner-action', e, a.label); b.textContent = `${a.label} (failed)`; }
      b.disabled = false;
    });
    row.appendChild(b);
  }
  const x = el.querySelector('.cq-banner-x'); if (x) x.addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  return el;
}
export function hideBanner(id = 'cq-banner') { const el = document.getElementById(id); if (el) el.remove(); }

/** Is this error about the browser's own saved-data storage (rather than the server or the code)? */
export function isStorageError(err) {
  const n = (err && err.name) || ''; const m = String((err && err.message) || '');
  return ['UnknownError', 'SecurityError', 'InvalidStateError', 'QuotaExceededError', 'TimeoutError', 'BlockedError', 'NotFoundError', 'AbortError'].includes(n) && /backing store|indexeddb|database|storage|saved data|quota|local storage/i.test(m)
    || /backing store|indexeddb/i.test(m);
}

/**
 * The banner for "the browser cannot open its saved data for this address" (a damaged or locked Chrome profile, a full disk,
 * private mode ...). The app keeps working in temporary mode; "Repair" clears this address's saved data (the library comes
 * back from the server's backup) and "Try again" simply tries once more.
 */
export function showStorageBanner(failure, { db, notify } = {}) {
  const where = typeof location !== 'undefined' ? location.host : 'this address';
  showBanner({
    id: 'cq-storage', tone: 'warn', dismissible: true,
    title: 'This browser cannot open its saved data',
    message: `ClipperIQ is running in <b>temporary mode</b>: you can still upload and make clips, but nothing is kept in this browser, so finished clips must be downloaded before you close the page. `
      + `This usually means Chrome's storage for <b>${esc(where)}</b> is damaged or locked (after a crash, a full disk, or another Chrome window using it). Closing every ClipperIQ tab and Chrome window, then opening it again, often fixes it. `
      + `<b>Repair</b> clears only this address's saved data; your library is backed up on the server and comes back by itself.`,
    details: `${failure && failure.name ? `${failure.name}: ` : ''}${(failure && failure.message) || ''}`,
    actions: [
      { label: 'Try again', primary: true, onClick: async () => { const mode = await db.retry(); if (mode === 'indexeddb') location.reload(); else notify?.warn?.('Still cannot open the saved data. Try Repair, or close other ClipperIQ tabs first.'); } },
      { label: 'Repair', onClick: async () => {
        if (!window.confirm(`Clear the saved data of ${where} in this browser and reload?\n\nYour library is backed up on the server and is restored automatically. Clips that were never backed up to the server would be lost.`)) return;
        try { await db.repair(); location.reload(); } catch (e) {
          diagnostics.add('repair', e);
          showBanner({ id: 'cq-repair', tone: 'error', title: 'Repair did not work', message: `${esc(short(e))}<br>Close every ClipperIQ tab and Chrome window and try again. If it still fails: in Chrome open <b>Settings, Privacy and security, Site settings, View permissions and data stored across sites</b>, search for <b>${esc(where)}</b> and delete its data.`, actions: [{ label: 'Copy details', onClick: () => copyText(diagnostics.text()) }] });
        }
      } },
      { label: 'Copy details', onClick: async () => { await copyText(diagnostics.text(`Storage: ${failure ? `${failure.name}: ${failure.message}` : ''}`)); } },
    ],
  });
}

/** The banner for any other failure of start-up. */
export function showStartupFailure(err, { db, notify } = {}) {
  diagnostics.add('startup', err);
  if (isStorageError(err)) { showStorageBanner({ name: err && err.name, message: short(err) }, { db, notify }); return; }
  showBanner({
    id: 'cq-fatal', tone: 'error', dismissible: false,
    title: 'ClipperIQ could not finish loading',
    message: `${esc(short(err))}<br>Reload usually fixes a one-off problem. If it keeps coming back, copy the details and send them along.`,
    details: String((err && err.stack) || short(err)),
    actions: [{ label: 'Reload', primary: true, onClick: () => location.reload() }, { label: 'Copy details', onClick: () => copyText(diagnostics.text()) }],
  });
}

// Browsers report these for harmless reasons; they are not worth a message.
const NOISE = /ResizeObserver loop|Script error\.?$|AbortError|The user aborted|Load failed$|cancelled|canceled|NetworkError when attempting to fetch/i;

/** Notes every unexpected error and tells the person once in a while (never a flood). */
export function installGlobalErrorHandlers({ notify } = {}) {
  const tell = (e) => {
    if (Date.now() - lastToastAt < 20000) return;
    lastToastAt = Date.now();
    try { notify?.error?.(`Something unexpected went wrong (${short(e).slice(0, 90)}). If it keeps happening, open Settings, Diagnostics and copy the details.`); } catch { /* ignore */ }
  };
  window.addEventListener('error', (ev) => {
    const e = ev.error || new Error(ev.message);
    if (NOISE.test(String(ev.message || '')) || (ev.target && ev.target !== window)) return; // a failed image / font load is not a script error
    diagnostics.add('error', e, ev.filename ? `${String(ev.filename).split('/').pop()}:${ev.lineno}` : '');
    tell(e);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    if (NOISE.test(String((r && (r.name || r.message)) || r))) return;
    diagnostics.add('promise', r);
    tell(r);
  });
}
