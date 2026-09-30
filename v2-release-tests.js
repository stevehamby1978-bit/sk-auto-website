function installV2ReleaseTests(app,db,{requireLogin,requireOwner}){
 const exists=table=>Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table));
 const cols=table=>exists(table)?db.prepare(`PRAGMA table_info(${table})`).all():[];
 const hasCol=(table,col)=>cols(table).some(c=>c.name===col);
 app.get('/api/v2/release-tests',requireLogin,requireOwner,(req,res)=>{
  const shopId=Number(req.session.employee.shop_id);
  const scoped=['customers','vehicles','repair_orders','appointments','employees','dvi_inspections','dvi_items','dvi_attachments','technician_time_entries','deferred_services','inventory_items','vendors','purchase_orders','purchase_order_items','canned_jobs','audit_log','customer_portal_tokens','v2_comebacks','v2_tasks','v2_ro_blockers','v2_ro_promises','v2_parts_requests','v2_vehicle_keys','v2_road_tests','v2_deliveries','v2_customer_requests','v2_shop_handoffs'];
  const isolation=scoped.map(table=>{if(!exists(table))return {table,ok:false,detail:'table missing'};const has=hasCol(table,'shop_id');return {table,ok:has,detail:has?'shop_id present':'shop_id missing'};});
  const dataChecks=[];
  const run=(name,sql)=>{try{const n=Number(db.prepare(sql).get()?.n||0);dataChecks.push({name,ok:n===0,count:n});}catch(e){dataChecks.push({name,ok:false,count:null,error:e.message});}};
  const link=(name,child,childKey,parent,parentKey='id')=>{if(exists(child)&&exists(parent)&&hasCol(child,'shop_id')&&hasCol(parent,'shop_id')&&hasCol(child,childKey))run(name,`SELECT COUNT(*) n FROM ${child} c JOIN ${parent} p ON p.${parentKey}=c.${childKey} WHERE c.${childKey} IS NOT NULL AND c.shop_id!=p.shop_id`);};

  link('Vehicles linked across shops','vehicles','customer_id','customers');
  link('Repair orders linked to customers across shops','repair_orders','customer_id','customers');
  link('Repair orders linked to vehicles across shops','repair_orders','vehicle_id','vehicles');
  link('DVI inspections linked to repair orders across shops','dvi_inspections','repair_order_id','repair_orders');
  link('DVI inspections linked to customers across shops','dvi_inspections','customer_id','customers');
  link('DVI inspections linked to vehicles across shops','dvi_inspections','vehicle_id','vehicles');
  link('DVI items linked to inspections across shops','dvi_items','inspection_id','dvi_inspections');
  link('DVI attachments linked to inspections across shops','dvi_attachments','inspection_id','dvi_inspections');
  link('Technician time linked to repair orders across shops','technician_time_entries','repair_order_id','repair_orders');
  link('Deferred services linked to customers across shops','deferred_services','customer_id','customers');
  link('Deferred services linked to vehicles across shops','deferred_services','vehicle_id','vehicles');
  link('Deferred services linked to repair orders across shops','deferred_services','repair_order_id','repair_orders');
  link('Inventory linked to vendors across shops','inventory_items','vendor_id','vendors');
  link('Purchase orders linked to vendors across shops','purchase_orders','vendor_id','vendors');
  link('Purchase orders linked to repair orders across shops','purchase_orders','repair_order_id','repair_orders');
  link('Purchase-order items linked across shops','purchase_order_items','purchase_order_id','purchase_orders');
  link('Portal tokens linked to customers across shops','customer_portal_tokens','customer_id','customers');

  const child=[['v2_tasks','repair_order_id'],['v2_ro_blockers','repair_order_id'],['v2_ro_promises','repair_order_id'],['v2_parts_requests','repair_order_id'],['v2_vehicle_keys','repair_order_id'],['v2_road_tests','repair_order_id'],['v2_deliveries','repair_order_id'],['v2_customer_requests','repair_order_id']];
  child.forEach(([t,c])=>link(`${t} linked across shops`,t,c,'repair_orders'));

  if(exists('dvi_items'))run('DVI items with invalid condition',`SELECT COUNT(*) n FROM dvi_items WHERE condition NOT IN ('green','yellow','red')`);
  if(exists('dvi_items'))run('DVI items with invalid customer decision',`SELECT COUNT(*) n FROM dvi_items WHERE customer_decision NOT IN ('pending','approved','declined')`);
  if(exists('technician_time_entries'))run('Technician time with negative minutes',`SELECT COUNT(*) n FROM technician_time_entries WHERE minutes IS NOT NULL AND minutes<0`);
  if(exists('customer_portal_tokens'))run('Duplicate active portal tokens',`SELECT COUNT(*) n FROM (SELECT token FROM customer_portal_tokens WHERE revoked_at IS NULL GROUP BY token HAVING COUNT(*)>1)`);
  if(exists('dvi_inspections'))run('Duplicate DVI public tokens',`SELECT COUNT(*) n FROM (SELECT public_token FROM dvi_inspections WHERE public_token IS NOT NULL GROUP BY public_token HAVING COUNT(*)>1)`);
  if(exists('v2_deliveries'))run('Delivered records without delivered workflow state',`SELECT COUNT(*) n FROM v2_deliveries d JOIN repair_orders r ON r.id=d.repair_order_id AND r.shop_id=d.shop_id WHERE d.delivered_at IS NOT NULL AND COALESCE(r.workflow_status,'')!='delivered'`);
  if(exists('v2_vehicle_keys'))run('Delivered ROs with missing keys',`SELECT COUNT(*) n FROM repair_orders r JOIN v2_vehicle_keys k ON k.repair_order_id=r.id AND k.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND k.status='missing'`);
  if(exists('v2_ro_blockers'))run('Delivered ROs with open blockers',`SELECT COUNT(*) n FROM repair_orders r JOIN v2_ro_blockers b ON b.repair_order_id=r.id AND b.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND b.status='open'`);
  if(exists('v2_parts_requests'))run('Delivered ROs with unfinished parts',`SELECT COUNT(*) n FROM repair_orders r JOIN v2_parts_requests p ON p.repair_order_id=r.id AND p.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND p.status IN ('requested','ordered','received')`);

  const currentShop={id:shopId,customers:shopId&&exists('customers')?db.prepare(`SELECT COUNT(*) n FROM customers WHERE shop_id=?`).get(shopId)?.n||0:0,repair_orders:shopId&&exists('repair_orders')?db.prepare(`SELECT COUNT(*) n FROM repair_orders WHERE shop_id=?`).get(shopId)?.n||0:0};
  const checks=[{label:'All critical V2 tables are shop-scoped',ok:isolation.every(x=>x.ok)},{label:'No detected cross-shop or workflow integrity problems',ok:dataChecks.every(x=>x.ok)},{label:'Current session has shop scope',ok:Number.isInteger(shopId)&&shopId>0}];
  res.json({ok:checks.every(x=>x.ok),checks,isolation,data_checks:dataChecks,current_shop:currentShop,timestamp:new Date().toISOString()});
 });
}
module.exports={installV2ReleaseTests};
