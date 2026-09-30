function installV2WorkflowGuards(app,db,{requireLogin}){
 const sid=req=>Number(req.session.employee.shop_id);
 const tableExists=name=>!!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
 app.get('/api/v2/repair-orders/:id/completion-check',requireLogin,(req,res)=>{const shop=sid(req),id=Number(req.params.id);const ro=db.prepare(`SELECT id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(id,shop);if(!ro)return res.status(404).json({error:'Repair order not found.'});const checks=[];
  if(tableExists('v2_ro_blockers')){const n=db.prepare(`SELECT COUNT(*) n FROM v2_ro_blockers WHERE shop_id=? AND repair_order_id=? AND status='open'`).get(shop,id).n;checks.push({key:'blockers',ok:n===0,label:n?`${n} open blocker(s)`:'No open blockers'});}
  if(tableExists('v2_parts_requests')){const n=db.prepare(`SELECT COUNT(*) n FROM v2_parts_requests WHERE shop_id=? AND repair_order_id=? AND status IN ('requested','ordered','received')`).get(shop,id).n;checks.push({key:'parts',ok:n===0,label:n?`${n} parts request(s) not installed`:'Parts requests complete'});}
  if(tableExists('v2_road_tests')){const n=db.prepare(`SELECT COUNT(*) n FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND status='in_progress'`).get(shop,id).n;checks.push({key:'road_test_open',ok:n===0,label:n?'Road test still in progress':'No road test in progress'});const fail=db.prepare(`SELECT COUNT(*) n FROM v2_road_tests WHERE shop_id=? AND repair_order_id=? AND result='failed' AND completed_at=(SELECT MAX(completed_at) FROM v2_road_tests WHERE shop_id=? AND repair_order_id=?)`).get(shop,id,shop,id).n;checks.push({key:'road_test_result',ok:fail===0,label:fail?'Latest road test failed':'Road test result clear'});}
  if(tableExists('v2_vehicle_keys')){const k=db.prepare(`SELECT status FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=?`).get(shop,id);checks.push({key:'key',ok:!k||k.status!=='missing',label:k?.status==='missing'?'Vehicle key marked missing':'Vehicle key accounted for'});}
  const blocking=checks.filter(x=>!x.ok);res.json({repair_order_id:id,ready:blocking.length===0,checks,blocking});
 });
}
module.exports={installV2WorkflowGuards};
