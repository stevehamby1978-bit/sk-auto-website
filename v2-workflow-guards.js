const { permissionMiddleware } = require('./v2-permissions');

function installV2WorkflowGuards(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 workflow guards require app and db.');
  if (!requireLogin) throw new Error('V2 workflow guards require login middleware.');

  const requireRepairOrders = permissionMiddleware('repair_orders');
  const validId = value => Number.isInteger(value) && value > 0;
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

  app.get('/api/v2/repair-orders/:id/completion-check', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const shop = Number(req.session?.employee?.shop_id || 0);
      const id = Number(req.params.id);
      if (!validId(shop)) return res.status(401).json({ error: 'A valid shop session is required.' });
      if (!validId(id)) return res.status(400).json({ error: 'Valid repair order ID is required.' });

      const ro = db.prepare(`
        SELECT id,status,workflow_status
        FROM repair_orders
        WHERE id=? AND shop_id=?
      `).get(id, shop);
      if (!ro) return res.status(404).json({ error: 'Repair order not found.' });

      const checks = [];
      const addCountCheck = (key, table, where, blockedLabel, clearLabel) => {
        if (!tableExists(table)) return;
        const n = Number(db.prepare(`
          SELECT COUNT(*) n FROM ${table}
          WHERE shop_id=? AND repair_order_id=? AND ${where}
        `).get(shop, id)?.n || 0);
        checks.push({ key, ok: n === 0, count: n, label: n ? blockedLabel(n) : clearLabel });
      };

      addCountCheck('blockers', 'v2_ro_blockers', "status='open'", n => `${n} open blocker(s)`, 'No open blockers');
      addCountCheck('parts', 'v2_parts_requests', "status IN ('requested','ordered')", n => `${n} parts request(s) still requested or ordered`, 'No parts waiting to arrive');
      addCountCheck('road_test_open', 'v2_road_tests', "status='in_progress'", () => 'Road test still in progress', 'No road test in progress');
      addCountCheck('customer_approval', 'v2_customer_requests', "status='open' AND request_type='approval'", n => `${n} customer approval request(s) open`, 'Customer approvals clear');
      addCountCheck('loaner', 'v2_loaner_assignments', 'returned_at IS NULL', () => 'Loaner vehicle still checked out', 'No active loaner vehicle');

      if (tableExists('v2_road_tests')) {
        const latest = db.prepare(`
          SELECT result,status,completed_at
          FROM v2_road_tests
          WHERE shop_id=? AND repair_order_id=? AND completed_at IS NOT NULL
          ORDER BY datetime(completed_at) DESC,id DESC
          LIMIT 1
        `).get(shop, id);
        const failed = String(latest?.result || '').toLowerCase() === 'failed';
        checks.push({
          key: 'road_test_result',
          ok: !failed,
          label: failed ? 'Latest completed road test failed' : 'Road test result clear'
        });
      }

      if (tableExists('v2_vehicle_keys')) {
        const key = db.prepare(`
          SELECT status FROM v2_vehicle_keys
          WHERE shop_id=? AND repair_order_id=?
          ORDER BY id DESC LIMIT 1
        `).get(shop, id);
        const missing = String(key?.status || '').toLowerCase() === 'missing';
        checks.push({ key: 'key', ok: !missing, label: missing ? 'Vehicle key marked missing' : 'Vehicle key accounted for' });
      }

      const workflow = String(ro.workflow_status || '').toLowerCase();
      const delivered = workflow === 'delivered';
      const blocking = checks.filter(check => !check.ok);
      const ready = !delivered && blocking.length === 0;

      return res.json({
        repair_order_id: id,
        status: ro.status,
        workflow_status: ro.workflow_status,
        delivered,
        ready,
        checks,
        blocking,
        blocking_count: blocking.length
      });
    } catch (err) {
      console.error('Garavex V2 completion check error:', err);
      return res.status(500).json({ error: 'Unable to run the repair order completion check.' });
    }
  });
}

module.exports = { installV2WorkflowGuards };
