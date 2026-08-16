
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');
const twilio = require('twilio');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'bookings.db');
const db = new Database(dbPath);

console.log(`Using booking database: ${dbPath}`);

app.use(express.json());
app.use(express.static(__dirname));

db.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    confirmation TEXT NOT NULL UNIQUE,
    service TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    notes TEXT,
    reminder_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, time)
  )
`);
const bookingColumns = db.prepare("PRAGMA table_info(bookings)").all();

if (!bookingColumns.some(column => column.name === 'reminder_sent')) {
  db.exec(`
    ALTER TABLE bookings
    ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_dates (
    date TEXT PRIMARY KEY,
    reason TEXT DEFAULT ''
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_times (
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    reason TEXT DEFAULT '',
    PRIMARY KEY (date, time)
  );
`);

const SHOP_SLOTS = [
  '8:00 AM','9:00 AM','10:00 AM','11:00 AM',
  '12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM'
];
function isBlockedDate(date) {
  return db
    .prepare('SELECT 1 FROM blocked_dates WHERE date = ?')
    .get(date) !== undefined;
}
function isWeekday(dateString) {
  const d = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

function isValidDateString(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

app.get('/api/availability', (req, res) => {
  const date = String(req.query.date || '');
  if (!isValidDateString(date) || !isWeekday(date)) {
    return res.status(400).json({error: 'Choose a Monday-Friday date.'});
  }
if (isBlockedDate(date)) {
  return res.json({
    date,
    available: [],
    blocked: true,
    message: 'S&K Auto is closed on this date.'
  });
}
const rows = db
  .prepare('SELECT time FROM bookings WHERE date = ?')
  .all(date);

const blockedRows = db
  .prepare('SELECT time FROM blocked_times WHERE date = ?')
  .all(date);

const booked = new Set(rows.map(r => r.time));
const blocked = new Set(blockedRows.map(r => r.time));

const available = SHOP_SLOTS.filter(
  t => !booked.has(t) && !blocked.has(t)
);
  res.json({date, available});
});

app.post('/api/book', (req, res) => {
  const {service, vehicle, date, time, name, phone, email = '', notes = ''} = req.body || {};

  if (![service, vehicle, date, time, name, phone].every(v => typeof v === 'string' && v.trim())) {
    return res.status(400).json({error: 'Missing required fields.'});
  }
  if (!isValidDateString(date) || !isWeekday(date)) {
    return res.status(400).json({error: 'Appointments are Monday-Friday only.'});
  }
  if (isBlockedDate(date)) {
  return res.status(400).json({
    error: 'S&K Auto is closed on this date. Please choose another day.'
  });
}
  const blockedTime = db
  .prepare('SELECT 1 FROM blocked_times WHERE date = ? AND time = ?')
  .get(date, time);

if (blockedTime) {
  return res.status(400).json({
    error: 'That appointment time is unavailable. Please choose another time.'
  });
}
  if (!SHOP_SLOTS.includes(time)) {
    return res.status(400).json({error: 'Invalid appointment time.'});
  }

  const confirmation = crypto.randomBytes(4).toString('hex').toUpperCase();

  try {
    db.prepare(`
      INSERT INTO bookings
      (confirmation, service, vehicle, date, time, name, phone, email, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      confirmation,
      service.trim(),
      vehicle.trim(),
      date,
      time,
      name.trim(),
      phone.trim(),
      String(email).trim(),
      String(notes).trim()
    );
resend.emails.send({
  from: 'S&K Auto <appointments@skautohutch.com>',
  to: ['skauto986@gmail.com'],
  subject: `New Appointment - ${date} at ${time}`,

  html: `
    <div style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;">
      <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #dddddd;">

        <div style="background:#151515;color:#ffffff;padding:22px;text-align:center;">
          <h1 style="margin:0;font-size:26px;">S&K AUTO</h1>
          <p style="margin:5px 0 0;color:#cccccc;">The Art of Automotive Repair</p>
        </div>

        <div style="padding:25px;">
          <h2 style="margin-top:0;">New Service Appointment</h2>

          <p>A new appointment has been scheduled through the S&K Auto website.</p>

          <table style="width:100%;border-collapse:collapse;font-size:16px;">
            <tr>
              <td style="padding:8px 0;font-weight:bold;">Customer</td>
              <td style="padding:8px 0;">${name.trim()}</td>
            </tr>

            <tr>
              <td style="padding:8px 0;font-weight:bold;">Phone</td>
              <td style="padding:8px 0;">${phone.trim()}</td>
            </tr>

            <tr>
              <td style="padding:8px 0;font-weight:bold;">Email</td>
              <td style="padding:8px 0;">${String(email).trim() || 'Not provided'}</td>
            </tr>

            <tr>
              <td style="padding:8px 0;font-weight:bold;">Vehicle</td>
              <td style="padding:8px 0;">${vehicle.trim()}</td>
            </tr>

            <tr>
              <td style="padding:8px 0;font-weight:bold;">Service</td>
              <td style="padding:8px 0;">${service.trim()}</td>
            </tr>

            <tr>
              <td style="padding:8px 0;font-weight:bold;">Date</td>
              <td style="padding:8px 0;">${date}</td>
            </tr>

            <tr>
              <td style="padding:8px 0;font-weight:bold;">Time</td>
              <td style="padding:8px 0;">${time}</td>
            </tr>
          </table>

          <div style="margin-top:20px;padding:15px;background:#f7f7f7;border-left:4px solid #d9271c;">
            <strong>Notes</strong><br>
            ${String(notes).trim() || 'None'}
          </div>

          <p style="margin-top:22px;">
            <strong>Confirmation Number:</strong> ${confirmation}
          </p>
        </div>

        <div style="background:#151515;color:#bbbbbb;padding:15px;text-align:center;font-size:13px;">
          S&K Auto • Hutchinson, Kansas
        </div>

      </div>
    </div>
  `,

  text: `
New appointment booked on the S&K Auto website.

Customer: ${name.trim()}
Phone: ${phone.trim()}
Email: ${String(email).trim() || 'Not provided'}

Vehicle: ${vehicle.trim()}
Service: ${service.trim()}

Date: ${date}
Time: ${time}

Notes:
${String(notes).trim() || 'None'}

Confirmation Number: ${confirmation}
  `
}).then(({ error }) => {
  if (error) {
    console.error('Booking email failed:', error);
  }
}).catch(err => {
  console.error('Booking email failed:', err);
});
    if (String(email).trim()) {
  resend.emails.send({
    from: 'S&K Auto <appointments@skautohutch.com>',
    to: [String(email).trim()],
    subject: `Your S&K Auto Appointment - ${date} at ${time}`,

    html: `
      <div style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;">
        <div style="max-width:600px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #dddddd;">

          <div style="background:#151515;color:#ffffff;padding:22px;text-align:center;">
            <h1 style="margin:0;font-size:26px;">S&K AUTO</h1>
            <p style="margin:5px 0 0;color:#cccccc;">The Art of Automotive Repair</p>
          </div>

          <div style="padding:25px;">
            <h2 style="margin-top:0;">Appointment Confirmed</h2>

            <p>Hi ${name.trim()},</p>

            <p>Your appointment with S&K Auto has been scheduled successfully.</p>

            <table style="width:100%;border-collapse:collapse;font-size:16px;">
              <tr>
                <td style="padding:8px 0;font-weight:bold;">Vehicle</td>
                <td style="padding:8px 0;">${vehicle.trim()}</td>
              </tr>

              <tr>
                <td style="padding:8px 0;font-weight:bold;">Service</td>
                <td style="padding:8px 0;">${service.trim()}</td>
              </tr>

              <tr>
                <td style="padding:8px 0;font-weight:bold;">Date</td>
                <td style="padding:8px 0;">${date}</td>
              </tr>

              <tr>
                <td style="padding:8px 0;font-weight:bold;">Time</td>
                <td style="padding:8px 0;">${time}</td>
              </tr>
            </table>

            <div style="margin-top:20px;padding:15px;background:#f7f7f7;border-left:4px solid #d9271c;">
              <strong>Confirmation Number:</strong> ${confirmation}
            </div>

            <p style="margin-top:22px;">
              S&K Auto<br>
              3107 Homestead<br>
              Hutchinson, KS 67502<br>
              Phone: (620) 899-0425
            </p>

            <p>Please call us if you need to make any changes to your appointment.</p>
          </div>

          <div style="background:#151515;color:#bbbbbb;padding:15px;text-align:center;font-size:13px;">
            S&K Auto • The Art of Automotive Repair
          </div>

        </div>
      </div>
    `,

    text: `
Hi ${name.trim()},

Your appointment with S&K Auto has been confirmed.

Vehicle: ${vehicle.trim()}
Service: ${service.trim()}
Date: ${date}
Time: ${time}

Confirmation Number: ${confirmation}

S&K Auto
3107 Homestead
Hutchinson, KS 67502
(620) 899-0425

Please call us if you need to make any changes to your appointment.
    `
  }).then(({ error }) => {
    if (error) {
      console.error('Customer confirmation email failed:', error);
    }
  }).catch(err => {
    console.error('Customer confirmation email failed:', err);
  });
}
twilioClient.messages.create({
  body: `New S&K Auto appointment

Customer: ${name.trim()}
Phone: ${phone.trim()}
Vehicle: ${vehicle.trim()}
Service: ${service.trim()}
Date: ${date}
Time: ${time}
Confirmation: ${confirmation}`,
  from: process.env.TWILIO_PHONE_NUMBER,
  to: process.env.SMS_TO_NUMBER
})
.then(message => {
  console.log('Appointment SMS sent:', message.sid);
})
.catch(err => {
  console.error('Appointment SMS failed:', err);
});    
    
    res.status(201).json({ok: true, confirmation});
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed: bookings.date, bookings.time')) {
      return res.status(409).json({error: 'That appointment time is no longer available.'});
    }
    console.error(err);
    res.status(500).json({error: 'Unable to save booking.'});
  }
});
app.get('/api/admin/blocked-dates', (req, res) => {
  const rows = db
    .prepare('SELECT date, reason FROM blocked_dates ORDER BY date')
    .all();

  res.json({ blockedDates: rows });
});

