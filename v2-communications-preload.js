'use strict';

/* Garavex V2 authenticated communication safety preload.
 * Legacy S&K-branded communication handlers are allowed only for the S&K shop.
 * Tenant ownership is verified before any legacy communication handler can run.
 */
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bookings.db');
const db = new Database(dbPath);
const originalPost = express.application.post;
const originalPatch = express.application.patch;
const installed = new WeakSet();
const protectedRoutes = new Set();

function sid(req) { return Number(req.session?.employee?.shop_id || 0); }
function id(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function ownsOrder(orderId, shopId) { return db.prepare('SELECT id FROM repair_orders WHERE id=? AND shop_id=?').get(orderId, shopId); }
function ownsPayment(paymentId, orderId, shopId) { return db.prepare('SELECT p.id FROM repair_order_payments p JOIN repair_orders r ON r.id=p.repair_order_id WHERE p.id=? AND p.repair_order_id=? AND r.shop_id=?').get(paymentId, orderId, shopId); }
function ownsRecommendation(recommendationId, orderId, shopId) { return db.prepare('SELECT rr.id FROM repair_order_recommendations rr JOIN repair_orders r ON r.id=rr.repair_order_id WHERE rr.id=? AND rr.repair_order_id=? AND r.shop_id=?').get(recommendationId, orderId, shopId); }
function isSkAuto(shopId) {
  if (!shopId) return false;
  const shop = db.prepare('SELECT name, slug FROM shops WHERE id=? AND active=1').get(shopId);
  if (!shop) return false;
  return String(shop.slug || '').trim().toLowerCase() === 'sk-auto' || String(shop.name || '').trim().toLowerCase() === 's&k auto';
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

  protectedRoutes.add('POST /api/estimates/:token/respond');
  originalPost.call(app, '/api/estimates/:token/respond', async (req, res) => {
    try {
      const status = String(req.body?.status || '').toLowerCase();
      if (!['approved', 'declined'].includes(status)) return res.status(400).json({ error: 'Status must be approved or declined.' });
      const token = String(req.params.token || '').trim();
      const estimate = db.prepare('SELECT e.id,e.customer_id,e.vehicle_id,e.status,e.shop_id,c.name AS customer_name,v.year AS vehicle_year,v.make AS vehicle_make,v.model AS vehicle_model FROM estimates e LEFT JOIN customers c ON c.id=e.customer_id AND c.shop_id=e.shop_id LEFT JOIN vehicles v ON v.id=e.vehicle_id AND v.shop_id=e.shop_id WHERE e.token=?').get(token);
      if (!estimate) return res.status(404).json({ error: 'Estimate not found.' });
      if (!estimate.shop_id) return res.status(409).json({ error: 'Estimate is missing shop ownership.' });
      if (estimate.status !== 'pending') return res.status(400).json({ error: 'This estimate has already been responded to.' });
      let repairOrderId = null;
      db.transaction(() => {
        const changed = db.prepare("UPDATE estimates SET status=?,responded_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status='pending'").run(status, estimate.id, estimate.shop_id);
        if (changed.changes !== 1) throw new Error('Estimate response changed before update completed.');
        if (status === 'approved') {
          const existing = db.prepare('SELECT id FROM repair_orders WHERE estimate_id=? AND shop_id=?').get(estimate.id, estimate.shop_id);
          if (existing) repairOrderId = Number(existing.id);
          else {
            const created = db.prepare("INSERT INTO repair_orders(estimate_id,customer_id,vehicle_id,status,shop_id) VALUES(?,?,?,'waiting',?)").run(estimate.id, estimate.customer_id, estimate.vehicle_id, estimate.shop_id);
            repairOrderId = Number(created.lastInsertRowid);
            const items = db.prepare('SELECT description,parts,labor FROM estimate_items WHERE estimate_id=? ORDER BY id').all(estimate.id);
            const insert = db.prepare('INSERT INTO repair_order_items(repair_order_id,description,parts,labor) VALUES(?,?,?,?)');
            for (const item of items) insert.run(repairOrderId, item.description, Number(item.parts)||0, Number(item.labor)||0);
          }
        }
      })();
      res.json({ success: true, status, repair_order_id: repairOrderId });
    } catch (err) { console.error('V2 estimate response error:', err); res.status(500).json({ error: 'Unable to update estimate.' }); }
  });

  // Recommendation authorization is tenant-safe. Non-S&K shops keep the generated
  // customer authorization link but skip the S&K Twilio sender instead of failing.
  protectedRoutes.add('POST /api/repair-orders/:repairOrderId/recommendations/:recommendationId/text-authorization');
  originalPost.call(app, '/api/repair-orders/:repairOrderId/recommendations/:recommendationId/text-authorization', (req, res, next) => {
    const shopId = sid(req);
    if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
    const orderId = id(req.params.repairOrderId), recommendationId = id(req.params.recommendationId);
    if (!orderId || !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
    if (!recommendationId || !ownsRecommendation(recommendationId, orderId, shopId)) return res.status(404).json({ error: 'Recommended repair not found.' });
    if (!isSkAuto(shopId)) return res.json({ success: true, notification_skipped: true, message: 'Recommendation saved. Customer authorization link created; SMS is not configured for this shop.' });
    next();
  });

  for (const route of ['/api/repair-orders/:id/text-invoice','/api/text-invoice','/api/text-authorization']) {
    originalPost.call(app, route, (req, res, next) => {
      const shopId = requireSk(req, res); if (!shopId) return;
      const orderId = id(req.params.id || req.params.repairOrderId);
      if (orderId && !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
      next();
    });
  }

  protectedRoutes.add('PATCH /api/repair-orders/:id/authorization');
  originalPatch.call(app, '/api/repair-orders/:id/authorization', (req, res) => {
    try {
      const shopId = sid(req); if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
      const orderId = id(req.params.id); if (!orderId || !ownsOrder(orderId, shopId)) return res.status(404).json({ error: 'Repair order not found.' });
      const authorizedBy = String(req.body?.authorized_by || '').trim(), method = String(req.body?.authorization_method || ''), notes = typeof req.body?.authorization_notes === 'string' ? req.body.authorization_notes.trim() : '';
      if (!authorizedBy) return res.status(400).json({ error: 'Authorized by is required.' });
      if (!['in_person','phone','text','email'].includes(method)) return res.status(400).json({ error: 'Please select a valid authorization method.' });
      const authorizedAt = new Date().toISOString();
      db.prepare('UPDATE repair_orders SET authorized_by=?,authorization_method=?,authorization_notes=?,authorized_at=? WHERE id=? AND shop_id=?').run(authorizedBy, method, notes, authorizedAt, orderId, shopId);
      res.json({ success: true, authorized_by: authorizedBy, authorization_method: method, authorization_notes: notes, authorized_at: authorizedAt });
    } catch (err) { res.status(500).json({ error: 'Unable to save customer authorization.' }); }
  });

  originalPatch.call(app, '/api/repair-orders/:id/complete', (req, res, next) => {
    try {
      const shopId = sid(req); if (!shopId) return res.status(401).json({ error: 'You must be signed in to complete a repair order.' });
      if (isSkAuto(shopId)) return next();
      const orderId = id(req.params.id); if (!orderId) return res.status(400).json({ error: 'Invalid repair order ID.' });
      const ro = db.prepare('SELECT id,status FROM repair_orders WHERE id=? AND shop_id=?').get(orderId, shopId);
      if (!ro) return res.status(404).json({ error: 'Repair order not found.' });
      if (ro.status === 'completed') return res.status(409).json({ error: 'This repair order has already been completed.' });
      db.transaction(() => { db.prepare("UPDATE repair_orders SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=?").run(orderId, shopId); const row=db.prepare('SELECT invoice_token FROM repair_orders WHERE id=? AND shop_id=?').get(orderId,shopId); if(!row?.invoice_token){const crypto=require('crypto');db.prepare('UPDATE repair_orders SET invoice_token=? WHERE id=? AND shop_id=?').run(crypto.randomBytes(32).toString('hex'),orderId,shopId);} })();
      return res.json({ success: true, status: 'completed', message: 'Repair order marked completed.' });
    } catch (err) { return res.status(500).json({ error: 'Unable to complete repair order.' }); }
  });
}

function shouldSuppress(method, route) { return protectedRoutes.has(`${method} ${route}`); }
express.application.post = function(route, ...handlers) { if (!installed.has(this)) install(this); if (shouldSuppress('POST', route)) return this; return originalPost.call(this, route, ...handlers); };
express.application.patch = function(route, ...handlers) { if (!installed.has(this)) install(this); if (shouldSuppress('PATCH', route)) return this; return originalPatch.call(this, route, ...handlers); };
module.exports = { installV2CommunicationSafety: install };
