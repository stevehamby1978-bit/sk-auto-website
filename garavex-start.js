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

// Emergency owner-repair scripts are intentionally not run during normal startup.
// They mutate login credentials and were only needed during staging recovery.
// Keep the scripts available for an explicit one-off repair if ever required.
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

// Extend the existing signature-verified Stripe webhook for Garavex subscriptions.
// This insertion happens after server.js has verified the Stripe-Signature against
// the raw request body, so subscription events never bypass webhook verification.
const subscriptionNeedle = `    // Direct charges created on a connected account produce an event.account.\n    // payment_intent.succeeded is the primary event configured for Garavex.\n    if (event.type !== 'payment_intent.succeeded') {\n      return res.json({ received: true, type: event.type });\n    }`;
const subscriptionReplacement = `    // Garavex platform subscription lifecycle events. Signature verification above\n    // is shared with the existing connected-account payment webhook.\n    const { handleGaravexSubscriptionEvent } = require('./v2-subscription-webhook');\n    const subscriptionResult = handleGaravexSubscriptionEvent(db, event);\n    if (subscriptionResult.handled) {\n      console.log('[V2 SUBSCRIPTIONS] webhook', event.type, subscriptionResult);\n      return res.json({ received: true, subscription: true });\n    }\n\n    // Direct charges created on a connected account produce an event.account.\n    // payment_intent.succeeded remains the repair-order payment event.\n    if (event.type !== 'payment_intent.succeeded') {\n      return res.json({ received: true, type: event.type });\n    }`;
if (!source.includes(subscriptionNeedle)) throw new Error('Garavex startup aborted: Stripe webhook insertion point was not found.');
source = source.replace(subscriptionNeedle, subscriptionReplacement);

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

// Recommendation authorization is installed by the dedicated V2 recommendation preload/bootstrap.
// Do not inject another copy into server.js here; keeping one implementation avoids startup syntax conflicts.

const bootstrap = `
// ===== GARAVEX V2 CENTRALIZED BOOTSTRAP =====
const { installGaravexV2 } = require('./v2-bootstrap');
const { installV2AuthDiagnostic } = require('./v2-auth-diagnostic');
installGaravexV2(app, db, { requireLogin, requireOwner, twilioClient, resend, stripe });
installV2AuthDiagnostic(app, db, { requireOwner });
app.use((req, res, next) => {
  if (!req.session?.employee) return next();
  const originalSendFile = res.sendFile.bind(res);
  res.sendFile = function(filePath, options, callback) {
    if (!String(filePath || '').toLowerCase().endsWith('.html')) return originalSendFile(filePath, options, callback);
    try {
      let html = fs.readFileSync(filePath, 'utf8');
      if (!html.includes('/v2-global-navigation.js')) html = html.replace(new RegExp('</body>', 'i'), '<script src="/v2-global-navigation.js" defer></script>\\n</body>');
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