app.post('/api/admin/blocked-dates', (req, res) => {
  const date = String(req.body.date || '');
  const reason = String(req.body.reason || '').trim();

  if (!isValidDateString(date)) {
    return res.status(400).json({ error: 'Invalid date.' });
  }

  db.prepare(`
    INSERT INTO blocked_dates (date, reason)
    VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET reason = excluded.reason
  `).run(date, reason);

  res.json({ ok: true, date, reason });
});

app.delete('/api/admin/blocked-dates/:date', (req, res) => {
  const date = String(req.params.date || '');

  if (!isValidDateString(date)) {
    return res.status(400).json({ error: 'Invalid date.' });
  }

  db.prepare('DELETE FROM blocked_dates WHERE date = ?').run(date);

  res.json({ ok: true, date });
});
app.get('/api/admin/blocked-times', (req, res) => {
  const rows = db
    .prepare('SELECT date, time, reason FROM blocked_times ORDER BY date, time')
    .all();

  res.json({ blockedTimes: rows });
});

app.post('/api/admin/blocked-times', (req, res) => {
  const date = String(req.body.date || '');
  const time = String(req.body.time || '');
  const reason = String(req.body.reason || '').trim();

  if (!isValidDateString(date)) {
    return res.status(400).json({ error: 'Invalid date.' });
  }

  if (!SHOP_SLOTS.includes(time)) {
    return res.status(400).json({ error: 'Invalid time.' });
  }

  db.prepare(`
    INSERT INTO blocked_times (date, time, reason)
    VALUES (?, ?, ?)
    ON CONFLICT(date, time) DO UPDATE SET reason = excluded.reason
  `).run(date, time, reason);

  res.json({ ok: true, date, time, reason });
});

