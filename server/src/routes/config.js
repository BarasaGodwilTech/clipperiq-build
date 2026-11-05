'use strict';
/**
 * Publishes the non-secret half of the server's single .env file so the frontend can pick up
 * TikTok/YouTube/Instagram app IDs automatically instead of requiring them to be re-entered
 * per browser. Secrets (client secrets) never leave the server — only their configured/not
 * flags are exposed, so the UI can show accurate connection-readiness without seeing them.
 */
const express = require('express');
const { wrap } = require('../middleware/asyncRoute');

function createConfigRouter({ config }) {
  const router = express.Router();

  router.get('/public', wrap(async (req, res) => {
    const c = config.credentials;
    res.json({
      tiktok_client_key: c.tiktok_client_key || '',
      google_client_id: c.google_client_id || '',
      facebook_app_id: c.facebook_app_id || '',
      tiktokConfigured: !!(c.tiktok_client_key && c.tiktok_client_secret),
      googleConfigured: !!(c.google_client_id && c.google_client_secret),
      facebookConfigured: !!(c.facebook_app_id && c.facebook_app_secret),
    });
  }));

  return router;
}

module.exports = { createConfigRouter };
