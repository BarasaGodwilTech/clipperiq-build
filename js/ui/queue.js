import { jobQueue, JOB_STATUS } from '../scheduler/jobQueue.js';
import { cronEngine } from '../scheduler/cronEngine.js';
import { notify, confirmAction } from './notifications.js';

function formatCountdown(ms) {
  if (ms <= 0) return 'Now';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const opts = { hour: '2-digit', minute: '2-digit', hour12: true };
  if (isToday) return `Today · ${d.toLocaleTimeString([], opts)}`;
  const diff = d.getDate() - now.getDate();
  if (diff === 1 && d.getMonth() === now.getMonth()) return `Tomorrow · ${d.toLocaleTimeString([], opts)}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` · ${d.toLocaleTimeString([], opts)}`;
}

const platformColor = (p) => {
  if (p === 'TikTok') return 'var(--tiktok)';
  if (p === 'Instagram') return 'var(--insta)';
  if (p === 'YouTube') return 'var(--youtube)';
  return 'var(--accent)';
};

export const queueUI = {
  jobs: [],
  countdownInterval: null,

  async refresh() {
    this.jobs = await jobQueue.getAll();
    this.jobs.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    this.render();
    this.startCountdowns();
  },

  render() {
    const tbody = document.getElementById('queueTable');
    if (!tbody) return;

    if (this.jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted)">
        <div style="font-size:32px;margin-bottom:8px">📋</div>
        No scheduled posts yet — approve clips and schedule them
      </td></tr>`;
      return;
    }

    tbody.innerHTML = this.jobs.map(j => this.renderRow(j)).join('');
  },

  renderRow(j) {
    const statusBadge = {
      scheduled: `<span class="badge badge-scheduled" id="countdown-${j.id}">● ${formatCountdown(new Date(j.scheduledAt) - Date.now())}</span>`,
      running:   `<span class="badge badge-processing">⚙ Posting…</span>` + (typeof j.progress === 'number' ? `
        <div style="margin-top:6px;width:140px;height:6px;background:var(--border);border-radius:999px;overflow:hidden">
          <div id="prog-${j.id}" style="height:100%;width:${Math.max(0, Math.min(100, j.progress))}%;background:var(--accent);transition:width .3s"></div>
        </div>` : ''),
      posted:    `<span class="badge badge-posted">✓ Posted</span>`,
      failed:    `<span class="badge badge-failed">✕ Failed${j.retryCount ? ` (${j.retryCount}x)` : ''}</span>`,
      cancelled: `<span class="badge badge-draft">— Cancelled</span>`,
    }[j.status] || `<span class="badge badge-draft">${j.status}</span>`;

    const actions = {
      scheduled: `
        <button class="btn btn-ghost btn-sm" onclick="window.queueUI.reschedule(${j.id})">Edit</button>
        <button class="btn btn-primary btn-sm" onclick="window.queueUI.postNow(${j.id})" title="Post immediately">▶</button>
        <button class="btn btn-danger btn-sm" onclick="window.queueUI.cancel(${j.id})">✕</button>`,
      running: `
        <button class="btn btn-warning btn-sm" onclick="window.queueUI.stop(${j.id})" title="Stop posting">■ Stop</button>`,
      failed: `<button class="btn btn-primary btn-sm" onclick="window.queueUI.retry(${j.id})">Retry</button>
        <button class="btn btn-danger btn-sm" onclick="window.queueUI.remove(${j.id})">Remove</button>`,
      posted: `<button class="btn btn-ghost btn-sm" onclick="window.queueUI.remove(${j.id})">Remove</button>`,
      cancelled: `<button class="btn btn-primary btn-sm" onclick="window.queueUI.retry(${j.id})">Retry</button>
        <button class="btn btn-danger btn-sm" onclick="window.queueUI.remove(${j.id})">Remove</button>`,
    }[j.status] || '';

    const errorTip = j.lastError ? ` title="Posting failed"` : '';

    return `<tr${errorTip}>
      <td>
        <div style="font-size:13px;font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          Clip #${j.clipId}
        </div>
        <div style="font-size:11px;color:var(--muted)">
          ${j.caption ? j.caption.slice(0, 60) + (j.caption.length > 60 ? '…' : '') : '—'}
        </div>
      </td>
      <td><span style="color:${platformColor(j.platform)};font-weight:600;font-size:12px">${j.platform}</span></td>
      <td style="color:var(--muted);font-size:12px">${formatDate(j.scheduledAt)}</td>
      <td style="font-size:11px;color:var(--muted)">${j.retryCount > 0 ? `Retry ${j.retryCount}/${j.maxRetries}` : '—'}</td>
      <td>${statusBadge}</td>
      <td><div style="display:flex;gap:6px">${actions}</div></td>
    </tr>`;
  },

  startCountdowns() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.countdownInterval = setInterval(async () => {
      for (const j of this.jobs) {
        if (j.status !== JOB_STATUS.SCHEDULED) continue;
        const el = document.getElementById(`countdown-${j.id}`);
        if (!el) continue;
        const ms = new Date(j.scheduledAt) - Date.now();
        el.textContent = `● ${formatCountdown(ms)}`;
      }
      try {
        const latest = await jobQueue.getAll();
        for (const job of latest) {
          if (job.status === JOB_STATUS.RUNNING && typeof job.progress === 'number') {
            const bar = document.getElementById(`prog-${job.id}`);
            if (bar) bar.style.width = `${Math.max(0, Math.min(100, job.progress))}%`;
          }
        }
      } catch {}
    }, 3000);
  },

  async cancel(id) {
    const ok = await confirmAction({
      title: 'Cancel this post?',
      message: 'This will cancel the scheduled post. It will not be published unless you reschedule it.',
      confirmText: 'Yes, cancel',
      cancelText: 'No',
      intent: 'danger',
    });
    if (!ok) return;
    await jobQueue.cancel(id);
    notify.info('Post cancelled');
    this.refresh();
  },

  async remove(id) {
    const ok = await confirmAction({
      title: 'Remove this item?',
      message: 'This will remove the post from your queue/history view.',
      confirmText: 'Yes, remove',
      cancelText: 'No',
      intent: 'danger',
    });
    if (!ok) return;
    await jobQueue.remove(id);
    this.refresh();
  },

  async retry(id) {
    notify.info('Retrying post...');
    const btn = document.activeElement && document.activeElement.tagName === 'BUTTON' ? document.activeElement : null;
    if (btn) btn.disabled = true;
    cronEngine.forceExecute(id).catch(() => notify.error('Retry failed')).finally(() => { if (btn) btn.disabled = false; });
    // Quick refresh now, and again shortly to pick up RUNNING status
    this.refresh();
    setTimeout(() => this.refresh(), 600);
  },

  async postNow(id) {
    const ok = await confirmAction({
      title: 'Post immediately?',
      message: 'This will attempt to publish the post right now.',
      confirmText: 'Yes, post now',
      cancelText: 'No',
      intent: 'primary',
    });
    if (!ok) return;
    notify.info('Posting now...');
    const btn = document.activeElement && document.activeElement.tagName === 'BUTTON' ? document.activeElement : null;
    if (btn) btn.disabled = true;
    cronEngine.forceExecute(id).catch(() => notify.error('Post failed')).finally(() => { if (btn) btn.disabled = false; });
    this.refresh();
    setTimeout(() => this.refresh(), 600);
  },

  async stop(id) {
    const btn = document.activeElement && document.activeElement.tagName === 'BUTTON' ? document.activeElement : null;
    if (btn) btn.disabled = true;
    try { await cronEngine.cancel(id); notify.info('Posting stopped'); }
    catch { notify.error('Failed to stop'); }
    finally { if (btn) btn.disabled = false; }
    this.refresh();
  },

  async reschedule(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return;
    let host = document.getElementById('reschedModal');
    if (!host) {
      host = document.createElement('div');
      host.className = 'overlay-modal';
      host.id = 'reschedModal';
      host.innerHTML = `
        <div class="modal-box" style="max-width:420px">
          <div class="modal-header">
            <span class="modal-title">Edit Schedule</span>
            <button class="modal-close" onclick="document.getElementById('reschedModal').classList.remove('show');window.app?._unlockBodyScroll?.()">✕</button>
          </div>
          <div class="form-group">
            <label class="form-label">Time</label>
            <input type="datetime-local" class="form-input" id="reschedTime">
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
            <button class="btn btn-ghost" onclick="document.getElementById('reschedModal').classList.remove('show');window.app?._unlockBodyScroll?.()">Cancel</button>
            <button class="btn btn-primary" id="reschedSave">Save</button>
          </div>
        </div>`;
      document.body.appendChild(host);
    }
    const current = new Date(job.scheduledAt);
    const iso = new Date(current.getTime() - current.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const input = document.getElementById('reschedTime');
    if (input) input.value = iso;
    const saveBtn = document.getElementById('reschedSave');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        try {
          const val = document.getElementById('reschedTime')?.value;
          if (!val) { notify.warn('Choose a time'); return; }
          const d = new Date(val);
          if (isNaN(d.getTime())) { notify.error('Invalid date/time'); return; }
          if (d <= new Date()) { notify.warn('Time must be in the future'); return; }
          await jobQueue.reschedule(id, d);
          notify.success('Rescheduled');
          document.getElementById('reschedModal')?.classList.remove('show');
          window.app?._unlockBodyScroll?.();
          this.refresh();
        } catch {
          notify.error('Failed to reschedule');
        }
      };
    }
    document.getElementById('reschedModal')?.classList.add('show');
    window.app?._lockBodyScroll?.();
  },
};

window.queueUI = queueUI;
