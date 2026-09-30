function installV2DailyPlan(app,db,{requireLogin}){
 const shop=req=>Number(req.session.employee.shop_id);
 const table=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 app.get('/api/v2/daily-plan',requireLogin,(req,res)=>{
  const s=shop(req), day=String(req.query.date||new Date().toISOString().slice(0,10));
  const tasks=table('v2_tasks')?db.prepare("SELECT id,repair_order_id,title,priority,due_at FROM v2_tasks WHERE shop_id=? AND status='open' AND (due_at IS NULL OR date(due_at)=date(?)) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,due_at").all(s,day):[];
  const promises=table('v2_ro_promises')?db.prepare("SELECT p.repair_order_id,p.promised_at,c.name customer_name FROM v2_ro_promises p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id JOIN customers c ON c.id=r.customer_id WHERE p.shop_id=? AND date(p.promised_at)=date(?) ORDER BY p.promised_at").all(s,day):[];
  const blockers=table('v2_ro_blockers')?db.prepare("SELECT b.repair_order_id,b.reason,c.name customer_name FROM v2_ro_blockers b JOIN repair_orders r ON r.id=b.repair_order_id AND r.shop_id=b.shop_id JOIN customers c ON c.id=r.customer_id WHERE b.shop_id=? AND b.status='open' ORDER BY b.created_at").all(s):[];
  const parts=table('v2_parts_requests')?db.prepare("SELECT p.repair_order_id,p.description,p.status,c.name customer_name FROM v2_parts_requests p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id JOIN customers c ON c.id=r.customer_id WHERE p.shop_id=? AND p.status NOT IN ('installed','cancelled') ORDER BY p.updated_at").all(s):[];
  res.json({date:day,tasks,promises,blockers,parts,counts:{tasks:tasks.length,promises:promises.length,blockers:blockers.length,parts:parts.length}});
 });
}
module.exports={installV2DailyPlan};
