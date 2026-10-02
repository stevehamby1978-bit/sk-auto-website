'use strict';

/* Garavex application launcher. */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, 'data');
process.env.DATA_DIR = dataDir;
process.env.DATA_Dir = dataDir;
fs.mkdirSync(dataDir, { recursive: true });
console.log(`[V2 STARTUP] database=${path.join(dataDir, 'bookings.db')}`);

function runOptionalOwnerRepair(label, scriptName) {
  try {
    console.log(`[V2 STARTUP] verifying ${label}`);
    execFileSync(process.execPath, [path.join(__dirname, 'scripts', scriptName)], { stdio: 'inherit', env: process.env });
    console.log(`[V2 STARTUP] ${label} verification finished`);
  } catch (err) {
    console.error(`[V2 STARTUP] WARNING: ${label} verification failed; continuing startup without modifying application availability.`);
    console.error(err && err.message ? err.message : err);
  }
}

function runReadOnlyOwnershipAudit() {
  try {
    console.log('[V2 STARTUP] running read-only tenant ownership audit');
    execFileSync(process.execPath, [path.join(__dirname, 'v2-data-ownership-audit.js')], { stdio: 'inherit', env: process.env });
    console.log('[V2 STARTUP] read-only tenant ownership audit finished');
  } catch (err) {
    console.error('[V2 STARTUP] WARNING: read-only ownership audit failed; continuing normal V2 startup.');
    console.error(err && err.message ? err.message : err);
  }
}

if (process.env.V2_REPAIR_OWNER_EMAIL && process.env.V2_REPAIR_OWNER_PASSWORD) runOptionalOwnerRepair('S&K owner', 'v2-login-repair.js');
if (process.env.V2_ZWICKL_OWNER_EMAIL && process.env.V2_ZWICKL_OWNER_PASSWORD) runOptionalOwnerRepair('Zwickl Repair owner', 'v2-zwickl-login-repair.js');
runReadOnlyOwnershipAudit();

require('./v2-auth-preload');
require('./v2-scheduling-preload');
require('./v2-recommendations-preload');
require('./v2-communications-preload');

const serverFilename = path.join(__dirname, 'server.js');
const listenerNeedle = '\napp.listen(PORT, () => {';
const bootstrapMarker = 'installGaravexV2(app, db';
let source = fs.readFileSync(serverFilename, 'utf8');
if (!source.includes(listenerNeedle)) throw new Error('Garavex startup aborted: server.js listener insertion point was not found.');
if (source.includes(bootstrapMarker)) throw new Error('Garavex startup aborted: V2 bootstrap is already wired directly into server.js.');
source = source.replace(/\nsendAppointmentReminders\(\);\s*\n\s*setInterval\(sendAppointmentReminders,\s*15\s*\*\s*60\s*\*\s*1000\);/, '\n// Legacy appointment reminder scheduler disabled by Garavex V2.');

