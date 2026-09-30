'use strict';
function installV2Preflight(app,db,{requireLogin,requireOwner}){
 if(!app||!db||!requireLogin||!requireOwner)throw new Error('V2 preflight requires app, db, and auth middleware.');
 const table=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
 const column=(name,col)=>table(name)&&db.prepare(`PRAGMA table_info(${name})`).all().some(c=>c.name===col);
 app.get('/api/v2/preflight',requireLogin,requireOwner,(req,res)=>{
  try{
   const shopId=Number(req.session?.employee?.shop_id||0);
   if(!Number.isInteger(shopId)||shopId<=0)return res.status(401).json({ok:false,error:'A valid shop session is required.'});
   const requiredTables=['shops','employees','customers','vehicles','repair_orders','dvi_inspections','dvi_items','technician_time_entries','deferred_services','inventory_items','vendors','purchase_orders','customer_portal_tokens','audit_log'];
   const missingTables=requiredTables.filter(name=>!table(name));
   const scopedTables=requiredTables.filter(name=>!['shops'].includes(name));
   const missingShopScope=scopedTables.filter(name=>table(name)&&!column(name,'shop_id'));
   const shop=db.prepare(`SELECT id,name,stripe_account_id,stripe_connected_at FROM shops WHERE id=? LIMIT 1`).get(shopId);
   const checks={
    shop:Boolean(shop),
    schema:missingTables.length===0,
    shopScoping:missingShopScope.length===0,
    stripeConfigured:Boolean(shop?.stripe_account_id),
    stripeConnected:Boolean(shop?.stripe_connected_at),
    sessionShopMatches:Boolean(db.prepare(`SELECT id FROM employees WHERE id=? AND shop_id=? AND active=1`).get(Number(req.session?.employee?.id||0),shopId))
   };
   const critical=['shop','schema','shopScoping','sessionShopMatches'];
   const ready=critical.every(key=>checks[key]);
   res.set('Cache-Control','no-store, private, max-age=0');
   return res.json({ok:true,ready,shop:{id:shopId,name:shop?.name||null},checks,missingTables,missingShopScope});
  }catch(err){console.error('V2 preflight error:',err);return res.status(500).json({ok:false,error:'Unable to run V2 preflight checks.'});}
 });
}
module.exports={installV2Preflight};
