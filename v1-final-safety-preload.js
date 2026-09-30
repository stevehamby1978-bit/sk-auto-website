/* Garavex V1 final safety overrides.
 * Tightens tenant isolation for appointment edits, recommended repairs,
 * receipt re-sends, and disables the obsolete generic invoice-text endpoint.
 */
const path=require('path');
const Database=require('better-sqlite3');
const express=require('express');
const crypto=require('crypto');
const twilio=require('twilio');
const {Resend}=require('resend');

const db=new Database(path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'bookings.db'));
const resend=process.env.RESEND_API_KEY?new Resend(process.env.RESEND_API_KEY):null;

function sid(req){const n=Number(req.session?.employee?.shop_id);return Number.isInteger(n)&&n>0?n:null;}
function requireShop(req,res){const n=sid(req);if(!n){res.status(401).json({error:'Not authorized.'});return null;}return n;}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''));}
function weekday(v){const d=new Date(`${v}T12:00:00`);return !Number.isNaN(d.getTime())&&d.getDay()>=1&&d.getDay()<=5;}
function money(v){return Math.round(Number(v||0)*100)/100;}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function normalizePhone(v){const d=String(v||'').replace(/\D/g,'');return d.length===10?'+1'+d:d.length===11&&d[0]==='1'?'+'.concat(d):null;}
function appUrl(){return String(process.env.PUBLIC_APP_URL||'https://app.garavex.com').trim().replace(/\/$/,'');}
const SHOP_SLOTS=['8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];

function shopProfile(shopId){
  return db.prepare(`SELECT id,name,phone,email,address,city,state,zip,tagline FROM shops WHERE id=? AND active=1`).get(shopId);
}
function ownedOrder(shopId,id){
  return db.prepare('SELECT id,customer_id FROM repair_orders WHERE id=? AND shop_id=?').get(id,shopId);
}
function ownedRecommendation(shopId,orderId,recId){
  return db.prepare(`
    SELECT rr.id,rr.repair_order_id,rr.description,rr.parts,rr.labor,rr.status,rr.authorization_token
    FROM repair_order_recommendations rr
    JOIN repair_orders r ON r.id=rr.repair_order_id
    WHERE rr.id=? AND rr.repair_order_id=? AND r.shop_id=?
  `).get(recId,orderId,shopId);
}

function updateAppointment(req,res){
  try{
    const shopId=requireShop(req,res);if(!shopId)return;
    const id=Number(req.params.id);
    const {date,time,name,phone,email='',vehicle,service,notes=''}=req.body||{};
    if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid appointment ID.'});
    if(!date||!time||!name||!phone||!vehicle||!service)return res.status(400).json({error:'Please complete all required appointment fields.'});
    if(!SHOP_SLOTS.includes(time))return res.status(400).json({error:'Invalid appointment time.'});
    if(!validDate(date)||!weekday(date))return res.status(400).json({error:'Please choose a Monday-Friday date.'});
    const appt=db.prepare('SELECT id FROM bookings WHERE id=? AND shop_id=?').get(id,shopId);
    if(!appt)return res.status(404).json({error:'Appointment not found.'});
    if(db.prepare('SELECT 1 FROM blocked_dates WHERE shop_id=? AND date=?').get(shopId,date))return res.status(409).json({error:'That date is unavailable.'});
    if(db.prepare('SELECT 1 FROM blocked_times WHERE shop_id=? AND date=? AND time=?').get(shopId,date,time))return res.status(409).json({error:'That appointment time is unavailable.'});
    if(db.prepare("SELECT id FROM bookings WHERE shop_id=? AND date=? AND time=? AND id<>? AND COALESCE(status,'scheduled')<>'cancelled'").get(shopId,date,time,id))return res.status(409).json({error:'That appointment time is already booked.'});
    db.prepare(`
      UPDATE bookings SET date=?,time=?,name=?,phone=?,email=?,vehicle=?,service=?,notes=?
      WHERE id=? AND shop_id=?
    `).run(date,time,String(name).trim(),String(phone).trim(),String(email||'').trim(),String(vehicle).trim(),String(service).trim(),String(notes||'').trim(),id,shopId);
    return res.json({success:true,message:'Appointment updated successfully.'});
  }catch(e){console.error('V1 appointment update failed:',e);return res.status(500).json({error:'Unable to update appointment.'});}
}

function listRecommendations(req,res){
  try{
    const shopId=requireShop(req,res);if(!shopId)return;const orderId=Number(req.params.id);
    if(!ownedOrder(shopId,orderId))return res.status(404).json({error:'Repair order not found.'});
    const rows=db.prepare(`
      SELECT rr.id,rr.repair_order_id,rr.description,rr.parts,rr.labor,rr.status,rr.created_at
      FROM repair_order_recommendations rr
      JOIN repair_orders r ON r.id=rr.repair_order_id
      WHERE rr.repair_order_id=? AND r.shop_id=?
      ORDER BY rr.id ASC
    `).all(orderId,shopId);
    return res.json(rows);
  }catch(e){console.error('V1 recommendation list failed:',e);return res.status(500).json({error:'Unable to load recommended repairs.'});}
}

async function addRecommendation(req,res){
  try{
    const shopId=requireShop(req,res);if(!shopId)return;const orderId=Number(req.params.id);
    const order=db.prepare(`SELECT r.id,r.customer_id,c.name customer_name,c.phone customer_phone FROM repair_orders r LEFT JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE r.id=? AND r.shop_id=?`).get(orderId,shopId);
    if(!order)return res.status(404).json({error:'Repair order not found.'});
    const description=String(req.body?.description||'').trim(),parts=Math.max(0,Number(req.body?.parts)||0),labor=Math.max(0,Number(req.body?.labor)||0);
    if(!description)return res.status(400).json({error:'Recommended repair description is required.'});
    const token=crypto.randomBytes(32).toString('hex');
    const result=db.prepare(`INSERT INTO repair_order_recommendations(repair_order_id,description,parts,labor,status,authorization_token) VALUES(?,?,?,?, 'pending',?)`).run(orderId,description,parts,labor,token);
    const recId=Number(result.lastInsertRowid),shop=shopProfile(shopId),to=normalizePhone(order.customer_phone);
    if(shop&&to&&process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_PHONE_NUMBER){
      try{
        const client=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
        const url=`${appUrl()}/repair-authorization.html?order=${encodeURIComponent(orderId)}&repair=${encodeURIComponent(recId)}&token=${encodeURIComponent(token)}`;
        await client.messages.create({from:process.env.TWILIO_PHONE_NUMBER,to,body:`${shop.name}: We recommend an additional repair: ${description}. Parts: $${parts.toFixed(2)}, Labor: $${labor.toFixed(2)}, Total: $${(parts+labor).toFixed(2)}. Review: ${url}`});
      }catch(err){console.error('V1 recommendation SMS failed:',err?.message||err);}
    }
    return res.status(201).json({success:true,id:recId,description,parts,labor,status:'pending',authorizationToken:token});
  }catch(e){console.error('V1 add recommendation failed:',e);return res.status(500).json({error:'Unable to add recommended repair.'});}
}

function deleteRecommendation(req,res){
  try{
    const shopId=requireShop(req,res);if(!shopId)return;const orderId=Number(req.params.repairOrderId),recId=Number(req.params.recommendationId);
    const rec=ownedRecommendation(shopId,orderId,recId);if(!rec)return res.status(404).json({error:'Recommended repair not found.'});
    db.prepare('DELETE FROM repair_order_recommendations WHERE id=? AND repair_order_id=?').run(recId,orderId);
    return res.json({success:true});
  }catch(e){console.error('V1 delete recommendation failed:',e);return res.status(500).json({error:'Unable to delete recommended repair.'});}
}

function approveRecommendation(req,res){
  try{
    const shopId=requireShop(req,res);if(!shopId)return;const orderId=Number(req.params.repairOrderId),recId=Number(req.params.recommendationId);
    const rec=ownedRecommendation(shopId,orderId,recId);if(!rec)return res.status(404).json({error:'Recommended repair not found.'});
    if(String(rec.status||'').toLowerCase()!=='pending')return res.status(409).json({error:'This recommended repair has already been decided.'});
    const result=db.transaction(()=>{
      const ins=db.prepare('INSERT INTO repair_order_items(repair_order_id,description,parts,labor) VALUES(?,?,?,?)').run(orderId,rec.description,Number(rec.parts)||0,Number(rec.labor)||0);
      const upd=db.prepare("UPDATE repair_order_recommendations SET status='approved' WHERE id=? AND repair_order_id=? AND status='pending'").run(recId,orderId);
      if(upd.changes!==1)throw new Error('Recommendation status changed before approval.');
      return ins;
    })();
    return res.json({success:true,message:'Recommended repair approved and added to repair order.',itemId:Number(result.lastInsertRowid)});
  }catch(e){console.error('V1 approve recommendation failed:',e);return res.status(500).json({error:'Unable to approve recommended repair.'});}
}

function declineRecommendation(req,res){
  try{
    const shopId=requireShop(req,res);if(!shopId)return;const orderId=Number(req.params.repairOrderId),recId=Number(req.params.recommendationId);
    const rec=ownedRecommendation(shopId,orderId,recId);if(!rec)return res.status(404).json({error:'Recommended repair not found.'});
    if(String(rec.status||'').toLowerCase()!=='pending')return res.status(409).json({error:'This recommended repair has already been decided.'});
    db.prepare("UPDATE repair_order_recommendations SET status='declined' WHERE id=? AND repair_order_id=? AND status='pending'").run(recId,orderId);
    return res.json({success:true,message:'Recommended repair declined.'});
  }catch(e){console.error('V1 decline recommendation failed:',e);return res.status(500).json({error:'Unable to decline recommended repair.'});}
}

async function emailReceipt(req,res){
  try{
    const shopId=requireShop(req,res);if(!shopId)return;const orderId=Number(req.params.id),shop=shopProfile(shopId);
    if(!shop)return res.status(404).json({error:'Shop not found.'});
    const o=db.prepare(`
      SELECT r.id,r.amount_paid,r.payment_method,c.name customer_name,c.email customer_email,
             v.year vehicle_year,v.make vehicle_make,v.model vehicle_model
      FROM repair_orders r
      LEFT JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
      LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
      WHERE r.id=? AND r.shop_id=?
    `).get(orderId,shopId);
    if(!o)return res.status(404).json({error:'Repair order not found.'});
    if(!o.customer_email)return res.status(400).json({error:'This customer does not have an email address.'});
    if(!resend)return res.status(503).json({error:'Email is not configured.'});
    const items=db.prepare('SELECT parts,labor FROM repair_order_items WHERE repair_order_id=?').all(orderId);
    const subtotal=money(items.reduce((n,x)=>n+Number(x.parts||0)+Number(x.labor||0),0)),total=money(subtotal+subtotal*.075),amountPaid=money(o.amount_paid),balance=money(Math.max(0,total-amountPaid));
    const last=db.prepare('SELECT amount,payment_method FROM repair_order_payments WHERE repair_order_id=? AND COALESCE(voided,0)=0 ORDER BY id DESC LIMIT 1').get(orderId);
    const paymentAmount=money(last?.amount??amountPaid),method=last?.payment_method||o.payment_method||'Not listed',vehicle=[o.vehicle_year,o.vehicle_make,o.vehicle_model].filter(Boolean).join(' ');
    const address=[shop.address,[shop.city,shop.state,shop.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const fromAddr=String(process.env.RECEIPT_FROM_EMAIL||process.env.FROM_EMAIL||'receipts@garavex.com').trim();
    await resend.emails.send({
      from:`${String(shop.name||'Garavex Shop').replace(/[<>]/g,'')} <${fromAddr}>`,
      to:[o.customer_email],
      subject:`${shop.name} Payment Receipt - Invoice #${orderId}`,
      html:`<div style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px"><div style="max-width:650px;margin:auto;background:#fff;border:1px solid #ddd;border-radius:10px;overflow:hidden"><div style="background:#151515;color:#fff;padding:22px;text-align:center"><h1 style="margin:0">${esc(shop.name)}</h1>${shop.tagline?`<p style="color:#ccc">${esc(shop.tagline)}</p>`:''}</div><div style="padding:25px"><h2>Payment Receipt</h2><p>Thank you, ${esc(o.customer_name||'Customer')}.</p><table style="width:100%"><tr><td>Vehicle</td><td style="text-align:right">${esc(vehicle||'Not listed')}</td></tr><tr><td>Payment Method</td><td style="text-align:right">${esc(method)}</td></tr><tr><td>This Payment</td><td style="text-align:right">$${paymentAmount.toFixed(2)}</td></tr><tr><td>Invoice Total</td><td style="text-align:right">$${total.toFixed(2)}</td></tr><tr><td>Total Paid</td><td style="text-align:right">$${amountPaid.toFixed(2)}</td></tr><tr><td><strong>Balance Due</strong></td><td style="text-align:right"><strong>$${balance.toFixed(2)}</strong></td></tr></table><hr><p><strong>${esc(shop.name)}</strong></p>${address?`<p>${esc(address)}</p>`:''}${shop.phone?`<p>${esc(shop.phone)}</p>`:''}${shop.email?`<p>${esc(shop.email)}</p>`:''}</div></div></div>`
    });
    return res.json({success:true,email:o.customer_email});
  }catch(e){console.error('V1 receipt resend failed:',e);return res.status(500).json({error:'Unable to email payment receipt.'});}
}


function respondEstimate(req,res){
  try{
    const token=String(req.params?.token||'').trim();
    const status=String(req.body?.status||'').toLowerCase();
    if(!token)return res.status(400).json({error:'Estimate token is required.'});
    if(!['approved','declined'].includes(status))return res.status(400).json({error:'Status must be approved or declined.'});

    const estimate=db.prepare(`
      SELECT e.id,e.customer_id,e.vehicle_id,e.status,e.shop_id,
             c.name AS customer_name,
             v.year AS vehicle_year,v.make AS vehicle_make,v.model AS vehicle_model
      FROM estimates e
      LEFT JOIN customers c ON c.id=e.customer_id AND c.shop_id=e.shop_id
      LEFT JOIN vehicles v ON v.id=e.vehicle_id AND v.shop_id=e.shop_id
      WHERE e.token=?
      LIMIT 1
    `).get(token);

    if(!estimate)return res.status(404).json({error:'Estimate not found.'});
    if(!estimate.shop_id)return res.status(409).json({error:'This estimate is missing shop ownership.'});
    if(String(estimate.status||'pending').toLowerCase()!=='pending')return res.status(409).json({error:'This estimate has already been responded to.'});

    let repairOrderId=null;
    db.transaction(()=>{
      const updated=db.prepare(`
        UPDATE estimates
        SET status=?,responded_at=CURRENT_TIMESTAMP
        WHERE id=? AND shop_id=? AND status='pending'
      `).run(status,estimate.id,estimate.shop_id);
      if(updated.changes!==1)throw new Error('Estimate status changed before response was saved.');

      if(status==='approved'){
        const existing=db.prepare('SELECT id FROM repair_orders WHERE estimate_id=? AND shop_id=? LIMIT 1').get(estimate.id,estimate.shop_id);
        if(existing){
          repairOrderId=Number(existing.id);
        }else{
          const ro=db.prepare(`
            INSERT INTO repair_orders(estimate_id,customer_id,vehicle_id,status,shop_id)
            VALUES(?,?,?,'waiting',?)
          `).run(estimate.id,estimate.customer_id,estimate.vehicle_id,estimate.shop_id);
          repairOrderId=Number(ro.lastInsertRowid);

          const items=db.prepare('SELECT description,parts,labor FROM estimate_items WHERE estimate_id=? ORDER BY id').all(estimate.id);
          const add=db.prepare('INSERT INTO repair_order_items(repair_order_id,description,parts,labor) VALUES(?,?,?,?)');
          for(const item of items)add.run(repairOrderId,item.description,Number(item.parts)||0,Number(item.labor)||0);
        }
      }
    })();

    return res.json({success:true,status,repair_order_id:repairOrderId});
  }catch(e){
    console.error('V1 estimate response failed:',e);
    return res.status(500).json({error:'Unable to update estimate.'});
  }
}

function disabledLegacyTextAuthorization(req,res){
  return res.status(410).json({error:'This legacy authorization-text endpoint has been retired. Use the repair-order authorization text route.'});
}

function disabledLegacyTextInvoice(req,res){
  return res.status(410).json({error:'This legacy invoice-text endpoint has been retired. Use the repair-order invoice text route.'});
}

const get=express.application.get,post=express.application.post,patch=express.application.patch,del=express.application.delete;
express.application.get=function(route,...handlers){
  if(route==='/api/repair-orders/:id/recommendations')return get.call(this,route,listRecommendations);
  return get.call(this,route,...handlers);
};
express.application.post=function(route,...handlers){
  if(route==='/api/repair-orders/:id/recommendations')return post.call(this,route,addRecommendation);
  if(route==='/api/repair-orders/:id/email-receipt')return post.call(this,route,emailReceipt);
  if(route==='/api/estimates/:token/respond')return post.call(this,route,respondEstimate);
  if(route==='/api/text-invoice')return post.call(this,route,disabledLegacyTextInvoice);
  if(route==='/api/text-authorization')return post.call(this,route,disabledLegacyTextAuthorization);
  return post.call(this,route,...handlers);
};
express.application.patch=function(route,...handlers){
  if(route==='/api/appointments/:id')return patch.call(this,route,updateAppointment);
  if(route==='/api/repair-orders/:repairOrderId/recommendations/:recommendationId/approve')return patch.call(this,route,approveRecommendation);
  if(route==='/api/repair-orders/:repairOrderId/recommendations/:recommendationId/decline')return patch.call(this,route,declineRecommendation);
  return patch.call(this,route,...handlers);
};
express.application.delete=function(route,...handlers){
  if(route==='/api/repair-orders/:repairOrderId/recommendations/:recommendationId')return del.call(this,route,deleteRecommendation);
  return del.call(this,route,...handlers);
};
