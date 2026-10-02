/* Garavex V1 one-time customer ownership repair.
 * Repairs the known Thomas Eubanks record only when there is exactly one
 * matching customer row and it is assigned outside the primary S&K Auto shop.
 * Related tenant-scoped records and matching appointments are moved with the customer.
 */
const path=require('path');
const fs=require('fs');
const Database=require('better-sqlite3');

const dataDir=process.env.DATA_DIR||path.join(__dirname,'data');
fs.mkdirSync(dataDir,{recursive:true});
const dbPath=path.join(dataDir,'bookings.db');

function tableExists(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function cols(db,name){return tableExists(db,name)?new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(c=>c.name)):new Set();}

setImmediate(()=>{
 const db=new Database(dbPath);
 try{
  if(!tableExists(db,'shops')||!tableExists(db,'customers'))return;
  const skShop=db.prepare("SELECT id,name FROM shops WHERE slug='sk-auto' LIMIT 1").get()||db.prepare("SELECT id,name FROM shops WHERE LOWER(TRIM(name))='s&k auto' ORDER BY id LIMIT 1").get();
  if(!skShop){console.warn('V1 customer data repair: primary S&K shop not found; no changes made.');return;}
  const matches=db.prepare("SELECT id,name,shop_id FROM customers WHERE LOWER(TRIM(name))='thomas eubanks' ORDER BY id").all();
  let customerMove=0,customerId=null;
  if(matches.length===1){const customer=matches[0];customerId=Number(customer.id);if(Number(customer.shop_id)!==Number(skShop.id)){const tx=db.transaction(()=>{const v=cols(db,'vehicles');if(v.has('customer_id')&&v.has('shop_id'))db.prepare('UPDATE vehicles SET shop_id=? WHERE customer_id=?').run(skShop.id,customer.id);const e=cols(db,'estimates');if(e.has('customer_id')&&e.has('shop_id'))db.prepare('UPDATE estimates SET shop_id=? WHERE customer_id=?').run(skShop.id,customer.id);const r=cols(db,'repair_orders');if(r.has('customer_id')&&r.has('shop_id'))db.prepare('UPDATE repair_orders SET shop_id=? WHERE customer_id=?').run(skShop.id,customer.id);customerMove=Number(db.prepare('UPDATE customers SET shop_id=? WHERE id=?').run(skShop.id,customer.id).changes||0);});tx();}}else if(matches.length>1)console.warn('V1 customer data repair: multiple Thomas Eubanks customer records found; customer reassignment skipped.');
  let appointmentMoves=0;if(tableExists(db,'bookings')&&cols(db,'bookings').has('shop_id')&&cols(db,'bookings').has('name'))appointmentMoves=Number(db.prepare("UPDATE bookings SET shop_id=? WHERE LOWER(TRIM(name))='thomas eubanks' AND (shop_id IS NULL OR shop_id<>?)").run(skShop.id,skShop.id).changes||0);
  function repair(table){if(!tableExists(db,table))return 0;const tc=cols(db,table),cc=cols(db,'customers');if(!tc.has('customer_id')||!tc.has('shop_id')||!cc.has('shop_id'))return 0;return Number(db.prepare(`UPDATE ${table} SET shop_id=(SELECT c.shop_id FROM customers c WHERE c.id=${table}.customer_id) WHERE customer_id IS NOT NULL AND EXISTS(SELECT 1 FROM customers c WHERE c.id=${table}.customer_id AND c.shop_id IS NOT NULL AND (${table}.shop_id IS NULL OR ${table}.shop_id<>c.shop_id))`).run().changes||0);}
  const repairedVehicles=repair('vehicles'),repairedEstimates=repair('estimates'),repairedRepairOrders=repair('repair_orders');
  let repairedEstimateOrders=0;if(tableExists(db,'repair_orders')&&tableExists(db,'estimates')){const r=cols(db,'repair_orders'),e=cols(db,'estimates');if(r.has('estimate_id')&&r.has('shop_id')&&e.has('shop_id'))repairedEstimateOrders=Number(db.prepare('UPDATE repair_orders SET shop_id=(SELECT e.shop_id FROM estimates e WHERE e.id=repair_orders.estimate_id) WHERE estimate_id IS NOT NULL AND EXISTS(SELECT 1 FROM estimates e WHERE e.id=repair_orders.estimate_id AND e.shop_id IS NOT NULL AND (repair_orders.shop_id IS NULL OR repair_orders.shop_id<>e.shop_id))').run().changes||0);}
  console.log(`V1 Thomas Eubanks ownership repair: customer_id=${customerId||'none'}, customer rows moved=${customerMove}, appointment rows moved=${appointmentMoves}, vehicles repaired=${repairedVehicles}, estimates repaired=${repairedEstimates}, repair orders repaired=${repairedRepairOrders}, estimate-linked repair orders repaired=${repairedEstimateOrders}, target shop #${skShop.id} (${skShop.name}).`);
 }catch(err){console.error('V1 customer data repair failed:',err);}finally{db.close();}
});
