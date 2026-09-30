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
      const employee = Number(req.session?.employee?.id || 0);
      const id = Number(req.params.id);
      if (!validId(shop) || !validId(employee)) return res.status(401).json({ error: 'A valid employee shop session is required.' });
      if (!validId(id)) return res.status(400).json({ error: 'Valid repair order ID is required.' });

      const ro = db.prepare(`SELECT id,status,workflow_status,payment_status FROM repair_orders WHERE id=? AND shop_id=?`).get(id, shop);
      if (!ro) return res.status(404).json({ error: 'Repair order not found.' });

      const checks = [];
      const addCountCheck = (key, table, where, blockedLabel, clearLabel) => {
        if (!tableExists(table)) return;
        const n = Number(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE shop_id=? AND repair_order_id=? AND ${where}`).get(shop, id)?.n || 0);
        checks.push({ key, ok: n === 0, count: n, label: n ? blockedLabel(n) : clearLabel });
      };

      addCountCheck('blockers','v2_ro_blockers',"status='open'",n=>`${n} open blocker(s)`,'No open blockers');
      addCountCheck('parts','v2_parts_requests',"status IN ('requested','ordered','received')",n=>`${n} unresolved parts request(s)`,'Parts requests resolved');
      addCountCheck('road_test_open','v2_road_tests',"status='in_progress'",()=> 'Road test still in progress','No road test in progress');
      addCountCheck('customer_requests','v2_customer_requests',"status='open'",n=>`${n} customer workflow request(s) open`,'Customer workflow requests clear');
      addCountCheck('loaner','v2_loaner_assignments','returned_at IS NULL',()=> 'Loaner vehicle still checked out','No active loaner vehicle');
      addCountCheck('technician_clock','technician_time_entries','clock_out IS NULL',()=> 'Technician clock still running','No active technician clock');
      addCountCheck('tasks','v2_tasks',"status='open'",n=>`${n} repair-order task(s) still open`,'Repair-order tasks complete');

      if (tableExists('v2_road_tests')) {
        const latest = db.prepare(`SELECT result,status,completed_at FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND completed_at IS NOT NULL ORDER BY datetime(completed_at) DESC,id DESC LIMIT 1`).get(shop,id);
        const result = String(latest?.result || '').toLowerCase();
        const clear = !latest || result === 'passed';
        checks.push({key:'road_test_result',ok:clear,label:!latest?'No completed road test requiring resolution':clear?'Latest road test passed':`Latest road test must pass before delivery${result?` (${result})`:''}`});
      }

      if (tableExists('v2_vehicle_keys')) {
        const key = db.prepare(`SELECT status FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(shop,id);
        const status=String(key?.status||'').toLowerCase();
        const accountedFor=!key||['checked_in','technician','board'].includes(status);
        checks.push({key:'key',ok:accountedFor,label:accountedFor?'Vehicle key accounted for':`Vehicle key custody must be resolved${status?` (${status})`:''}`});
      }

      const workflow=String(ro.workflow_status||'').toLowerCase();
      const delivered=workflow==='delivered';
      const operationalBlocking=checks.filter(check=>!check.ok);
      const ready=!delivered&&operationalBlocking.length===0;
      const paid=String(ro.payment_status||'').toLowerCase()==='paid';
      const readyStatus=workflow==='ready';
      const deliveryChecks=checks.concat([
        {key:'ready_status',ok:readyStatus,label:readyStatus?'Repair order is in ready status':'Repair order must be in ready status'},
        {key:'payment',ok:paid,label:paid?'Payment complete':'Payment must be collected before delivery'}
      ]);
      const deliveryBlocking=deliveryChecks.filter(check=>!check.ok);
      const deliverable=!delivered&&deliveryBlocking.length===0;

      return res.json({repair_order_id:id,status:ro.status,workflow_status:ro.workflow_status,payment_status:ro.payment_status,delivered,ready,deliverable,checks,blocking:operationalBlocking,blocking_count:operationalBlocking.length,delivery_checks:deliveryChecks,delivery_blocking:deliveryBlocking,delivery_blocking_count:deliveryBlocking.length});
    } catch (err) {
      console.error('Garavex V2 completion check error:',err);
      return res.status(500).json({error:'Unable to run the repair order completion check.'});
    }
  });
}

module.exports = { installV2WorkflowGuards };
