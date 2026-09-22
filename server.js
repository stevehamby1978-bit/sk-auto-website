/*
 * S&K Auto Shop Management System
 * Copyright © 2026 S&K Auto. All Rights Reserved.
 *
 * This software and its source code are proprietary to S&K Auto.
 * Unauthorized copying, modification, distribution, or commercial use
 * is prohibited except with permission from the copyright owner.
 */
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');
const twilio = require('twilio');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
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
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    files: 3,
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif'
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed.'));
    }
  }
});
const dbPath = path.join(dataDir, 'bookings.db');
const db = new Database(dbPath);

console.log(`Using booking database: ${dbPath}`);

app.use(express.json());
// ===== S&K AUTO - EMPLOYEE SESSIONS =====
app.set('trust proxy', 1);

app.use(session({
  name: 'skauto_session',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));
// ===== S&K AUTO - REQUIRE EMPLOYEE LOGIN =====
function requireLogin(req, res, next) {
  if (req.session && req.session.employee) {
    return next();
  }

  return res.redirect('/login.html');
}
// ===== S&K AUTO - REQUIRE OWNER =====
function requireOwner(req, res, next) {
  if (
    req.session &&
    req.session.employee &&
    req.session.employee.role === 'owner'
  ) {
    return next();
  }

  return res.status(403).send(
    'Access denied. Owner permission required.'
  );
}
// ===== S&K AUTO - PROTECTED SHOP PAGES =====
const protectedPages = [
  '/dashboard.html',
  '/customers.html',
  '/customer.html',
  '/estimates-admin.html',
  '/repair-orders.html',
  '/repair-order.html',
  '/invoices.html',
  '/invoice.html',
  '/appointments.html'
  
];

app.get(protectedPages, requireLogin);
// ===== S&K AUTO - OWNER ONLY PAGES =====
app.get('/employees.html', requireLogin, requireOwner);
app.use(express.static(__dirname));
app.get('/repair-order.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'repair-order.html'));
});
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
    status TEXT NOT NULL DEFAULT 'scheduled',
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
if (!bookingColumns.some(column => column.name === 'status')) {
  db.exec(`
    ALTER TABLE bookings
    ADD COLUMN status TEXT NOT NULL DEFAULT 'scheduled'
  `);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
  )
`);

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

// ===== S&K AUTO ESTIMATE SYSTEM =====

db.exec(`
-- ===== S&K AUTO SaaS - SHOPS =====
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

  -- ===== S&K AUTO - EMPLOYEES =====
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'technician',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    year TEXT,
    make TEXT,
    model TEXT,
    vin TEXT,
    mileage TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS estimates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    vehicle_id INTEGER,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    responded_at TEXT,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
  );

  CREATE TABLE IF NOT EXISTS estimate_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estimate_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    parts REAL NOT NULL DEFAULT 0,
    labor REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS repair_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    estimate_id INTEGER,
    customer_id INTEGER NOT NULL,
    vehicle_id INTEGER,
    status TEXT NOT NULL DEFAULT 'waiting',
    technician_notes TEXT,
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
payment_method TEXT,
paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    FOREIGN KEY (estimate_id) REFERENCES estimates(id),
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
  );

  CREATE TABLE IF NOT EXISTS repair_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repair_order_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    parts REAL NOT NULL DEFAULT 0,
    labor REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (repair_order_id) REFERENCES repair_orders(id) ON DELETE CASCADE
  );
`);
// ===== S&K AUTO - REPAIR ORDER AUTHORIZATION MIGRATION =====

const repairOrderColumns = db
  .prepare(`PRAGMA table_info(repair_orders)`)
  .all()
  .map(column => column.name);
// ===== S&K AUTO - PAYMENT HISTORY TABLE =====
db.exec(`
  CREATE TABLE IF NOT EXISTS repair_order_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repair_order_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repair_order_id)
      REFERENCES repair_orders(id)
      ON DELETE CASCADE
  );
`);
// ===== S&K AUTO - INVOICE EMAIL HISTORY =====
db.prepare(`
  CREATE TABLE IF NOT EXISTS invoice_email_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repair_order_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repair_order_id)
      REFERENCES repair_orders(id)
      ON DELETE CASCADE
  );
`).run();
// ===== S&K AUTO SaaS - CREATE PRIMARY SHOP =====
db.prepare(`
  INSERT OR IGNORE INTO shops (
    name,
    slug,
    phone,
    email,
    address,
    city,
    state,
    zip
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'S&K Auto',
  'sk-auto',
  '(620) 899-0425',
  null,
  '3107 Homestead',
  'Hutchinson',
  'KS',
  '67502'
);
// ===== S&K AUTO - PAYMENT AMOUNT MIGRATION =====
if (!repairOrderColumns.includes("amount_paid")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN amount_paid REAL NOT NULL DEFAULT 0
  `).run();
}
if (!repairOrderColumns.includes("authorized_by")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN authorized_by TEXT
  `).run();
}

if (!repairOrderColumns.includes("authorization_method")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN authorization_method TEXT
  `).run();
}

if (!repairOrderColumns.includes("authorization_notes")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN authorization_notes TEXT
  `).run();
}
// ===== S&K AUTO - REPAIR ORDER PAYMENT MIGRATION =====

if (!repairOrderColumns.includes("payment_status")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'
  `).run();
}

if (!repairOrderColumns.includes("payment_method")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN payment_method TEXT
  `).run();
}

if (!repairOrderColumns.includes("paid_at")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN paid_at TEXT
  `).run();
}

if (!repairOrderColumns.includes("authorized_at")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN authorized_at TEXT
  `).run();
}
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

