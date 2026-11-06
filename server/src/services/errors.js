'use strict';
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
    this.expose = true;
  }
}
const bad = (m, code) => new HttpError(400, m, code);
const notFound = (m = 'Not found') => new HttpError(404, m, 'NOT_FOUND');
const conflict = (m, code) => new HttpError(409, m, code);
module.exports = { HttpError, bad, notFound, conflict };
