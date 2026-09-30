const { permissionMiddleware } = require('./v2-permissions');

function installV2Quality(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 quality requires app and db.');
  if (!requireLogin) throw new Error('V2 quality requires login middleware.');

  const requireRepairOrders = permissionMiddleware('repair_orders');
  const validId = value => Number.isInteger(value) && value > 0;
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const shopId = req => Number(req.session?.employee?.shop_id || 0);
  const employeeId = req => Number(req.session?.employee?.id || 0);

  function audit(req, action, id, details) {
    db.prepare(`
      INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)
      VALUES(?,?,?,?,?,?)
    `).run(shopId(req), employeeId(req), action, 'repair_order', id, JSON.stringify(details || {}));
  }

  function checksFor(shop, id) {
    const ro = db.prepare(`
      SELECT r.id,r.status,r.workflow_status,r.customer_concern,r.technician_diagnosis,
             r.customer_id,r.vehicle_id,c.name customer_name,
             v.year,v.make,v.model,v.mileage
      FROM repair_orders r
      JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
      LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
      WHERE r.id=? AND r.shop_id=?
    `).get(id, shop);
    if (!ro) return null;

    const itemCount = Number(db.prepare(`
      SELECT COUNT(*) n FROM repair_order_items i
      JOIN repair_orders r ON r.id=i.repair_order_id
      WHERE i.repair_order_id=? AND r.shop_id=?
    `).get(id, shop)?.n || 0);
    const openTime = Number(db.prepare(`
      SELECT COUNT(*) n FROM technician_time_entries
      WHERE shop_id=? AND repair_order_id=? AND clock_out IS NULL
    `).get(shop, id)?.n || 0);
    const dvi = db.prepare(`
      SELECT id,status FROM dvi_inspections
      WHERE shop_id=? AND repair_order_id=?
      ORDER BY id DESC LIMIT 1
    `).get(shop, id);

    const checks = [
      { key: 'customer_concern', label: 'Customer concern documented', ok: Boolean(String(ro.customer_concern || '').trim()) },
      { key: 'mileage', label: 'Vehicle mileage recorded', ok: Boolean(String(ro.mileage || '').trim()) },
      { key: 'line_items', label: 'Repair order has line items', ok: itemCount > 0 },
      { key: 'diagnosis', label: 'Technician diagnosis documented', ok: Boolean(String(ro.technician_diagnosis || '').trim()) },
      { key: 'technician_time', label: 'No technician clock still running', ok: openTime === 0 },
      { key: 'inspection', label: 'Digital inspection completed or intentionally skipped', ok: !dvi || ['completed','sent','approved'].includes(String(dvi.status || '').toLowerCase()) }
    ];

    const addCountCheck = (key, table, where, label) => {
      if (!tableExists(table)) return;
      const n = Number(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE shop_id=? AND repair_order_id=? AND ${where}`).get(shop, id)?.n || 0);
      checks.push({ key, label, ok: n === 0, count: n });
    };

    addCountCheck('blockers', 'v2_ro_blockers', "status='open'", 'No open workflow blockers');
    addCountCheck('parts', 'v2_parts_requests', "status IN ('requested','ordered')", 'No requested or ordered parts outstanding');
    addCountCheck('road_test', 'v2_road_tests', "status='in_progress'", 'No road test still in progress');
    addCountCheck('customer_approval', 'v2_customer_requests', "status='open' AND request_type='approval'", 'No customer approval request outstanding');
    addCountCheck('loaner', 'v2_loaner_assignments', 'returned_at IS NULL', 'No loaner vehicle still checked out');

    if (tableExists('v2_road_tests')) {
      const latest = db.prepare(`
        SELECT result FROM v2_road_tests
        WHERE shop_id=? AND repair_order_id=? AND completed_at IS NOT NULL
        ORDER BY datetime(completed_at) DESC,id DESC LIMIT 1
      `).get(shop, id);
      checks.push({ key: 'road_test_result', label: 'Latest road test did not fail', ok: String(latest?.result || '').toLowerCase() !== 'failed' });
    }

    if (tableExists('v2_vehicle_keys')) {
      const key = db.prepare(`SELECT status FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(shop, id);
      checks.push({ key: 'vehicle_key', label: 'Vehicle key accounted for', ok: String(key?.status || '').toLowerCase() !== 'missing' });
    }

    return { ro, checks };
  }

  app.get('/api/v2/repair-orders/:id/quality', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const shop = shopId(req), id = Number(req.params.id);
      if (!validId(shop)) return res.status(401).json({ error: 'A valid shop session is required.' });
      if (!validId(id)) return res.status(400).json({ error: 'Valid repair order ID is required.' });
      const result = checksFor(shop, id);
      if (!result) return res.status(404).json({ error: 'Repair order not found.' });
      const blocking = result.checks.filter(check => !check.ok);
      return res.json({ ...result.ro, checks: result.checks, blocking, blocking_count: blocking.length, ready: blocking.length === 0 });
    } catch (err) {
      console.error('Garavex V2 quality check error:', err);
      return res.status(500).json({ error: 'Unable to run final quality checks.' });
    }
  });

  app.post('/api/v2/repair-orders/:id/quality/approve', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const shop = shopId(req), employee = employeeId(req), id = Number(req.params.id);
      if (!validId(shop) || !validId(employee)) return res.status(401).json({ error: 'A valid employee shop session is required.' });
      if (!validId(id)) return res.status(400).json({ error: 'Valid repair order ID is required.' });

      const result = checksFor(shop, id);
      if (!result) return res.status(404).json({ error: 'Repair order not found.' });
      if (String(result.ro.workflow_status || '').toLowerCase() === 'delivered') return res.status(409).json({ error: 'Delivered repair orders cannot be quality-approved again.' });
      const blocking = result.checks.filter(check => !check.ok);
      if (blocking.length) return res.status(409).json({ error: 'Final quality cannot be approved until all required checks pass.', checks: result.checks, blocking });

      const note = String(req.body?.note || '').trim().slice(0, 2000);
      const previous = result.ro.workflow_status;
      const tx = db.transaction(() => {
        const changed = db.prepare(`
          UPDATE repair_orders SET workflow_status='ready'
          WHERE id=? AND shop_id=? AND COALESCE(workflow_status,'')=COALESCE(?, '')
        `).run(id, shop, previous);
        if (changed.changes !== 1) throw new Error('Repair order changed before quality approval could be saved.');
        audit(req, 'quality.approved', id, { note, previous_workflow_status: previous, checks: result.checks.map(check => check.key) });
      });
      tx();
      return res.json({ ok: true, workflow_status: 'ready', checks: result.checks });
    } catch (err) {
      console.error('Garavex V2 quality approval error:', err);
      return res.status(409).json({ error: 'Final quality approval could not be saved because the repair order changed or a requirement was not satisfied.' });
    }
  });
}

module.exports = { installV2Quality };
