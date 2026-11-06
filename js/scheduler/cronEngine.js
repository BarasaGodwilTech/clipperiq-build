import { jobQueue, JOB_STATUS } from './jobQueue.js';
import { retryHandler } from './retryHandler.js';
import { videoStore } from '../storage/videoStore.js';
import { db, STORES } from '../storage/db.js';

const CHECK_INTERVAL_MS = 60 * 1000;

export class CronEngine {
  constructor() {
    this.intervalId = null;
    this.running = false;
    this.platformAPIs = {};
    this.onJobComplete = null;
    this.onJobFailed = null;
    this.onTick = null;
    this.jobAbortControllers = new Map();
  }

  registerPlatform(name, api) {
    this.platformAPIs[name.toLowerCase()] = api;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
    this.intervalId = setInterval(() => this._tick(), CHECK_INTERVAL_MS);
    console.log('[CronEngine] Scheduler started, checking every 60 seconds');
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
    console.log('[CronEngine] Scheduler stopped');
  }

  async _tick() {
    if (this.onTick) this.onTick();
    try {
      // Heal stale RUNNING jobs (e.g., tab crashed or network lost)
      try {
        const running = await jobQueue.getByStatus(JOB_STATUS.RUNNING);
        const STALE_MS = 10 * 60 * 1000; // 10 minutes
        const now = Date.now();
        for (const j of running) {
          const updated = new Date(j.updatedAt || j.createdAt || Date.now()).getTime();
          if (now - updated > STALE_MS) {
            // Respect retry limits on stale recovery
            const fresh = await jobQueue.getById(j.id);
            const canRetry = fresh && (fresh.retryCount || 0) < (fresh.maxRetries ?? 3);
            if (canRetry) {
              const next = new Date(now + 15000).toISOString();
              await jobQueue.markFailed(j.id, 'Worker reset: previous run became stale', next);
              console.warn(`[CronEngine] Recovered stale job ${j.id}; rescheduled at ${next}`);
            } else {
              await jobQueue.markFailed(j.id, 'Worker reset: previous run became stale (max retries reached)', null);
              console.warn(`[CronEngine] Stale job ${j.id} marked failed (retry limit reached)`);
            }
          }
        }
      } catch (e) {
        console.warn('[CronEngine] Stale job recovery failed:', e?.message || e);
      }

      const duePosts = await jobQueue.getDue(new Date());
      if (duePosts.length === 0) return;
      console.log(`[CronEngine] ${duePosts.length} post(s) due`);
      for (const post of duePosts) {
        await this.executePost(post);
      }
    } catch (err) {
      console.error('[CronEngine] Tick error:', err);
    }
  }

  async executePost(post) {
    console.log(`[CronEngine] Executing post ${post.id} on ${post.platform}`);
    // Enforce part order: delay this job if any earlier part from the same upload hasn't posted yet
    try {
      const clip = await db.get(STORES.CLIPS, post.clipId);
      if (clip && clip.uploadId != null && clip.partNumber != null) {
        const allClips = await db.getAll(STORES.CLIPS);
        const earlier = allClips.filter(c => c.uploadId === clip.uploadId && c.partNumber != null && c.partNumber < clip.partNumber);
        if (earlier.length > 0) {
          // Check if earlier parts have been posted for this platform
          const hist = await db.getAll(STORES.POSTED_HISTORY);
          const postedIds = new Set(hist.filter(h => h.platform === post.platform).map(h => h.clipId));
          // Check all scheduled posts for this platform (including running, scheduled, and retryable failed)
          const scheduledPosts = await db.getAll(STORES.SCHEDULED_POSTS);
          const pendingIds = new Set(
            scheduledPosts
              .filter(p => p.platform === post.platform && (
                p.status === 'scheduled' ||
                p.status === 'running' ||
                (p.status === 'failed' && (p.retryCount || 0) < (p.maxRetries || 3))
              ))
              .map(p => p.clipId)
          );
          // Part 2 is blocked if any earlier part is neither posted nor permanently failed
          const pendingEarlier = earlier.filter(c => !postedIds.has(c.id) && pendingIds.has(c.id));
          if (pendingEarlier.length > 0) {
            const deferMs = 2 * 60 * 1000;
            const next = new Date(Date.now() + deferMs);
            await jobQueue.reschedule(post.id, next);
            console.warn(`[CronEngine] Deferred job ${post.id} (Clip #${post.clipId}) until earlier parts post (blocked by: ${pendingEarlier.map(c => c.partNumber).join(', ')})`);
            return;
          }
        }
      }
    } catch (e) {
      console.warn('[CronEngine] Part-order check failed, proceeding:', e?.message || e);
    }
    const controller = new AbortController();
    this.jobAbortControllers.set(post.id, controller);
    await jobQueue.markRunning(post.id);

    try {
      const api = this.platformAPIs[post.platform.toLowerCase()];
      if (!api) throw new Error(`No API registered for platform: ${post.platform}`);

      const videoBlob = await videoStore.getBlob(post.blobId);
      if (!videoBlob) throw new Error(`Video blob not found: ${post.blobId}`);

      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Job timed out')), ms)),
      ]);

