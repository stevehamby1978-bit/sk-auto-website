function installV2WorkflowSummary(app,db,{requireLogin}){
 const sid=req=>Number(req.session.employee.shop_id),has=n=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
 app.get('/api/v2/repair-orders/:id/workflow-summary',requireLogin,(req,res)=>{
  const s=sid(req),id=Number(req.params.id);const ro=db.prepare(`SELECT r.*,c.name customer_name,c.phone customer_phone,v.year,v.make,v.model,v.vin FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id WHERE r.id=? AND r.shop_id=?`).get(id,s);if(!ro)return res.status(404).json({error:'Repair order not found.'});
  const count=(table,where='1=1')=>has(table)?db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE shop_id=? AND repair_order_id=? AND ${where}`).get(s,id).n:0;
  const latest=(table,cols='*')=>has(table)?db.prepare(`SELECT ${cols} FROM ${table} WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(s,id):null;
  const data={repair_order:ro,open_tasks:count('v2_tasks',"status='open'"),open_blockers:count('v2_ro_blockers',"status='open'"),open_customer_contacts:count('v2_customer_requests',"status='open'"),parts_pending:count('v2_parts_requests',"status NOT IN ('installed','cancelled')"),timeline_events:count('v2_workflow_events'),latest_promise:latest('v2_ro_promises'),latest_road_test:latest('v2_road_tests'),latest_quality:latest('v2_quality_checks'),latest_delivery:latest('v2_deliveries'),latest_warranty:latest('v2_warranties')};
  data.ready_for_delivery=!data.open_blockers&&!data.parts_pending&&(!data.latest_quality||['passed','complete','completed'].includes(String(data.latest_quality.status||'').toLowerCase()));res.json(data);
 });
}
module.exports={installV2WorkflowSummary};
