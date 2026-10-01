'use strict';

/* Garavex V2 authenticated communication safety preload.
 * Legacy S&K-branded communication handlers are allowed only for the S&K shop.
 * Tenant ownership is verified before any legacy communication handler can run.
 */
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'appointments.db');
const db = new Database(dbPath);
const originalPost = express.application.post;
const originalPatch = express.application.patch;
const installed = new WeakSet();

function sid(req) { return Number(req.session?.employee?.shop_id || 0); }
function id(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function ownsOrder(orderId, shopId) {
  return db.prepare('SELECT id FROM repair_orders WHERE id=? AND shop_id=?').get(orderId, shopId);
}
function ownsPayment(paymentId, orderId, shopId) {
  return db.prepare(`
    SELECT p.id
    FROM repair_order_payments p
    JOIN repair_orders r ON r.id=p.repair_order_id
    WHERE p.id=? AND p.repair_order_id=? AND r.shop_id=?
  `).get(paymentId, orderId, shopId);
}
function isSkAuto(shopId) {
  if (!shopId) return false;
  const shop = db.prepare('SELECT name, slug FROM shops WHERE id=? AND active=1').get(shopId);
  if (!shop) return false;
  return String(shop.slug || '').trim().toLowerCase() === 'sk-auto' ||
    String(shop.name || '').trim().toLowerCase() === 's&k auto';
}
function requireSk(req, res) {
  const shopId = sid(req);
  if (!shopId) { res.status(401).json({ error: 'Not authorized.' }); return 0; }
  if (!isSkAuto(shopId)) { res.status(403).json({ error: 'This S&K communication service is not enabled for this shop.' }); return 0; }
  return shopId;
}

function install(app) {
  if (installed.has(app)) return;
  installed.add(app);

  // Keep mature S&K rendering, but only after ownership + S&K-shop checks.
  originalPost.call(app, '/api/repair-orders/:id/email-invoice', (req, res, next) => {
    const shopId = requireSk(req, res); if (!shopId) return;
    const orderId = id(req.params.id);
    if (!orderId || !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
    next();
  });

  originalPost.call(app, '/api/repair-orders/:id/payments/:paymentId/email-receipt', (req, res, next) => {
    const shopId = requireSk(req, res); if (!shopId) return;
    const orderId = id(req.params.id), paymentId = id(req.params.paymentId);
    if (!orderId || !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
    if (!paymentId || !ownsPayment(paymentId, orderId, shopId)) return res.status(404).json({ error: 'Payment not found.' });
    next();
  });

  // Legacy estimate creation immediately sends S&K-branded Twilio messages and
  // builds skautohutch.com customer links, so it must never run for another tenant.
  originalPost.call(app, '/api/estimates', (req, res, next) => {
    const shopId = requireSk(req, res); if (!shopId) return;
    next();
  });

  // All legacy Twilio endpoints below use S&K's account/branding and therefore stay S&K-only.
  for (const route of [
    '/api/repair-orders/:id/text-invoice',
    '/api/repair-orders/:repairOrderId/recommendations/:recommendationId/text-authorization',
    '/api/text-invoice',
    '/api/text-authorization'
  ]) {
    originalPost.call(app, route, (req, res, next) => {
      const shopId = requireSk(req, res); if (!shopId) return;
      const orderId = id(req.params.id || req.params.repairOrderId);
      if (orderId && !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
      next();
    });
  }

  // Completion itself remains available to every tenant. For non-S&K shops we perform
  // the tenant-safe completion here and intentionally do not fall through to the legacy
  // handler, because that handler sends S&K's automatic vehicle-ready Twilio message.
  originalPatch.call(app, '/api/repair-orders/:id/complete', (req, res, next) => {
    try {
      const shopId = sid(req);
      if (!shopId) return res.status(401).json({ error: 'You must be signed in to complete a repair order.' });
      if (isSkAuto(shopId)) return next();
      const orderId = id(req.params.id);
      if (!orderId) return res.status(400).json({ error: 'Invalid repair order ID.' });
      const ro = db.prepare('SELECT id,status FROM repair_orders WHERE id=? AND shop_id=?').get(orderId, shopId);
      if (!ro) return res.status(404).json({ error: 'Repair order not found.' });
      if (ro.status === 'completed') return res.status(409).json({ error: 'This repair order has already been completed.' });
      const tx = db.transaction(() => {
        db.prepare("UPDATE repair_orders SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=?").run(orderId, shopId);
        const row = db.prepare('SELECT invoice_token FROM repair_orders WHERE id=? AND shop_id=?').get(orderId, shopId);
        if (!row?.invoice_token) {
          const crypto = require('crypto');
          db.prepare('UPDATE repair_orders SET invoice_token=? WHERE id=? AND shop_id=?').run(crypto.randomBytes(32).toString('hex'), orderId, shopId);
        }
      });
      tx();
      return res.json({ success: true, status: 'completed', message: 'Repair order marked completed.' });
    } catch (err) {
      console.error('V2 non-S&K completion guard failed:', err);
      return res.status(500).json({ error: 'Unable to complete repair order.' });
    }
  });
}

express.application.post = function(route, ...handlers) {
  if (!installed.has(this)) install(this);
  return originalPost.call(this, route, ...handlers);
};
express.application.patch = function(route, ...handlers) {
  if (!installed.has(this)) install(this);
  return originalPatch.call(this, route, ...handlers);
};

module.exports = { installV2CommunicationSafety: install };
