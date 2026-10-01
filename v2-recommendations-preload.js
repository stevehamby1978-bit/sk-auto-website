'use strict';

/*
 * Garavex V2 recommendation tenant-safety preload.
 * Loaded before server.js so these authenticated handlers win route precedence.
 * Public customer authorization-token routes remain owned by server.js.
 */
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');

const dbPath = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'appointments.db');
const db = new Database(dbPath);
const originalGet = express.application.get;
const originalDelete = express.application.delete;
const originalPatch = express.application.patch;
const protectedRoutes = new Set([
  'GET /api/repair-orders/:id/recommendations',
  'DELETE /api/repair-orders/:repairOrderId/recommendations/:recommendationId',
  'PATCH /api/repair-orders/:repairOrderId/recommendations/:recommendationId/approve',
  'PATCH /api/repair-orders/:repairOrderId/recommendations/:recommendationId/decline'
]);
const installed = new WeakSet();

function shopId(req) { return Number(req.session?.employee?.shop_id || 0); }
function positiveId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function ownedOrder(id, sid) {
  return db.prepare('SELECT id, status, amount_paid FROM repair_orders WHERE id=? AND shop_id=?').get(id, sid);
}
function ownedRecommendation(orderId, recommendationId, sid) {
  return db.prepare(`
    SELECT rr.id, rr.repair_order_id, rr.description, rr.parts, rr.labor, rr.status, rr.created_at
    FROM repair_order_recommendations rr
    JOIN repair_orders r ON r.id=rr.repair_order_id
    WHERE rr.id=? AND rr.repair_order_id=? AND r.shop_id=?
  `).get(recommendationId, orderId, sid);
}
function auth(req, res) {
  const sid = shopId(req);
  if (!sid) { res.status(401).json({ error: 'Not authorized.' }); return 0; }
  return sid;
}

function install(app) {
  if (installed.has(app)) return;
  installed.add(app);

  originalGet.call(app, '/api/repair-orders/:id/recommendations', (req, res) => {
    try {
      const sid = auth(req, res); if (!sid) return;
      const orderId = positiveId(req.params.id);
      if (!orderId || !ownedOrder(orderId, sid)) return res.status(404).json({ error: 'Repair order not found.' });
      const rows = db.prepare(`
        SELECT rr.id,rr.repair_order_id,rr.description,rr.parts,rr.labor,rr.status,rr.created_at
        FROM repair_order_recommendations rr
        JOIN repair_orders r ON r.id=rr.repair_order_id
        WHERE rr.repair_order_id=? AND r.shop_id=?
        ORDER BY rr.id ASC
      `).all(orderId, sid);
      res.json(rows);
    } catch (err) {
      console.error('V2 get recommended repairs error:', err);
      res.status(500).json({ error: 'Unable to load recommended repairs.' });
    }
  });

  originalDelete.call(app, '/api/repair-orders/:repairOrderId/recommendations/:recommendationId', (req, res) => {
    try {
      const sid = auth(req, res); if (!sid) return;
      const orderId = positiveId(req.params.repairOrderId), recommendationId = positiveId(req.params.recommendationId);
      if (!orderId || !recommendationId || !ownedRecommendation(orderId, recommendationId, sid)) return res.status(404).json({ error: 'Recommended repair not found.' });
      const result = db.prepare(`DELETE FROM repair_order_recommendations WHERE id=? AND repair_order_id=?`).run(recommendationId, orderId);
      if (result.changes !== 1) return res.status(404).json({ error: 'Recommended repair not found.' });
      res.json({ success: true });
    } catch (err) {
      console.error('V2 delete recommended repair error:', err);
      res.status(500).json({ error: 'Unable to delete recommended repair.' });
    }
  });

  originalPatch.call(app, '/api/repair-orders/:repairOrderId/recommendations/:recommendationId/approve', (req, res) => {
    try {
      const sid = auth(req, res); if (!sid) return;
      const orderId = positiveId(req.params.repairOrderId), recommendationId = positiveId(req.params.recommendationId);
      const order = orderId && ownedOrder(orderId, sid);
      if (!order) return res.status(404).json({ error: 'Repair order not found.' });
      if (order.status === 'completed' || Number(order.amount_paid || 0) > 0) return res.status(409).json({ error: 'Completed or paid repair orders cannot be edited.' });
      const recommendation = ownedRecommendation(orderId, recommendationId, sid);
      if (!recommendation) return res.status(404).json({ error: 'Recommended repair not found.' });
      if (String(recommendation.status || '').toLowerCase() !== 'pending') return res.status(409).json({ error: 'This recommended repair has already been processed.' });
      const result = db.transaction(() => {
        const item = db.prepare(`INSERT INTO repair_order_items(repair_order_id,description,parts,labor) VALUES(?,?,?,?)`).run(orderId, recommendation.description, Number(recommendation.parts)||0, Number(recommendation.labor)||0);
        const changed = db.prepare(`UPDATE repair_order_recommendations SET status='approved' WHERE id=? AND repair_order_id=? AND status='pending'`).run(recommendationId, orderId);
        if (changed.changes !== 1) throw new Error('Recommendation status changed before approval completed.');
        return item.lastInsertRowid;
      })();
      res.json({ success: true, message: 'Recommended repair approved and added to repair order.', itemId: result });
    } catch (err) {
      console.error('V2 approve recommended repair error:', err);
      res.status(500).json({ error: 'Unable to approve recommended repair.' });
    }
  });

  originalPatch.call(app, '/api/repair-orders/:repairOrderId/recommendations/:recommendationId/decline', (req, res) => {
    try {
      const sid = auth(req, res); if (!sid) return;
      const orderId = positiveId(req.params.repairOrderId), recommendationId = positiveId(req.params.recommendationId);
      if (!orderId || !recommendationId || !ownedOrder(orderId, sid)) return res.status(404).json({ error: 'Repair order not found.' });
      const recommendation = ownedRecommendation(orderId, recommendationId, sid);
      if (!recommendation) return res.status(404).json({ error: 'Recommended repair not found.' });
      if (String(recommendation.status || '').toLowerCase() !== 'pending') return res.status(409).json({ error: 'This recommended repair has already been processed.' });
      const result = db.prepare(`UPDATE repair_order_recommendations SET status='declined' WHERE id=? AND repair_order_id=? AND status='pending'`).run(recommendationId, orderId);
      if (result.changes !== 1) return res.status(409).json({ error: 'This recommended repair has already been processed.' });
      res.json({ success: true, message: 'Recommended repair declined.' });
    } catch (err) {
      console.error('V2 decline recommended repair error:', err);
      res.status(500).json({ error: 'Unable to decline recommended repair.' });
    }
  });
}

function intercept(method, original) {
  express.application[method] = function(route, ...handlers) {
    if (!installed.has(this)) install(this);
    const key = `${method.toUpperCase()} ${route}`;
    if (protectedRoutes.has(key)) return this;
    return original.call(this, route, ...handlers);
  };
}
intercept('get', originalGet);
intercept('delete', originalDelete);
intercept('patch', originalPatch);

module.exports = { installV2RecommendationSafety: install };