const legacyEstimateMarker = '// ===== S&K AUTO - CREATE ESTIMATE =====';
if (!source.includes(legacyEstimateMarker)) throw new Error('Garavex startup aborted: legacy estimate marker was not found.');
const v2EstimateRoute = `
// ===== GARAVEX V2 TENANT-SAFE CREATE ESTIMATE =====
app.post('/api/estimates', (req, res) => {
  try {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
    const { customer, vehicle, notes, items } = req.body || {};
    if (!customer?.name || !customer?.phone) return res.status(400).json({ error: 'Customer name and phone number are required.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one estimate item is required.' });
    const token = crypto.randomBytes(24).toString('hex');
    const createEstimate = db.transaction(() => {
      let existingCustomer = db.prepare('SELECT id FROM customers WHERE phone = ? AND shop_id = ? LIMIT 1').get(customer.phone.trim(), shopId);
      let customerId;
      if (existingCustomer) {
        customerId = Number(existingCustomer.id);
        db.prepare('UPDATE customers SET name = ?, email = ? WHERE id = ? AND shop_id = ?').run(customer.name.trim(), customer.email ? customer.email.trim() : null, customerId, shopId);
      } else {
        customerId = Number(db.prepare('INSERT INTO customers (name, phone, email, shop_id) VALUES (?, ?, ?, ?)').run(customer.name.trim(), customer.phone.trim(), customer.email ? customer.email.trim() : null, shopId).lastInsertRowid);
      }
      const vehicleId = Number(db.prepare('INSERT INTO vehicles (customer_id, year, make, model, vin, mileage, shop_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(customerId, vehicle?.year || null, vehicle?.make || null, vehicle?.model || null, vehicle?.vin || null, vehicle?.mileage || null, shopId).lastInsertRowid);
      const estimateId = Number(db.prepare('INSERT INTO estimates (customer_id, vehicle_id, token, notes, shop_id) VALUES (?, ?, ?, ?, ?)').run(customerId, vehicleId, token, notes || null, shopId).lastInsertRowid);
      const insertItem = db.prepare('INSERT INTO estimate_items (estimate_id, description, parts, labor) VALUES (?, ?, ?, ?)');
      for (const item of items) {
        const description = String(item?.description || '').trim();
        if (!description) throw new Error('Every estimate item needs a description.');
        const parts = Number(item.parts) || 0;
        const labor = Number(item.labor) || 0;
        if (parts < 0 || labor < 0) throw new Error('Parts and labor cannot be negative.');
        insertItem.run(estimateId, description, parts, labor);
      }
      return estimateId;
    });
    const estimateId = createEstimate();
    console.log('[V2 ESTIMATE] created', { estimateId, shopId });
    return res.status(201).json({ success: true, id: estimateId, token });
  } catch (err) {
    console.error('[V2 ESTIMATE] create failed:', err);
    return res.status(500).json({ error: 'Unable to create estimate.' });
  }
});
// ===== END GARAVEX V2 TENANT-SAFE CREATE ESTIMATE =====
`;
source = source.replace(legacyEstimateMarker, `${v2EstimateRoute}\n${legacyEstimateMarker}`);

// Install V2 repair-order write routes directly before their legacy S&K handlers.
const completeMarker = '// ===== S&K AUTO - MARK REPAIR ORDER COMPLETED =====';
if (!source.includes(completeMarker)) throw new Error('Garavex startup aborted: repair completion marker was not found.');
const v2CompleteRoute = `
// ===== GARAVEX V2 TENANT-SAFE COMPLETE REPAIR ORDER =====
app.patch('/api/repair-orders/:id/complete', (req, res) => {
  try {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Invalid repair order ID.' });
    const order = db.prepare('SELECT id,status,invoice_token FROM repair_orders WHERE id=? AND shop_id=?').get(orderId, shopId);
    if (!order) return res.status(404).json({ error: 'Repair order not found.' });
    if (order.status === 'completed') return res.status(409).json({ error: 'This repair order has already been completed.' });
    let invoiceToken = order.invoice_token;
    db.transaction(() => {
      if (!invoiceToken) {
        invoiceToken = crypto.randomBytes(32).toString('hex');
        db.prepare('UPDATE repair_orders SET invoice_token=? WHERE id=? AND shop_id=?').run(invoiceToken, orderId, shopId);
      }
      db.prepare("UPDATE repair_orders SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=?").run(orderId, shopId);
    })();
    console.log('[V2 COMPLETE] completed', { orderId, shopId });
    return res.json({ success: true, id: orderId, status: 'completed', invoice_token: invoiceToken });
  } catch (err) {
    console.error('[V2 COMPLETE] failed:', err);
    return res.status(500).json({ error: 'Unable to complete repair order.' });
  }
});
// ===== END GARAVEX V2 TENANT-SAFE COMPLETE REPAIR ORDER =====
`;
source = source.replace(completeMarker, `${v2CompleteRoute}\n${completeMarker}`);

