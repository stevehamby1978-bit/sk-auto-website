'use strict';
const {loadCurrentEmployee}=require('./v2-permissions');
function installV2Preflight(app,db,{requireLogin,requireOwner}){
 if(!app||!db||!requireLogin||!requireOwner)throw new Error('V2 preflight requires app, db, and auth middleware.');
 const table=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
 const column=(name,col)=>table(name)&&db.prepare(`PRAGMA table_info(${name})`).all().some(c=>c.name===col);
 const validId=value=>Number.isInteger(value)&&value>0;
 app.get('/api/v2/preflight',requireLogin,requireOwner,(req,res)=>{
  try{
   res.set('Cache-Control','no-store, private, max-age=0');res.set('Pragma','no-cache');res.set('Expires','0');
   const employee=loadCurrentEmployee(db,req.session?.employee),shopId=Number(employee?.shop_id||0),employeeId=Number(employee?.id||0);
   if(!employee||!validId(shopId)||!validId(employeeId))return res.status(401).json({ok:false,ready:false,error:'Employee session is no longer valid for this shop.'});
   const requiredTables=['shops','employees','customers','vehicles','repair_orders','repair_order_items','repair_order_payments','estimates','estimate_items','bookings','dvi_inspections','dvi_items','dvi_attachments','technician_time_entries','deferred_services','inventory_items','vendors','purchase_orders','purchase_order_items','canned_jobs','audit_log','customer_portal_tokens','v2_comebacks','v2_tasks','v2_ro_blockers','v2_ro_promises','v2_parts_requests','v2_vehicle_keys','v2_road_tests','v2_deliveries','v2_customer_requests','v2_shop_handoffs','v2_loaners','v2_loaner_assignments','v2_warranties'];
   const missingTables=requiredTables.filter(name=>!table(name));
   const parentOwnedTables=new Set(['repair_order_items','estimate_items']);
   const scopedTables=requiredTables.filter(name=>name!=='shops'&&!parentOwnedTables.has(name));
   const missingShopScope=scopedTables.filter(name=>table(name)&&!column(name,'shop_id'));
   const shop=db.prepare(`SELECT id,name,stripe_account_id,stripe_connected_at FROM shops WHERE id=? LIMIT 1`).get(shopId);
   const stripeServerConfigured=Boolean(String(process.env.STRIPE_SECRET_KEY||'').trim());
   const stripeWebhookConfigured=Boolean(String(process.env.STRIPE_WEBHOOK_SECRETS||process.env.STRIPE_WEBHOOK_SECRET||'').trim());
   const sessionSecret=String(process.env.SESSION_SECRET||'');
   const sessionSecretConfigured=sessionSecret.trim().length>=32;
   const checks={
    shop:Boolean(shop),
    schema:missingTables.length===0,
    shopScoping:missingShopScope.length===0,
    sessionShopMatches:Boolean(db.prepare(`SELECT id FROM employees WHERE id=? AND shop_id=? AND active=1`).get(employeeId,shopId)),
    stripeServerConfigured,
    stripeWebhookConfigured,
    sessionSecretConfigured,
    stripeAccountConfigured:Boolean(shop?.stripe_account_id),
    stripeConnected:Boolean(shop?.stripe_connected_at)
   };
   const critical=['shop','schema','shopScoping','sessionShopMatches','stripeServerConfigured','stripeWebhookConfigured','sessionSecretConfigured','stripeAccountConfigured','stripeConnected'];
   const blockers=critical.filter(key=>!checks[key]);
   const ready=blockers.length===0;
   req.v2Employee=employee;req.v2ShopId=shopId;
   return res.json({ok:ready,ready,shop:{id:shopId,name:shop?.name||null},payment_provider:'stripe',checks,blockers,missingTables,missingShopScope,timestamp:new Date().toISOString()});
  }catch(err){console.error('V2 preflight error:',err);return res.status(500).json({ok:false,ready:false,error:'Unable to run V2 preflight checks.'});}
 });
}
module.exports={installV2Preflight};