app.post('/api/book', upload.array('photos', 3), (req, res) => {
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
  
     const bookingResult = db.prepare(`
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
const bookingId = bookingResult.lastInsertRowid;

if (req.files && req.files.length > 0) {
  const insertPhoto = db.prepare(`
    INSERT INTO booking_photos
    (booking_id, filename, original_name)
    VALUES (?, ?, ?)
  `);

  for (const file of req.files) {
    insertPhoto.run(
      bookingId,
      file.filename,
      file.originalname
    );
  }
}
    
    resend.emails.send({
  from: 'S&K Auto <appointments@skautohutch.com>',
  to: ['skauto986@gmail.com'],
  subject: `New Appointment - ${date} at ${time}`,
attachments: (req.files || []).map(file => ({
  filename: file.originalname,
  content: fs.readFileSync(file.path)
})),
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
// ===== S&K AUTO - GET ALL ESTIMATES =====
app.get("/api/estimates", (req, res) => {
  try {
    const estimates = db.prepare(`
      SELECT
        e.*,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model,
        v.vin AS vehicle_vin,
        v.mileage AS vehicle_mileage
      FROM estimates e
      LEFT JOIN customers c ON e.customer_id = c.id
      LEFT JOIN vehicles v ON e.vehicle_id = v.id
      WHERE e.shop_id = ?
      ORDER BY e.id DESC
   `).all(req.session.employee.shop_id);

    res.json(estimates);
  } catch (err) {
    console.error("Get estimates error:", err);
    res.status(500).json({
      error: "Unable to retrieve estimates."
    });
  }
});
// ----- S&K AUTO - GET ONE ESTIMATE -----
app.get('/api/estimates/:token', (req, res) => {
  try {
    const estimate = db.prepare(`
      SELECT
        e.*,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model,
        v.vin AS vehicle_vin,
        v.mileage AS vehicle_mileage
      FROM estimates e
      LEFT JOIN customers c ON e.customer_id = c.id
      LEFT JOIN vehicles v ON e.vehicle_id = v.id
      WHERE e.token = ?
    `).get(req.params.token);
const items = estimate
  ? db.prepare(`
      SELECT description, parts, labor
      FROM estimate_items
      WHERE estimate_id = ?
      ORDER BY id ASC
    `).all(estimate.id)
  : [];

if (estimate) {
  estimate.items = items;

  const subtotal = items.reduce((sum, item) => {
    return sum + Number(item.parts || 0) + Number(item.labor || 0);
  }, 0);

 estimate.subtotal = subtotal;

const taxRate = 0.075;
estimate.tax = Math.round(subtotal * taxRate * 100) / 100;

estimate.total =
  Math.round((subtotal + estimate.tax) * 100) / 100;
}
    if (!estimate) {
      return res.status(404).send('Estimate not found');
    }

    res.json(estimate);

  } catch (err) {
    console.error('Get estimate error:', err);
    res.status(500).json({
      error: 'Unable to retrieve estimate.'
    });
  }
});
// ===== S&K AUTO - EMPLOYEE TEMPORARY PASSWORD MIGRATION =====
try {
  const employeeColumns = db.prepare(`
    PRAGMA table_info(employees)
  `).all();

  const hasMustChangePassword = employeeColumns.some(
    column => column.name === 'must_change_password'
  );

  if (!hasMustChangePassword) {
    db.prepare(`
      ALTER TABLE employees
      ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
    `).run();

    console.log('Added must_change_password column to employees.');
  }
} catch (err) {
  console.error('Employee password migration error:', err);
}

// ===== S&K AUTO SaaS - EMPLOYEE SHOP MIGRATION =====
const employeeShopColumns = db.prepare(`
  PRAGMA table_info(employees)
`).all().map(column => column.name);

if (!employeeShopColumns.includes("shop_id")) {
  db.prepare(`
    ALTER TABLE employees
    ADD COLUMN shop_id INTEGER
  `).run();
}
// ===== S&K AUTO SaaS - ASSIGN EXISTING EMPLOYEES =====
const primaryShop = db.prepare(`
  SELECT id
  FROM shops
  WHERE slug = ?
  LIMIT 1
`).get('sk-auto');

if (primaryShop) {
  db.prepare(`
    UPDATE employees
    SET shop_id = ?
    WHERE shop_id IS NULL
  `).run(primaryShop.id);
}
// ===== S&K AUTO SaaS - CUSTOMER SHOP MIGRATION =====
const customerShopColumns = db.prepare(`
  PRAGMA table_info(customers)
`).all().map(column => column.name);

if (!customerShopColumns.includes("shop_id")) {
  db.prepare(`
    ALTER TABLE customers
    ADD COLUMN shop_id INTEGER
  `).run();
}

// ===== S&K AUTO SaaS - ASSIGN EXISTING CUSTOMERS =====
if (primaryShop) {
  db.prepare(`
    UPDATE customers
    SET shop_id = ?
    WHERE shop_id IS NULL
  `).run(primaryShop.id);
}
// ===== S&K AUTO SaaS - VEHICLE SHOP MIGRATION =====
const vehicleShopColumns = db.prepare(`
  PRAGMA table_info(vehicles)
`).all().map(column => column.name);

if (!vehicleShopColumns.includes("shop_id")) {
  db.prepare(`
    ALTER TABLE vehicles
    ADD COLUMN shop_id INTEGER
  `).run();
}

// ===== S&K AUTO SaaS - ASSIGN EXISTING VEHICLES =====
if (primaryShop) {
  db.prepare(`
    UPDATE vehicles
    SET shop_id = ?
    WHERE shop_id IS NULL
  `).run(primaryShop.id);
}

// ===== S&K AUTO - EMPLOYEE LOGIN =====
app.post("/api/login", async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    const employee = db.prepare(`
      SELECT
        id,
        name,
        email,
        password_hash,
       role,
must_change_password,
shop_id,
active
      FROM employees
      WHERE LOWER(email) = ?
      LIMIT 1
    `).get(cleanEmail);

    if (!employee) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

    if (!employee.active) {
      return res.status(403).json({
        error: "This employee account is inactive."
      });
    }

    const passwordMatches =
      await bcrypt.compare(
        password,
        employee.password_hash
      );

    if (!passwordMatches) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

   req.session.employee = {
  id: employee.id,
  name: employee.name,
  email: employee.email,
 role: employee.role,
shop_id: employee.shop_id,
must_change_password: employee.must_change_password
};
    req.session.save(err => {
      if (err) {
        console.error("Session save error:", err);

        return res.status(500).json({
          error: "Unable to complete login."
        });
      }

      res.json({
        success: true,
      employee: {
  id: employee.id,
  name: employee.name,
  email: employee.email,
 role: employee.role,
shop_id: employee.shop_id,
must_change_password: employee.must_change_password
}
      });
    });

  } catch (err) {
    console.error("Employee login error:", err);

    res.status(500).json({
      error: "Unable to log in."
    });
  }
});
// ===== S&K AUTO - CHANGE EMPLOYEE PASSWORD =====
app.post("/api/change-password", async (req, res) => {
  try {
    if (!req.session.employee || !req.session.employee.id) {
      return res.status(401).json({
        error: "You must be signed in to change your password."
      });
    }

    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({
        error: "New password must be at least 8 characters."
      });
    }

    const employeeId = req.session.employee.id;

    const passwordHash = await bcrypt.hash(newPassword, 12);

    const result = db.prepare(`
      UPDATE employees
      SET
        password_hash = ?,
        must_change_password = 0
      WHERE id = ?
    `).run(
      passwordHash,
      employeeId
    );

    if (result.changes === 0) {
      return res.status(404).json({
        error: "Employee account not found."
      });
    }

    req.session.employee.must_change_password = 0;

    req.session.save(err => {
      if (err) {
        console.error("Password change session error:", err);

        return res.status(500).json({
          error: "Password changed, but the session could not be updated."
        });
      }

      res.json({
        success: true
      });
    });

  } catch (err) {
    console.error("Change employee password error:", err);

    res.status(500).json({
      error: "Unable to change password."
    });
  }
});

// ===== S&K AUTO - EMPLOYEE LOGOUT =====
app.post("/api/logout", (req, res) => {
  if (!req.session) {
    return res.json({
      success: true
    });
  }

  req.session.destroy(err => {
    if (err) {
      console.error("Employee logout error:", err);

      return res.status(500).json({
        error: "Unable to log out."
      });
    }

    res.clearCookie('skauto_session');

    res.json({
      success: true
    });
  });
});
// ===== S&K AUTO - CURRENT EMPLOYEE =====
app.get("/api/current-employee", (req, res) => {
  if (!req.session || !req.session.employee) {
    return res.status(401).json({
      error: "Not logged in."
    });
  }

  res.json({
    employee: req.session.employee
  });
});


// ===== S&K AUTO - GET EMPLOYEES =====
app.get("/api/employees", (req, res) => {
  try {
    const employees = db.prepare(`
      SELECT
        id,
        name,
        email,
        role,
        active,
        created_at
      FROM employees
      ORDER BY active DESC, name ASC
    `).all();

    res.json(employees);

  } catch (err) {
    console.error("Get employees error:", err);

    res.status(500).json({
      error: "Unable to load employees."
    });
  }
});

// ===== S&K AUTO - ADD EMPLOYEE =====
app.post("/api/employees", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Employee name is required."
      });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({
        error: "Employee email is required."
      });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters."
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    const allowedRoles = [
      "owner",
      "manager",
      "service_writer",
      "technician"
    ];

    const employeeRole = allowedRoles.includes(role)
      ? role
      : "technician";

    const existingEmployee = db.prepare(`
      SELECT id
      FROM employees
      WHERE LOWER(email) = ?
    `).get(cleanEmail);

    if (existingEmployee) {
      return res.status(409).json({
        error: "An employee with this email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
    INSERT INTO employees (
  name,
  email,
  password_hash,
  role,
  active,
  must_change_password
)
VALUES (?, ?, ?, ?, 1, 1)
    `).run(
      name.trim(),
      cleanEmail,
      passwordHash,
      employeeRole
    );

    res.status(201).json({
      success: true,
      employee: {
        id: result.lastInsertRowid,
        name: name.trim(),
        email: cleanEmail,
        role: employeeRole,
        active: 1
      }
    });

  } catch (err) {
    console.error("Add employee error:", err);

    res.status(500).json({
      error: "Unable to add employee."
    });
  }
});
// ===== S&K AUTO - RESET EMPLOYEE PASSWORD =====
app.post("/api/employees/:id/reset-password", async (req, res) => {
  try {
    if (
      !req.session ||
      !req.session.employee ||
      req.session.employee.role !== "owner"
    ) {
      return res.status(403).json({
        error: "Only the owner can reset employee passwords."
      });
    }

    const employeeId = Number(req.params.id);
    const { temporaryPassword } = req.body;

    if (!employeeId) {
      return res.status(400).json({
        error: "Employee is required."
      });
    }

    if (!temporaryPassword || temporaryPassword.length < 8) {
      return res.status(400).json({
        error: "Temporary password must be at least 8 characters."
      });
    }

    const employee = db.prepare(`
      SELECT id, name
      FROM employees
      WHERE id = ?
    `).get(employeeId);

    if (!employee) {
      return res.status(404).json({
        error: "Employee account not found."
      });
    }

    const passwordHash = await bcrypt.hash(
      temporaryPassword,
      12
    );

    db.prepare(`
      UPDATE employees
      SET
        password_hash = ?,
        must_change_password = 1
      WHERE id = ?
    `).run(
      passwordHash,
      employeeId
    );

    res.json({
      success: true,
      message: "Temporary password created successfully."
    });

  } catch (err) {
    console.error("Reset employee password error:", err);

    res.status(500).json({
      error: "Unable to reset employee password."
    });
  }
});

