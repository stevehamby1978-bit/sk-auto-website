const {permissionMiddleware,loadCurrentEmployee}=require('./v2-permissions');
function installV2DashboardKpis(app,db,{requireLogin}){
 if(!app||!db)throw new Error('V2 dashboard KPIs require app and db.');
 if(!requireLogin)throw new Error('V2 dashboard KPIs require authentication middleware.');
 const requireDashboard=permissionMiddleware('dashboard',db),validId=x=>Number.isInteger(x)&&x>0;
 const exists=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
 const one=(sql,...p)=>db.prepare(sql).get(...p)||{};
 app.get('/api/v2/kpis',requireLogin,requireDashboard,(req,res)=>{
  try{
   const employee=req.v2Employee||loadCurrentEmployee(db,req.session?.employee),s=Number(employee?.shop_id||0),e=Number(employee?.id||0);if(!employee||!validId(s)||!validId(e))return res.status(401).json({error:'Employee session is no longer valid for this shop.'});const live=loadCurrentEmployee(db,req.session?.employee);if(!live||Number(live.id)!==e||Number(live.shop_id)!==s)return res.status(401).json({error:'Employee session is no longer valid for this shop.'});req.v2Employee=employee;req.v2ShopId=s;
   res.set('Cache-Control','no-store, private, max-age=0');res.set('Pragma','no-cache');res.set('Expires','0');res.set('X-Content-Type-Options','nosniff');
   const today=exists('appointments')?one(`SELECT COUNT(*) appointments FROM appointments WHERE shop_id=? AND date(appointment_date)=date('now','localtime')`,s):{};
   const active=exists('repair_orders')?one(`SELECT COUNT(*) active FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id WHERE r.shop_id=? AND r.status!='completed' AND (r.vehicle_id IS NULL OR v.id IS NOT NULL)`,s):{};
   const ready=exists('repair_orders')?one(`SELECT COUNT(*) ready FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id WHERE r.shop_id=? AND LOWER(COALESCE(r.workflow_status,''))='ready' AND (r.vehicle_id IS NULL OR v.id IS NOT NULL)`,s):{};
   const deferred=exists('deferred_services')?one(`SELECT COUNT(*) count,COALESCE(SUM(d.estimated_total),0) value FROM deferred_services d JOIN customers c ON c.id=d.customer_id AND c.shop_id=d.shop_id LEFT JOIN vehicles v ON v.id=d.vehicle_id AND v.shop_id=d.shop_id WHERE d.shop_id=? AND d.status IN('deferred','scheduled') AND (d.vehicle_id IS NULL OR v.id IS NOT NULL)`,s):{};
   const low=exists('inventory_items')?one(`SELECT COUNT(*) count FROM inventory_items WHERE shop_id=? AND active=1 AND quantity<=reorder_level`,s):{};
   const out=exists('inventory_items')?one(`SELECT COUNT(*) count FROM inventory_items WHERE shop_id=? AND active=1 AND quantity<=0`,s):{};
   const parts=exists('v2_parts_requests')?one(`SELECT COUNT(*) count FROM v2_parts_requests p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id WHERE p.shop_id=? AND p.status IN('requested','ordered')`,s):{};
   const overdueParts=exists('v2_parts_requests')?one(`SELECT COUNT(*) count FROM v2_parts_requests p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id WHERE p.shop_id=? AND p.status='ordered' AND p.eta IS NOT NULL AND datetime(p.eta)<datetime('now','localtime')`,s):{};
   const purchase=exists('purchase_orders')?one(`SELECT COUNT(*) count FROM purchase_orders WHERE shop_id=? AND status IN('draft','ordered','partial')`,s):{};
   const blockers=exists('v2_ro_blockers')?one(`SELECT COUNT(*) count FROM v2_ro_blockers b JOIN repair_orders r ON r.id=b.repair_order_id AND r.shop_id=b.shop_id WHERE b.shop_id=? AND b.status='open'`,s):{};
   const comeback=exists('v2_comebacks')?one(`SELECT COALESCE(SUM(CASE WHEN cb.status IN('open','in_progress') THEN 1 ELSE 0 END),0) open_count,COALESCE(SUM(cb.labor_cost+cb.parts_cost),0) total_cost FROM v2_comebacks cb JOIN repair_orders r ON r.id=cb.repair_order_id AND r.shop_id=cb.shop_id WHERE cb.shop_id=?`,s):{};
   return res.json({appointments_today:Number(today.appointments||0),active_repair_orders:Number(active.active||0),ready_for_pickup:Number(ready.ready||0),deferred_count:Number(deferred.count||0),deferred_value:Number(deferred.value||0),low_stock:Number(low.count||0),out_of_stock:Number(out.count||0),parts_waiting:Number(parts.count||0),overdue_parts:Number(overdueParts.count||0),open_purchase_orders:Number(purchase.count||0),open_blockers:Number(blockers.count||0),open_comebacks:Number(comeback.open_count||0),comeback_cost:Number(comeback.total_cost||0)});
  }catch(err){console.error('Garavex V2 KPI error:',err);return res.status(500).json({error:'Unable to load dashboard KPIs.'});}
 });
}
module.exports={installV2DashboardKpis};
