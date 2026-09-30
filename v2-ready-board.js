const { permissionMiddleware } = require('./v2-permissions');

function installV2ReadyBoard(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 ready board requires app and db.');
  if (!requireLogin) throw new Error('V2 ready board requires login middleware.');

  const requireRepairOrders = permissionMiddleware('repair_orders');
  const validId = value => Number.isInteger(value) && value > 0;
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

  app.get('/api/v2/ready-board', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const shopId = Number(req.session?.employee?.shop_id || 0);
      const employeeId = Number(req.session?.employee?.id || 0);
      if (!validId(shopId) || !validId(employeeId)) return res.status(401).json({ error: 'A valid employee shop session is required.' });

      const repairOrders = db.prepare(`
        SELECT r.id, r.status, r.workflow_status, r.payment_status, r.completed_at, r.created_at,
               c.name customer_name, c.phone customer_phone,
               v.year, v.make, v.model
        FROM repair_orders r
        JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        WHERE r.shop_id=?
          AND LOWER(COALESCE(r.workflow_status,''))!='delivered'
          AND (r.status!='completed' OR datetime(r.completed_at)>=datetime('now','-1 day'))
        ORDER BY
          CASE WHEN LOWER(COALESCE(r.workflow_status,''))='ready' THEN 0 ELSE 1 END,
          CASE WHEN r.completed_at IS NULL THEN 1 ELSE 0 END,
          r.completed_at,
          r.id DESC
        LIMIT 150
      `).all(shopId);

      const statements = {
        blocker: exists('v2_ro_blockers') ? db.prepare(`SELECT 1 FROM v2_ro_blockers WHERE shop_id=? AND repair_order_id=? AND status='open' LIMIT 1`) : null,
        parts: exists('v2_parts_requests') ? db.prepare(`SELECT 1 FROM v2_parts_requests WHERE shop_id=? AND repair_order_id=? AND status IN ('requested','ordered','received') LIMIT 1`) : null,
        roadTest: exists('v2_road_tests') ? db.prepare(`SELECT 1 FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND status='in_progress' LIMIT 1`) : null,
        latestRoadTest: exists('v2_road_tests') ? db.prepare(`SELECT result FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND completed_at IS NOT NULL ORDER BY datetime(completed_at) DESC,id DESC LIMIT 1`) : null,
        key: exists('v2_vehicle_keys') ? db.prepare(`SELECT status FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`) : null,
        customerRequest: exists('v2_customer_requests') ? db.prepare(`SELECT 1 FROM v2_customer_requests WHERE shop_id=? AND repair_order_id=? AND status='open' LIMIT 1`) : null,
        loaner: exists('v2_loaner_assignments') ? db.prepare(`SELECT 1 FROM v2_loaner_assignments WHERE shop_id=? AND repair_order_id=? AND returned_at IS NULL LIMIT 1`) : null,
        technicianClock: exists('technician_time_entries') ? db.prepare(`SELECT 1 FROM technician_time_entries WHERE shop_id=? AND repair_order_id=? AND clock_out IS NULL LIMIT 1`) : null,
        task: exists('v2_tasks') ? db.prepare(`SELECT 1 FROM v2_tasks WHERE shop_id=? AND repair_order_id=? AND status='open' LIMIT 1`) : null,
        promise: exists('v2_ro_promises') ? db.prepare(`SELECT promised_at FROM v2_ro_promises WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`) : null,
        delivery: exists('v2_deliveries') ? db.prepare(`SELECT customer_notified,keys_returned,documents_given,delivered_at FROM v2_deliveries WHERE shop_id=? AND repair_order_id=?`) : null
      };

      const rows = repairOrders.map(ro => {
        const issues = [];
        if (statements.blocker?.get(shopId, ro.id)) issues.push('Open blocker');
        if (statements.parts?.get(shopId, ro.id)) issues.push('Parts request unresolved');
        if (statements.roadTest?.get(shopId, ro.id)) issues.push('Road test active');
        const latestRoadTest = statements.latestRoadTest?.get(shopId, ro.id);
        const latestResult = String(latestRoadTest?.result || '').toLowerCase();
        if (latestRoadTest && latestResult !== 'passed') issues.push(`Latest road test ${latestResult || 'unresolved'}`);
        const key = statements.key?.get(shopId, ro.id);
        if (key && !['checked_in','technician','board'].includes(String(key.status || '').toLowerCase())) issues.push('Key custody unresolved');
        if (statements.customerRequest?.get(shopId, ro.id)) issues.push('Customer workflow request open');
        if (statements.loaner?.get(shopId, ro.id)) issues.push('Loaner still checked out');
        if (statements.technicianClock?.get(shopId, ro.id)) issues.push('Technician clock running');
        if (statements.task?.get(shopId, ro.id)) issues.push('Open repair-order task');

        const promisedAt = statements.promise?.get(shopId, ro.id)?.promised_at || null;
        const workflow = String(ro.workflow_status || '').toLowerCase();
        const paymentPaid = String(ro.payment_status || '').toLowerCase() === 'paid';
        const ready = workflow === 'ready' && issues.length === 0;
        const deliveryIssues = [...issues];
        if (workflow !== 'ready') deliveryIssues.push('Repair order not in ready status');
        if (!paymentPaid) deliveryIssues.push('Payment not complete');

        const delivery = statements.delivery?.get(shopId, ro.id) || null;
        if (workflow === 'ready') {
          if (!delivery) deliveryIssues.push('Delivery checklist not started');
          else {
            if (!delivery.customer_notified) deliveryIssues.push('Customer notification not confirmed');
            if (!delivery.keys_returned) deliveryIssues.push('Key return not confirmed');
            if (!delivery.documents_given) deliveryIssues.push('Invoice/documents not confirmed');
          }
        }
        const deliverable = workflow === 'ready' && deliveryIssues.length === 0;

        return {
          ...ro,
          promised_at: promisedAt,
          issues,
          issue_count: issues.length,
          ready,
          payment_paid: paymentPaid,
          delivery_started: Boolean(delivery),
          delivery_issues: deliveryIssues,
          delivery_issue_count: deliveryIssues.length,
          deliverable,
          action_required: deliveryIssues.length > 0,
          board_state: deliverable ? 'deliverable' : ready ? 'ready_handoff' : issues.length ? 'blocked' : workflow || 'waiting'
        };
      });

      const summary = rows.reduce((acc, row) => {
        acc.total += 1;
        if (row.deliverable) acc.deliverable += 1;
        if (row.ready) acc.ready += 1;
        else if (row.issue_count > 0) acc.blocked += 1;
        else acc.in_progress += 1;
        if (row.ready && !row.payment_paid) acc.payment_due += 1;
        if (row.ready && row.payment_paid && !row.deliverable) acc.handoff_due += 1;
        return acc;
      }, { total: 0, ready: 0, deliverable: 0, payment_due: 0, handoff_due: 0, blocked: 0, in_progress: 0 });

      return res.json({ summary, repair_orders: rows });
    } catch (err) {
      console.error('Garavex V2 ready board error:', err);
      return res.status(500).json({ error: 'Unable to load the ready board.' });
    }
  });
}

module.exports = { installV2ReadyBoard };