// ===== S&K AUTO - ADD CUSTOMER =====
app.post("/api/customers", (req, res) => {
  try {

    const {
      name,
      phone,
      email
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Customer name is required."
      });
    }
// Check for an existing customer with the same phone or email
const cleanPhone = phone ? phone.replace(/\D/g, "") : "";
const cleanEmail = email ? email.trim().toLowerCase() : "";

const existingCustomers = db.prepare(`
  SELECT id, name, phone, email
  FROM customers
  WHERE shop_id = ?
`).all(req.session.employee.shop_id);

const duplicateCustomer = existingCustomers.find(existing => {
  const existingPhone = existing.phone
    ? existing.phone.replace(/\D/g, "")
    : "";

  const existingEmail = existing.email
    ? existing.email.trim().toLowerCase()
    : "";

  const phoneMatches =
    cleanPhone &&
    existingPhone &&
    cleanPhone === existingPhone;

  const emailMatches =
    cleanEmail &&
    existingEmail &&
    cleanEmail === existingEmail;

  return phoneMatches || emailMatches;
});

if (duplicateCustomer) {
  return res.status(409).json({
    error: "Possible duplicate customer.",
    duplicate: {
      id: duplicateCustomer.id,
      name: duplicateCustomer.name,
      phone: duplicateCustomer.phone,
      email: duplicateCustomer.email
    }
  });
}
  const result = db.prepare(`
  INSERT INTO customers
  (name, phone, email, shop_id)
  VALUES (?, ?, ?, ?)
`).run(
  name.trim(),
  phone ? phone.trim() : "",
  email ? email.trim() : "",
  req.session.employee.shop_id
);

    res.status(201).json({
      success: true,
      id: Number(result.lastInsertRowid),
      name: name.trim(),
      phone: phone ? phone.trim() : "",
      email: email ? email.trim() : ""
    });

  } catch (err) {

    console.error("Add customer error:", err);

    res.status(500).json({
      error: "Unable to add customer."
    });

  }
});

// ===== S&K AUTO - GET ALL CUSTOMERS =====
app.get("/api/customers", (req, res) => {
  try {
    const customers = db.prepare(`
      SELECT
        c.id,
        c.name,
        c.phone,
        c.email,
        COUNT(DISTINCT v.id) AS vehicle_count,
        COUNT(DISTINCT r.id) AS repair_order_count
      FROM customers c
      LEFT JOIN vehicles v
        ON v.customer_id = c.id
      LEFT JOIN repair_orders r
        ON r.customer_id = c.id
        WHERE c.shop_id = ?
      GROUP BY
        c.id,
        c.name,
        c.phone,
        c.email
      ORDER BY c.name ASC
    `).all(req.session.employee.shop_id);

    res.json(customers);

  } catch (err) {
    console.error("Get customers error:", err);

    res.status(500).json({
      error: "Unable to retrieve customers."
    });
  }
});

// ===== S&K AUTO - EDIT CUSTOMER =====
app.patch("/api/customers/:id", (req, res) => {
  try {

    const {
      name,
      phone,
      email
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "Customer name is required."
      });
    }

    const customer = db.prepare(`
      SELECT id
      FROM customers
      WHERE id = ?
    `).get(req.params.id);

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found."
      });
    }
   // Check whether another customer already uses this phone or email
const cleanPhone = phone ? phone.replace(/\D/g, "") : "";
const cleanEmail = email ? email.trim().toLowerCase() : "";

const otherCustomers = db.prepare(`
  SELECT id, name, phone, email
  FROM customers
  WHERE id != ?
`).all(req.params.id);

const duplicateCustomer = otherCustomers.find(existing => {
  const existingPhone = existing.phone
    ? existing.phone.replace(/\D/g, "")
    : "";

  const existingEmail = existing.email
    ? existing.email.trim().toLowerCase()
    : "";

  const phoneMatches =
    cleanPhone &&
    existingPhone &&
    cleanPhone === existingPhone;

  const emailMatches =
    cleanEmail &&
    existingEmail &&
    cleanEmail === existingEmail;

  return phoneMatches || emailMatches;
});

if (duplicateCustomer) {
  return res.status(409).json({
    error: "Possible duplicate customer.",
    duplicate: {
      id: duplicateCustomer.id,
      name: duplicateCustomer.name,
      phone: duplicateCustomer.phone,
      email: duplicateCustomer.email
    }
  });
} 

    db.prepare(`
      UPDATE customers
      SET
        name = ?,
        phone = ?,
        email = ?
      WHERE id = ?
    `).run(
      name.trim(),
      phone ? phone.trim() : "",
      email ? email.trim() : "",
      req.params.id
    );

    res.json({
      success: true,
      id: Number(req.params.id),
      name: name.trim(),
      phone: phone ? phone.trim() : "",
      email: email ? email.trim() : ""
    });

  } catch (err) {

    console.error("Edit customer error:", err);

    res.status(500).json({
      error: "Unable to update customer."
    });

  }
});
// ===== S&K AUTO - MERGE CUSTOMERS =====
app.post("/api/customers/:id/merge", (req, res) => {
  try {
    const keepCustomerId = Number(req.params.id);
    const duplicateCustomerId = Number(req.body.duplicateCustomerId);

    if (!keepCustomerId || !duplicateCustomerId) {
      return res.status(400).json({
        error: "Both customers are required."
      });
    }

    if (keepCustomerId === duplicateCustomerId) {
      return res.status(400).json({
        error: "A customer cannot be merged into itself."
      });
    }

    const keepCustomer = db.prepare(`
      SELECT id
      FROM customers
      WHERE id = ?
    `).get(keepCustomerId);

    const duplicateCustomer = db.prepare(`
      SELECT id
      FROM customers
      WHERE id = ?
    `).get(duplicateCustomerId);

    if (!keepCustomer || !duplicateCustomer) {
      return res.status(404).json({
        error: "Customer not found."
      });
    }

    const mergeCustomers = db.transaction(() => {

      // Move vehicles to the customer being kept
      db.prepare(`
        UPDATE vehicles
        SET customer_id = ?
        WHERE customer_id = ?
      `).run(keepCustomerId, duplicateCustomerId);

      // Move estimates to the customer being kept
      db.prepare(`
        UPDATE estimates
        SET customer_id = ?
        WHERE customer_id = ?
      `).run(keepCustomerId, duplicateCustomerId);

      // Move repair orders to the customer being kept
      db.prepare(`
        UPDATE repair_orders
        SET customer_id = ?
        WHERE customer_id = ?
      `).run(keepCustomerId, duplicateCustomerId);

      // Delete the now-empty duplicate customer
      db.prepare(`
        DELETE FROM customers
        WHERE id = ?
      `).run(duplicateCustomerId);

    });

    mergeCustomers();

    res.json({
      success: true,
      customerId: keepCustomerId
    });

  } catch (err) {
    console.error("Merge customer error:", err);

    res.status(500).json({
      error: "Unable to merge customers."
    });
  }
});



// ===== S&K AUTO - DELETE CUSTOMER =====
app.delete("/api/customers/:id", (req, res) => {
  try {
    const customerId = req.params.id;

    const customer = db.prepare(`
      SELECT id
      FROM customers
      WHERE id = ?
    `).get(customerId);

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found."
      });
    }

    // Protect customers that have repair order history
    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE customer_id = ?
      LIMIT 1
    `).get(customerId);

    if (repairOrder) {
      return res.status(400).json({
        error: "This customer cannot be deleted because they have repair order history."
      });
    }

    // Delete estimates belonging to this customer.
    // Estimate items will be removed automatically by ON DELETE CASCADE.
    db.prepare(`
      DELETE FROM estimates
      WHERE customer_id = ?
    `).run(customerId);

    // Delete vehicles belonging to this customer
    db.prepare(`
      DELETE FROM vehicles
      WHERE customer_id = ?
    `).run(customerId);

    // Delete the customer
    db.prepare(`
      DELETE FROM customers
      WHERE id = ?
    `).run(customerId);

    res.json({
      success: true
    });

  } catch (err) {
    console.error("Delete customer error:", err);

    res.status(500).json({
      error: "Unable to delete customer."
    });
  }
});
// ===== S&K AUTO - GET ONE CUSTOMER =====
app.get("/api/customers/:id", (req, res) => {
  try {

    const customer = db.prepare(`
      SELECT
        id,
        name,
        phone,
        email
      FROM customers
