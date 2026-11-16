'use strict';
/**
 * A fair, first-come-first-served limit on how many things run at once.
 *
 * Every clip render in the whole server takes a slot, whichever movie it belongs to. So two movies processed at the same time
 * share the computer's capacity (each gets its turn, neither starves), instead of both asking for all of it and slowing each
 * other down. A job waiting for a slot can be cancelled while it waits.
 */
function createSlots(size) {
  let capacity = Math.max(1, Math.floor(size) || 1);
  let free = capacity;
  const waiters = [];
  const abortError = () => Object.assign(new Error('Stopped'), { code: 'ABORT_ERR' });

  function next() {
    while (free > 0 && waiters.length) {
      const w = waiters.shift();
      if (w.signal) w.signal.removeEventListener('abort', w.onAbort);
      w.grant();
    }
  }

  function acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError()); return; }
      const grant = () => {
        free--;
        let released = false;
        resolve(() => { if (released) return; released = true; free++; next(); });
      };
      if (free > 0 && waiters.length === 0) { grant(); return; }
      const w = { grant, signal, onAbort: null };
      w.onAbort = () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(abortError()); } };
      if (signal) signal.addEventListener('abort', w.onAbort, { once: true });
      waiters.push(w);
    });
  }

  return {
    acquire,
    resize(n) { const m = Math.max(1, Math.floor(n) || 1); free += m - capacity; capacity = m; next(); },
    stats: () => ({ capacity, running: capacity - free, waiting: waiters.length }),
  };
}

module.exports = { createSlots };
