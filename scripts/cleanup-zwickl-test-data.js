'use strict';
const path=require('path');
const Database=require('better-sqlite3');
const dbPath=path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'bookings.db');
const db=new Database(dbPath);
const SHOP=245,CUSTOMER=17,BOOKING=17,ESTIMATE=10,RO=28,INVENTORY=1,LOANER=1;
const exists=t=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const cols=t=>exists(t)?new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(x=>x.name)):new Set();
const del=(t,where,args=[])=>{if(!exists(t))return 0;return db.prepare(`DELETE FROM ${t} WHERE ${where}`).run(...args).changes;};
try{
 const shop=db.prepare("SELECT id,slug FROM shops WHERE id=?").get(SHOP);
 if(!shop||shop.slug!=='zwickl-repair-llc')throw new Error('Safety stop: Zwickl shop 245 not found.');
 const customer=db.prepare("SELECT id,name,shop_id FROM customers WHERE id=? AND shop_id=?").get(CUSTOMER,SHOP);
 const booking=db.prepare("SELECT id,name,shop_id FROM bookings WHERE id=? AND shop_id=?").get(BOOKING,SHOP);
 const estimate=db.prepare("SELECT id,customer_id,vehicle_id,shop_id FROM estimates WHERE id=? AND shop_id=?").get(ESTIMATE,SHOP);
 const ro=db.prepare("SELECT id,customer_id,vehicle_id,shop_id FROM repair_orders WHERE id=? AND shop_id=?").get(RO,SHOP);
 const inv=db.prepare("SELECT id,part_number,description,shop_id FROM inventory_items WHERE id=? AND shop_id=?").get(INVENTORY,SHOP);
 const loaner=db.prepare("SELECT id,name,vin,shop_id FROM v2_loaners WHERE id=? AND shop_id=?").get(LOANER,SHOP);
 if(!customer||customer.name!=='V-2 Test Customer')throw new Error('Safety stop: expected test customer mismatch.');
 if(!booking||booking.name!=='V-2 Test Customer')throw new Error('Safety stop: expected test booking mismatch.');
 if(!estimate||estimate.customer_id!==CUSTOMER)throw new Error('Safety stop: expected test estimate mismatch.');
 if(!ro||ro.customer_id!==CUSTOMER)throw new Error('Safety stop: expected test RO mismatch.');
 if(!inv||String(inv.description)!=='Test Oil Filters')throw new Error('Safety stop: expected test inventory mismatch.');
 if(!loaner||String(loaner.vin)!=='TESTLOANER001')throw new Error('Safety stop: expected test loaner mismatch.');
 const out=db.transaction(()=>{
   const deleted={};
   for(const t of ['customer_communication_history','invoice_email_history','repair_order_recommendations','repair_order_payments','repair_order_items']){
     const c=cols(t); if(c.has('repair_order_id'))deleted[t]=del(t,'repair_order_id=?',[RO]);
   }
   if(cols('v2_loaner_assignments').has('repair_order_id'))deleted.v2_loaner_assignments=del('v2_loaner_assignments','shop_id=? AND repair_order_id=?',[SHOP,RO]);
   if(cols('booking_photos').has('booking_id'))deleted.booking_photos=del('booking_photos','booking_id=?',[BOOKING]);
   if(cols('estimate_items').has('estimate_id'))deleted.estimate_items=del('estimate_items','estimate_id=?',[ESTIMATE]);
   deleted.repair_orders=del('repair_orders','id=? AND shop_id=?',[RO,SHOP]);
   deleted.estimates=del('estimates','id=? AND shop_id=?',[ESTIMATE,SHOP]);
   deleted.bookings=del('bookings','id=? AND shop_id=?',[BOOKING,SHOP]);
   deleted.inventory_items=del('inventory_items','id=? AND shop_id=?',[INVENTORY,SHOP]);
   deleted.v2_loaners=del('v2_loaners','id=? AND shop_id=?',[LOANER,SHOP]);
   deleted.vehicles=del('vehicles','customer_id=? AND shop_id=?',[CUSTOMER,SHOP]);
   deleted.customers=del('customers','id=? AND shop_id=?',[CUSTOMER,SHOP]);
   return deleted;
 })();
 console.log('GARAVEX_ZWICKL_TEST_CLEANUP_OK '+JSON.stringify(out));
}catch(e){console.error('GARAVEX_ZWICKL_TEST_CLEANUP_FAILED '+e.message);process.exitCode=1;}finally{db.close();}
