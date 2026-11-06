import { db, STORES } from '../storage/db.js';

export const JOB_STATUS = {
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  POSTED: 'posted',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const jobQueue = {
  async add(jobData) {
    // Normalize time and validate inputs
    const when = new Date(jobData.scheduledAt);
    if (isNaN(when.getTime())) throw new Error('Invalid schedule time');

    // Duplicate guard: avoid scheduling the same clip+platform at ~the same time
    // Treat within 60s as duplicates to catch double-clicks and quick repeats
    const all = await db.getAll(STORES.SCHEDULED_POSTS);
    const targetTs = when.getTime();
    const platformName = String(jobData.platform || '').trim();
    const dup = all.some(p =>
      p && p.clipId === jobData.clipId &&
      String(p.platform || '').trim().toLowerCase() === platformName.toLowerCase() &&
      (p.status === JOB_STATUS.SCHEDULED || p.status === JOB_STATUS.RUNNING) &&
      Math.abs(new Date(p.scheduledAt).getTime() - targetTs) <= 60000
    );
    if (dup) {
      throw new Error(`Already scheduled for ${platformName} around this time`);
    }

    const job = {
      clipId: jobData.clipId,
      blobId: jobData.blobId,
      platform: jobData.platform,
      caption: jobData.caption || '',
      scheduledAt: when.toISOString(),
      originalScheduledAt: when.toISOString(), // Preserve original schedule time
      status: JOB_STATUS.SCHEDULED,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      options: jobData.options || {},
    };
    const id = await db.put(STORES.SCHEDULED_POSTS, job);
    return { id, ...job };
  },

  async getAll() {
    return db.getAll(STORES.SCHEDULED_POSTS);
  },

  async getById(id) {
    return db.get(STORES.SCHEDULED_POSTS, id);
  },

  async getDue(now = new Date()) {
    return db.getScheduledPostsDue(now);
  },

  async getByStatus(status) {
    return db.getAllByIndex(STORES.SCHEDULED_POSTS, 'status', status);
  },

  async markRunning(id) {
    return db.updatePostStatus(id, JOB_STATUS.RUNNING, { progress: 0 });
  },

  async markPosted(id, result = {}) {
    await db.updatePostStatus(id, JOB_STATUS.POSTED, {
      postedAt: new Date().toISOString(),
      result: JSON.stringify(result),
      progress: 100,
    });

    const job = await db.get(STORES.SCHEDULED_POSTS, id);
    await db.put(STORES.POSTED_HISTORY, {
      jobId: id,
      clipId: job.clipId,
      platform: job.platform,
      caption: job.caption,
      scheduledAt: job.scheduledAt,
      postedAt: new Date().toISOString(),
      result: JSON.stringify(result),
    });
  },

  async markFailed(id, errorMsg, nextRetryAt = null) {
    const job = await db.get(STORES.SCHEDULED_POSTS, id);
    if (!job) return;

    const update = {
      ...job,
      status: nextRetryAt ? JOB_STATUS.SCHEDULED : JOB_STATUS.FAILED,
      retryCount: (job.retryCount || 0) + 1,
      lastError: errorMsg,
      updatedAt: new Date().toISOString(),
      progress: nextRetryAt ? 0 : (job.progress || 0),
    };

    if (nextRetryAt) {
      // Ensure retry time never jumps ahead of original scheduled time
      // This preserves the order of scheduled posts
      const originalTime = job.originalScheduledAt ? new Date(job.originalScheduledAt).getTime() : 0;
      const retryTime = new Date(nextRetryAt).getTime();
      const safeRetryTime = Math.max(originalTime, retryTime);
      update.scheduledAt = new Date(safeRetryTime).toISOString();
    }
    return db.put(STORES.SCHEDULED_POSTS, update);
  },

  async cancel(id) {
    return db.updatePostStatus(id, JOB_STATUS.CANCELLED, { progress: null });
  },

  async reschedule(id, newTime) {
    const job = await db.get(STORES.SCHEDULED_POSTS, id);
    if (!job) throw new Error(`Job ${id} not found`);
    return db.put(STORES.SCHEDULED_POSTS, {
      ...job,
      scheduledAt: new Date(newTime).toISOString(),
      originalScheduledAt: job.originalScheduledAt || job.scheduledAt, // Preserve original schedule time
      status: JOB_STATUS.SCHEDULED,
      updatedAt: new Date().toISOString(),
    });
  },

  async remove(id) {
    return db.delete(STORES.SCHEDULED_POSTS, id);
  },

  async getUpcomingCount() {
    const all = await this.getByStatus(JOB_STATUS.SCHEDULED);
    return all.length;
  },

  getTimeUntilNext(jobs) {
    const now = Date.now();
    const upcoming = jobs
      .filter((j) => j.status === JOB_STATUS.SCHEDULED)
      .map((j) => new Date(j.scheduledAt).getTime())
      .filter((t) => t > now)
      .sort((a, b) => a - b);

    if (!upcoming.length) return null;
    return upcoming[0] - now;
  },

  async setProgress(id, progress) {
    const job = await db.get(STORES.SCHEDULED_POSTS, id);
    if (!job) return;
    return db.put(STORES.SCHEDULED_POSTS, { ...job, progress, updatedAt: new Date().toISOString() });
  },
};
