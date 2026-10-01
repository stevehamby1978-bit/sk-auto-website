const { permissionMiddleware, loadCurrentEmployee } = require('./v2-permissions');

function installV2WorkflowSummary(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 workflow summary requires app and db.');
  if (!requireLogin) throw new Error('V2 workflow summary requires login middleware.');

  const requireRepairOrders = permissionMiddleware('repair_orders', db);
  const validId = value => Number.isInteger(value) && value > 0;
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const allowedTables = new Set(['v2_tasks','v2_ro_blockers','v2_customer_requests','v2_parts_requests','v2_road_tests','v2_vehicle_keys','v2_loaner_assignments','v2_workflow_events','v2_ro_promises','v2_deliveries','v2_warranties','technician_time_entries']);
  const safeTable = name => { if (!allowedTables.has(name)) throw new Error(`Unsupported workflow summary table: ${name}`); return name; };
  const noStore = res => { res.set('Cache-Control','no-store, private, max-age=0'); res.set('Pragma','no-cache'); res.set('Expires','0'); res.set('X-Content-Type-Options','nosniff'); };

  app.get('/api/v2/repair-orders/:id/workflow-summary', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const employee = req.v2Employee || loadCurrentEmployee(db, req.session?.employee);
      const shopId = Number(employee?.shop_id || 0), employeeId = Number(employee?.id || 0), id = Number(req.params.id);
      if (!employee || !validId(shopId) || !validId(employeeId)) return res.status(401).json({ error: 'Employee session is no longer valid for this shop.' });
      const live = loadCurrentEmployee(db, req.session?.employee);
      if (!live || Number(live.id) !== employeeId || Number(live.shop_id) !== shopId) return res.status(401).json({ error: 'Employee session is no longer valid for this shop.' });
      if (!validId(id)) return res.status(400).json({ error: 'Valid repair order ID is required.' });
      req.v2Employee = live; req.v2ShopId = shopId; noStore(res);

      const ro = db.prepare(`SELECT r.*,c.name customer_name,c.phone customer_phone,v.year,v.make,v.model,v.vin FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id AND v.customer_id=r.customer_id WHERE r.id=? AND r.shop_id=? AND (r.vehicle_id IS NULL OR v.id IS NOT NULL)`).get(id, shopId);
      if (!ro) return res.status(404).json({ error: 'Repair order, customer, or vehicle relationship was not found.' });

      const count = (table, where='1=1') => { safeTable(table); if(!tableExists(table))return 0; return Number(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE shop_id=? AND repair_order_id=? AND ${where}`).get(shopId,id)?.n||0); };
      const latest = table => { safeTable(table); if(!tableExists(table))return null; return db.prepare(`SELECT * FROM ${table} WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(shopId,id)||null; };
      const data = {
        repair_order:ro,
        open_tasks:count('v2_tasks',"LOWER(COALESCE(status,''))='open'"),
        open_blockers:count('v2_ro_blockers',"LOWER(COALESCE(status,''))='open'"),
        open_customer_contacts:count('v2_customer_requests',"LOWER(COALESCE(status,''))='open'"),
        open_approvals:count('v2_customer_requests',"LOWER(COALESCE(status,''))='open' AND LOWER(COALESCE(request_type,''))='approval'"),
        parts_pending:count('v2_parts_requests',"LOWER(COALESCE(status,'')) IN ('requested','ordered')"),
        parts_received:count('v2_parts_requests',"LOWER(COALESCE(status,''))='received'"),
        active_road_tests:count('v2_road_tests',"LOWER(COALESCE(status,''))='in_progress'"),
        missing_keys:count('v2_vehicle_keys',"LOWER(COALESCE(status,''))='missing'"),
        active_loaners:0,
        active_technician_clocks:0,
        timeline_events:count('v2_workflow_events'),
        latest_promise:latest('v2_ro_promises'), latest_road_test:latest('v2_road_tests'), latest_delivery:latest('v2_deliveries'), latest_warranty:latest('v2_warranties')
      };
      if(tableExists('v2_loaner_assignments'))data.active_loaners=Number(db.prepare(`SELECT COUNT(*) n FROM v2_loaner_assignments WHERE shop_id=? AND repair_order_id=? AND returned_at IS NULL`).get(shopId,id)?.n||0);
      if(tableExists('technician_time_entries'))data.active_technician_clocks=Number(db.prepare(`SELECT COUNT(*) n FROM technician_time_entries WHERE shop_id=? AND repair_order_id=? AND clock_out IS NULL`).get(shopId,id)?.n||0);

      const workflow=String(ro.workflow_status||'').trim().toLowerCase(), legacyStatus=String(ro.status||'').trim().toLowerCase(), paymentStatus=String(ro.payment_status||'').trim().toLowerCase();
      const delivered=workflow==='delivered'||Boolean(data.latest_delivery?.delivered_at), closed=delivered||legacyStatus==='completed', paid=paymentStatus==='paid';
      const gates=[];
      if(!closed){
        if(workflow!=='ready')gates.push('Repair order must be moved to ready status');
        if(data.open_tasks>0)gates.push('Complete open repair-order tasks');
        if(data.open_blockers>0)gates.push('Resolve open workflow blockers');
        if(data.parts_pending>0)gates.push('Resolve requested or ordered parts');
        if(data.active_road_tests>0)gates.push('Complete active road test');
        const roadResult=String(data.latest_road_test?.result||'').trim().toLowerCase();
        if(data.latest_road_test?.completed_at&&roadResult!=='passed')gates.push(`Latest road test must pass before delivery${roadResult?` (${roadResult})`:''}`);
        if(data.missing_keys>0)gates.push('Locate missing vehicle key');
        if(data.open_customer_contacts>0)gates.push('Resolve open customer workflow requests');
        if(data.active_loaners>0)gates.push('Return active loaner vehicle');
        if(data.active_technician_clocks>0)gates.push('Stop active technician clock');
        if(!paid)gates.push('Collect payment before delivery');
      }
      data.delivery_gates=gates; data.ready_for_delivery=!closed&&workflow==='ready'&&gates.length===0; data.delivered=delivered; data.closed=closed;
      data.summary={action_required:!closed&&gates.length>0,gate_count:gates.length,open_work_items:data.open_tasks+data.open_blockers+data.open_customer_contacts,customer_waiting:data.open_customer_contacts>0,parts_waiting:data.parts_pending>0,technician_clock_running:data.active_technician_clocks>0,payment_waiting:!closed&&!paid};
      return res.json(data);
    } catch(err){console.error('Garavex V2 workflow summary error:',err);return res.status(500).json({error:'Unable to load repair order workflow summary.'});}
  });
}

module.exports = { installV2WorkflowSummary };