app.delete('/api/admin/blocked-times/:date/:time', (req, res) => {
  const date = String(req.params.date || '');
  const time = String(req.params.time || '');

  if (!isValidDateString(date)) {
    return res.status(400).json({ error: 'Invalid date.' });
  }

  db.prepare(
    'DELETE FROM blocked_times WHERE date = ? AND time = ?'
  ).run(date, time);

  res.json({ ok: true, date, time });
});
app.get('/api/health', (req, res) => {
  res.json({ok: true});
});
function normalizePhoneNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  return phone;
}
function timeToMinutes(timeString) {
  const match = String(timeString).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3].toUpperCase();

  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;

  return hour * 60 + minute;
}
async function sendAppointmentReminders() {
  try {
    const now = new Date();
    const reminderTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const chicagoDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(reminderTime);

    const chicagoTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(reminderTime);

     const appointments = db.prepare(`
  SELECT *
  FROM bookings
  WHERE date = ?
    AND reminder_sent = 0
`).all(chicagoDate);

    for (const appointment of appointments) {
      const appointmentMinutes = timeToMinutes(appointment.time);
const reminderMinutes = timeToMinutes(chicagoTime);

if (
  appointmentMinutes === null ||
  reminderMinutes === null ||
  appointmentMinutes > reminderMinutes ||
  appointmentMinutes <= reminderMinutes - 60
) {
  continue;
}
      try {
        await twilioClient.messages.create({
          body: `S&K Auto reminder: You have an appointment tomorrow at ${appointment.time} for ${appointment.service}. Confirmation: ${appointment.confirmation}. Please call us if you need to make changes. Reply STOP to opt out.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: normalizePhoneNumber(appointment.phone)
        });

        db.prepare(`
          UPDATE bookings
          SET reminder_sent = 1
          WHERE id = ?
        `).run(appointment.id);

        console.log(`Reminder SMS sent for booking ${appointment.confirmation}`);
      } catch (err) {
        console.error(`Reminder SMS failed for booking ${appointment.confirmation}:`, err);
      }
    }
  } catch (err) {
    console.error('Reminder checker failed:', err);
  }
}

sendAppointmentReminders();

setInterval(sendAppointmentReminders, 15 * 60 * 1000);
app.listen(PORT, () => {
  console.log(`S&K Auto website running on http://localhost:${PORT}`);
});

