function installV2DashboardKpis(app,db,{requireLogin}){
 if(!app||!db)throw new Error('V2 dashboard KPIs require app and db.');
 if(!requireLogin)throw new Error('V2 dashboard KPIs require authentication middleware.');
 const sid=req=>Number(req.session?.employee?.shop_id||0);
 const validId=x=>Number.isInteger(x)&&x>0;
 app.get('/api/v2/kpis',requireLogin,(req,res)=>{
  try{
   const s=sid(req);if(!validId(s))return res.status(401).json({error:'A valid shop session is required.'});
   const one=(sql,...p)=>db.prepare(sql).get(...p)||{};
   const today=one(`SELECT COUNT(*) appointments FROM appointments WHERE shop_id=? AND date(appointment_date)=date('now','localtime')`,s);
   const active=one(`SELECT COUNT(*) active FROM repair_orders WHERE shop_id=? AND status!='completed'`,s);
   const ready=one(`SELECT COUNT(*) ready FROM repair_orders WHERE shop_id=? AND workflow_status='ready'`,s);
   const deferred=one(`SELECT COUNT(*) count,COALESCE(SUM(estimated_total),0) value FROM deferred_services WHERE shop_id=? AND status IN('deferred','scheduled')`,s);
   const low=one(`SELECT COUNT(*) count FROM inventory_items WHERE shop_id=? AND active=1 AND quantity<=reorder_level`,s);
   const out=one(`SELECT COUNT(*) count FROM inventory_items WHERE shop_id=? AND active=1 AND quantity<=0`,s);
   const parts=one(`SELECT COUNT(*) count FROM v2_parts_requests WHERE shop_id=? AND status IN('requested','ordered')`,s);
   const overdueParts=one(`SELECT COUNT(*) count FROM v2_parts_requests WHERE shop_id=? AND status='ordered' AND eta IS NOT NULL AND datetime(eta)<datetime('now','localtime')`,s);
   const purchase=one(`SELECT COUNT(*) count FROM purchase_orders WHERE shop_id=? AND status IN('draft','ordered','partial')`,s);
   const blockers=one(`SELECT COUNT(*) count FROM v2_ro_blockers WHERE shop_id=? AND status='open'`,s);
   let comeback={open_count:0,total_cost:0};
   try{comeback=one(`SELECT COALESCE(SUM(CASE WHEN status IN('open','in_progress') THEN 1 ELSE 0 END),0) open_count,COALESCE(SUM(labor_cost+parts_cost),0) total_cost FROM v2_comebacks WHERE shop_id=?`,s)}catch(_){}
   return res.json({appointments_today:Number(today.appointments||0),active_repair_orders:Number(active.active||0),ready_for_pickup:Number(ready.ready||0),deferred_count:Number(deferred.count||0),deferred_value:Number(deferred.value||0),low_stock:Number(low.count||0),out_of_stock:Number(out.count||0),parts_waiting:Number(parts.count||0),overdue_parts:Number(overdueParts.count||0),open_purchase_orders:Number(purchase.count||0),open_blockers:Number(blockers.count||0),open_comebacks:Number(comeback.open_count||0),comeback_cost:Number(comeback.total_cost||0)});
  }catch(err){console.error('Garavex V2 KPI error:',err);return res.status(500).json({error:'Unable to load dashboard KPIs.'});}
 });
}
module.exports={installV2DashboardKpis};