      const result = await retryHandler.withRetry(
        () => withTimeout(this._publishToplatform(api, post.platform, videoBlob, post, controller.signal), 7 * 60 * 1000),
        post.id,
        (attempt, delay, err) => {
          console.warn(`[CronEngine] Retry ${attempt} for job ${post.id} in ${delay}ms:`, err.message);
        }
      );

      await jobQueue.markPosted(post.id, result);
      console.log(`[CronEngine] Post ${post.id} succeeded`);
      if (this.onJobComplete) this.onJobComplete(post, result);
    } catch (err) {
      console.error(`[CronEngine] Post ${post.id} failed:`, err.message);
      if (err.name === 'AbortError' || /aborted|cancelled/i.test(err.message || '')) {
        await jobQueue.cancel(post.id);
      } else {
        const freshPost = await jobQueue.getById(post.id);
        if (freshPost && retryHandler.shouldRetry(freshPost) && retryHandler.isRetryableError(err)) {
          const nextTime = retryHandler.getNextRetryTime(freshPost.retryCount || 0);
          await jobQueue.markFailed(post.id, err.message, nextTime);
          console.log(`[CronEngine] Scheduled retry for job ${post.id} at ${nextTime}`);
        } else {
          await jobQueue.markFailed(post.id, err.message, null);
        }
      }

      if (this.onJobFailed) this.onJobFailed(post, err);
    } finally {
      this.jobAbortControllers.delete(post.id);
    }
  }

  async _publishToplatform(api, platform, videoBlob, post, abortSignal) {
    const p = platform.toLowerCase();
    if (p === 'tiktok') {
      return api.publishVideo(videoBlob, post.caption, post.options, (pct) => jobQueue.setProgress(post.id, pct), abortSignal);
    }
    if (p === 'instagram') {
      return api.publishReel(videoBlob, post.caption, post.options, (pct) => jobQueue.setProgress(post.id, pct));
    }
    if (p === 'youtube') {
      return api.uploadShort(videoBlob, {
        title: post.caption?.slice(0, 100) || 'Short',
        description: post.caption || '',
        tags: post.options?.tags || [],
        privacy: post.options?.privacy || 'public',
      }, (pct) => jobQueue.setProgress(post.id, pct), abortSignal);
    }
    throw new Error(`Unsupported platform: ${platform}`);
  }

  async forceExecute(jobId) {
    const post = await jobQueue.getById(jobId);
    if (!post) throw new Error(`Job ${jobId} not found`);
    return this.executePost(post);
  }

  async cancel(jobId) {
    const ctrl = this.jobAbortControllers.get(jobId);
    if (ctrl) {
      ctrl.abort();
      // Reflect cancellation immediately in storage/UI
      await jobQueue.cancel(jobId);
    } else {
      await jobQueue.cancel(jobId);
    }
  }
}

export const cronEngine = new CronEngine();
