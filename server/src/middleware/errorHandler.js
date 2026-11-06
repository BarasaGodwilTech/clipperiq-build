'use strict';
const { HttpError } = require('../services/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
}

function createErrorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return; // response (e.g. a proxied stream) already started
    const status = err instanceof HttpError ? err.status : (Number.isInteger(err.status) ? err.status : 500);
    const message = (err instanceof HttpError || status < 500) ? err.message : 'Internal server error';
    if (status >= 500) logger.error(`${req.method} ${req.path} -> ${status}: ${err.stack || err.message}`);
    else logger.warn(`${req.method} ${req.path} -> ${status}: ${err.message}`);
    res.status(status).json({ error: message });
  };
}

module.exports = { notFoundHandler, createErrorHandler };
