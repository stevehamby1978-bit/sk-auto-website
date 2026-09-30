/* Garavex V1 tenant-aware appointment reminder runtime. */
const path=require('path'),Database=require('better-sqlite3'),twilio=require('twilio');
const dataDir=process.env.DATA_DIR||path.join(__dirname,'data');
const db=new Database(path.join(dataDir,'bookings.db'));

function normalizePhone(v){const d=String(v||'').replace(/\D/g,'');return d.length===10?`+1${d}`:d.length===11&&d.startsWith('1')?`+${d}`:null;}
function timeToMinutes(v){const m=String(v||'').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);if(!m)return null;let h=Number(m[1]);const min=Number(m[2]),p=m[3].toUpperCase();if(p==='PM'&&h!==12)h+=12;if(p==='AM'&&h===12)h=0;return h*60+min;}
function chicagoParts(date){return {date:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(date),time:new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',hour12:true}).format(date)};}

async function runTenantReminders(){
  if(!process.env.TWILIO_ACCOUNT_SID||!process.env.TWILIO_AUTH_TOKEN||!process.env.TWILIO_PHONE_NUMBER)return;
  try{
    const target=new Date(Date.now()+24*60*60*1000),parts=chicagoParts(target),targetMinutes=timeToMinutes(parts.time);
    if(targetMinutes===null)return;
    const rows=db.prepare(`
      SELECT b.id,b.confirmation,b.service,b.date,b.time,b.phone,b.shop_id,
             COALESCE(NULLIF(TRIM(s.name),''),'Your repair shop') AS shop_name,
             NULLIF(TRIM(s.phone),'') AS shop_phone
      FROM bookings b
      JOIN shops s ON s.id=b.shop_id AND s.active=1
      WHERE b.date=? AND b.reminder_sent=0 AND COALESCE(b.status,'scheduled')<>'cancelled'
      ORDER BY b.id
    `).all(parts.date);
    const client=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
    for(const a of rows){
      const appointmentMinutes=timeToMinutes(a.time);
      if(appointmentMinutes===null||appointmentMinutes>targetMinutes||appointmentMinutes<=targetMinutes-60)continue;
      const to=normalizePhone(a.phone);if(!to)continue;
      const contact=a.shop_phone?` Call ${a.shop_phone} if you need to make changes.`:' Please contact the shop if you need to make changes.';
      try{
        await client.messages.create({from:process.env.TWILIO_PHONE_NUMBER,to,body:`${a.shop_name} reminder: You have an appointment tomorrow at ${a.time} for ${a.service}. Confirmation: ${a.confirmation}.${contact} Reply STOP to opt out.`});
        db.prepare('UPDATE bookings SET reminder_sent=1 WHERE id=? AND shop_id=? AND reminder_sent=0').run(a.id,a.shop_id);
        console.log(`V1 reminder sent for shop ${a.shop_id}, booking ${a.confirmation}`);
      }catch(err){console.error(`V1 reminder failed for shop ${a.shop_id}, booking ${a.confirmation}:`,err?.message||err);}
    }
  }catch(err){console.error('V1 reminder checker failed:',err);}
}

/*
 * server.js still contains the legacy S&K reminder scheduler. Prevent that timer
 * from being registered while server.js loads, then restore the native timer and
 * run the tenant-aware scheduler here. This keeps V1 deploy-safe without allowing
 * both reminder workers to text the same appointment.
 */
const nativeSetInterval=global.setInterval;
global.setInterval=function(fn,delay,...args){if(fn&&fn.name==='sendAppointmentReminders'&&delay===15*60*1000){console.log('Garavex V1: suppressed legacy appointment reminder interval.');return {unref(){}};}return nativeSetInterval(fn,delay,...args);};
process.nextTick(()=>{global.setInterval=nativeSetInterval;setTimeout(()=>{runTenantReminders();const timer=nativeSetInterval(runTenantReminders,15*60*1000);if(timer&&typeof timer.unref==='function')timer.unref();},1500);});
