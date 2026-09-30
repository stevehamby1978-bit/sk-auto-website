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

function tableExists(db,name){
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function cols(db,name){
  return tableExists(db,name)?new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(c=>c.name)):new Set();
}

setImmediate(()=>{
  const db=new Database(dbPath);
  try{
    if(!tableExists(db,'shops')||!tableExists(db,'customers'))return;

    const skShop=
      db.prepare("SELECT id,name FROM shops WHERE slug='sk-auto' LIMIT 1").get() ||
      db.prepare("SELECT id,name FROM shops WHERE LOWER(TRIM(name))='s&k auto' ORDER BY id LIMIT 1").get();

    if(!skShop){
      console.warn('V1 customer data repair: primary S&K shop not found; no changes made.');
      return;
    }

    const matches=db.prepare(`
      SELECT id,name,shop_id
      FROM customers
      WHERE LOWER(TRIM(name))='thomas eubanks'
      ORDER BY id
    `).all();

    let customerMove=0;
    let customerId=null;

    if(matches.length===1){
      const customer=matches[0];
      customerId=Number(customer.id);

      if(Number(customer.shop_id)!==Number(skShop.id)){
        const tx=db.transaction(()=>{
          const vehicleCols=cols(db,'vehicles');
          if(vehicleCols.has('customer_id')&&vehicleCols.has('shop_id')){
            db.prepare('UPDATE vehicles SET shop_id=? WHERE customer_id=?').run(skShop.id,customer.id);
          }

          const estimateCols=cols(db,'estimates');
          if(estimateCols.has('customer_id')&&estimateCols.has('shop_id')){
            db.prepare('UPDATE estimates SET shop_id=? WHERE customer_id=?').run(skShop.id,customer.id);
          }

          const roCols=cols(db,'repair_orders');
          if(roCols.has('customer_id')&&roCols.has('shop_id')){
            db.prepare('UPDATE repair_orders SET shop_id=? WHERE customer_id=?').run(skShop.id,customer.id);
          }

          customerMove=Number(db.prepare('UPDATE customers SET shop_id=? WHERE id=?').run(skShop.id,customer.id).changes||0);
        });
        tx();
      }
    }else if(matches.length>1){
      console.warn('V1 customer data repair: multiple Thomas Eubanks customer records found; customer reassignment skipped.');
    }

    let appointmentMoves=0;
    if(tableExists(db,'bookings')&&cols(db,'bookings').has('shop_id')&&cols(db,'bookings').has('name')){
      appointmentMoves=Number(db.prepare(`
        UPDATE bookings
        SET shop_id=?
        WHERE LOWER(TRIM(name))='thomas eubanks'
          AND (shop_id IS NULL OR shop_id<>?)
      `).run(skShop.id,skShop.id).changes||0);
    }

    console.log(`V1 Thomas Eubanks ownership repair: customer_id=${customerId||'none'}, customer rows moved=${customerMove}, appointment rows moved=${appointmentMoves}, target shop #${skShop.id} (${skShop.name}).`);
  }catch(err){
    console.error('V1 customer data repair failed:',err);
  }finally{
    db.close();
  }
});
