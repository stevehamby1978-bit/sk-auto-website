'use strict';

// Garavex V2 tenant-safe estimate compatibility preload.
// Intercepts the legacy estimate create/list routes before server.js registers them.
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const express = require('express');

const db = new Database(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bookings.db'));
const originalPost = express.application.post;
const originalGet = express.application.get;

function shopId(req) {
  const id = Number(req.session?.employee?.shop_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function createEstimate(req, res) {
  try {
    const sid = shopId(req);
    if (!sid) return res.status(401).json({ error: 'Not authorized.' });

    const { customer, vehicle, notes, items } = req.body || {};
    const name = String(customer?.name || '').trim();
    const phone = String(customer?.phone || '').trim();
    const email = String(customer?.email || '').trim() || null;

    if (!name || !phone) return res.status(400).json({ error: 'Customer name and phone number are required.' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one estimate item is required.' });

    const normalizedItems = items.map(item => ({
      description: String(item?.description || '').trim(),
      parts: Number(item?.parts || 0),
      labor: Number(item?.labor || 0)
    }));
    if (normalizedItems.some(item => !item.description)) return res.status(400).json({ error: 'Every estimate item needs a description.' });
    if (normalizedItems.some(item => !Number.isFinite(item.parts) || !Number.isFinite(item.labor) || item.parts < 0 || item.labor < 0)) {
      return res.status(400).json({ error: 'Parts and labor must be valid non-negative amounts.' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const tx = db.transaction(() => {
      let existing = db.prepare(`SELECT id FROM customers WHERE phone = ? AND shop_id = ? LIMIT 1`).get(phone, sid);
      let customerId;
      if (existing) {
        customerId = Number(existing.id);
        db.prepare(`UPDATE customers SET name = ?, email = ? WHERE id = ? AND shop_id = ?`).run(name, email, customerId, sid);
      } else {
        const result = db.prepare(`INSERT INTO customers (name, phone, email, shop_id) VALUES (?, ?, ?, ?)`).run(name, phone, email, sid);
        customerId = Number(result.lastInsertRowid);
      }

      const vehicleResult = db.prepare(`
        INSERT INTO vehicles (customer_id, year, make, model, vin, mileage, shop_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        customerId,
        vehicle?.year || null,
        String(vehicle?.make || '').trim() || null,
        String(vehicle?.model || '').trim() || null,
        String(vehicle?.vin || '').trim().toUpperCase() || null,
        vehicle?.mileage || null,
        sid
      );
      const vehicleId = Number(vehicleResult.lastInsertRowid);

      const estimateResult = db.prepare(`
        INSERT INTO estimates (customer_id, vehicle_id, token, notes, shop_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(customerId, vehicleId, token, String(notes || '').trim() || null, sid);
      const estimateId = Number(estimateResult.lastInsertRowid);

      const insertItem = db.prepare(`INSERT INTO estimate_items (estimate_id, description, parts, labor) VALUES (?, ?, ?, ?)`);
      for (const item of normalizedItems) insertItem.run(estimateId, item.description, item.parts, item.labor);
      return estimateId;
    });

    const id = tx();
    return res.status(201).json({ success: true, id, token });
  } catch (err) {
    console.error('V2 create estimate error:', err);
    return res.status(500).json({ error: 'Unable to create estimate.' });
  }
}

function listEstimates(req, res) {
  try {
    const sid = shopId(req);
    if (!sid) return res.status(401).json({ error: 'Not authorized.' });
    const rows = db.prepare(`
      SELECT e.id, e.token, e.status, e.notes, e.created_at,
             c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email,
             v.year AS vehicle_year, v.make AS vehicle_make, v.model AS vehicle_model,
             v.vin AS vehicle_vin, v.mileage AS vehicle_mileage
      FROM estimates e
      LEFT JOIN customers c ON c.id = e.customer_id AND c.shop_id = e.shop_id
      LEFT JOIN vehicles v ON v.id = e.vehicle_id AND v.shop_id = e.shop_id
      WHERE e.shop_id = ?
      ORDER BY e.id DESC
    `).all(sid);
    return res.json(rows);
  } catch (err) {
    console.error('V2 list estimates error:', err);
    return res.status(500).json({ error: 'Unable to retrieve estimates.' });
  }
}

express.application.post = function(route, ...handlers) {
  if (route === '/api/estimates') return originalPost.call(this, route, createEstimate);
  return originalPost.call(this, route, ...handlers);
};

express.application.get = function(route, ...handlers) {
  if (route === '/api/estimates') return originalGet.call(this, route, listEstimates);
  return originalGet.call(this, route, ...handlers);
};
