'use strict';

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const express = require('express');
const twilio = require('twilio');
const { Resend } = require('resend');

const db = new Database(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bookings.db'));
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const sms = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const SHOP_SLOTS = ['8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'];

function sessionShop(req) {
  const id = Number(req.session?.employee?.shop_id || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}
function skShop() {
  return db.prepare("SELECT id,name,phone,email,address,city,state,zip FROM shops WHERE slug='sk-auto' LIMIT 1").get();
}
function shopForRequest(req, res, allowPublicSk = false) {
  const id = sessionShop(req);
  if (id) return db.prepare('SELECT id,name,phone,email,address,city,state,zip FROM shops WHERE id=? AND active=1').get(id) || null;
  if (allowPublicSk) return skShop();
  res.status(401).json({ error: 'Not authorized.' });
  return null;
}
function validDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function weekday(v) { const d = new Date(`${v}T12:00:00`); return !Number.isNaN(d.getTime()) && d.getDay() >= 1 && d.getDay() <= 5; }
function normalizePhone(v) { const d = String(v || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : null; }
function isBlocked(shopId, date) { return !!db.prepare('SELECT 1 FROM blocked_dates WHERE shop_id=? AND date=?').get(shopId, date); }
function isBlockedTime(shopId, date, time) { return !!db.prepare('SELECT 1 FROM blocked_times WHERE shop_id=? AND date=? AND time=?').get(shopId, date, time); }
function collision(shopId, date, time, excludeId = 0) {
  return !!db.prepare("SELECT id FROM bookings WHERE shop_id=? AND date=? AND time=? AND id<>? AND COALESCE(status,'scheduled')<>'cancelled'").get(shopId, date, time, excludeId);
}

function availability(req, res) {
  try {
    const shop = shopForRequest(req, res, true); if (!shop) return;
    const date = String(req.query.date || '');
    if (!validDate(date) || !weekday(date)) return res.status(400).json({ error: 'Choose a Monday-Friday date.' });
    if (isBlocked(shop.id, date)) return res.json({ date, available: [], blocked: true, message: `${shop.name} is closed on this date.` });
    const booked = new Set(db.prepare("SELECT time FROM bookings WHERE shop_id=? AND date=? AND COALESCE(status,'scheduled')<>'cancelled'").all(shop.id, date).map(r => r.time));
    const blocked = new Set(db.prepare('SELECT time FROM blocked_times WHERE shop_id=? AND date=?').all(shop.id, date).map(r => r.time));
    return res.json({ date, available: SHOP_SLOTS.filter(t => !booked.has(t) && !blocked.has(t)) });
  } catch (e) { console.error('V2 availability failed:', e); return res.status(500).json({ error: 'Unable to load availability.' }); }
}

async function book(req, res) {
  try {
    const shop = shopForRequest(req, res, true); if (!shop) return;
    const internal = !!sessionShop(req);
    const { service, vehicle, date, time, name, phone, email = '', notes = '' } = req.body || {};
    if (![service, vehicle, date, time, name, phone].every(v => typeof v === 'string' && v.trim())) return res.status(400).json({ error: 'Missing required fields.' });
    if (!validDate(date) || !weekday(date)) return res.status(400).json({ error: 'Appointments are Monday-Friday only.' });
    if (!SHOP_SLOTS.includes(time)) return res.status(400).json({ error: 'Invalid appointment time.' });
    if (isBlocked(shop.id, date)) return res.status(409).json({ error: `${shop.name} is closed on this date.` });
    if (isBlockedTime(shop.id, date, time)) return res.status(409).json({ error: 'That appointment time is unavailable.' });
    if (collision(shop.id, date, time)) return res.status(409).json({ error: 'That appointment time is already booked.' });

    const confirmation = crypto.randomBytes(4).toString('hex').toUpperCase();
    const result = db.prepare(`INSERT INTO bookings(confirmation,service,vehicle,date,time,name,phone,email,notes,shop_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(confirmation, service.trim(), vehicle.trim(), date, time, name.trim(), phone.trim(), String(email).trim(), String(notes).trim(), shop.id);
    const bookingId = Number(result.lastInsertRowid);
    if (req.files?.length) {
      const insert = db.prepare('INSERT INTO booking_photos(booking_id,filename,original_name) VALUES(?,?,?)');
      for (const file of req.files) insert.run(bookingId, file.filename, file.originalname);
    }

    // Public booking remains the S&K website flow. Internal Garavex-created appointments
    // are intentionally not sent through S&K-specific notification addresses.
    if (!internal && shop.id === skShop()?.id) {
      const customerEmail = String(email || '').trim();
      if (resend && customerEmail) {
        resend.emails.send({
          from: 'S&K Auto <appointments@skautohutch.com>', to: [customerEmail],
          subject: `Your S&K Auto Appointment - ${date} at ${time}`,
          text: `Hi ${name.trim()},\n\nYour appointment with S&K Auto is confirmed.\nVehicle: ${vehicle.trim()}\nService: ${service.trim()}\nDate: ${date}\nTime: ${time}\nConfirmation: ${confirmation}\n\nS&K Auto\n3107 Homestead\nHutchinson, KS 67502\n(620) 899-0425`
        }).catch(err => console.error('V2 customer appointment email failed:', err));
      }
      if (sms && process.env.TWILIO_PHONE_NUMBER && process.env.SMS_TO_NUMBER) {
        sms.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: process.env.SMS_TO_NUMBER,
          body: `New S&K Auto appointment\nCustomer: ${name.trim()}\nPhone: ${phone.trim()}\nVehicle: ${vehicle.trim()}\nService: ${service.trim()}\nDate: ${date}\nTime: ${time}\nConfirmation: ${confirmation}`
        }).catch(err => console.error('V2 shop appointment SMS failed:', err));
      }
    }
    return res.status(201).json({ ok: true, success: true, confirmation, id: bookingId });
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: 'That appointment time is no longer available.' });
    console.error('V2 booking failed:', e); return res.status(500).json({ error: 'Unable to save booking.' });
  }
}

function listAppointments(req, res) {
  try { const shop = shopForRequest(req, res); if (!shop) return; return res.json(db.prepare('SELECT * FROM bookings WHERE shop_id=? ORDER BY date ASC,time ASC').all(shop.id)); }
  catch (e) { console.error('V2 appointment list failed:', e); return res.status(500).json({ error: 'Unable to retrieve appointments.' }); }
}
function deleteAppointment(req, res) {
  try { const shop = shopForRequest(req, res); if (!shop) return; const result = db.prepare('DELETE FROM bookings WHERE id=? AND shop_id=?').run(Number(req.params.id), shop.id); if (!result.changes) return res.status(404).json({ error: 'Appointment not found.' }); return res.json({ success: true, message: 'Appointment deleted.' }); }
  catch (e) { console.error('V2 appointment delete failed:', e); return res.status(500).json({ error: 'Unable to delete appointment.' }); }
}
function updateAppointment(req, res) {
  try {
    const shop = shopForRequest(req, res); if (!shop) return; const id = Number(req.params.id);
    const { date,time,name,phone,email='',vehicle,service,notes='' } = req.body || {};
    if (!date || !time || !name || !phone || !vehicle || !service) return res.status(400).json({ error: 'Please complete all required appointment fields.' });
    if (!SHOP_SLOTS.includes(time) || !validDate(date) || !weekday(date)) return res.status(400).json({ error: 'Please choose a valid Monday-Friday appointment time.' });
    if (!db.prepare('SELECT id FROM bookings WHERE id=? AND shop_id=?').get(id, shop.id)) return res.status(404).json({ error: 'Appointment not found.' });
    if (isBlocked(shop.id, date) || isBlockedTime(shop.id, date, time)) return res.status(409).json({ error: 'That appointment time is unavailable.' });
    if (collision(shop.id, date, time, id)) return res.status(409).json({ error: 'That appointment time is already booked.' });
    db.prepare('UPDATE bookings SET date=?,time=?,name=?,phone=?,email=?,vehicle=?,service=?,notes=? WHERE id=? AND shop_id=?')
      .run(date,time,String(name).trim(),String(phone).trim(),String(email).trim(),String(vehicle).trim(),String(service).trim(),String(notes).trim(),id,shop.id);
    return res.json({ success: true, message: 'Appointment updated successfully.' });
  } catch (e) { console.error('V2 appointment update failed:', e); return res.status(500).json({ error: 'Unable to update appointment.' }); }
}
function updateStatus(req, res) {
  try { const shop = shopForRequest(req, res); if (!shop) return; const allowed=['scheduled','checked_in','in_progress','completed','cancelled']; const status=String(req.body?.status||''); if(!allowed.includes(status)) return res.status(400).json({error:'Invalid appointment status.'}); const result=db.prepare('UPDATE bookings SET status=? WHERE id=? AND shop_id=?').run(status,Number(req.params.id),shop.id); if(!result.changes)return res.status(404).json({error:'Appointment not found.'}); return res.json({success:true,id:Number(req.params.id),status}); }
  catch(e){console.error('V2 appointment status failed:',e);return res.status(500).json({error:'Unable to update appointment status.'});}
}
function blockedDatesGet(req,res){try{const shop=shopForRequest(req,res);if(!shop)return;return res.json({blockedDates:db.prepare('SELECT date,reason FROM blocked_dates WHERE shop_id=? ORDER BY date').all(shop.id)});}catch(e){return res.status(500).json({error:'Unable to load blocked dates.'});}}
function blockedDatesPost(req,res){try{const shop=shopForRequest(req,res);if(!shop)return;const date=String(req.body?.date||''),reason=String(req.body?.reason||'').trim();if(!validDate(date))return res.status(400).json({error:'Invalid date.'});db.prepare('INSERT INTO blocked_dates(shop_id,date,reason) VALUES(?,?,?) ON CONFLICT(shop_id,date) DO UPDATE SET reason=excluded.reason').run(shop.id,date,reason);return res.json({ok:true,date,reason});}catch(e){return res.status(500).json({error:'Unable to block date.'});}}
function blockedDatesDelete(req,res){try{const shop=shopForRequest(req,res);if(!shop)return;const date=String(req.params.date||'');if(!validDate(date))return res.status(400).json({error:'Invalid date.'});db.prepare('DELETE FROM blocked_dates WHERE shop_id=? AND date=?').run(shop.id,date);return res.json({ok:true,date});}catch(e){return res.status(500).json({error:'Unable to unblock date.'});}}
function blockedTimesGet(req,res){try{const shop=shopForRequest(req,res);if(!shop)return;return res.json({blockedTimes:db.prepare('SELECT date,time,reason FROM blocked_times WHERE shop_id=? ORDER BY date,time').all(shop.id)});}catch(e){return res.status(500).json({error:'Unable to load blocked times.'});}}
function blockedTimesPost(req,res){try{const shop=shopForRequest(req,res);if(!shop)return;const date=String(req.body?.date||''),time=String(req.body?.time||''),reason=String(req.body?.reason||'').trim();if(!validDate(date)||!SHOP_SLOTS.includes(time))return res.status(400).json({error:'Invalid date or time.'});db.prepare('INSERT INTO blocked_times(shop_id,date,time,reason) VALUES(?,?,?,?) ON CONFLICT(shop_id,date,time) DO UPDATE SET reason=excluded.reason').run(shop.id,date,time,reason);return res.json({ok:true,date,time,reason});}catch(e){return res.status(500).json({error:'Unable to block time.'});}}
function blockedTimesDelete(req,res){try{const shop=shopForRequest(req,res);if(!shop)return;const date=String(req.params.date||''),time=String(req.params.time||'');db.prepare('DELETE FROM blocked_times WHERE shop_id=? AND date=? AND time=?').run(shop.id,date,time);return res.json({ok:true,date,time});}catch(e){return res.status(500).json({error:'Unable to unblock time.'});}}

async function sendTenantAppointmentReminders() {
  try {
    const reminderTime = new Date(Date.now() + 24*60*60*1000);
    const date = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(reminderTime);
    const rows = db.prepare(`SELECT b.*,s.name shop_name,s.phone shop_phone FROM bookings b JOIN shops s ON s.id=b.shop_id WHERE b.date=? AND b.reminder_sent=0 AND COALESCE(b.status,'scheduled')='scheduled'`).all(date);
    if (!sms || !process.env.TWILIO_PHONE_NUMBER) return;
    for (const row of rows) {
      const to=normalizePhone(row.phone); if(!to)continue;
      try { await sms.messages.create({from:process.env.TWILIO_PHONE_NUMBER,to,body:`${row.shop_name}: Reminder - you have an appointment tomorrow at ${row.time} for ${row.service}. Confirmation: ${row.confirmation}.${row.shop_phone ? ' Questions? Call '+row.shop_phone+'.' : ''} Reply STOP to opt out.`}); db.prepare('UPDATE bookings SET reminder_sent=1 WHERE id=? AND shop_id=?').run(row.id,row.shop_id); }
      catch(err){console.error(`V2 appointment reminder failed for booking ${row.id}:`,err?.message||err);}
    }
  } catch(e){console.error('V2 appointment reminder checker failed:',e);}
}

const get=express.application.get, post=express.application.post, patch=express.application.patch, del=express.application.delete;
express.application.get=function(route,...handlers){
  if(route==='/api/availability') return get.call(this,route,availability);
  if(route==='/api/appointments') return get.call(this,route,listAppointments);
  if(route==='/api/admin/blocked-dates') return get.call(this,route,blockedDatesGet);
  if(route==='/api/admin/blocked-times') return get.call(this,route,blockedTimesGet);
  return get.call(this,route,...handlers);
};
express.application.post=function(route,...handlers){
  if(route==='/api/book') return post.call(this,route,...handlers.slice(0,-1),book);
  if(route==='/api/admin/blocked-dates') return post.call(this,route,blockedDatesPost);
  if(route==='/api/admin/blocked-times') return post.call(this,route,blockedTimesPost);
  return post.call(this,route,...handlers);
};
express.application.patch=function(route,...handlers){
  if(route==='/api/appointments/:id') return patch.call(this,route,updateAppointment);
  if(route==='/api/appointments/:id/status') return patch.call(this,route,updateStatus);
  return patch.call(this,route,...handlers);
};
express.application.delete=function(route,...handlers){
  if(route==='/api/appointments/:id') return del.call(this,route,deleteAppointment);
  if(route==='/api/admin/blocked-dates/:date') return del.call(this,route,blockedDatesDelete);
  if(route==='/api/admin/blocked-times/:date/:time') return del.call(this,route,blockedTimesDelete);
  return del.call(this,route,...handlers);
};

setTimeout(()=>{ sendTenantAppointmentReminders(); setInterval(sendTenantAppointmentReminders,15*60*1000); },1000);
