'use strict';
/** Wrap an async Express handler so rejected promises reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { wrap };
