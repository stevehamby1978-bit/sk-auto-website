/* Garavex V1 tenant-aware manual balance reminder route. */
const path=require('path'),Database=require('better-sqlite3'),express=require('express'),twilio=require('twilio');
const db=new Database(path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'bookings.db'));
const client=process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN?twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN):null;
function sid(req){const n=Number(req.session?.employee?.shop_id);return Number.isInteger(n)&&n>0?n:null;}
function phone(v){const d=String(v||'').replace(/\D/g,'');if(d.length===10)return '+1'+d;if(d.length===11&&d[0]==='1')return '+'+d;return String(v||'').trim();}
async function reminder(req,res){try{
 const shopId=sid(req);if(!shopId)return res.status(401).json({error:'Not authorized.'});const id=Number(req.params.id);if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid repair order.'});
 const ro=db.prepare(`SELECT r.id,r.amount_paid,r.status,c.name customer_name,c.phone customer_phone FROM repair_orders r LEFT JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE r.id=? AND r.shop_id=? AND r.status='completed'`).get(id,shopId);if(!ro)return res.status(404).json({error:'Completed repair order not found.'});
 const to=phone(ro.customer_phone);if(!to)return res.status(400).json({error:'Customer does not have a phone number.'});
 const shop=db.prepare(`SELECT name,phone FROM shops WHERE id=? AND active=1`).get(shopId);if(!shop)return res.status(404).json({error:'Shop not found.'});
 const items=db.prepare('SELECT parts,labor FROM repair_order_items WHERE repair_order_id=?').all(id);const subtotal=Math.round(items.reduce((s,x)=>s+Number(x.parts||0)+Number(x.labor||0),0)*100)/100,total=Math.round((subtotal+subtotal*.075)*100)/100,paid=Math.round(Number(ro.amount_paid||0)*100)/100,balance=Math.max(0,Math.round((total-paid)*100)/100);if(balance<=.009)return res.status(400).json({error:'This invoice is already paid in full.'});
 if(!client||!process.env.TWILIO_PHONE_NUMBER)return res.status(503).json({error:'Text messaging is not configured.'});
 const name=String(ro.customer_name||'Customer').trim(),shopName=String(shop.name||'Your repair shop').trim(),shopPhone=String(shop.phone||'').trim();
 const body=`Hello ${name}, this is a friendly reminder from ${shopName} that your account has an outstanding balance of $${balance.toFixed(2)}.${shopPhone?` Please contact us at ${shopPhone} to arrange payment.`:''} Thank you for choosing ${shopName}. Reply STOP to opt out.`;
 const msg=await client.messages.create({body,from:process.env.TWILIO_PHONE_NUMBER,to});
 db.prepare(`UPDATE repair_orders SET balance_reminder_sent_at=CURRENT_TIMESTAMP,balance_reminder_count=COALESCE(balance_reminder_count,0)+1 WHERE id=? AND shop_id=?`).run(id,shopId);
 console.log('V1 manual balance reminder sent:',msg.sid);return res.json({success:true,message:'Balance reminder sent.',balance_due:balance});
 }catch(e){console.error('V1 manual balance reminder failed:',e);return res.status(500).json({error:'Unable to send balance reminder.'});}}
const post=express.application.post;express.application.post=function(route,...handlers){if(route==='/api/repair-orders/:id/balance-reminder')return post.call(this,route,reminder);return post.call(this,route,...handlers);};