WHERE id = ?
  AND shop_id = ?
`).get(
  req.params.id,
  req.session.employee.shop_id
);

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found."
      });
    }

    // Get all vehicles belonging to this customer
    customer.vehicles = db.prepare(`
      SELECT
        id,
        year,
        make,
        model,
        vin,
        mileage
      FROM vehicles
      WHERE customer_id = ?
      ORDER BY year DESC, make ASC, model ASC
    `).all(customer.id);


    // Get complete repair history
    customer.repair_orders = db.prepare(`
      SELECT
        r.id,
        r.vehicle_id,
        r.status,
        r.payment_status,
        r.payment_method,
        r.amount_paid,
        r.created_at,
        r.completed_at,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model,
        v.vin AS vehicle_vin,
        v.mileage AS vehicle_mileage
      FROM repair_orders r
      LEFT JOIN vehicles v
        ON r.vehicle_id = v.id
      WHERE r.customer_id = ?
      ORDER BY r.id DESC
    `).all(customer.id);


    // Add repair items and totals to each repair order
    for (const repairOrder of customer.repair_orders) {

      repairOrder.items = db.prepare(`
        SELECT
          id,
          description,
          parts,
          labor
        FROM repair_order_items
        WHERE repair_order_id = ?
        ORDER BY id ASC
      `).all(repairOrder.id);

      repairOrder.subtotal =
        repairOrder.items.reduce(
          (sum, item) =>
            sum +
            (Number(item.parts) || 0) +
            (Number(item.labor) || 0),
          0
        );

      repairOrder.tax =
        Math.round(
          repairOrder.subtotal * 0.075 * 100
        ) / 100;

      repairOrder.total =
        Math.round(
          (repairOrder.subtotal + repairOrder.tax) * 100
        ) / 100;

    }


    res.json(customer);

  } catch (err) {

    console.error("Get customer error:", err);

    res.status(500).json({
      error: "Unable to retrieve customer."
    });

  }
});

// ===== S&K AUTO - DELETE VEHICLE =====
app.delete("/api/vehicles/:id", (req, res) => {
  try {
    const vehicleId = req.params.id;

    const vehicle = db.prepare(`
      SELECT id
      FROM vehicles
      WHERE id = ?
    `).get(vehicleId);

    if (!vehicle) {
      return res.status(404).json({
        error: "Vehicle not found."
      });
    }

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE vehicle_id = ?
      LIMIT 1
    `).get(vehicleId);

    if (repairOrder) {
      return res.status(400).json({
        error: "This vehicle cannot be deleted because it has repair order history."
      });
    }

   // Keep existing estimates, but detach them from this vehicle
db.prepare(`
  UPDATE estimates
  SET vehicle_id = NULL
  WHERE vehicle_id = ?
`).run(vehicleId);

// Delete the vehicle
db.prepare(`
  DELETE FROM vehicles
  WHERE id = ?
`).run(vehicleId);

    res.json({
      success: true
    });

  } catch (err) {
    console.error("Delete vehicle error:", err);

    res.status(500).json({
      error: "Unable to delete vehicle."
    });
  }
});

// ===== S&K AUTO - TODAY'S APPOINTMENTS =====
app.get("/api/dashboard/todays-appointments", (req, res) => {
  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());

    const appointments = db.prepare(`
      SELECT *
      FROM bookings
      WHERE date = ?
      ORDER BY time ASC
    `).all(today);

   const statusCounts = {
  scheduled: 0,
  checked_in: 0,
  in_progress: 0,
  completed: 0,
  cancelled: 0
};

for (const appointment of appointments) {
  const status = appointment.status || "scheduled";

  if (Object.prototype.hasOwnProperty.call(statusCounts, status)) {
    statusCounts[status]++;
  }
}

res.json({
  count: appointments.length,
  appointments: appointments,
  statusCounts: statusCounts
});
  } catch (err) {
    console.error("Today's appointments error:", err);

    res.status(500).json({
      error: "Unable to retrieve today's appointments."
    });
  }
});
// ===== S&K AUTO - GET ALL APPOINTMENTS =====
app.get("/api/appointments", (req, res) => {
  try {

    const appointments = db.prepare(`
      SELECT *
      FROM bookings
      ORDER BY date ASC, time ASC
    `).all();

    res.json(appointments);

  } catch (err) {

    console.error("Get appointments error:", err);

    res.status(500).json({
      error: "Unable to retrieve appointments."
    });

  }
});
// ===== S&K AUTO - DELETE APPOINTMENT =====
app.delete("/api/appointments/:id", (req, res) => {
  try {
    const appointment = db.prepare(`
      SELECT id
      FROM bookings
      WHERE id = ?
    `).get(req.params.id);

    if (!appointment) {
      return res.status(404).json({
        error: "Appointment not found."
      });
    }

    db.prepare(`
      DELETE FROM bookings
      WHERE id = ?
    `).run(req.params.id);

    res.json({
      success: true,
      message: "Appointment deleted."
    });

  } catch (err) {
    console.error("Delete appointment error:", err);

    res.status(500).json({
      error: "Unable to delete appointment."
    });
  }
});
// ===== S&K AUTO - UPDATE APPOINTMENT =====
app.patch("/api/appointments/:id", (req, res) => {
  try {
    const id = req.params.id;

    const {
      date,
      time,
      name,
      phone,
      email,
      vehicle,
      service,
      notes
    } = req.body;

    if (
      !date ||
      !time ||
      !name ||
      !phone ||
      !vehicle ||
      !service
    ) {
      return res.status(400).json({
        error: "Please complete all required appointment fields."
      });
    }

    if (!SHOP_SLOTS.includes(time)) {
      return res.status(400).json({
        error: "Invalid appointment time."
      });
    }

    if (!isValidDateString(date) || !isWeekday(date)) {
      return res.status(400).json({
        error: "Please choose a Monday-Friday date."
      });
    }

    if (isBlockedDate(date)) {
      return res.status(400).json({
        error: "S&K Auto is closed on this date."
      });
    }

    const blockedTime = db.prepare(`
      SELECT 1
      FROM blocked_times
      WHERE date = ? AND time = ?
    `).get(date, time);

    if (blockedTime) {
      return res.status(400).json({
        error: "That appointment time is unavailable."
      });
    }

    const existingBooking = db.prepare(`
      SELECT id
      FROM bookings
      WHERE date = ?
        AND time = ?
        AND id != ?
    `).get(date, time, id);

    if (existingBooking) {
      return res.status(409).json({
        error: "That appointment time is already booked."
      });
    }

    const appointment = db.prepare(`
      SELECT id
      FROM bookings
      WHERE id = ?
    `).get(id);

    if (!appointment) {
      return res.status(404).json({
        error: "Appointment not found."
      });
    }

    db.prepare(`
      UPDATE bookings
      SET date = ?,
          time = ?,
          name = ?,
          phone = ?,
          email = ?,
          vehicle = ?,
          service = ?,
          notes = ?
      WHERE id = ?
    `).run(
      date,
      time,
      name.trim(),
      phone.trim(),
      (email || "").trim(),
      vehicle.trim(),
      service.trim(),
      (notes || "").trim(),
      id
    );

    res.json({
      success: true,
      message: "Appointment updated successfully."
    });

  } catch (err) {
    console.error("Update appointment error:", err);

    res.status(500).json({
      error: "Unable to update appointment."
    });
  }
});

// ===== S&K AUTO - UPDATE APPOINTMENT STATUS =====
app.patch("/api/appointments/:id/status", (req, res) => {
  try {
    const { status } = req.body;

    const allowedStatuses = [
      "scheduled",
      "checked_in",
      "in_progress",
      "completed",
      "cancelled"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Invalid appointment status."
      });
    }

    const appointment = db.prepare(`
      SELECT id
      FROM bookings
      WHERE id = ?
    `).get(req.params.id);

    if (!appointment) {
      return res.status(404).json({
        error: "Appointment not found."
      });
    }

    db.prepare(`
      UPDATE bookings
      SET status = ?
      WHERE id = ?
    `).run(status, req.params.id);

    res.json({
      success: true,
      id: Number(req.params.id),
      status: status
    });

  } catch (err) {
    console.error("Update appointment status error:", err);

    res.status(500).json({
      error: "Unable to update appointment status."
    });
  }
});

