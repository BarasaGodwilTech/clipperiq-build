import { db, STORES } from '../storage/db.js';
import { videoStore } from '../storage/videoStore.js';
import { jobQueue } from '../scheduler/jobQueue.js';
import { authStore } from '../storage/authStore.js';
import { diagnostics } from '../core/errors.js';

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function formatDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const dashboard = {
  /**
   * Fills every part of the dashboard. A part that fails (say, one damaged record) is reported where it should have appeared,
   * with a Retry, and never stops the other parts from loading.
   */
  async refresh() {
    const parts = [
      ['numbers', () => this.updateStats()],
      ['recent uploads', () => this.renderRecentUploads()],
      ['calendar', () => this.buildCalendar()],
      ['greeting', () => this.updateGreeting()],
      ['upcoming posts', () => this.renderUpcomingPosts()],
    ];
    const results = await Promise.allSettled(parts.map(([, fn]) => fn()));
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') return;
      failed.push(parts[i][0]);
      diagnostics.add('dashboard', r.reason, parts[i][0]);
      console.warn(`[Dashboard] ${parts[i][0]} failed:`, r.reason);
      this._showSectionError(parts[i][0], r.reason);
    });
    return failed;
  },

  _showSectionError(name, err) {
    const msg = String((err && err.message) || err || 'unknown problem').slice(0, 120).replace(/[<>&]/g, '');
    const html = `<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">Couldn't load the ${name}: ${msg}<br><button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="window.app?.retryDashboard?.()">Try again</button></div>`;
    const target = { 'recent uploads': 'recentUploads', 'upcoming posts': 'upcomingPosts' }[name];
    if (target) { const el = document.getElementById(target); if (el) el.innerHTML = html; return; }
    if (name === 'numbers') document.querySelectorAll('#view-dashboard .stat-change').forEach((e) => { if (/Loading/.test(e.textContent)) e.textContent = 'Could not load'; });
    if (name === 'greeting') { const s = document.getElementById('dashSub'); if (s && /Loading/.test(s.textContent)) s.textContent = 'Could not load your schedule'; }
  },

  async renderUpcomingPosts() {
    const el = document.getElementById('upcomingPosts');
    if (!el) return;
    const jobs = await jobQueue.getAll();
    const upcoming = jobs
      .filter(j => j.status === 'scheduled')
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
      .slice(0, 5);

    if (upcoming.length === 0) {
      el.innerHTML = '<div style="text-align:center;padding:16px;color:var(--muted)">No scheduled posts</div>';
      return;
    }

    const colors = { TikTok: 'var(--tiktok)', Instagram: 'var(--insta)', YouTube: 'var(--youtube)' };
    const fmt = (iso) => {
      const d = new Date(iso);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
      return isToday ? `Today · ${t}` : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` · ${t}`;
    };

    el.innerHTML = upcoming.map(j => `
      <div class="video-item">
        <div style="width:8px;height:8px;border-radius:50%;background:${colors[j.platform]||'var(--accent)'};flex-shrink:0"></div>
        <div class="video-info">
          <div class="video-name">Clip #${j.clipId}</div>
          <div class="video-meta">${fmt(j.scheduledAt)} · ${j.platform}</div>
        </div>
        <span class="badge badge-scheduled" style="font-size:10px">${j.caption?.slice(0,20)||'No caption'}...</span>
      </div>`).join('');
  },

  async updateGreeting() {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const el = document.getElementById('dashGreeting');
    if (el) el.textContent = `${greeting} 👋`;

    const scheduled = await jobQueue.getByStatus('scheduled');
    const sub = document.getElementById('dashSub');
    if (sub) {
      const todayCount = scheduled.filter(j => {
        const d = new Date(j.scheduledAt);
        const now = new Date();
        return d.toDateString() === now.toDateString();
      }).length;
      const platforms = [...new Set(scheduled.map(j => j.platform))];
      if (todayCount > 0) {
        sub.textContent = `You have ${todayCount} clip${todayCount !== 1 ? 's' : ''} scheduled today across ${platforms.length} platform${platforms.length !== 1 ? 's' : ''}`;
      } else {
        sub.textContent = 'No clips scheduled for today — add some from the Upload tab';
      }
    }
  },

  async updateStats() {
    const [clips, scheduled, uploads] = await Promise.all([
      db.getAll(STORES.CLIPS),
      db.getAll(STORES.SCHEDULED_POSTS),
      db.getAll(STORES.UPLOADS),
    ]);

    const posted = scheduled.filter(j => j.status === 'posted');
    const scheduledOnly = scheduled.filter(j => j.status === 'scheduled');

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentClips = clips.filter(c => new Date(c.createdAt).getTime() > weekAgo);

    this.setStat('statClips', clips.length, `↑ ${recentClips.length} this week`);
    this.setStat('statScheduled', scheduledOnly.length, `${scheduled.length} total`);
    this.setStat('statPosted', posted.length, '');
    this.setStat('statUploads', uploads.length, '');
  },

  setStat(id, value, sub) {
    const el = document.getElementById(id);
    if (el) el.querySelector('.stat-num').textContent = value;
    const subEl = el?.querySelector('.stat-change');
    if (subEl && sub) subEl.textContent = sub;
  },

  async renderRecentUploads() {
    const uploads = await videoStore.getAllUploads();
    const container = document.getElementById('recentUploads');
    if (!container) return;

    if (uploads.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:32px;color:var(--muted)">
          <div style="font-size:32px;margin-bottom:8px">📁</div>
          <div>No uploads yet. <a href="#" onclick="window.app.navigate('upload')" style="color:var(--accent2)">Upload your first video</a></div>
        </div>`;
      return;
    }

    const recent = uploads.slice(-5).reverse();
    const statusBadge = (s, id) => {
      const map = {
        uploaded: '<span class="badge badge-draft">Uploaded</span>',
        processing: `<span class="badge badge-processing" data-proc-badge="${esc(id)}">⚙ Processing</span>`,
        done: '<span class="badge badge-scheduled">✓ Ready</span>',
        failed: '<span class="badge badge-failed" title="Open to retry">✕ Failed</span>',
        cancelled: '<span class="badge badge-draft" title="Open to resume">⏹ Stopped</span>',
      };
      return map[s] || `<span class="badge badge-draft">${s}</span>`;
    };

    // Each row opens the upload's details window (progress, steps, clips so far) - see processingStatus.js.
    container.innerHTML = recent.map(u => `
      <div class="video-item" data-upload-id="${esc(u.id)}" role="button" tabindex="0" title="Click to see what's happening with this video" style="cursor:pointer"
           onclick="window.processingStatus?.openUpload(this.dataset.uploadId)"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.processingStatus?.openUpload(this.dataset.uploadId)}">
        <div class="video-thumb">
          <div style="color:var(--dim);font-size:18px">▶</div>
        </div>
        <div class="video-info">
          <div class="video-name" title="${esc(u.name)}">${esc(u.name)}</div>
          <div class="video-meta">${u.duration ? formatDuration(u.duration) + ' · ' : ''}${formatBytes(u.size)} · ${timeAgo(u.createdAt)}</div>
        </div>
        ${statusBadge(u.status, u.id)}
      </div>
    `).join('');
    window.processingStatus?.updateRows?.();
  },

  async buildCalendar() {
    const grid = document.getElementById('calGrid');
    if (!grid) return;

    const allJobs = await jobQueue.getAll();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay();

    const postsByDay = {};
    for (const job of allJobs) {
      const d = new Date(job.scheduledAt);
      if (d.getFullYear() === year && d.getMonth() === month) {
        const day = d.getDate();
        if (!postsByDay[day]) postsByDay[day] = [];
        postsByDay[day].push(job.platform);
      }
    }

    const dayLabels = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    let html = dayLabels.map(d => `<div class="cal-day-label">${d}</div>`).join('');
    for (let i = 0; i < firstDay; i++) html += `<div class="cal-day empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = d === now.getDate();
      const posts = postsByDay[d] || [];
      const platformColor = (p) => {
        if (p === 'TikTok') return 'var(--tiktok)';
        if (p === 'Instagram') return 'var(--insta)';
        if (p === 'YouTube') return 'var(--youtube)';
        return 'var(--accent)';
      };
      html += `<div class="cal-day${isToday ? ' today' : ''}${posts.length ? ' has-posts' : ''}">
        <span>${d}</span>
        ${posts.length ? `<div class="cal-dots">${[...new Set(posts)].map(p => `<div class="cal-dot" style="background:${platformColor(p)}"></div>`).join('')}</div>` : ''}
      </div>`;
    }
    grid.innerHTML = html;
  },
};
