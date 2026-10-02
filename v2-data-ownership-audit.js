'use strict';
/* Read-only Garavex V2 tenant ownership audit. Never mutates customer data. */
const path=require('path');
const Database=require('better-sqlite3');
const dbPath=path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'bookings.db');
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
function exists(name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function has(name,col){return exists(name)&&db.prepare(`PRAGMA table_info(${name})`).all().some(c=>c.name===col);}
function groups(table){if(!exists(table))return {missing:true};if(!has(table,'shop_id'))return {no_shop_id:true,total:Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n||0)};const rows=db.prepare(`SELECT COALESCE(CAST(shop_id AS TEXT),'NULL') shop_id,COUNT(*) count FROM ${table} GROUP BY shop_id ORDER BY shop_id`).all();return Object.fromEntries(rows.map(r=>[String(r.shop_id),Number(r.count)]));}
try{const shops=exists('shops')?db.prepare('SELECT id,slug,active FROM shops ORDER BY id').all():[];const report={read_only:true,shops:shops.map(s=>({id:s.id,slug:s.slug,active:s.active})),tables:{}};for(const table of ['employees','customers','bookings','vehicles','estimates','repair_orders','repair_order_payments','inventory_items','v2_loaners','v2_loaner_assignments'])report.tables[table]=groups(table);
const zwickl=245;report.zwickl_test_records={};
if(exists('customers'))report.zwickl_test_records.customers=db.prepare('SELECT id,name FROM customers WHERE shop_id=? ORDER BY id').all(zwickl);
if(exists('bookings'))report.zwickl_test_records.bookings=db.prepare('SELECT id,name,date,time FROM bookings WHERE shop_id=? ORDER BY id').all(zwickl);
if(exists('vehicles'))report.zwickl_test_records.vehicles=db.prepare('SELECT id,customer_id,year,make,model FROM vehicles WHERE shop_id=? ORDER BY id').all(zwickl);
if(exists('estimates'))report.zwickl_test_records.estimates=db.prepare('SELECT id,customer_id,vehicle_id FROM estimates WHERE shop_id=? ORDER BY id').all(zwickl);
if(exists('repair_orders'))report.zwickl_test_records.repair_orders=db.prepare('SELECT id,customer_id,vehicle_id,status FROM repair_orders WHERE shop_id=? ORDER BY id').all(zwickl);
if(exists('inventory_items'))report.zwickl_test_records.inventory=db.prepare('SELECT id,sku,name,quantity FROM inventory_items WHERE shop_id=? ORDER BY id').all(zwickl);
if(exists('v2_loaners'))report.zwickl_test_records.loaners=db.prepare('SELECT id,name,year,make,model,plate,vin,status,active FROM v2_loaners WHERE shop_id=? ORDER BY id').all(zwickl);
console.log('GARAVEX_DATA_OWNERSHIP_AUDIT '+JSON.stringify(report));}catch(err){console.error('GARAVEX_DATA_OWNERSHIP_AUDIT_FAILED',err.message);process.exitCode=1;}finally{db.close();}