// ===== S&K AUTO - GET ALL REPAIR ORDERS =====
app.get("/api/repair-orders", (req, res) => {
  try {
    const repairOrders = db.prepare(`
      SELECT
        r.*,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model,
        v.vin AS vehicle_vin,
        v.mileage AS vehicle_mileage
      FROM repair_orders r
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN vehicles v ON r.vehicle_id = v.id
      WHERE r.shop_id = ?
      ORDER BY r.id DESC
    `).all(req.session.employee.shop_id);

    for (const repairOrder of repairOrders) {
      repairOrder.items = db.prepare(`
        SELECT id, description, parts, labor
        FROM repair_order_items
        WHERE repair_order_id = ?
        ORDER BY id ASC
      `).all(repairOrder.id);

      repairOrder.subtotal = repairOrder.items.reduce(
        (sum, item) =>
          sum + (Number(item.parts) || 0) + (Number(item.labor) || 0),
        0
      );
    }

    res.json(repairOrders);

  } catch (err) {
    console.error("Get repair orders error:", err);

    res.status(500).json({
      error: "Unable to retrieve repair orders."
    });
  }
});
// ===== S&K AUTO - GET ONE REPAIR ORDER =====
app.get("/api/repair-orders/:id", (req, res) => {
  try {
    const repairOrder = db.prepare(`
      SELECT
        r.*,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model,
        v.vin AS vehicle_vin,
        v.mileage AS vehicle_mileage
      FROM repair_orders r
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN vehicles v ON r.vehicle_id = v.id
      WHERE r.id = ?
    `).get(req.params.id);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    repairOrder.items = db.prepare(`
      SELECT id, description, parts, labor
      FROM repair_order_items
      WHERE repair_order_id = ?
      ORDER BY id ASC
    `).all(repairOrder.id);

    repairOrder.subtotal = repairOrder.items.reduce(
      (sum, item) =>
        sum +
        (Number(item.parts) || 0) +
        (Number(item.labor) || 0),
      0
    );
// ===== S&K AUTO - GET PAYMENT HISTORY =====
repairOrder.payments = db.prepare(`
  SELECT id, amount, payment_method, paid_at
  FROM repair_order_payments
  WHERE repair_order_id = ?
  ORDER BY id ASC
`).all(repairOrder.id);
   
  console.log("PAYMENT HISTORY:", repairOrder.payments);  
    
    res.json(repairOrder);

  } catch (err) {
    console.error("Get repair order error:", err);

    res.status(500).json({
      error: "Unable to retrieve repair order."
    });
  }
});


