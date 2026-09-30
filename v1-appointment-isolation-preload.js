/* Garavex V1 appointment tenant-isolation hotfix.
 * Loaded before server.js so legacy appointment routes cannot expose or mutate
 * bookings owned by another shop. Remove once the legacy routes are rewritten
 * with native shop_id predicates.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const express = require('express');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'bookings.db'));

function shopId(req) {
  const id = Number(req.session?.employee?.shop_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function appointmentGuard(req, res, next) {
  const sid = shopId(req);
  if (!sid) return res.status(401).json({ error: 'Not authorized.' });

  const id = Number(req.params?.id);
  if (req.method !== 'GET') {
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid appointment ID.' });
    }
    const owned = db.prepare('SELECT id FROM bookings WHERE id = ? AND shop_id = ? LIMIT 1').get(id, sid);
    if (!owned) return res.status(404).json({ error: 'Appointment not found.' });
    return next();
  }

  // The legacy GET handler currently selects all bookings. Filter its JSON
  // response at the route boundary so only this session's shop can leave API.
  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (Array.isArray(payload)) {
      payload = payload.filter(row => Number(row?.shop_id) === sid);
    }
    return originalJson(payload);
  };
  next();
}

const originalGet = express.application.get;
const originalDelete = express.application.delete;
const originalPatch = express.application.patch;

express.application.get = function(pathname, ...handlers) {
  if (pathname === '/api/appointments') handlers.unshift(appointmentGuard);
  return originalGet.call(this, pathname, ...handlers);
};
express.application.delete = function(pathname, ...handlers) {
  if (pathname === '/api/appointments/:id') handlers.unshift(appointmentGuard);
  return originalDelete.call(this, pathname, ...handlers);
};
express.application.patch = function(pathname, ...handlers) {
  if (pathname === '/api/appointments/:id' || pathname === '/api/appointments/:id/status') {
    handlers.unshift(appointmentGuard);
  }
  return originalPatch.call(this, pathname, ...handlers);
};
