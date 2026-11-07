'use strict';
const express = require('express');
const { wrap } = require('../middleware/asyncRoute');
const { HttpError } = require('../services/errors');

function createDiagnosticsRouter({ selfTest }) {
  const router = express.Router();
  router.post('/selftest', wrap(async (req, res) => {
    try { res.json(selfTest.start()); }
    catch (e) { throw new HttpError(e.status || 500, e.message); }
  }));
  router.get('/selftest/:id', wrap(async (req, res) => {
    const v = selfTest.get(req.params.id);
    if (!v) throw new HttpError(404, 'That test is no longer known to the server. Run it again.');
    res.set('Cache-Control', 'no-store'); res.json(v);
  }));
  router.delete('/selftest/:id', wrap(async (req, res) => { selfTest.stop(req.params.id); res.json({ ok: true }); }));
  return router;
}
module.exports = { createDiagnosticsRouter };
