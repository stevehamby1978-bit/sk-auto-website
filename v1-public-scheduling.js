/* Garavex V1 tenant-safe public scheduling runtime. */
const path=require('path'),fs=require('fs'),crypto=require('crypto'),Database=require('better-sqlite3'),express=require('express'),multer=require('multer');
const {Resend}=require('resend');const twilio=require('twilio');
const dataDir=process.env.DATA_DIR||path.join(__dirname,'data'),uploadsDir=path.join(dataDir,'uploads');fs.mkdirSync(uploadsDir,{recursive:true});const db=new Database(path.join(dataDir,'bookings.db'));
const TIMES=['8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];
const upload=multer({storage:multer.diskStorage({destination:(r,f,cb)=>cb(null,uploadsDir),filename:(r,f,cb)=>cb(null,`${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(f.originalname).toLowerCase()}`)}),limits:{files:3,fileSize:8*1024*1024},fileFilter:(r,f,cb)=>cb(null,['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(f.mimetype))});
function hostname(req){return String(req.get('x-forwarded-host')||req.get('host')||'').split(',')[0].trim().split(':')[0].toLowerCase();}
function resolveShop(req){
  const h=hostname(req);

  // The S&K public website must always book into S&K Auto, even if the browser
  // also has an authenticated Garavex session for another shop.
  if(h==='skautohutch.com'||h==='www.skautohutch.com'){
    return db.prepare("SELECT * FROM shops WHERE active=1 AND (slug='sk-auto' OR LOWER(name)='s&k auto') ORDER BY CASE WHEN slug='sk-auto' THEN 0 ELSE 1 END,id LIMIT 1").get()||null;
  }

  // Generic public scheduling links may explicitly identify the target shop.
  const slug=String(req.query?.shop||req.body?.shop||'').trim().toLowerCase();
  if(/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)){
    const s=db.prepare('SELECT * FROM shops WHERE slug=? AND active=1').get(slug);
    if(s)return s;
  }

  // Inside the authenticated Garavex app, use the logged-in employee's shop.
  const sid=Number(req.session?.employee?.shop_id||0);
  if(Number.isInteger(sid)&&sid>0){
    const s=db.prepare('SELECT * FROM shops WHERE id=? AND active=1').get(sid);
    if(s)return s;
  }

  // Local/Railway fallback is only for direct service testing.
  if(h.endsWith('.up.railway.app')||h==='localhost'||h==='127.0.0.1'){
    return db.prepare("SELECT * FROM shops WHERE active=1 AND (slug='sk-auto' OR LOWER(name)='s&k auto') ORDER BY CASE WHEN slug='sk-auto' THEN 0 ELSE 1 END,id LIMIT 1").get()||null;
  }
  return null;
}
function dateOK(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''));}function phone(v){const d=String(v||'').replace(/\D/g,'');return d.length===10?`+1${d}`:d.length===11&&d[0]==='1'?`+${d}`:null;}function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function availability(req,res){try{const s=resolveShop(req);if(!s)return res.status(404).json({error:'Scheduling shop not found.'});const d=String(req.query?.date||'');if(!dateOK(d))return res.status(400).json({error:'Valid date is required.'});const dow=new Date(`${d}T12:00:00`).getDay();if(dow===0||dow===6)return res.json({available:[],shop:{slug:s.slug,name:s.name}});if(db.prepare('SELECT 1 FROM blocked_dates WHERE shop_id=? AND date=?').get(s.id,d))return res.json({available:[],shop:{slug:s.slug,name:s.name}});const booked=new Set(db.prepare("SELECT time FROM bookings WHERE shop_id=? AND date=? AND status<>'cancelled'").all(s.id,d).map(x=>x.time)),blocked=new Set(db.prepare('SELECT time FROM blocked_times WHERE shop_id=? AND date=?').all(s.id,d).map(x=>x.time));return res.json({available:TIMES.filter(t=>!booked.has(t)&&!blocked.has(t)),shop:{slug:s.slug,name:s.name}});}catch(e){console.error('V1 availability:',e);return res.status(500).json({error:'Unable to load availability.'});}}
async function notify(s,b){const jobs=[];if(process.env.RESEND_API_KEY){const r=new Resend(process.env.RESEND_API_KEY),from=`${s.name} via Garavex <appointments@skautohutch.com>`;if(s.email)jobs.push(r.emails.send({from,to:[s.email],subject:`New appointment: ${b.name} - ${b.date} ${b.time}`,html:`<h2>New appointment</h2><p>${esc(b.name)} — ${esc(b.phone)}</p><p>${esc(b.vehicle)} — ${esc(b.service)}</p><p>${esc(b.date)} at ${esc(b.time)}</p><p>Confirmation: ${esc(b.confirmation)}</p>`}));if(b.email)jobs.push(r.emails.send({from,to:[b.email],subject:`Appointment confirmed with ${s.name}`,html:`<h2>Appointment confirmed</h2><p>${esc(b.name)}, you are scheduled with <strong>${esc(s.name)}</strong> for <strong>${esc(b.date)}</strong> at <strong>${esc(b.time)}</strong>.</p><p>${esc(b.service)} — ${esc(b.vehicle)}<br>Confirmation: ${esc(b.confirmation)}</p>${s.phone?`<p>Questions? Call ${esc(s.phone)}.</p>`:''}`}));}const to=phone(b.phone);if(to&&process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_PHONE_NUMBER)jobs.push(twilio(process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN).messages.create({from:process.env.TWILIO_PHONE_NUMBER,to,body:`${s.name}: Appointment confirmed for ${b.date} at ${b.time}. ${b.service}. Confirmation: ${b.confirmation}. Reply STOP to opt out.`}));const results=await Promise.allSettled(jobs);for(const x of results)if(x.status==='rejected')console.error('V1 booking notification:',x.reason?.message||x.reason);}
function book(req,res){upload.array('photos',3)(req,res,async err=>{if(err)return res.status(400).json({error:'Unable to upload appointment photos.'});try{const s=resolveShop(req);if(!s)return res.status(404).json({error:'Scheduling shop not found.'});const b={service:String(req.body?.service||'').trim(),vehicle:String(req.body?.vehicle||'').trim(),date:String(req.body?.date||''),time:String(req.body?.time||''),name:String(req.body?.name||'').trim(),phone:String(req.body?.phone||'').trim(),email:String(req.body?.email||'').trim(),notes:String(req.body?.notes||'').trim()};if(!b.service||!b.vehicle||!dateOK(b.date)||!TIMES.includes(b.time)||!b.name||!b.phone)return res.status(400).json({error:'Service, vehicle, date, time, name, and phone are required.'});const dow=new Date(`${b.date}T12:00:00`).getDay();if(dow===0||dow===6)return res.status(409).json({error:'That date is unavailable.'});if(db.prepare('SELECT 1 FROM blocked_dates WHERE shop_id=? AND date=?').get(s.id,b.date)||db.prepare('SELECT 1 FROM blocked_times WHERE shop_id=? AND date=? AND time=?').get(s.id,b.date,b.time))return res.status(409).json({error:'That time is unavailable.'});const confirmation=crypto.randomBytes(6).toString('hex').toUpperCase();try{db.transaction(()=>{const x=db.prepare('INSERT INTO bookings(confirmation,service,vehicle,date,time,name,phone,email,notes,shop_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(confirmation,b.service,b.vehicle,b.date,b.time,b.name,b.phone,b.email||null,b.notes||null,s.id);for(const f of req.files||[])db.prepare('INSERT INTO booking_photos(booking_id,filename,original_name) VALUES(?,?,?)').run(Number(x.lastInsertRowid),f.filename,f.originalname);})();}catch(e){if(String(e.message||'').includes('UNIQUE constraint failed'))return res.status(409).json({error:'That time was just booked.'});throw e;}b.confirmation=confirmation;notify(s,b).catch(e=>console.error('V1 booking notify failure:',e));return res.status(201).json({success:true,confirmation,shop:{slug:s.slug,name:s.name}});}catch(e){console.error('V1 public booking:',e);return res.status(500).json({error:'Unable to complete booking.'});}});}
const previousGet=express.application.get,previousPost=express.application.post;
express.application.get=function(route,...handlers){if(route==='/api/availability')return previousGet.call(this,route,availability);return previousGet.call(this,route,...handlers);};
express.application.post=function(route,...handlers){if(route==='/api/book')return previousPost.call(this,route,book);return previousPost.call(this,route,...handlers);};
