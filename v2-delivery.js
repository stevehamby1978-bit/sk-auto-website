const { permissionMiddleware } = require('./v2-permissions');

function installV2Delivery(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 delivery requires app and db.');
  if (!requireLogin) throw new Error('V2 delivery requires login middleware.');

  const requireDelivery = permissionMiddleware('delivery');
  const validId = value => Number.isInteger(value) && value > 0;
  const shopId = req => Number(req.session?.employee?.shop_id || 0);
  const employeeId = req => Number(req.session?.employee?.id || 0);
  const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const flag = value => value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_deliveries(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      repair_order_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      customer_notified INTEGER NOT NULL DEFAULT 0,
      keys_returned INTEGER NOT NULL DEFAULT 0,
      old_parts_returned INTEGER NOT NULL DEFAULT 0,
      documents_given INTEGER NOT NULL DEFAULT 0,
      next_service_explained INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      delivered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id,repair_order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_deliveries_shop ON v2_deliveries(shop_id,delivered_at);
  `);

  function session(req, res) {
    const s = shopId(req), e = employeeId(req);
    if (!validId(s) || !validId(e)) {
      res.status(401).json({ error: 'A valid employee shop session is required.' });
      return null;
    }
    return { s, e };
  }

  app.get('/api/v2/deliveries', requireLogin, requireDelivery, (req, res) => {
    try {
      const auth = session(req, res); if (!auth) return;
      const rows = db.prepare(`
        SELECT d.*, c.name customer_name, v.year, v.make, v.model
        FROM v2_deliveries d
        JOIN repair_orders r ON r.id=d.repair_order_id AND r.shop_id=d.shop_id
        JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        WHERE d.shop_id=?
        ORDER BY d.delivered_at IS NULL DESC, d.updated_at DESC, d.id DESC
        LIMIT 100
      `).all(auth.s);
      return res.json(rows);
    } catch (err) {
      console.error('Garavex V2 deliveries list error:', err);
      return res.status(500).json({ error: 'Unable to load deliveries.' });
    }
  });

  app.put('/api/v2/repair-orders/:id/delivery', requireLogin, requireDelivery, (req, res) => {
    try {
      const auth = session(req, res); if (!auth) return;
      const ro = Number(req.params.id);
      if (!validId(ro)) return res.status(400).json({ error: 'Valid repair order ID is required.' });

      const order = db.prepare(`SELECT id,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(ro, auth.s);
      if (!order) return res.status(404).json({ error: 'Repair order not found.' });
      if (String(order.workflow_status || '').toLowerCase() === 'delivered') return res.status(409).json({ error: 'Delivery is already complete and cannot be edited.' });

      const existing = db.prepare(`SELECT delivered_at FROM v2_deliveries WHERE shop_id=? AND repair_order_id=?`).get(auth.s, ro);
      if (existing?.delivered_at) return res.status(409).json({ error: 'Delivery is already complete and cannot be edited.' });

      db.prepare(`
        INSERT INTO v2_deliveries(
          shop_id,repair_order_id,employee_id,customer_notified,keys_returned,
          old_parts_returned,documents_given,next_service_explained,notes
        ) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(shop_id,repair_order_id) DO UPDATE SET
          employee_id=excluded.employee_id,
          customer_notified=excluded.customer_notified,
          keys_returned=excluded.keys_returned,
          old_parts_returned=excluded.old_parts_returned,
          documents_given=excluded.documents_given,
          next_service_explained=excluded.next_service_explained,
          notes=excluded.notes,
          updated_at=CURRENT_TIMESTAMP
      `).run(
        auth.s, ro, auth.e,
        flag(req.body?.customer_notified), flag(req.body?.keys_returned),
        flag(req.body?.old_parts_returned), flag(req.body?.documents_given),
        flag(req.body?.next_service_explained), String(req.body?.notes || '').trim().slice(0, 2000)
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('Garavex V2 delivery checklist error:', err);
      return res.status(500).json({ error: 'Unable to save the delivery checklist.' });
    }
  });

  app.patch('/api/v2/repair-orders/:id/delivery/complete', requireLogin, requireDelivery, (req, res) => {
    try {
      const auth = session(req, res); if (!auth) return;
      const ro = Number(req.params.id);
      if (!validId(ro)) return res.status(400).json({ error: 'Valid repair order ID is required.' });

      const order = db.prepare(`SELECT id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(ro, auth.s);
      if (!order) return res.status(404).json({ error: 'Repair order not found.' });
      if (String(order.workflow_status || '').toLowerCase() === 'delivered') return res.status(409).json({ error: 'Vehicle has already been delivered.' });

      const delivery = db.prepare(`SELECT * FROM v2_deliveries WHERE shop_id=? AND repair_order_id=?`).get(auth.s, ro);
      if (!delivery) return res.status(404).json({ error: 'Delivery checklist not started.' });
      if (delivery.delivered_at) return res.status(409).json({ error: 'Vehicle has already been delivered.' });

      const missing = [];
      if (!delivery.keys_returned) missing.push('Return customer keys');
      if (!delivery.documents_given) missing.push('Provide invoice/documents');
      if (String(order.workflow_status || '').toLowerCase() !== 'ready') missing.push('Repair order must be in ready status');
      if (has('v2_ro_blockers') && db.prepare(`SELECT 1 FROM v2_ro_blockers WHERE shop_id=? AND repair_order_id=? AND status='open' LIMIT 1`).get(auth.s, ro)) missing.push('Resolve open workflow blockers');
      if (has('v2_parts_requests') && db.prepare(`SELECT 1 FROM v2_parts_requests WHERE shop_id=? AND repair_order_id=? AND status IN ('requested','ordered') LIMIT 1`).get(auth.s, ro)) missing.push('Resolve requested or ordered parts');
      if (has('v2_road_tests') && db.prepare(`SELECT 1 FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND status='in_progress' LIMIT 1`).get(auth.s, ro)) missing.push('Complete road test');
      if (has('v2_vehicle_keys') && db.prepare(`SELECT 1 FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=? AND status='missing' LIMIT 1`).get(auth.s, ro)) missing.push('Locate missing vehicle key');
      if (has('v2_customer_requests') && db.prepare(`SELECT 1 FROM v2_customer_requests WHERE shop_id=? AND repair_order_id=? AND status='open' AND request_type='approval' LIMIT 1`).get(auth.s, ro)) missing.push('Resolve customer approval request');
      if (has('v2_loaner_assignments') && db.prepare(`SELECT 1 FROM v2_loaner_assignments WHERE shop_id=? AND repair_order_id=? AND returned_at IS NULL LIMIT 1`).get(auth.s, ro)) missing.push('Return active loaner vehicle');
      if (missing.length) return res.status(409).json({ error: 'Vehicle cannot be delivered until required workflow items are complete.', missing });

      const tx = db.transaction(() => {
        const completed = db.prepare(`
          UPDATE v2_deliveries
          SET delivered_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
          WHERE shop_id=? AND repair_order_id=? AND delivered_at IS NULL
        `).run(auth.s, ro);
        if (completed.changes !== 1) throw new Error('Delivery changed before completion could be saved.');

        const moved = db.prepare(`
          UPDATE repair_orders SET workflow_status='delivered'
          WHERE id=? AND shop_id=? AND COALESCE(workflow_status,'')='ready'
        `).run(ro, auth.s);
        if (moved.changes !== 1) throw new Error('Repair order workflow changed before delivery could be completed.');

        if (has('v2_vehicle_keys')) {
          db.prepare(`
            UPDATE v2_vehicle_keys
            SET status='customer',location='Returned to customer',updated_by=?,updated_at=CURRENT_TIMESTAMP
            WHERE shop_id=? AND repair_order_id=?
          `).run(auth.e, auth.s, ro);
        }

        db.prepare(`
          INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)
          VALUES(?,?,?,?,?,?)
        `).run(auth.s, auth.e, 'repair_order.delivered', 'repair_order', ro, JSON.stringify({
          delivery_id: delivery.id,
          previous_workflow_status: order.workflow_status
        }));
      });

      tx();
      return res.json({ ok: true, workflow_status: 'delivered' });
    } catch (err) {
      console.error('Garavex V2 delivery completion error:', err);
      return res.status(409).json({ error: 'Delivery could not be completed because the repair order changed or a delivery requirement was not satisfied.' });
    }
  });
}

module.exports = { installV2Delivery };
