const { permissionMiddleware, loadCurrentEmployee } = require('./v2-permissions');

function installV2Quality(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 quality requires app and db.');
  if (!requireLogin) throw new Error('V2 quality requires login middleware.');

  const requireRepairOrders = permissionMiddleware('repair_orders', db);
  const validId = value => Number.isInteger(value) && value > 0;
  const tableExists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const noStore=res=>{res.set('Cache-Control','no-store, private, max-age=0');res.set('Pragma','no-cache');res.set('Expires','0');res.set('X-Content-Type-Options','nosniff');};
  const auth=(req,res)=>{const employee=req.v2Employee||loadCurrentEmployee(db,req.session?.employee),shop=Number(employee?.shop_id||0),employeeId=Number(employee?.id||0);if(!employee||!validId(shop)||!validId(employeeId)){res.status(401).json({error:'Employee session is no longer valid for this shop.'});return null;}const current=loadCurrentEmployee(db,req.session?.employee);if(!current||Number(current.id)!==employeeId||Number(current.shop_id)!==shop){res.status(401).json({error:'Employee session is no longer valid for this shop.'});return null;}req.v2Employee=current;req.v2ShopId=shop;return{shop,employeeId};};
  const live=(req,a)=>{const employee=loadCurrentEmployee(db,req.session?.employee);return employee&&Number(employee.id)===a.employeeId&&Number(employee.shop_id)===a.shop;};

  function checksFor(shop, id) {
    const ro = db.prepare(`SELECT r.id,r.status,r.workflow_status,r.customer_concern,r.technician_diagnosis,r.customer_id,r.vehicle_id,c.name customer_name,v.year,v.make,v.model,v.mileage FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id WHERE r.id=? AND r.shop_id=? AND (r.vehicle_id IS NULL OR v.id IS NOT NULL)`).get(id, shop);
    if (!ro) return null;
    const itemCount = Number(db.prepare(`SELECT COUNT(*) n FROM repair_order_items i JOIN repair_orders r ON r.id=i.repair_order_id WHERE i.repair_order_id=? AND r.shop_id=?`).get(id, shop)?.n || 0);
    const openTime = Number(db.prepare(`SELECT COUNT(*) n FROM technician_time_entries WHERE shop_id=? AND repair_order_id=? AND clock_out IS NULL`).get(shop, id)?.n || 0);
    const dvi = db.prepare(`SELECT id,status FROM dvi_inspections WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(shop, id);
    const checks = [
      { key:'customer_concern', label:'Customer concern documented', ok:Boolean(String(ro.customer_concern || '').trim()) },
      { key:'vehicle', label:'Vehicle attached to repair order', ok:validId(Number(ro.vehicle_id)) },
      { key:'mileage', label:'Vehicle mileage recorded', ok:Boolean(String(ro.mileage || '').trim()) },
      { key:'line_items', label:'Repair order has line items', ok:itemCount > 0 },
      { key:'diagnosis', label:'Technician diagnosis documented', ok:Boolean(String(ro.technician_diagnosis || '').trim()) },
      { key:'technician_time', label:'No technician clock still running', ok:openTime === 0 },
      { key:'inspection', label:'Digital inspection completed or intentionally skipped', ok:!dvi || ['completed','sent','approved'].includes(String(dvi.status || '').toLowerCase()) }
    ];
    const addCountCheck = (key, table, where, label) => {if (!tableExists(table)) return;const n = Number(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE shop_id=? AND repair_order_id=? AND ${where}`).get(shop, id)?.n || 0);checks.push({ key, label, ok:n === 0, count:n });};
    addCountCheck('blockers','v2_ro_blockers',"status='open'",'No open workflow blockers');
    addCountCheck('parts','v2_parts_requests',"status IN ('requested','ordered','received')",'No outstanding parts requests');
    addCountCheck('road_test','v2_road_tests',"status='in_progress'",'No road test still in progress');
    addCountCheck('customer_requests','v2_customer_requests',"status='open'",'No open customer workflow requests');
    addCountCheck('tasks','v2_tasks',"status='open'",'No open repair-order tasks');
    addCountCheck('loaner','v2_loaner_assignments','returned_at IS NULL','No loaner vehicle still checked out');
    if (tableExists('v2_road_tests')) {const latest = db.prepare(`SELECT result FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND completed_at IS NOT NULL ORDER BY datetime(completed_at) DESC,id DESC LIMIT 1`).get(shop, id);const result = String(latest?.result || '').toLowerCase();checks.push({ key:'road_test_result', label:'Latest road test passed or was not required', ok:!latest || result === 'passed' });}
    if (tableExists('v2_vehicle_keys')) {const key = db.prepare(`SELECT status FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(shop, id);checks.push({ key:'vehicle_key', label:'Vehicle key accounted for', ok:!key || ['checked_in','technician','board'].includes(String(key.status || '').toLowerCase()) });}
    return { ro, checks };
  }

  app.get('/api/v2/repair-orders/:id/quality', requireLogin, requireRepairOrders, (req, res) => {
    try {const a=auth(req,res);if(!a)return;noStore(res);const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid repair order ID is required.'});const result=checksFor(a.shop,id);if(!result)return res.status(404).json({error:'Repair order, customer, or vehicle relationship was not found.'});const blocking=result.checks.filter(check=>!check.ok);return res.json({...result.ro,checks:result.checks,blocking,blocking_count:blocking.length,ready:blocking.length===0});} catch(err) { console.error('Garavex V2 quality check error:',err); return res.status(500).json({error:'Unable to run final quality checks.'}); }
  });

  app.post('/api/v2/repair-orders/:id/quality/approve', requireLogin, requireRepairOrders, (req, res) => {
    try {const a=auth(req,res);if(!a)return;noStore(res);const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid repair order ID is required.'});const note=String(req.body?.note || '').trim();if(note.length>2000)return res.status(400).json({error:'Quality approval note cannot exceed 2000 characters.'});let responseChecks=[];const tx=db.transaction(()=>{if(!live(req,a))throw new Error('SESSION_INVALID');const result=checksFor(a.shop,id);if(!result)throw new Error('RO_NOT_FOUND');const current=String(result.ro.workflow_status || '').toLowerCase();if(String(result.ro.status||'').toLowerCase()==='completed'||current==='delivered')throw new Error('RO_CLOSED');if(current==='ready')throw new Error('ALREADY_READY');const blocking=result.checks.filter(check=>!check.ok);if(blocking.length){const err=new Error('QUALITY_BLOCKED');err.checks=result.checks;err.blocking=blocking;throw err;}const previous=result.ro.workflow_status;const changed=db.prepare(`UPDATE repair_orders SET workflow_status='ready' WHERE id=? AND shop_id=? AND COALESCE(workflow_status,'')=COALESCE(?, '') AND LOWER(COALESCE(status,''))!='completed'`).run(id,a.shop,previous);if(changed.changes!==1)throw new Error('QUALITY_CHANGED');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.shop,a.employeeId,'quality.approved','repair_order',id,JSON.stringify({note,previous_workflow_status:previous,checks:result.checks.map(check=>check.key)}));responseChecks=result.checks;});try{tx();}catch(err){const code=String(err.message||'');if(code==='SESSION_INVALID')return res.status(401).json({error:'Employee session is no longer valid for this shop.'});if(code==='RO_NOT_FOUND')return res.status(404).json({error:'Repair order, customer, or vehicle relationship was not found.'});if(code==='RO_CLOSED')return res.status(409).json({error:'Completed or delivered repair orders cannot be quality-approved again.'});if(code==='ALREADY_READY')return res.status(409).json({error:'This repair order has already passed final quality approval.'});if(code==='QUALITY_BLOCKED')return res.status(409).json({error:'Final quality cannot be approved until all required checks pass.',checks:err.checks,blocking:err.blocking});if(code==='QUALITY_CHANGED')return res.status(409).json({error:'Final quality approval could not be saved because the repair order changed.'});throw err;}return res.json({ok:true,workflow_status:'ready',checks:responseChecks});} catch(err) { console.error('Garavex V2 quality approval error:',err); return res.status(500).json({error:'Unable to save final quality approval.'}); }
  });
}

module.exports = { installV2Quality };
