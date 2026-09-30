/* Garavex V1 tenant-aware automatic balance reminders. */
const path=require('path'),Database=require('better-sqlite3'),twilio=require('twilio');
const db=new Database(path.join(process.env.DATA_DIR||path.join(__dirname,'data'),'bookings.db'));
function phone(v){const d=String(v||'').replace(/\D/g,'');return d.length===10?`+1${d}`:d.length===11&&d[0]==='1'?`+${d}`:null;}
function money(v){return Math.round(Number(v||0)*100)/100;}
async function run(){
 if(!process.env.TWILIO_ACCOUNT_SID||!process.env.TWILIO_AUTH_TOKEN||!process.env.TWILIO_PHONE_NUMBER)return;
 const client=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN),now=new Date();
 try{
  const orders=db.prepare(`SELECT r.id,r.shop_id,r.completed_at,r.balance_reminder_sent_at,r.balance_reminder_count,r.amount_paid,c.name customer_name,c.phone customer_phone,COALESCE(NULLIF(TRIM(s.name),''),'Your repair shop') shop_name,NULLIF(TRIM(s.phone),'') shop_phone FROM repair_orders r JOIN shops s ON s.id=r.shop_id AND s.active=1 LEFT JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE r.status='completed' AND r.completed_at IS NOT NULL AND c.phone IS NOT NULL`).all();
  for(const o of orders){try{
   const subtotal=money(db.prepare(`SELECT COALESCE(SUM(parts+labor),0) subtotal FROM repair_order_items WHERE repair_order_id=?`).get(o.id)?.subtotal),total=money(subtotal+money(subtotal*.075)),balance=money(Math.max(0,total-money(o.amount_paid)));
   if(balance<=.009)continue;const completed=new Date(o.completed_at);if(Number.isNaN(completed.getTime()))continue;
   const count=Number(o.balance_reminder_count||0),days=(now-completed)/86400000;let send=count===0&&days>=3;
   if(count>0&&o.balance_reminder_sent_at){const last=new Date(o.balance_reminder_sent_at);send=!Number.isNaN(last.getTime())&&(now-last)/86400000>=7;}
   if(!send)continue;const to=phone(o.customer_phone);if(!to)continue;const first=String(o.customer_name||'').trim().split(/\s+/)[0];
   const contact=o.shop_phone?` Please contact us at ${o.shop_phone} regarding payment.`:' Please contact the shop regarding payment.';
   await client.messages.create({from:process.env.TWILIO_PHONE_NUMBER,to,body:`${o.shop_name}: ${first?first+', ':''}this is a friendly reminder that your outstanding balance is $${balance.toFixed(2)} on repair order #${o.id}.${contact} If you have already made payment, please disregard this message. Reply STOP to opt out.`});
   db.prepare(`UPDATE repair_orders SET balance_reminder_sent_at=?,balance_reminder_count=COALESCE(balance_reminder_count,0)+1 WHERE id=? AND shop_id=?`).run(new Date().toISOString(),o.id,o.shop_id);
   console.log(`V1 balance reminder sent for shop ${o.shop_id}, repair order ${o.id}`);
  }catch(e){console.error(`V1 balance reminder failed for shop ${o.shop_id}, repair order ${o.id}:`,e?.message||e);}}
 }catch(e){console.error('V1 balance reminder checker failed:',e);}
}
const native=global.setInterval;
global.setInterval=function(fn,delay,...args){if(fn&&fn.name==='runAutomaticBalanceReminders'){console.log('Garavex V1: suppressed legacy automatic balance reminder interval.');return {unref(){}};}return native(fn,delay,...args);};
process.nextTick(()=>{global.setInterval=native;setTimeout(()=>{run();const t=native(run,60*60*1000);if(t?.unref)t.unref();},2500);});