// ===== S&K AUTO - EMAIL / RESEND PAYMENT RECEIPT =====
app.post("/api/repair-orders/:id/email-receipt", async (req, res) => {
  try {
    const repairOrder = db.prepare(`
      SELECT
        r.id,
        r.amount_paid,
        r.payment_method,
        c.name AS customer_name,
        c.email AS customer_email,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model,
        v.vin AS vehicle_vin
      FROM repair_orders r
      LEFT JOIN customers c ON r.customer_id = c.id
      LEFT JOIN vehicles v ON r.vehicle_id = v.id
      WHERE r.id = ?
    `).get(req.params.id);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    if (!repairOrder.customer_email) {
      return res.status(400).json({
        error: "This customer does not have an email address."
      });
    }

    const items = db.prepare(`
      SELECT description, parts, labor
      FROM repair_order_items
      WHERE repair_order_id = ?
      ORDER BY id ASC
    `).all(req.params.id);

    const subtotal = items.reduce(
      (sum, item) =>
        sum +
        Number(item.parts || 0) +
        Number(item.labor || 0),
      0
    );

    const tax = subtotal * 0.075;
    const total = subtotal + tax;
    const amountPaid = Number(repairOrder.amount_paid || 0);
    const balance = Math.max(0, total - amountPaid);

    const lastPayment = db.prepare(`
      SELECT amount, payment_method, paid_at
      FROM repair_order_payments
      WHERE repair_order_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(req.params.id);

    const paymentAmount = lastPayment
      ? Number(lastPayment.amount || 0)
      : amountPaid;

    const paymentMethod =
      (lastPayment && lastPayment.payment_method) ||
      repairOrder.payment_method ||
      "Not listed";

    const vehicleDescription = [
      repairOrder.vehicle_year,
      repairOrder.vehicle_make,
      repairOrder.vehicle_model
    ].filter(Boolean).join(" ");

    await resend.emails.send({
      from: "S&K Auto <appointments@skautohutch.com>",
      to: [repairOrder.customer_email],
      subject: `S&K Auto Payment Receipt - Invoice #${repairOrder.id}`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;">
          <div style="max-width:650px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #dddddd;">

            <div style="background:#151515;color:#ffffff;padding:22px;text-align:center;">
              <h1 style="margin:0;font-size:26px;">S&K AUTO</h1>
              <p style="margin:5px 0 0;color:#cccccc;">The Art of Automotive Repair</p>
            </div>

            <div style="padding:25px;">
              <h2 style="margin-top:0;">Payment Receipt</h2>

              <p>Thank you, ${repairOrder.customer_name || "Customer"}.</p>
              <p>This is a copy of your payment receipt for Invoice #${repairOrder.id}.</p>

              <table style="width:100%;border-collapse:collapse;font-size:16px;">
                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Vehicle</td>
                  <td style="padding:8px 0;text-align:right;">${vehicleDescription || "Not listed"}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Payment Method</td>
                  <td style="padding:8px 0;text-align:right;">${paymentMethod}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Payment</td>
                  <td style="padding:8px 0;text-align:right;">$${paymentAmount.toFixed(2)}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Invoice Total</td>
                  <td style="padding:8px 0;text-align:right;">$${total.toFixed(2)}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Total Paid</td>
                  <td style="padding:8px 0;text-align:right;">$${amountPaid.toFixed(2)}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Balance Due</td>
                  <td style="padding:8px 0;text-align:right;font-weight:bold;">$${balance.toFixed(2)}</td>
                </tr>
              </table>

              <hr style="margin:25px 0;border:none;border-top:1px solid #dddddd;">

              <p style="margin-bottom:5px;"><strong>S&K Auto</strong></p>
              <p style="margin:5px 0;">3107 Homestead</p>
              <p style="margin:5px 0;">Hutchinson, KS 67502</p>
              <p style="margin:5px 0;">(620) 899-0425</p>

              <p style="margin-top:25px;font-size:13px;color:#777777;">
                Please keep this email for your records.
              </p>
            </div>

          </div>
        </div>
      `
    });

    console.log(
      `Payment receipt resent to ${repairOrder.customer_email}`
    );

    res.json({
      success: true,
      email: repairOrder.customer_email
    });

  } catch (err) {
    console.error("Resend payment receipt error:", err);

    res.status(500).json({
      error: "Unable to email payment receipt."
    });
  }
});

// ===== S&K AUTO - UPDATE REPAIR ORDER STATUS =====
app.patch("/api/repair-orders/:id/status", (req, res) => {
  try {
    const { status } = req.body;

    const allowedStatuses = [
      "waiting",
      "in_progress",
      "completed",
      "cancelled"
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Invalid repair order status."
      });
    }

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE id = ?
    `).get(req.params.id);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    const completedAt =
  status === "completed"
    ? new Date().toISOString()
    : null;

db.prepare(`
  UPDATE repair_orders
  SET status = ?,
      completed_at = ?
  WHERE id = ?
`).run(
  status,
  completedAt,
  req.params.id
);

    res.json({
      success: true,
      id: Number(req.params.id),
      status: status
    });

  } catch (err) {
    console.error("Update repair order status error:", err);

    res.status(500).json({
      error: "Unable to update repair order status."
    });
  }
});
// ===== S&K AUTO - UPDATE PAYMENT STATUS =====
app.patch("/api/repair-orders/:id/payment", async (req, res) => {
  try {
    const {
  payment_status,
  payment_method,
  amount_paid
} = req.body;

   const paymentAmount =
  Math.max(0, Number(req.body.payment_amount) || 0); 
   const allowedStatuses = [
  "unpaid",
  "partial",
  "paid"
];
    const allowedMethods = [
      "cash",
      "card",
      "check",
      "other"
    ];

    if (!allowedStatuses.includes(payment_status)) {
      return res.status(400).json({
        error: "Invalid payment status."
      });
    }

    if (
      payment_status === "paid" &&
      !allowedMethods.includes(payment_method)
    ) {
      return res.status(400).json({
        error: "Please select a valid payment method."
      });
    }

   const repairOrder = db.prepare(`
  SELECT
    r.id,
    r.customer_id,
    r.vehicle_id,
    c.name AS customer_name,
    c.email AS customer_email,
    c.phone AS customer_phone,
    v.year AS vehicle_year,
    v.make AS vehicle_make,
    v.model AS vehicle_model,
    v.vin AS vehicle_vin
  FROM repair_orders r
  LEFT JOIN customers c
    ON r.customer_id = c.id
  LEFT JOIN vehicles v
    ON r.vehicle_id = v.id
  WHERE r.id = ?
`).get(req.params.id);
    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    const paidAt =
      payment_status === "paid"
        ? new Date().toISOString()
        : null;

   const method = payment_method || null;
const amountPaid =
  Math.max(0, Number(amount_paid) || 0);
db.prepare(`
  UPDATE repair_orders
  SET payment_status = ?,
      payment_method = ?,
      paid_at = ?,
      amount_paid = ?
  WHERE id = ?
`).run(
  payment_status,
  method,
  paidAt,
  amountPaid,
  req.params.id
);

  // ===== S&K AUTO - RECORD PAYMENT HISTORY =====
if (paymentAmount > 0 && method) {
  db.prepare(`
    INSERT INTO repair_order_payments
    (repair_order_id, amount, payment_method)
    VALUES (?, ?, ?)
  `).run(
    req.params.id,
    paymentAmount,
    method
  );
} 
   // ===== S&K AUTO - CALCULATE RECEIPT TOTALS =====
const receiptItems = db.prepare(`
  SELECT
    description,
    parts,
    labor
  FROM repair_order_items
  WHERE repair_order_id = ?
  ORDER BY id ASC
`).all(req.params.id);

const receiptSubtotal = receiptItems.reduce(
  (sum, item) =>
    sum +
    Number(item.parts || 0) +
    Number(item.labor || 0),
  0
);

const receiptTax = receiptSubtotal * 0.075;
const receiptTotal = receiptSubtotal + receiptTax;

const receiptBalance = Math.max(
  0,
  receiptTotal - amountPaid
);

    // ===== S&K AUTO - EMAIL PAYMENT RECEIPT =====
if (
  repairOrder.customer_email &&
  paymentAmount > 0 &&
  method
) {
  try {
    const vehicleDescription = [
      repairOrder.vehicle_year,
      repairOrder.vehicle_make,
      repairOrder.vehicle_model
    ].filter(Boolean).join(" ");

    await resend.emails.send({
      from: "S&K Auto <appointments@skautohutch.com>",
      to: [repairOrder.customer_email],
      subject: `S&K Auto Payment Receipt - Invoice #${req.params.id}`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;">
          <div style="max-width:650px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #dddddd;">

            <div style="background:#151515;color:#ffffff;padding:22px;text-align:center;">
              <h1 style="margin:0;font-size:26px;">S&K AUTO</h1>
              <p style="margin:5px 0 0;color:#cccccc;">The Art of Automotive Repair</p>
            </div>

            <div style="padding:25px;">
              <h2 style="margin-top:0;">Payment Receipt</h2>

              <p>Thank you, ${repairOrder.customer_name || "Customer"}.</p>
              <p>We have received your payment for Invoice #${req.params.id}.</p>

              <table style="width:100%;border-collapse:collapse;font-size:16px;">
                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Vehicle</td>
                  <td style="padding:8px 0;text-align:right;">${vehicleDescription || "Not listed"}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Payment Method</td>
                  <td style="padding:8px 0;text-align:right;">${method}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">This Payment</td>
                  <td style="padding:8px 0;text-align:right;">$${paymentAmount.toFixed(2)}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Invoice Total</td>
                  <td style="padding:8px 0;text-align:right;">$${receiptTotal.toFixed(2)}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Total Paid</td>
                  <td style="padding:8px 0;text-align:right;">$${amountPaid.toFixed(2)}</td>
                </tr>

                <tr>
                  <td style="padding:8px 0;font-weight:bold;">Balance Due</td>
                  <td style="padding:8px 0;text-align:right;font-weight:bold;">$${receiptBalance.toFixed(2)}</td>
                </tr>
              </table>

              <hr style="margin:25px 0;border:none;border-top:1px solid #dddddd;">

              <p style="margin-bottom:5px;"><strong>S&K Auto</strong></p>
              <p style="margin:5px 0;">3107 Homestead</p>
              <p style="margin:5px 0;">Hutchinson, KS 67502</p>
              <p style="margin:5px 0;">(620) 899-0425</p>

              <p style="margin-top:25px;font-size:13px;color:#777777;">
                Please keep this email for your records.
              </p>
            </div>

          </div>
        </div>
      `
    });

    console.log(
      `Payment receipt emailed to ${repairOrder.customer_email}`
    );

  } catch (emailErr) {
    console.error(
      "Payment receipt email error:",
      emailErr
    );
  }
}
    
    res.json({
  success: true,
  id: Number(req.params.id),
  payment_status: payment_status,
  payment_method: method,
  paid_at: paidAt,
  amount_paid: amountPaid
});

  } catch (err) {
    console.error("Update payment status error:", err);

    res.status(500).json({
      error: "Unable to update payment status."
    });
  }
});

// ===== S&K AUTO - EMAIL INVOICE =====
app.post("/api/repair-orders/:id/email-invoice", async (req, res) => {
  try {
    const repairOrder = db.prepare(`
      SELECT
        r.id,
        r.customer_id,
        r.vehicle_id,
        r.status,
        r.payment_status,
        r.payment_method,
        r.amount_paid,
        r.created_at,
        c.name AS customer_name,
        c.email AS customer_email,
        c.phone AS customer_phone,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model,
        v.vin AS vehicle_vin,
        v.mileage AS vehicle_mileage
      FROM repair_orders r
      LEFT JOIN customers c
        ON r.customer_id = c.id
      LEFT JOIN vehicles v
        ON r.vehicle_id = v.id
      WHERE r.id = ?
    `).get(req.params.id);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    if (!repairOrder.customer_email) {
      return res.status(400).json({
        error: "This customer does not have an email address."
      });
    }

    const items = db.prepare(`
      SELECT
        description,
        parts,
        labor
      FROM repair_order_items
      WHERE repair_order_id = ?
      ORDER BY id ASC
    `).all(req.params.id);

    const subtotal = items.reduce(
      (sum, item) =>
        sum +
        Number(item.parts || 0) +
        Number(item.labor || 0),
      0
    );

    const tax = subtotal * 0.075;
    const total = subtotal + tax;
    const amountPaid = Number(repairOrder.amount_paid || 0);
    const balance = Math.max(0, total - amountPaid);

    const vehicleDescription = [
      repairOrder.vehicle_year,
      repairOrder.vehicle_make,
      repairOrder.vehicle_model
    ].filter(Boolean).join(" ");
const paymentStatusText =
  repairOrder.payment_status === "paid"
    ? "PAID"
    : repairOrder.payment_status === "partial"
      ? "PARTIALLY PAID"
      : "UNPAID";
    const itemRows = items.map(item => {
      const parts = Number(item.parts || 0);
      const labor = Number(item.labor || 0);
      const lineTotal = parts + labor;

      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #dddddd;">
            ${item.description || ""}
          </td>
          <td style="padding:10px;border-bottom:1px solid #dddddd;text-align:right;">
            $${parts.toFixed(2)}
          </td>
          <td style="padding:10px;border-bottom:1px solid #dddddd;text-align:right;">
            $${labor.toFixed(2)}
          </td>
          <td style="padding:10px;border-bottom:1px solid #dddddd;text-align:right;">
            $${lineTotal.toFixed(2)}
          </td>
        </tr>
      `;
    }).join("");

    await resend.emails.send({
      from: "S&K Auto <appointments@skautohutch.com>",
      to: [repairOrder.customer_email],
      subject: `S&K Auto Invoice #${repairOrder.id}`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;">
          <div style="max-width:700px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #dddddd;">

           <div style="background:#151515;color:#ffffff;padding:22px;text-align:center;">
  <img
    src="https://skautohutch.com/sk-auto-invoice-logo.png"
    alt="S&K Auto"
    style="display:block;width:180px;max-width:100%;height:auto;margin:0 auto 8px auto;"
  >
  <p style="margin:5px 0 0;color:#cccccc;">
    The Art of Automotive Repair
  </p>
</div>

            <div style="padding:25px;">
              <h2 style="margin-top:0;">
                Invoice #${repairOrder.id}
              </h2>

              <p>
                Thank you, ${repairOrder.customer_name || "Customer"}.
              </p>

              <p>
                Below is your invoice from S&K Auto.
              </p>
<div style="margin:20px 0;padding:12px;text-align:center;background:#f2f2f2;border-radius:6px;font-size:18px;font-weight:bold;">
  PAYMENT STATUS: ${paymentStatusText}
</div>
              <table style="width:100%;margin:20px 0;border-collapse:collapse;">
                <tr>
                  <td style="padding:6px 0;font-weight:bold;">Vehicle</td>
                  <td style="padding:6px 0;text-align:right;">
                    ${vehicleDescription || "Not listed"}
                  </td>
                </tr>

                <tr>
                  <td style="padding:6px 0;font-weight:bold;">VIN</td>
                  <td style="padding:6px 0;text-align:right;">
                    ${repairOrder.vehicle_vin || "Not listed"}
                  </td>
                </tr>
              </table>

              <table style="width:100%;border-collapse:collapse;margin-top:20px;">
                <thead>
                  <tr style="background:#eeeeee;">
                    <th style="padding:10px;text-align:left;">Service</th>
                    <th style="padding:10px;text-align:right;">Parts</th>
                    <th style="padding:10px;text-align:right;">Labor</th>
                    <th style="padding:10px;text-align:right;">Total</th>
                  </tr>
                </thead>

                <tbody>
                  ${itemRows}
                </tbody>
              </table>

              <div style="margin-top:25px;text-align:right;">
                <p>
                  <strong>Subtotal:</strong>
                  $${subtotal.toFixed(2)}
                </p>

                <p>
                  <strong>Tax:</strong>
                  $${tax.toFixed(2)}
                </p>

                <p style="font-size:18px;">
                  <strong>Total:</strong>
                  $${total.toFixed(2)}
                </p>

                <p>
                  <strong>Amount Paid:</strong>
                  $${amountPaid.toFixed(2)}
                </p>

                <p style="font-size:20px;">
                  <strong>Balance Due:</strong>
                  $${balance.toFixed(2)}
                </p>
              </div>

              <div style="margin-top:30px;border-top:1px solid #dddddd;padding-top:20px;">
                <strong>S&K Auto</strong><br>
                3107 Homestead<br>
                Hutchinson, KS 67502<br>
                (620) 899-0425
              </div>

              <p style="margin-top:25px;font-size:13px;color:#777777;">
                Please keep this email for your records.
              </p>
            </div>

          </div>
        </div>
      `
    });

    console.log(
      `Invoice #${repairOrder.id} emailed to ${repairOrder.customer_email}`
    );
// Record successful invoice email
db.prepare(`
  INSERT INTO invoice_email_history
  (repair_order_id, email)
  VALUES (?, ?)
`).run(
  repairOrder.id,
  repairOrder.customer_email
);
    res.json({
      success: true,
      email: repairOrder.customer_email
    });

  } catch (err) {
    console.error("Email invoice error:", err);

    res.status(500).json({
      error: "Unable to email invoice."
    });
  }
});
// ===== S&K AUTO - GET INVOICE EMAIL HISTORY =====
app.get("/api/repair-orders/:id/invoice-email-history", (req, res) => {
  try {
    const repairOrderId = req.params.id;

    const history = db.prepare(`
      SELECT
        id,
        email,
        sent_at
      FROM invoice_email_history
      WHERE repair_order_id = ?
      ORDER BY id DESC
    `).all(repairOrderId);

    res.json(history);

  } catch (err) {
    console.error("Invoice email history error:", err);

    res.status(500).json({
      error: "Unable to load invoice email history."
    });
  }
});
// ===== S&K AUTO - ADD REPAIR ORDER ITEM =====
app.post("/api/repair-orders/:id/items", (req, res) => {
  try {
    const { description, parts, labor } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({
        error: "Repair description is required."
      });
    }

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE id = ?
    `).get(req.params.id);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    const partsAmount = Number(parts) || 0;
    const laborAmount = Number(labor) || 0;

    if (partsAmount < 0 || laborAmount < 0) {
      return res.status(400).json({
        error: "Parts and labor cannot be negative."
      });
    }

    const result = db.prepare(`
      INSERT INTO repair_order_items
      (repair_order_id, description, parts, labor)
      VALUES (?, ?, ?, ?)
    `).run(
      req.params.id,
      description.trim(),
      partsAmount,
      laborAmount
    );

    res.status(201).json({
      success: true,
      id: Number(result.lastInsertRowid),
      description: description.trim(),
      parts: partsAmount,
      labor: laborAmount
    });

  } catch (err) {
    console.error("Add repair order item error:", err);

    res.status(500).json({
      error: "Unable to add repair item."
    });
  }
});

// ===== S&K AUTO - DELETE REPAIR ORDER ITEM =====
app.delete("/api/repair-orders/:repairOrderId/items/:itemId", (req, res) => {
  try {

    const item = db.prepare(`
      SELECT id
      FROM repair_order_items
      WHERE id = ?
        AND repair_order_id = ?
    `).get(
      req.params.itemId,
      req.params.repairOrderId
    );

    if (!item) {
      return res.status(404).json({
        error: "Repair item not found."
      });
    }

    db.prepare(`
      DELETE FROM repair_order_items
      WHERE id = ?
        AND repair_order_id = ?
    `).run(
      req.params.itemId,
      req.params.repairOrderId
    );

    res.json({
      success: true
    });

  } catch (err) {

    console.error("Delete repair order item error:", err);

    res.status(500).json({
      error: "Unable to delete repair item."
    });

  }
});

// ===== S&K AUTO - EDIT REPAIR ORDER ITEM =====
app.patch("/api/repair-orders/:repairOrderId/items/:itemId", (req, res) => {
  try {
    const { description, parts, labor } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({
        error: "Repair description is required."
      });
    }

    const item = db.prepare(`
      SELECT id
      FROM repair_order_items
      WHERE id = ?
        AND repair_order_id = ?
    `).get(
      req.params.itemId,
      req.params.repairOrderId
    );

    if (!item) {
      return res.status(404).json({
        error: "Repair item not found."
      });
    }

    const partsAmount = Number(parts) || 0;
    const laborAmount = Number(labor) || 0;

    if (partsAmount < 0 || laborAmount < 0) {
      return res.status(400).json({
        error: "Parts and labor cannot be negative."
      });
    }

    db.prepare(`
      UPDATE repair_order_items
      SET description = ?, parts = ?, labor = ?
      WHERE id = ?
        AND repair_order_id = ?
    `).run(
      description.trim(),
      partsAmount,
      laborAmount,
      req.params.itemId,
      req.params.repairOrderId
    );

    res.json({
      success: true,
      id: Number(req.params.itemId),
      description: description.trim(),
      parts: partsAmount,
      labor: laborAmount
    });

  } catch (err) {
    console.error("Edit repair order item error:", err);

    res.status(500).json({
      error: "Unable to edit repair item."
    });
  }
});

// ===== S&K AUTO - UPDATE TECHNICIAN NOTES =====
app.patch("/api/repair-orders/:id/notes", (req, res) => {
  try {
    const { technician_notes } = req.body;

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE id = ?
    `).get(req.params.id);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    const notes =
      typeof technician_notes === "string"
        ? technician_notes.trim()
        : "";

    db.prepare(`
      UPDATE repair_orders
      SET technician_notes = ?
      WHERE id = ?
    `).run(
      notes,
      req.params.id
    );

    res.json({
      success: true,
      technician_notes: notes
    });

  } catch (err) {

    console.error("Update technician notes error:", err);

    res.status(500).json({
      error: "Unable to update technician notes."
    });

  }
});

// ===== S&K AUTO - UPDATE CUSTOMER AUTHORIZATION =====
app.patch("/api/repair-orders/:id/authorization", (req, res) => {
  try {

    const {
      authorized_by,
      authorization_method,
      authorization_notes
    } = req.body;

    if (!authorized_by || !authorized_by.trim()) {
      return res.status(400).json({
        error: "Authorized by is required."
      });
    }

    const allowedMethods = [
      "in_person",
      "phone",
      "text",
      "email"
    ];

    if (!allowedMethods.includes(authorization_method)) {
      return res.status(400).json({
        error: "Please select a valid authorization method."
      });
    }

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE id = ?
    `).get(req.params.id);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    const authorizedAt =
      new Date().toISOString();

    db.prepare(`
      UPDATE repair_orders
      SET
        authorized_by = ?,
        authorization_method = ?,
        authorization_notes = ?,
        authorized_at = ?
      WHERE id = ?
    `).run(
      authorized_by.trim(),
      authorization_method,
      typeof authorization_notes === "string"
        ? authorization_notes.trim()
        : "",
      authorizedAt,
      req.params.id
    );

    res.json({
      success: true,
      authorized_by: authorized_by.trim(),
      authorization_method,
      authorization_notes:
        typeof authorization_notes === "string"
          ? authorization_notes.trim()
          : "",
      authorized_at: authorizedAt
    });

  } catch (err) {

    console.error("Update customer authorization error:", err);

    res.status(500).json({
      error: "Unable to save customer authorization."
    });

  }
});
// ===== S&K AUTO - RESPOND TO ESTIMATE =====

app.post("/api/estimates/:token/respond", (req, res) => {
  try {
    const { status } = req.body;

    if (!["approved", "declined"].includes(status)) {
      return res.status(400).json({
        error: "Status must be approved or declined."
      });
    }

   const estimate = db.prepare(`
  SELECT
e.id,
e.customer_id,
e.vehicle_id,
e.status,
c.name AS customer_name,
    v.year AS vehicle_year,
    v.make AS vehicle_make,
    v.model AS vehicle_model
  FROM estimates e
  LEFT JOIN customers c ON e.customer_id = c.id
  LEFT JOIN vehicles v ON e.vehicle_id = v.id
  WHERE e.token = ?
`).get(req.params.token);

    if (!estimate) {
      return res.status(404).json({
        error: "Estimate not found."
      });
    }

    if (estimate.status !== "pending") {
      return res.status(400).json({
        error: "This estimate has already been responded to."
      });
    }

    db.prepare(`
      UPDATE estimates
      SET status = ?, responded_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, estimate.id);

   // Automatically create a repair order when estimate is approved
if (status === "approved") {
  const existingRepairOrder = db.prepare(`
    SELECT id
    FROM repair_orders
    WHERE estimate_id = ?
  `).get(estimate.id);

  if (!existingRepairOrder) {
    const repairOrderResult = db.prepare(`
      INSERT INTO repair_orders
      (estimate_id, customer_id, vehicle_id, status)
      VALUES (?, ?, ?, 'waiting')
    `).run(
      estimate.id,
      estimate.customer_id,
      estimate.vehicle_id
    );

    const repairOrderId = Number(repairOrderResult.lastInsertRowid);

    const estimateItems = db.prepare(`
      SELECT description, parts, labor
      FROM estimate_items
      WHERE estimate_id = ?
      ORDER BY id
    `).all(estimate.id);

    const insertRepairItem = db.prepare(`
      INSERT INTO repair_order_items
      (repair_order_id, description, parts, labor)
      VALUES (?, ?, ?, ?)
    `);

    for (const item of estimateItems) {
      insertRepairItem.run(
        repairOrderId,
        item.description,
        item.parts,
        item.labor
      );
    }
  }
} 
const vehicleText = [
  estimate.vehicle_year,
  estimate.vehicle_make,
  estimate.vehicle_model
].filter(Boolean).join(" ");

const responseText =
  `S&K Auto Estimate Update\n\n` +
  `${estimate.customer_name} has ${status.toUpperCase()} Estimate #${estimate.id}\n` +
  `Vehicle: ${vehicleText}`;

twilioClient.messages.create({
  body: responseText,
  from: process.env.TWILIO_PHONE_NUMBER,
  to: process.env.SMS_TO_NUMBER
})
.then(message => {
  console.log("Estimate response SMS sent:", message.sid);
})
.catch(err => {
  console.error("Estimate response SMS failed:", err);
});
    res.json({
      success: true,
      status: status
    });

  } catch (err) {
    console.error("Estimate response error:", err);

    res.status(500).json({
      error: "Unable to update estimate."
    });
  }
});// ===== S&K AUTO - CREATE ESTIMATE =====

