function installV2ReleaseTests(app,db,{requireLogin,requireOwner}){
 const exists=(table)=>Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table));
 const cols=(table)=>exists(table)?db.prepare(`PRAGMA table_info(${table})`).all():[];
 app.get('/api/v2/release-tests',requireLogin,requireOwner,(req,res)=>{
  const shopId=Number(req.session.employee.shop_id);
  const scoped=['customers','vehicles','repair_orders','appointments','employees','deferred_services','inventory_parts','vendors','purchase_orders','audit_log','v2_comebacks'];
  const isolation=scoped.map(table=>{if(!exists(table))return {table,ok:false,detail:'table missing'};const has=cols(table).some(c=>c.name==='shop_id');return {table,ok:has,detail:has?'shop_id present':'shop_id missing'};});
  const orphanChecks=[];
  const run=(name,sql)=>{try{const n=Number(db.prepare(sql).get()?.n||0);orphanChecks.push({name,ok:n===0,count:n});}catch(e){orphanChecks.push({name,ok:false,count:null,error:e.message});}};
  run('Vehicles linked across shops',`SELECT COUNT(*) n FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE v.shop_id!=c.shop_id`);
  run('Repair orders linked across shops',`SELECT COUNT(*) n FROM repair_orders r JOIN customers c ON c.id=r.customer_id WHERE r.shop_id!=c.shop_id`);
  run('Repair-order vehicles linked across shops',`SELECT COUNT(*) n FROM repair_orders r JOIN vehicles v ON v.id=r.vehicle_id WHERE r.shop_id!=v.shop_id`);
  if(exists('deferred_services'))run('Deferred services linked across shops',`SELECT COUNT(*) n FROM deferred_services d JOIN customers c ON c.id=d.customer_id WHERE d.shop_id!=c.shop_id`);
  if(exists('v2_comebacks'))run('Comebacks linked across shops',`SELECT COUNT(*) n FROM v2_comebacks cb JOIN customers c ON c.id=cb.customer_id WHERE cb.shop_id!=c.shop_id`);
  const currentShop={id:shopId,customers:db.prepare(`SELECT COUNT(*) n FROM customers WHERE shop_id=?`).get(shopId)?.n||0,repair_orders:db.prepare(`SELECT COUNT(*) n FROM repair_orders WHERE shop_id=?`).get(shopId)?.n||0};
  const checks=[{label:'All critical tables are shop-scoped',ok:isolation.every(x=>x.ok)},{label:'No detected cross-shop relationships',ok:orphanChecks.every(x=>x.ok)},{label:'Current session has shop scope',ok:Boolean(shopId)}];
  res.json({ok:checks.every(x=>x.ok),checks,isolation,orphan_checks:orphanChecks,current_shop:currentShop,timestamp:new Date().toISOString()});
 });
}
module.exports={installV2ReleaseTests};
