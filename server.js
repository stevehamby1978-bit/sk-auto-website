
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');
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
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, time)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS blocked_dates (
    date TEXT PRIMARY KEY,
    reason TEXT DEFAULT ''
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
  const rows = db.prepare('SELECT time FROM bookings WHERE date = ?').all(date);
  const booked = new Set(rows.map(r => r.time));
  const available = SHOP_SLOTS.filter(t => !booked.has(t));
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
app.get('/api/health', (req, res) => {
  res.json({ok: true});
});

app.listen(PORT, () => {
  console.log(`S&K Auto website running on http://localhost:${PORT}`);
});

