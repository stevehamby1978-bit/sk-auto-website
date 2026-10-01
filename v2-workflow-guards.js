const { permissionMiddleware, loadCurrentEmployee } = require('./v2-permissions');

function installV2WorkflowGuards(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 workflow guards require app and db.');
  if (!requireLogin) throw new Error('V2 workflow guards require login middleware.');

  const requireRepairOrders = permissionMiddleware('repair_orders', db);
  const validId = value => Number.isInteger(value) && value > 0;
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const noStore = res => { res.set('Cache-Control','no-store, private, max-age=0'); res.set('Pragma','no-cache'); res.set('Expires','0'); res.set('X-Content-Type-Options','nosniff'); };
  const auth = (req,res) => {
    const employee=req.v2Employee||loadCurrentEmployee(db,req.session?.employee);
    const shop=Number(employee?.shop_id||0), employeeId=Number(employee?.id||0);
    if(!employee||!validId(shop)||!validId(employeeId)){res.status(401).json({error:'Employee session is no longer valid for this shop.'});return null;}
    const live=loadCurrentEmployee(db,req.session?.employee);
    if(!live||Number(live.id)!==employeeId||Number(live.shop_id)!==shop){res.status(401).json({error:'Employee session is no longer valid for this shop.'});return null;}
    req.v2Employee=live; req.v2ShopId=shop;
    return {shop,employeeId};
  };

  app.get('/api/v2/repair-orders/:id/completion-check', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const a=auth(req,res); if(!a)return;
      noStore(res);
      const id=Number(req.params.id);
      if(!validId(id))return res.status(400).json({error:'Valid repair order ID is required.'});

      const ro=db.prepare(`SELECT r.id,r.status,r.workflow_status,r.payment_status,r.customer_id,r.vehicle_id FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id AND v.customer_id=r.customer_id WHERE r.id=? AND r.shop_id=? AND (r.vehicle_id IS NULL OR v.id IS NOT NULL)`).get(id,a.shop);
      if(!ro)return res.status(404).json({error:'Repair order, customer, or vehicle relationship was not found.'});

      const checks=[];
      const addCountCheck=(key,table,where,blockedLabel,clearLabel)=>{
        if(!tableExists(table))return;
        const n=Number(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE shop_id=? AND repair_order_id=? AND ${where}`).get(a.shop,id)?.n||0);
        checks.push({key,ok:n===0,count:n,label:n?blockedLabel(n):clearLabel});
      };

      addCountCheck('blockers','v2_ro_blockers',"status='open'",n=>`${n} open blocker(s)`,'No open blockers');
      addCountCheck('parts','v2_parts_requests',"status IN ('requested','ordered')",n=>`${n} unresolved parts request(s)`,'Parts requests resolved');
      addCountCheck('road_test_open','v2_road_tests',"status='in_progress'",()=> 'Road test still in progress','No road test in progress');
      addCountCheck('customer_requests','v2_customer_requests',"status='open'",n=>`${n} customer workflow request(s) open`,'Customer workflow requests clear');
      addCountCheck('loaner','v2_loaner_assignments','returned_at IS NULL',()=> 'Loaner vehicle still checked out','No active loaner vehicle');
      addCountCheck('technician_clock','technician_time_entries','clock_out IS NULL',()=> 'Technician clock still running','No active technician clock');
      addCountCheck('tasks','v2_tasks',"status='open'",n=>`${n} repair-order task(s) still open`,'Repair-order tasks complete');

      if(tableExists('v2_road_tests')){
        const latest=db.prepare(`SELECT result,status,completed_at FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND completed_at IS NOT NULL ORDER BY datetime(completed_at) DESC,id DESC LIMIT 1`).get(a.shop,id);
        const result=String(latest?.result||'').toLowerCase(),clear=!latest||result==='passed';
        checks.push({key:'road_test_result',ok:clear,label:!latest?'No completed road test requiring resolution':clear?'Latest road test passed':`Latest road test must pass before delivery${result?` (${result})`:''}`});
      }

      if(tableExists('v2_vehicle_keys')){
        const key=db.prepare(`SELECT status FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(a.shop,id);
        const status=String(key?.status||'').toLowerCase(),accountedFor=!key||['checked_in','technician','board'].includes(status);
        checks.push({key:'key',ok:accountedFor,label:accountedFor?'Vehicle key accounted for':`Vehicle key custody must be resolved${status?` (${status})`:''}`});
      }

      const workflow=String(ro.workflow_status||'').trim().toLowerCase();
      const legacyStatus=String(ro.status||'').trim().toLowerCase();
      const delivered=workflow==='delivered';
      const closed=delivered||legacyStatus==='completed';
      const operationalBlocking=checks.filter(check=>!check.ok),ready=!closed&&operationalBlocking.length===0;
      const paid=String(ro.payment_status||'').trim().toLowerCase()==='paid',readyStatus=workflow==='ready';
      const deliveryChecks=checks.concat([{key:'repair_order_open',ok:!closed,label:closed?'Repair order is already completed or delivered':'Repair order remains open for delivery'},{key:'ready_status',ok:readyStatus,label:readyStatus?'Repair order is in ready status':'Repair order must be in ready status'},{key:'payment',ok:paid,label:paid?'Payment complete':'Payment must be collected before delivery'}]);

      if(tableExists('v2_deliveries')){
        const delivery=db.prepare(`SELECT customer_notified,keys_returned,documents_given,delivered_at FROM v2_deliveries WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(a.shop,id);
        deliveryChecks.push({key:'delivery_started',ok:Boolean(delivery),label:delivery?'Delivery checklist started':'Start the delivery checklist'},{key:'customer_notified',ok:Boolean(delivery?.customer_notified),label:delivery?.customer_notified?'Customer notification confirmed':'Confirm customer was notified'},{key:'keys_returned',ok:Boolean(delivery?.keys_returned),label:delivery?.keys_returned?'Key return confirmed':'Confirm keys will be returned to customer'},{key:'documents_given',ok:Boolean(delivery?.documents_given),label:delivery?.documents_given?'Invoice/documents confirmed':'Confirm invoice and service documents are provided'});
      }

      const deliveryBlocking=deliveryChecks.filter(check=>!check.ok),deliverable=!closed&&deliveryBlocking.length===0;
      return res.json({repair_order_id:id,status:ro.status,workflow_status:ro.workflow_status,payment_status:ro.payment_status,delivered,closed,ready,deliverable,checks,blocking:operationalBlocking,blocking_count:operationalBlocking.length,delivery_checks:deliveryChecks,delivery_blocking:deliveryBlocking,delivery_blocking_count:deliveryBlocking.length});
    } catch(err){console.error('Garavex V2 completion check error:',err);return res.status(500).json({error:'Unable to run the repair order completion check.'});}
  });
}

module.exports = { installV2WorkflowGuards };
