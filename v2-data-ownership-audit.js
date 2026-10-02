'use strict';
/* Read-only Garavex V2 tenant ownership audit. Never mutates customer data. */
const path=require('path');
const Database=require('better-sqlite3');
const dbPath=path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'bookings.db');
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
function exists(name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function has(name,col){return exists(name)&&db.prepare(`PRAGMA table_info(${name})`).all().some(c=>c.name===col);}
function groups(table){if(!exists(table))return {missing:true};if(!has(table,'shop_id'))return {no_shop_id:true,total:Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n||0)};const rows=db.prepare(`SELECT COALESCE(CAST(shop_id AS TEXT),'NULL') shop_id,COUNT(*) count FROM ${table} GROUP BY shop_id ORDER BY shop_id`).all();return Object.fromEntries(rows.map(r=>[String(r.shop_id),Number(r.count)]));}
try{const shops=exists('shops')?db.prepare('SELECT id,name,slug,active FROM shops ORDER BY id').all():[];const report={database:dbPath,read_only:true,shops,tables:{}};for(const table of ['customers','bookings','vehicles','estimates','repair_orders','repair_order_payments'])report.tables[table]=groups(table);console.log('GARAVEX_DATA_OWNERSHIP_AUDIT '+JSON.stringify(report));}catch(err){console.error('GARAVEX_DATA_OWNERSHIP_AUDIT_FAILED',err.message);process.exitCode=1;}finally{db.close();}
