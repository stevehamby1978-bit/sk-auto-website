const { permissionMiddleware, loadCurrentEmployee } = require('./v2-permissions');

function installV2CoreOperations(app, db, { requireLogin, requireOwner }) {
  if (!app || !db) throw new Error('V2 core operations require app and db.');
  if (!requireLogin || !requireOwner) throw new Error('V2 core operations require authentication middleware.');

  const requireRO = permissionMiddleware('repair_orders', db);
  const validId = value => Number.isInteger(value) && value > 0;
  const currentEmployee = req => req.v2Employee || loadCurrentEmployee(db, req.session?.employee);
  const shopId = req => Number(currentEmployee(req)?.shop_id || 0);
  const employeeId = req => Number(currentEmployee(req)?.id || 0);

  function audit(req, action, repairOrderId, details = {}) {
    const s = shopId(req);
    const e = employeeId(req);
    if (!validId(s) || !validId(e)) return;
    db.prepare(`
      INSERT INTO audit_log (shop_id, employee_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, 'repair_order', ?, ?)
    `).run(s, e, action, repairOrderId, JSON.stringify(details));
  }

  function route(handler) {
    return (req, res) => {
      try {
        res.set('Cache-Control', 'no-store, private, max-age=0');
        res.set('Pragma', 'no-cache');
        const employee = currentEmployee(req);
        const s = Number(employee?.shop_id || 0);
        const e = Number(employee?.id || 0);
        if (!validId(s) || !validId(e)) return res.status(401).json({ error: 'Employee session is no longer valid for this shop.' });
        req.v2Employee = employee;
        req.v2ShopId = s;
        return handler(req, res, s);
      } catch (err) {
        console.error('Garavex V2 core operation error:', err);
        return res.status(500).json({ error: 'Unable to complete this request.' });
      }
    };
  }

  app.get('/api/v2/overview', requireLogin, route((req, res, s) => {
    const one = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n || 0);
    res.json({
      activeRepairOrders: one(`SELECT COUNT(*) n FROM repair_orders WHERE shop_id=? AND status!='completed'`, s),
      inspections: one(`SELECT COUNT(*) n FROM dvi_inspections WHERE shop_id=? AND status!='completed'`, s),
      deferred: one(`SELECT COUNT(*) n FROM deferred_services WHERE shop_id=? AND status='deferred'`, s),
      lowStock: one(`SELECT COUNT(*) n FROM inventory_items WHERE shop_id=? AND active=1 AND quantity<=reorder_level`, s),
      techniciansClockedIn: one(`SELECT COUNT(DISTINCT employee_id) n FROM technician_time_entries WHERE shop_id=? AND clock_out IS NULL`, s)
    });
  }));

  app.get('/api/v2/shop-board', requireLogin, requireRO, route((req, res, s) => {
    const rows = db.prepare(`
      SELECT r.id, r.status, r.workflow_status, r.parts_status, r.promised_at,
             r.assigned_technician_id, r.created_at,
             c.name customer_name, v.year, v.make, v.model, e.name technician_name
      FROM repair_orders r
      LEFT JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
      LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
      LEFT JOIN employees e ON e.id=r.assigned_technician_id AND e.shop_id=r.shop_id
      WHERE r.shop_id=? AND r.status!='completed'
      ORDER BY CASE WHEN r.promised_at IS NULL THEN 1 ELSE 0 END, r.promised_at, r.created_at, r.id
      LIMIT 500
    `).all(s);
    res.json(rows);
  }));

  app.patch('/api/v2/repair-orders/:id/workflow', requireLogin, requireRO, route((req, res, s) => {
    const id = Number(req.params.id);
    const next = String(req.body?.workflow_status || '').trim();
    const allowed = ['waiting', 'assigned', 'in_progress', 'waiting_parts', 'waiting_approval', 'ready', 'completed'];
    if (!validId(id)) return res.status(400).json({ error: 'Valid repair order ID is required.' });
    if (!allowed.includes(next)) return res.status(400).json({ error: 'Invalid workflow status.' });

    const ro = db.prepare(`
      SELECT id, status, workflow_status, assigned_technician_id
      FROM repair_orders WHERE id=? AND shop_id=?
    `).get(id, s);
    if (!ro) return res.status(404).json({ error: 'Repair order not found.' });
    if (ro.status === 'completed' && next !== 'completed') return res.status(409).json({ error: 'Completed repair orders cannot be moved back into workflow.' });
    if (next === 'assigned' && !ro.assigned_technician_id) return res.status(409).json({ error: 'Assign a technician before moving this repair order to assigned.' });
    if (next === ro.workflow_status) return res.json({ ok: true, unchanged: true, workflow_status: next });

    const changed = db.prepare(`
      UPDATE repair_orders SET workflow_status=?
      WHERE id=? AND shop_id=? AND workflow_status=?
    `).run(next, id, s, ro.workflow_status);
    if (changed.changes !== 1) return res.status(409).json({ error: 'Repair order changed before this update could be saved.' });

    audit(req, 'workflow.update', id, { from: ro.workflow_status, to: next });
    res.json({ ok: true, workflow_status: next });
  }));

  app.patch('/api/v2/repair-orders/:id/assign', requireLogin, requireRO, route((req, res, s) => {
    const id = Number(req.params.id);
    const tech = Number(req.body?.employee_id);
    if (!validId(id) || !validId(tech)) return res.status(400).json({ error: 'Valid repair order and technician IDs are required.' });

    const ro = db.prepare(`
      SELECT id, status, workflow_status, assigned_technician_id
      FROM repair_orders WHERE id=? AND shop_id=?
    `).get(id, s);
    if (!ro) return res.status(404).json({ error: 'Repair order not found.' });
    if (ro.status === 'completed') return res.status(409).json({ error: 'Completed repair orders cannot be reassigned.' });

    const employee = db.prepare(`
      SELECT id, name, role FROM employees
      WHERE id=? AND shop_id=? AND active=1
    `).get(tech, s);
    if (!employee) return res.status(400).json({ error: 'Active employee not found for this shop.' });
    if (Number(ro.assigned_technician_id) === tech) return res.json({ ok: true, unchanged: true, employee_id: tech, workflow_status: ro.workflow_status });

    const next = ro.workflow_status === 'waiting' ? 'assigned' : ro.workflow_status;
    const changed = db.prepare(`
      UPDATE repair_orders SET assigned_technician_id=?, workflow_status=?
      WHERE id=? AND shop_id=? AND COALESCE(assigned_technician_id,0)=COALESCE(?,0)
    `).run(tech, next, id, s, ro.assigned_technician_id);
    if (changed.changes !== 1) return res.status(409).json({ error: 'Repair order changed before this assignment could be saved.' });

    audit(req, 'technician.assign', id, {
      from_employee_id: ro.assigned_technician_id || null,
      to_employee_id: tech,
      to_employee_name: employee.name
    });
    res.json({ ok: true, employee_id: tech, employee_name: employee.name, workflow_status: next });
  }));

  app.get('/api/v2/technician-performance', requireLogin, requireOwner, route((req, res, s) => {
    const rows = db.prepare(`
      SELECT e.id, e.name,
             COUNT(DISTINCT t.repair_order_id) jobs,
             COALESCE(SUM(CASE WHEN t.clock_out IS NOT NULL THEN t.minutes ELSE 0 END),0) actual_minutes,
             COALESCE((
               SELECT SUM(roi.labor_hours)
               FROM repair_order_items roi
               JOIN repair_orders rr ON rr.id=roi.repair_order_id
               WHERE rr.shop_id=e.shop_id AND rr.assigned_technician_id=e.id
             ),0) billed_hours
      FROM employees e
      LEFT JOIN technician_time_entries t ON t.employee_id=e.id AND t.shop_id=e.shop_id
      WHERE e.shop_id=? AND e.active=1
      GROUP BY e.id,e.name
      ORDER BY e.name
      LIMIT 500
    `).all(s);
    res.json(rows.map(row => ({
      ...row,
      jobs: Number(row.jobs || 0),
      actual_minutes: Number(row.actual_minutes || 0),
      billed_hours: Number(row.billed_hours || 0)
    })));
  }));

  app.get('/api/v2/profitability', requireLogin, requireOwner, route((req, res, s) => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(i.parts),0) parts_sales,
             COALESCE(SUM(i.parts_cost),0) parts_cost,
             COALESCE(SUM(i.labor),0) labor_sales,
             COALESCE(SUM(i.labor_cost),0) labor_cost
      FROM repair_order_items i
      JOIN repair_orders r ON r.id=i.repair_order_id
      WHERE r.shop_id=?
    `).get(s);
    const partsSales = Number(row.parts_sales || 0);
    const partsCost = Number(row.parts_cost || 0);
    const laborSales = Number(row.labor_sales || 0);
    const laborCost = Number(row.labor_cost || 0);
    const sales = partsSales + laborSales;
    const cost = partsCost + laborCost;
    const grossProfit = sales - cost;
    res.json({
      parts_sales: partsSales,
      parts_cost: partsCost,
      labor_sales: laborSales,
      labor_cost: laborCost,
      sales,
      cost,
      gross_profit: grossProfit,
      gross_margin: sales > 0 ? (grossProfit / sales) * 100 : 0
    });
  }));

  app.get('/api/v2/audit', requireLogin, requireOwner, route((req, res, s) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 500) : 250;
    const rows = db.prepare(`
      SELECT a.id, a.employee_id, a.action, a.entity_type, a.entity_id,
             a.details, a.created_at, e.name employee_name
      FROM audit_log a
      LEFT JOIN employees e ON e.id=a.employee_id AND e.shop_id=a.shop_id
      WHERE a.shop_id=?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?
    `).all(s, limit);
    res.json(rows);
  }));
}

module.exports = { installV2CoreOperations };
