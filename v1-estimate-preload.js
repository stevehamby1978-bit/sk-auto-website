/* Garavex V1 tenant-aware estimate creation + notification route. */
const path=require('path'),Database=require('better-sqlite3'),express=require('express'),crypto=require('crypto'),twilio=require('twilio');
const db=new Database(path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'bookings.db'));
function sid(req){const n=Number(req.session?.employee?.shop_id);return Number.isInteger(n)&&n>0?n:null;}
function phone(v){const d=String(v||'').replace(/\D/g,'');return d.length===10?`+1${d}`:d.length===11&&d[0]==='1'?`+${d}`:null;}
function appUrl(){return String(process.env.PUBLIC_APP_URL||'https://app.garavex.com').trim().replace(/\/$/,'');}
function sms(){if(!process.env.TWILIO_ACCOUNT_SID||!process.env.TWILIO_AUTH_TOKEN||!process.env.TWILIO_PHONE_NUMBER)return null;return twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);}
async function createEstimate(req,res){try{
 const shopId=sid(req);if(!shopId)return res.status(401).json({error:'Not authorized.'});
 const {customer={},vehicle={},notes='',items=[]}=req.body||{},name=String(customer.name||'').trim(),rawPhone=String(customer.phone||'').trim(),email=String(customer.email||'').trim().toLowerCase();
 if(!name||!rawPhone)return res.status(400).json({error:'Customer name and phone are required.'});if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'At least one estimate item is required.'});
 const cleanItems=items.map(i=>({description:String(i?.description||'').trim(),parts:Math.max(0,Number(i?.parts)||0),labor:Math.max(0,Number(i?.labor)||0)}));if(cleanItems.some(i=>!i.description))return res.status(400).json({error:'Every estimate item needs a description.'});
 const shop=db.prepare(`SELECT id,name,phone,email FROM shops WHERE id=? AND active=1`).get(shopId);if(!shop)return res.status(404).json({error:'Shop not found.'});const token=crypto.randomBytes(32).toString('hex'),digits=rawPhone.replace(/\D/g,'');
 const result=db.transaction(()=>{
   const customers=db.prepare('SELECT id,phone,email FROM customers WHERE shop_id=?').all(shopId);let existing=customers.find(c=>(digits&&String(c.phone||'').replace(/\D/g,'')===digits)||(email&&String(c.email||'').trim().toLowerCase()===email));let customerId;
   if(existing){customerId=Number(existing.id);db.prepare('UPDATE customers SET name=?,phone=?,email=? WHERE id=? AND shop_id=?').run(name,rawPhone,email,customerId,shopId);}else{customerId=Number(db.prepare('INSERT INTO customers(name,phone,email,shop_id) VALUES(?,?,?,?)').run(name,rawPhone,email,shopId).lastInsertRowid);}
   const vin=String(vehicle.vin||'').trim().toUpperCase(),year=String(vehicle.year||'').trim(),make=String(vehicle.make||'').trim(),model=String(vehicle.model||'').trim(),mileage=String(vehicle.mileage||'').trim();let vehicleId=null;
   if(vin){const found=db.prepare('SELECT id FROM vehicles WHERE shop_id=? AND customer_id=? AND UPPER(vin)=? LIMIT 1').get(shopId,customerId,vin);if(found)vehicleId=Number(found.id);}
   if(!vehicleId&&(year||make||model||vin||mileage))vehicleId=Number(db.prepare('INSERT INTO vehicles(customer_id,year,make,model,vin,mileage,shop_id) VALUES(?,?,?,?,?,?,?)').run(customerId,year||null,make||null,model||null,vin||null,mileage||null,shopId).lastInsertRowid);
   const estimateId=Number(db.prepare('INSERT INTO estimates(customer_id,vehicle_id,token,notes,shop_id) VALUES(?,?,?,?,?)').run(customerId,vehicleId,token,String(notes||'').trim(),shopId).lastInsertRowid),ins=db.prepare('INSERT INTO estimate_items(estimate_id,description,parts,labor) VALUES(?,?,?,?)');for(const i of cleanItems)ins.run(estimateId,i.description,i.parts,i.labor);return {estimateId,customerId};
 })();
 const total=Math.round(cleanItems.reduce((n,i)=>n+i.parts+i.labor,0)*1.075*100)/100,url=`${appUrl()}/estimate.html?token=${encodeURIComponent(token)}`,client=sms(),to=phone(rawPhone);
 if(client&&to){try{await client.messages.create({from:process.env.TWILIO_PHONE_NUMBER,to,body:`${shop.name}: ${name.split(/\s+/)[0]}, your estimate #${result.estimateId} for $${total.toFixed(2)} is ready. Review and respond here: ${url}`});}catch(e){console.error('V1 estimate customer SMS failed:',e?.message||e);}}
 if(client&&process.env.SMS_TO_NUMBER){try{await client.messages.create({from:process.env.TWILIO_PHONE_NUMBER,to:process.env.SMS_TO_NUMBER,body:`New ${shop.name} estimate #${result.estimateId}\nCustomer: ${name}\nTotal: $${total.toFixed(2)}\nReview: ${url}`});}catch(e){console.error('V1 estimate shop SMS failed:',e?.message||e);}}
 return res.status(201).json({success:true,id:result.estimateId,token});
 }catch(e){console.error('V1 create estimate failed:',e);return res.status(500).json({error:'Unable to create estimate.'});}}
const post=express.application.post;
express.application.post=function(route,...handlers){if(route==='/api/estimates')return post.call(this,route,createEstimate);return post.call(this,route,...handlers);};