const textAuthMarker = "app.post('/api/repair-orders/:repairOrderId/recommendations/:recommendationId/text-authorization'";
if (!source.includes(textAuthMarker)) throw new Error('Garavex startup aborted: recommendation text authorization route was not found.');
const v2TextAuthRoute = `
// ===== GARAVEX V2 TENANT-SAFE RECOMMENDATION NOTIFICATION =====
app.post('/api/repair-orders/:repairOrderId/recommendations/:recommendationId/text-authorization', async (req, res) => {
  try {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    if (!shopId) return res.status(401).json({ error: 'Not authorized.' });
    const orderId = Number(req.params.repairOrderId);
    const recommendationId = Number(req.params.recommendationId);
    const row = db.prepare(\`
      SELECT rr.id,rr.description,rr.parts,rr.labor,rr.authorization_token,
             c.name AS customer_name,c.phone AS customer_phone,
             s.name AS shop_name,s.slug AS shop_slug
      FROM repair_order_recommendations rr
      JOIN repair_orders r ON r.id=rr.repair_order_id
      JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
      JOIN shops s ON s.id=r.shop_id
      WHERE rr.id=? AND rr.repair_order_id=? AND r.shop_id=?
    \`).get(recommendationId, orderId, shopId);
    if (!row) return res.status(404).json({ error: 'Recommended repair not found.' });
    const isSk = String(row.shop_slug || '').toLowerCase() === 'sk-auto';
    if (!isSk) return res.json({ success: true, notification_skipped: true, reason: 'SMS authorization is not configured for this shop.' });
    if (!row.customer_phone) return res.status(400).json({ error: 'Customer phone number is required to text authorization.' });
    const base = process.env.REPAIR_AUTHORIZATION_BASE_URL || 'https://skautohutch.com/repair-authorization.html';
    const url = base + '?order=' + encodeURIComponent(orderId) + '&repair=' + encodeURIComponent(recommendationId) + '&token=' + encodeURIComponent(row.authorization_token || '');
    const total = Number(row.parts || 0) + Number(row.labor || 0);
    await twilioClient.messages.create({
      body: (row.shop_name || 'S&K Auto') + ': Hi ' + (row.customer_name || 'Customer') + ', we recommended: ' + row.description + '. Total: $' + total.toFixed(2) + '. Approve or decline: ' + url,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: row.customer_phone
    });
    return res.json({ success: true, notification_sent: true });
  } catch (err) {
    console.error('[V2 RECOMMENDATION SMS] failed:', err);
    return res.status(500).json({ error: 'Unable to process repair authorization notification.' });
  }
});
// ===== END GARAVEX V2 TENANT-SAFE RECOMMENDATION NOTIFICATION =====
`;
source = source.replace(textAuthMarker, `${v2TextAuthRoute}\n${textAuthMarker}`);

// Add one consistent Dashboard button to authenticated Garavex HTML screens.
// The browser script excludes login/public/customer-facing pages and the dashboard itself.
const globalNavTag = '<script src="/v2-global-navigation.js" defer></script>';
source = source.replace(/res\.sendFile\(path\.join\(__dirname, '([^']+\.html)'\)\);/g, (match, file) => match);

const bootstrap = `
// ===== GARAVEX V2 CENTRALIZED BOOTSTRAP =====
const { installGaravexV2 } = require('./v2-bootstrap');
const { installV2AuthDiagnostic } = require('./v2-auth-diagnostic');
installGaravexV2(app, db, { requireLogin, requireOwner, twilioClient, resend });
installV2AuthDiagnostic(app, db, { requireOwner });
// Inject persistent Dashboard navigation into authenticated HTML responses.
app.use((req, res, next) => {
  if (!req.session?.employee) return next();
  const originalSendFile = res.sendFile.bind(res);
  res.sendFile = function(filePath, options, callback) {
    if (!String(filePath || '').toLowerCase().endsWith('.html')) return originalSendFile(filePath, options, callback);
    try {
      let html = fs.readFileSync(filePath, 'utf8');
      if (!html.includes('/v2-global-navigation.js')) html = html.replace(/<\/body>/i, globalNavTag + '\n</body>');
      return res.type('html').send(html);
    } catch (err) {
      return originalSendFile(filePath, options, callback);
    }
  };
  next();
});
// ===== END GARAVEX V2 CENTRALIZED BOOTSTRAP =====
`;
source = source.replace(listenerNeedle, `${bootstrap}${listenerNeedle}`);
const serverModule = new Module(serverFilename, module);
serverModule.filename = serverFilename;
serverModule.paths = Module._nodeModulePaths(__dirname);
serverModule._compile(source, serverFilename);
