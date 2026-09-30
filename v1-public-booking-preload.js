/* Garavex V1 public scheduling: resolve a shop before availability or booking. */
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const Database=require('better-sqlite3');
const express=require('express');
const multer=require('multer');
const {Resend}=require('resend');
const twilio=require('twilio');

const dataDir=process.env.DATA_DIR||path.join(__dirname,'data');
const uploadsDir=path.join(dataDir,'uploads');
fs.mkdirSync(uploadsDir,{recursive:true});
const db=new Database(path.join(dataDir,'bookings.db'));
const TIMES=['8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];
const upload=multer({
  storage:multer.diskStorage({
    destination:(req,file,cb)=>cb(null,uploadsDir),
    filename:(req,file,cb)=>cb(null,`${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits:{files:3,fileSize:8*1024*1024},
  fileFilter:(req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.mimetype))
});

function host(req){return String(req.get('x-forwarded-host')||req.get('host')||'').split(',')[0].trim().split(':')[0].toLowerCase();}
function validSlug(v){return /^[a-z0-9][a-z0-9-]{0,62}$/.test(String(v||''));}
function resolveShop(req){
  const sessionId=Number(req.session?.employee?.shop_id||0);
  if(Number.isInteger(sessionId)&&sessionId>0){
    const s=db.prepare('SELECT * FROM shops WHERE id=? AND active=1 LIMIT 1').get(sessionId);
    if(s)return s;
  }
  const slug=String(req.query?.shop||req.body?.shop||'').trim().toLowerCase();
  if(slug&&validSlug(slug)){
    const s=db.prepare('SELECT * FROM shops WHERE slug=? AND active=1 LIMIT 1').get(slug);
    if(s)return s;
  }
  const h=host(req);
  if(h==='skautohutch.com'||h==='www.skautohutch.com'||h.endsWith('.up.railway.app')||h==='localhost'||h==='127.0.0.1'){
    return db.prepare("SELECT * FROM shops WHERE active=1 AND LOWER(name)='s&k auto' ORDER BY id LIMIT 1").get()||null;
  }
  return null;
}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''));}
function normalizePhone(v){const d=String(v||'').replace(/\D/g,'');if(d.length===10)return `+1${d}`;if(d.length===11&&d.startsWith('1'))return `+${d}`;return null;}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function publicAvailability(req,res){
  try{
    const shop=resolveShop(req);if(!shop)return res.status(404).json({error:'Scheduling shop not found.'});
    const date=String(req.query?.date||'');if(!validDate(date))return res.status(400).json({error:'Valid date is required.'});
    const day=new Date(`${date}T12:00:00`).getDay();if(day===0||day===6)return res.json({available:[],shop:{slug:shop.slug,name:shop.name}});
    if(db.prepare('SELECT 1 FROM blocked_dates WHERE shop_id=? AND date=? LIMIT 1').get(shop.id,date))return res.json({available:[],shop:{slug:shop.slug,name:shop.name}});
    const booked=new Set(db.prepare("SELECT time FROM bookings WHERE shop_id=? AND date=? AND status<>'cancelled'").all(shop.id,date).map(r=>r.time));
    const blocked=new Set(db.prepare('SELECT time FROM blocked_times WHERE shop_id=? AND date=?').all(shop.id,date).map(r=>r.time));
    return res.json({available:TIMES.filter(t=>!booked.has(t)&&!blocked.has(t)),shop:{slug:shop.slug,name:shop.name}});
  }catch(err){console.error('V1 public availability error:',err);return res.status(500).json({error:'Unable to load availability.'});}
}
async function sendBookingNotifications(shop,b){
  const jobs=[];
  if(process.env.RESEND_API_KEY){
    const resend=new Resend(process.env.RESEND_API_KEY);const from=`${shop.name} via Garavex <appointments@skautohutch.com>`;
    if(shop.email)jobs.push(resend.emails.send({from,to:[shop.email],subject:`New appointment: ${b.name} - ${b.date} ${b.time}`,html:`<h2>New appointment</h2><p><strong>Customer:</strong> ${esc(b.name)}</p><p><strong>Phone:</strong> ${esc(b.phone)}</p><p><strong>Vehicle:</strong> ${esc(b.vehicle)}</p><p><strong>Service:</strong> ${esc(b.service)}</p><p><strong>Date:</strong> ${esc(b.date)} at ${esc(b.time)}</p><p><strong>Confirmation:</strong> ${esc(b.confirmation)}</p>`}));
    if(b.email)jobs.push(resend.emails.send({from,to:[b.email],subject:`Appointment confirmed with ${shop.name}`,html:`<h2>Appointment confirmed</h2><p>${esc(b.name)}, your appointment with <strong>${esc(shop.name)}</strong> is scheduled for <strong>${esc(b.date)}</strong> at <strong>${esc(b.time)}</strong>.</p><p>Service: ${esc(b.service)}<br>Vehicle: ${esc(b.vehicle)}<br>Confirmation: ${esc(b.confirmation)}</p>${shop.phone?`<p>Questions? Call ${esc(shop.phone)}.</p>`:''}`}));
  }
  const to=normalizePhone(b.phone);
  if(to&&process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_PHONE_NUMBER){
    const client=twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN);
    jobs.push(client.messages.create({from:process.env.TWILIO_PHONE_NUMBER,to,body:`${shop.name}: Appointment confirmed for ${b.date} at ${b.time}. Service: ${b.service}. Confirmation: ${b.confirmation}. Reply STOP to opt out.`}));
  }
  const results=await Promise.allSettled(jobs);for(const r of results)if(r.status==='rejected')console.error('V1 booking notification error:',r.reason?.message||r.reason);
}
function publicBook(req,res){
  upload.array('photos',3)(req,res,async err=>{
    if(err)return res.status(400).json({error:'Unable to upload appointment photos.'});
    try{
      const shop=resolveShop(req);if(!shop)return res.status(404).json({error:'Scheduling shop not found.'});
      const b={service:String(req.body?.service||'').trim(),vehicle:String(req.body?.vehicle||'').trim(),date:String(req.body?.date||''),time:String(req.body?.time||''),name:String(req.body?.name||'').trim(),phone:String(req.body?.phone||'').trim(),email:String(req.body?.email||'').trim(),notes:String(req.body?.notes||'').trim()};
      if(!b.service||!b.vehicle||!validDate(b.date)||!TIMES.includes(b.time)||!b.name||!b.phone)return res.status(400).json({error:'Service, vehicle, date, time, name, and phone are required.'});
      const day=new Date(`${b.date}T12:00:00`).getDay();if(day===0||day===6)return res.status(409).json({error:'That date is unavailable.'});
      if(db.prepare('SELECT 1 FROM blocked_dates WHERE shop_id=? AND date=? LIMIT 1').get(shop.id,b.date)||db.prepare('SELECT 1 FROM blocked_times WHERE shop_id=? AND date=? AND time=? LIMIT 1').get(shop.id,b.date,b.time))return res.status(409).json({error:'That time is unavailable.'});
      const confirmation=crypto.randomBytes(6).toString('hex').toUpperCase();
      let bookingId;
      try{
        const tx=db.transaction(()=>{const result=db.prepare(`INSERT INTO bookings(confirmation,service,vehicle,date,time,name,phone,email,notes,shop_id) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(confirmation,b.service,b.vehicle,b.date,b.time,b.name,b.phone,b.email||null,b.notes||null,shop.id);bookingId=Number(result.lastInsertRowid);for(const f of req.files||[])db.prepare('INSERT INTO booking_photos(booking_id,filename,original_name) VALUES(?,?,?)').run(bookingId,f.filename,f.originalname);});tx();
      }catch(e){if(String(e.message||'').includes('UNIQUE constraint failed'))return res.status(409).json({error:'That time was just booked.'});throw e;}
      b.confirmation=confirmation;sendBookingNotifications(shop,b).catch(e=>console.error('V1 booking notification failure:',e));
      return res.status(201).json({success:true,confirmation,shop:{slug:shop.slug,name:shop.name}});
    }catch(e){console.error('V1 public booking error:',e);return res.status(500).json({error:'Unable to complete booking.'});}
  });
}

const priorGet=express.application.get.bind(express.application);
const priorPost=express.application.post.bind(express.application);
express.application.get=function(route,...handlers){if(route==='/api/availability')return priorGet.call(this,route,publicAvailability);return priorGet.call(this,route,...handlers);};
express.application.post=function(route,...handlers){if(route==='/api/book')return priorPost.call(this,route,publicBook);return priorPost.call(this,route,...handlers);};
