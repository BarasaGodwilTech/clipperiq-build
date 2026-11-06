'use strict';
/**
 * Background tasks for "find the best moments".
 *
 * Looking through a long video can take minutes. Holding one web request open that long is fragile (a proxy, an antivirus
 * scanner or a sleeping laptop cuts it) and shows no progress. So the analysis runs as a task: the app starts it, then asks
 * how far it is, and can stop it.
 */
const crypto = require('crypto');

function createAnalysisTasks({ run, keepMs = 60 * 60 * 1000, max = 50 } = {}) {
  const tasks = new Map();

  const view = (t) => ({
    taskId: t.id, uploadId: t.uploadId, status: t.status, progress: t.progress,
    error: t.error, errorCode: t.errorCode, result: t.status === 'done' ? t.result : null,
  });

  function gc() {
    const now = Date.now();
    for (const [id, t] of tasks) if (t.status !== 'running' && now - t.finishedAt > keepMs) tasks.delete(id);
    // a flood of requests must not grow without bound: drop the oldest finished ones
    if (tasks.size > max) for (const [id, t] of tasks) { if (tasks.size <= max) break; if (t.status !== 'running') tasks.delete(id); }
  }

  function start(uploadId, params) {
    gc();
    // one analysis of the same video with the same settings at a time: asking twice returns the running one
    const key = JSON.stringify([uploadId, params]);
    for (const t of tasks.values()) if (t.status === 'running' && t.key === key) return view(t);
    const t = {
      id: 'ana_' + crypto.randomBytes(6).toString('hex'), uploadId, key, status: 'running', progress: 0,
      error: null, errorCode: null, result: null, finishedAt: 0, ac: new AbortController(),
    };
    tasks.set(t.id, t);
    (async () => {
      try {
        t.result = await run(uploadId, params, { signal: t.ac.signal, onProgress: (f) => { t.progress = Math.max(t.progress, Math.min(99, Math.round((Number(f) || 0) * 100))); } });
        t.status = 'done'; t.progress = 100;
      } catch (e) {
        t.status = (e && e.code === 'ABORT_ERR') || t.ac.signal.aborted ? 'cancelled' : 'failed';
        t.error = t.status === 'cancelled' ? 'Stopped' : String((e && e.message) || e);
        t.errorCode = (e && (e.code || e.status)) || null;
      } finally { t.finishedAt = Date.now(); }
    })();
    return view(t);
  }

  function get(id) { const t = tasks.get(String(id)); return t ? view(t) : null; }
  function cancel(id) { const t = tasks.get(String(id)); if (!t) return false; if (t.status === 'running') t.ac.abort(); return true; }

  return { start, get, cancel, size: () => tasks.size };
}

module.exports = { createAnalysisTasks };
