'use strict';

/* Garavex V2 authenticated communication safety preload.
 * This layer blocks legacy handlers for tenant-owned communication endpoints unless
 * the requested repair order belongs to the logged-in shop. Public S&K website
 * communication routes are intentionally untouched.
 */
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'appointments.db');
const db = new Database(dbPath);
const originalPost = express.application.post;
const installed = new WeakSet();

const protectedRoutes = new Set([
  '/api/repair-orders/:id/email-invoice',
  '/api/repair-orders/:id/payments/:paymentId/email-receipt'
]);

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

function install(app) {
  if (installed.has(app)) return;
  installed.add(app);

  // These guards intentionally call next() so the existing mature email rendering
  // remains in server.js while tenant ownership is enforced before it can execute.
  originalPost.call(app, '/api/repair-orders/:id/email-invoice', (req, res, next) => {
    const shopId = sid(req);
    const orderId = id(req.params.id);
    if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
    if (!orderId || !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
    next();
  });

  originalPost.call(app, '/api/repair-orders/:id/payments/:paymentId/email-receipt', (req, res, next) => {
    const shopId = sid(req);
    const orderId = id(req.params.id);
    const paymentId = id(req.params.paymentId);
    if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
    if (!orderId || !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
    if (!paymentId || !ownsPayment(paymentId, orderId, shopId)) return res.status(404).json({ error: 'Payment not found.' });
    next();
  });
}

express.application.post = function(route, ...handlers) {
  if (!installed.has(this)) install(this);
  // Keep the legacy handler after our guard: Express will reach it only after next().
  return originalPost.call(this, route, ...handlers);
};

module.exports = { installV2CommunicationSafety: install };
