const {permissionMiddleware}=require('./v2-permissions');
function installV2DailyPlan(app,db,{requireLogin}){
 const shop=req=>Number(req.session.employee.shop_id),requireRepairOrders=permissionMiddleware('repair_orders');
 const table=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 app.get('/api/v2/daily-plan',requireLogin,requireRepairOrders,(req,res)=>{
  const s=shop(req),day=String(req.query.date||new Date().toISOString().slice(0,10)).trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||Number.isNaN(Date.parse(day+'T00:00:00Z')))return res.status(400).json({error:'Valid plan date is required.'});
  const tasks=table('v2_tasks')?db.prepare("SELECT id,repair_order_id,title,priority,due_at FROM v2_tasks WHERE shop_id=? AND status='open' AND (due_at IS NULL OR date(due_at)=date(?)) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,due_at LIMIT 250").all(s,day):[];
  const promises=table('v2_ro_promises')?db.prepare("SELECT p.repair_order_id,p.promised_at,c.name customer_name FROM v2_ro_promises p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE p.shop_id=? AND COALESCE(r.workflow_status,'')!='delivered' AND date(p.promised_at)=date(?) ORDER BY p.promised_at LIMIT 250").all(s,day):[];
  const blockerCols=table('v2_ro_blockers')?db.prepare(`PRAGMA table_info(v2_ro_blockers)`).all().map(x=>x.name):[],blockerText=blockerCols.includes('description')&&blockerCols.includes('reason')?`COALESCE(NULLIF(b.description,''),b.reason)`:blockerCols.includes('description')?'b.description':'b.reason';
  const blockers=table('v2_ro_blockers')?db.prepare(`SELECT b.repair_order_id,${blockerText} reason,c.name customer_name FROM v2_ro_blockers b JOIN repair_orders r ON r.id=b.repair_order_id AND r.shop_id=b.shop_id JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE b.shop_id=? AND b.status='open' AND COALESCE(r.workflow_status,'')!='delivered' ORDER BY b.created_at LIMIT 250`).all(s):[];
  const parts=table('v2_parts_requests')?db.prepare("SELECT p.repair_order_id,p.description,p.status,c.name customer_name FROM v2_parts_requests p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE p.shop_id=? AND p.status NOT IN ('installed','cancelled') AND COALESCE(r.workflow_status,'')!='delivered' ORDER BY p.updated_at LIMIT 250").all(s):[];
  res.json({date:day,tasks,promises,blockers,parts,counts:{tasks:tasks.length,promises:promises.length,blockers:blockers.length,parts:parts.length}});
 });
}
module.exports={installV2DailyPlan};
