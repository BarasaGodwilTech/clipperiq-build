let container = null;

function getContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = `
      position:fixed; bottom:24px; right:24px; z-index:9999;
      display:flex; flex-direction:column-reverse; gap:10px;
      pointer-events:none;
    `;
    document.body.appendChild(container);
  }
  return container;
}

function createToast(message, type = 'info', duration = 4000) {
  const colors = {
    success: { bg: 'rgba(22,163,74,0.95)', border: 'rgba(34,197,94,0.4)', icon: '✓' },
    error:   { bg: 'rgba(185,28,28,0.95)',  border: 'rgba(239,68,68,0.4)',  icon: '✕' },
    warn:    { bg: 'rgba(161,98,7,0.95)',   border: 'rgba(245,158,11,0.4)', icon: '⚠' },
    info:    { bg: 'rgba(30,30,40,0.97)',   border: 'rgba(124,92,252,0.4)', icon: 'ℹ' },
  };

  const c = colors[type] || colors.info;
  const toast = document.createElement('div');
  toast.style.cssText = `
    background:${c.bg}; border:1px solid ${c.border};
    border-radius:10px; padding:12px 16px;
    display:flex; align-items:flex-start; gap:10px;
    max-width:340px; min-width:240px;
    color:#fff; font-size:13px; font-family:'DM Sans',sans-serif;
    backdrop-filter:blur(8px);
    box-shadow:0 4px 20px rgba(0,0,0,0.4);
    pointer-events:all;
    animation: slideInToast .25s ease;
    cursor:default;
  `;

  toast.innerHTML = `
    <span style="font-size:15px;line-height:1.2;flex-shrink:0">${c.icon}</span>
    <span style="flex:1;line-height:1.4">${escapeHtml(message)}</span>
    <button onclick="this.closest('[data-toast]').remove()" style="background:none;border:none;color:rgba(255,255,255,0.5);cursor:pointer;padding:0;font-size:14px;line-height:1;flex-shrink:0">✕</button>
  `;
  toast.setAttribute('data-toast', type);

  if (!document.getElementById('toast-style')) {
    const style = document.createElement('style');
    style.id = 'toast-style';
    style.textContent = `
      @keyframes slideInToast { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }
      @keyframes fadeOutToast { from { opacity:1; } to { opacity:0; transform:translateY(10px); } }
    `;
    document.head.appendChild(style);
  }

  return toast;
}

function isDev() {
  try {
    const h = (typeof window !== 'undefined' && window.location && window.location.hostname) ? window.location.hostname : '';
    return h.includes('localhost') || h === '127.0.0.1';
  } catch {
    return false;
  }
}

let _confirmActive = false;
let _confirmResolve = null;
let _confirmPrevFocus = null;
let _confirmKeyHandler = null;

function _getConfirmEls() {
  const overlay = document.getElementById('confirmModal');
  if (!overlay) return null;
  return {
    overlay,
    box: overlay.querySelector('.modal-box'),
    title: document.getElementById('confirmModalTitle'),
    desc: document.getElementById('confirmModalDesc'),
    yes: document.getElementById('confirmModalYes'),
    no: document.getElementById('confirmModalNo'),
    close: document.getElementById('confirmModalClose'),
  };
}

function _getFocusable(root) {
  if (!root) return [];
  const all = Array.from(root.querySelectorAll('button,[href],input,select,textarea,[tabindex]'));
  return all.filter(el => {
    const tabIndex = el.getAttribute('tabindex');
    if (tabIndex === '-1') return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  });
}

function _closeConfirm(result) {
  const els = _getConfirmEls();
  if (!els || !_confirmActive) return;
  _confirmActive = false;
  try {
    els.overlay.classList.remove('show');
    els.overlay.setAttribute('aria-hidden', 'true');
  } catch {}
  try {
    if (_confirmKeyHandler) document.removeEventListener('keydown', _confirmKeyHandler, true);
  } catch {}
  _confirmKeyHandler = null;
  try { window.app?._unlockBodyScroll?.(); } catch {}
  try { _confirmPrevFocus?.focus?.(); } catch {}
  _confirmPrevFocus = null;
  const resolve = _confirmResolve;
  _confirmResolve = null;
  try { resolve?.(result); } catch {}
}

export function confirmAction(opts = {}) {
  const title = opts.title || 'Confirm';
  const message = opts.message || '';
  const confirmText = opts.confirmText || 'Yes';
  const cancelText = opts.cancelText || 'No';
  const intent = opts.intent || 'danger';

  const els = _getConfirmEls();
  if (!els) {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }

  if (_confirmActive) _closeConfirm(false);

  _confirmActive = true;
  _confirmPrevFocus = document.activeElement;

  return new Promise((resolve) => {
    _confirmResolve = resolve;

    try {
      els.title.textContent = title;
      els.desc.textContent = message;
      els.yes.textContent = confirmText;
      els.no.textContent = cancelText;
      els.yes.className = intent === 'danger' ? 'btn btn-danger' : 'btn btn-primary';
      els.no.className = 'btn btn-ghost';
    } catch {}

    const onYes = (e) => { try { e?.preventDefault?.(); } catch {} _closeConfirm(true); };
    const onNo = (e) => { try { e?.preventDefault?.(); } catch {} _closeConfirm(false); };
    const onBackdrop = (e) => { if (e && e.target === els.overlay) onNo(e); };

    try {
      els.yes.onclick = onYes;
      els.no.onclick = onNo;
      if (els.close) els.close.onclick = onNo;
      els.overlay.onclick = onBackdrop;
    } catch {}

    _confirmKeyHandler = (e) => {
      if (!_confirmActive) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onNo(e);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        onYes(e);
        return;
      }
      if (e.key === 'Tab') {
        const focusables = _getFocusable(els.box);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || active === els.box) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    try { document.addEventListener('keydown', _confirmKeyHandler, true); } catch {}

    try {
      els.overlay.classList.add('show');
      els.overlay.setAttribute('aria-hidden', 'false');
    } catch {}
    try { window.app?._lockBodyScroll?.(); } catch {}

    setTimeout(() => {
      try { els.no.focus(); } catch {}
    }, 0);
  });
}

export const notify = {
  show(message, type = 'info', duration = 4000) {
    const c = getContainer();
    const toast = createToast(message, type, duration);
    c.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'fadeOutToast .3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
    return toast;
  },

  success(msg, duration = 4000) { return this.show(msg, 'success', duration); },
  error(msg, duration = 6000)   { return this.show(msg, 'error', duration); },
  warn(msg, duration = 5000)    { return this.show(msg, 'warn', duration); },
  info(msg, duration = 4000)    { return this.show(msg, 'info', duration); },

  copyError(err) {
    // In production, avoid exposing technical details to end users
    if (!isDev()) {
      return this.error('Something went wrong. Please try again.', 6000);
    }
    const detail = err?.stack || err?.message || String(err);
    const toast = this.error(`${err.message} — <a href="#" onclick="navigator.clipboard.writeText(${JSON.stringify(detail)}).then(()=>this.textContent='Copied!');return false" style="color:#fca5a5;text-decoration:underline">Copy details</a>`, 8000);
    toast.querySelector('span:nth-child(2)').innerHTML = toast.querySelector('span:nth-child(2)').textContent;
    const inner = toast.querySelector('span:nth-child(2)');
    inner.innerHTML = `${escapeHtml(err.message)} — <a href="#" onclick="navigator.clipboard.writeText(${JSON.stringify(detail)}).then(()=>this.textContent='Copied!');return false;" style="color:#fca5a5;text-decoration:underline">Copy details</a>`;
    return toast;
  },
};

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