app.post("/api/estimates", (req, res) => {
  try {
    const { customer, vehicle, notes, items } = req.body;

    if (!customer || !customer.name || !customer.phone) {
      return res.status(400).json({
        error: "Customer name and phone number are required."
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "At least one estimate item is required."
      });
    }

    const token = crypto.randomBytes(24).toString("hex");

    const createEstimate = db.transaction(() => {

     let existingCustomer = db.prepare(`
  SELECT id
  FROM customers
  WHERE phone = ?
    AND shop_id = ?
  LIMIT 1
`).get(
  customer.phone.trim(),
  req.session.employee.shop_id
);

let customerId;

if (existingCustomer) {
  customerId = Number(existingCustomer.id);

  db.prepare(`
    UPDATE customers
    SET name = ?, email = ?
    WHERE id = ?
  `).run(
    customer.name.trim(),
    customer.email ? customer.email.trim() : null,
    customerId
  );

} else {
 const customerResult = db.prepare(`
  INSERT INTO customers (name, phone, email, shop_id)
  VALUES (?, ?, ?, ?)
`).run(
  customer.name.trim(),
  customer.phone.trim(),
  customer.email ? customer.email.trim() : null,
  req.session.employee.shop_id
);
  customerId = Number(customerResult.lastInsertRowid);
}

     const vehicleResult = db.prepare(`
  INSERT INTO vehicles
  (customer_id, year, make, model, vin, mileage, shop_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  customerId,
  vehicle?.year || null,
  vehicle?.make || null,
  vehicle?.model || null,
  vehicle?.vin || null,
  vehicle?.mileage || null,
  req.session.employee.shop_id
);

      const vehicleId = Number(vehicleResult.lastInsertRowid);

    const estimateResult = db.prepare(`
  INSERT INTO estimates
  (customer_id, vehicle_id, token, notes, shop_id)
  VALUES (?, ?, ?, ?, ?)
`).run(
  customerId,
  vehicleId,
  token,
  notes || null,
  req.session.employee.shop_id
);

      const estimateId = Number(estimateResult.lastInsertRowid);

      const insertItem = db.prepare(`
        INSERT INTO estimate_items
        (estimate_id, description, parts, labor)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of items) {
        if (!item.description || !item.description.trim()) {
          throw new Error("Every estimate item needs a description.");
        }

        const parts = Number(item.parts) || 0;
        const labor = Number(item.labor) || 0;

        if (parts < 0 || labor < 0) {
          throw new Error("Parts and labor cannot be negative.");
        }

        insertItem.run(
          estimateId,
          item.description.trim(),
          parts,
          labor
        );
      }

      return estimateId;
    });

    const estimateId = createEstimate();
// Text the customer their estimate link
const estimateUrl =
  `https://skautohutch.com/estimate.html?token=${encodeURIComponent(token)}`;

const customerMessage =
  `S&K Auto: Hi ${customer.name.trim()}, your vehicle repair estimate is ready. ` +
  `View and approve or decline it here: ${estimateUrl}`;

twilioClient.messages.create({
  body: customerMessage,
  from: process.env.TWILIO_PHONE_NUMBER,
  to: customer.phone.trim()
})
.then(message => {
  console.log("Customer estimate SMS sent:", message.sid);
})
.catch(err => {
  console.error("Customer estimate SMS failed:", err);
});
  
    // Text S&K Auto when a new estimate is created
const shopMessage =
  `S&K Auto - NEW ESTIMATE\n\n` +
  `Customer: ${customer.name.trim()}\n` +
  `Phone: ${customer.phone.trim()}\n` +
  `Vehicle: ${[
    vehicle?.year,
    vehicle?.make,
    vehicle?.model
  ].filter(Boolean).join(" ")}\n` +
  `Estimate #: ${estimateId}\n` +
  `View: ${estimateUrl}`;

twilioClient.messages.create({
  body: shopMessage,
  from: process.env.TWILIO_PHONE_NUMBER,
  to: process.env.SMS_TO_NUMBER
})
.then(message => {
  console.log("New estimate notification SMS sent:", message.sid);
})
.catch(err => {
  console.error("New estimate notification SMS failed:", err);
});
    res.status(201).json({
      success: true,
      id: estimateId,
      token: token
    });

  } catch (err) {
    console.error("Create estimate error:", err);

    res.status(500).json({
      error: "Unable to create estimate."
    });
  }
});

app.listen(PORT, () => {
  console.log(`S&K Auto website running on http://localhost:${PORT}`);
});

