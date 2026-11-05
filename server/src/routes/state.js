'use strict';
const express = require('express');
const { wrap } = require('../middleware/asyncRoute');

/** GET returns the saved library snapshot (or `{ state: null }`); PUT replaces it. See services/stateStore.js. */
function createStateRouter({ stateStore }) {
  const router = express.Router();
  const json = express.json({ limit: '40mb' });

  router.get('/', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ state: stateStore.get() });
  }));

  router.put('/', json, wrap(async (req, res) => {
    res.json(stateStore.put(req.body || {}, { force: req.query.force === '1' }));
  }));

  return router;
}

module.exports = { createStateRouter };
