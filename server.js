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
const SQLiteStore = require('connect-sqlite3')(session);
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const fs = require('fs');
// ===== S&K AUTO - QUICKBOOKS CONFIGURATION =====
const QUICKBOOKS_CLIENT_ID =
  process.env.QUICKBOOKS_CLIENT_ID;

const QUICKBOOKS_CLIENT_SECRET =
  process.env.QUICKBOOKS_CLIENT_SECRET;

const QUICKBOOKS_REDIRECT_URI =
  process.env.QUICKBOOKS_REDIRECT_URI;

const QUICKBOOKS_AUTH_URL =
  'https://appcenter.intuit.com/connect/oauth2';

const QUICKBOOKS_TOKEN_URL =
  'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const QUICKBOOKS_SCOPE =
  'com.intuit.quickbooks.accounting';
// ===== END QUICKBOOKS CONFIGURATION =====
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
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: dataDir
    }),
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
invoice_token TEXT,
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

// ===== S&K AUTO - INVOICE TOKEN MIGRATION =====
if (!repairOrderColumns.includes('invoice_token')) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN invoice_token TEXT
  `).run();

  console.log('Added invoice_token column to repair_orders');
}

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

// ===== S&K AUTO - PAYMENT VOID SUPPORT =====
const paymentColumns = db.prepare(
    `PRAGMA table_info(repair_order_payments)`
).all();

const paymentColumnNames = paymentColumns.map(column => column.name);

if (!paymentColumnNames.includes('voided')) {
    db.prepare(`
        ALTER TABLE repair_order_payments
        ADD COLUMN voided INTEGER NOT NULL DEFAULT 0
    `).run();
}

if (!paymentColumnNames.includes('voided_at')) {
    db.prepare(`
        ALTER TABLE repair_order_payments
        ADD COLUMN voided_at TEXT
    `).run();
}

if (!paymentColumnNames.includes('void_reason')) {
    db.prepare(`
        ALTER TABLE repair_order_payments
        ADD COLUMN void_reason TEXT
    `).run();
}
// ===== S&K AUTO - BALANCE REMINDER SUPPORT =====
const balanceReminderColumns = db
    .prepare(`PRAGMA table_info(repair_orders)`)
    .all()
    .map(column => column.name);

if (!balanceReminderColumns.includes('balance_reminder_sent_at')) {
    db.prepare(`
        ALTER TABLE repair_orders
        ADD COLUMN balance_reminder_sent_at TEXT
    `).run();
}

if (!balanceReminderColumns.includes('balance_reminder_count')) {
    db.prepare(`
        ALTER TABLE repair_orders
        ADD COLUMN balance_reminder_count INTEGER NOT NULL DEFAULT 0
    `).run();
}
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

// ===== S&K AUTO SaaS - REPAIR ORDER WORKFLOW MIGRATION =====

// Add shop isolation to repair orders
if (!repairOrderColumns.includes("shop_id")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN shop_id INTEGER
  `).run();
}

// Add customer concern to repair orders
if (!repairOrderColumns.includes("customer_concern")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN customer_concern TEXT
  `).run();
}

// Add technician diagnosis / recommended repairs to repair orders
if (!repairOrderColumns.includes("technician_diagnosis")) {
    db.prepare(`
        ALTER TABLE repair_orders
        ADD COLUMN technician_diagnosis TEXT
    `).run();
}

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

// ===== S&K AUTO - RECOMMENDED REPAIRS MIGRATION =====
db.prepare(`
  CREATE TABLE IF NOT EXISTS repair_order_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repair_order_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    parts REAL NOT NULL DEFAULT 0,
    labor REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (repair_order_id) REFERENCES repair_orders(id)
  )
`).run();
// ===== S&K AUTO - CUSTOMER REPAIR AUTHORIZATION MIGRATION =====

const recommendationColumns = db.prepare(
  `PRAGMA table_info(repair_order_recommendations)`
).all().map(column => column.name);

if (!recommendationColumns.includes("authorization_token")) {
  db.prepare(`
    ALTER TABLE repair_order_recommendations
    ADD COLUMN authorization_token TEXT
  `).run();
}

if (!recommendationColumns.includes("authorized_at")) {
  db.prepare(`
    ALTER TABLE repair_order_recommendations
    ADD COLUMN authorized_at DATETIME
  `).run();
}

if (!recommendationColumns.includes("authorization_source")) {
  db.prepare(`
    ALTER TABLE repair_order_recommendations
    ADD COLUMN authorization_source TEXT
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

// ===== S&K AUTO - AUTOMATIC BALANCE REMINDERS =====
async function sendBalanceReminders() {
  try {
    const now = new Date();

    const repairOrders = db.prepare(`
      SELECT
        r.id,
        r.completed_at,
        r.balance_reminder_sent_at,
        r.balance_reminder_count,
        c.name AS customer_name,
        c.phone AS customer_phone
      FROM repair_orders r
      LEFT JOIN customers c ON r.customer_id = c.id
      WHERE r.status = 'completed'
        AND r.completed_at IS NOT NULL
        AND c.phone IS NOT NULL
    `).all();

    for (const repairOrder of repairOrders) {
      try {
        // Calculate current repair order total
        const items = db.prepare(`
          SELECT parts, labor
          FROM repair_order_items
          WHERE repair_order_id = ?
        `).all(repairOrder.id);

        const subtotal = items.reduce(
          (sum, item) =>
            sum +
            Number(item.parts || 0) +
            Number(item.labor || 0),
          0
        );

      const tax =
  Math.round(
    subtotal * 0.075 * 100
  ) / 100;

const total =
  Math.round(
    (subtotal + tax) * 100
  ) / 100;
        // Calculate all active (non-voided) payments
        const paymentRow = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS amount_paid
          FROM repair_order_payments
          WHERE repair_order_id = ?
            AND COALESCE(voided, 0) = 0
        `).get(repairOrder.id);

        const amountPaid = Number(paymentRow.amount_paid || 0);
        const balanceDue = Math.max(0, total - amountPaid);

        // Stop if the invoice has been paid
        if (balanceDue <= 0.009) {
          continue;
        }

        const completedAt = new Date(repairOrder.completed_at);

        if (Number.isNaN(completedAt.getTime())) {
          continue;
        }

        const daysSinceCompleted =
          (now.getTime() - completedAt.getTime()) /
          (24 * 60 * 60 * 1000);

        const reminderCount =
          Number(repairOrder.balance_reminder_count || 0);

        let shouldSend = false;

        // First reminder: 3 days after completion
        if (reminderCount === 0) {
          shouldSend = daysSinceCompleted >= 3;
        } else if (repairOrder.balance_reminder_sent_at) {
          // Additional reminders: every 7 days
          const lastReminder =
            new Date(repairOrder.balance_reminder_sent_at);

          if (!Number.isNaN(lastReminder.getTime())) {
            const daysSinceLastReminder =
              (now.getTime() - lastReminder.getTime()) /
              (24 * 60 * 60 * 1000);

            shouldSend = daysSinceLastReminder >= 7;
          }
        }

        if (!shouldSend) {
          continue;
        }

        const customerPhone =
          normalizePhoneNumber(repairOrder.customer_phone);

        if (!customerPhone) {
          continue;
        }

        const customerFirstName =
          String(repairOrder.customer_name || '')
            .trim()
            .split(/\s+/)[0];

        await twilioClient.messages.create({
          body:
            `S&K Auto: ` +
            `${customerFirstName ? customerFirstName + ', ' : ''}` +
            `this is a friendly reminder that your outstanding balance is ` +
            `$${balanceDue.toFixed(2)} on repair order #${repairOrder.id}. ` +
            `Please contact us at (620) 899-0425 regarding payment. ` +
            `If you have already made payment, please disregard this message. ` +
            `Reply STOP to opt out.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: customerPhone
        });

        db.prepare(`
          UPDATE repair_orders
          SET
            balance_reminder_sent_at = ?,
            balance_reminder_count =
              COALESCE(balance_reminder_count, 0) + 1
          WHERE id = ?
        `).run(
          new Date().toISOString(),
          repairOrder.id
        );

        console.log(
          `Balance reminder sent for repair order ${repairOrder.id}`
        );
      } catch (err) {
        console.error(
          `Balance reminder failed for repair order ${repairOrder.id}:`,
          err
        );
      }
    }
  } catch (err) {
    console.error('Balance reminder checker failed:', err);
  }
}
 sendBalanceReminders();

 setInterval(sendBalanceReminders, 15 * 60 * 1000);

// ===== S&K AUTO - GET OUTSTANDING BALANCES =====
app.get('/api/outstanding-balances', (req, res) => {
  try {
    const shopId = req.session?.employee?.shop_id;

    if (!shopId) {
      return res.status(401).json({
        error: 'Not authorized.'
      });
    }

    const repairOrders = db.prepare(`
      SELECT
        r.id,
        r.completed_at,
        r.balance_reminder_sent_at,
        r.balance_reminder_count,
        c.name AS customer_name,
        c.phone AS customer_phone,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model
      FROM repair_orders r
      LEFT JOIN customers c
        ON r.customer_id = c.id
      LEFT JOIN vehicles v
        ON r.vehicle_id = v.id
      WHERE r.shop_id = ?
        AND r.status = 'completed'
        AND r.completed_at IS NOT NULL
      ORDER BY r.completed_at ASC
    `).all(shopId);

    const outstandingBalances = [];

    for (const repairOrder of repairOrders) {

      // Calculate repair order subtotal
      const items = db.prepare(`
        SELECT parts, labor
        FROM repair_order_items
        WHERE repair_order_id = ?
      `).all(repairOrder.id);

      const subtotal = items.reduce(
        (sum, item) =>
          sum +
          Number(item.parts || 0) +
          Number(item.labor || 0),
        0
      );

      // Same tax calculation used by the invoice system
      const tax =
        Math.round(subtotal * 0.075 * 100) / 100;

      const total =
        Math.round((subtotal + tax) * 100) / 100;

      // Count only payments that have NOT been voided
      const paymentRow = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS amount_paid
        FROM repair_order_payments
        WHERE repair_order_id = ?
          AND COALESCE(voided, 0) = 0
      `).get(repairOrder.id);

      const amountPaid =
        Math.round(Number(paymentRow.amount_paid || 0) * 100) / 100;

      const balanceDue =
        Math.max(
          0,
          Math.round((total - amountPaid) * 100) / 100
        );

      // Paid invoices do not belong on this list
      if (balanceDue <= 0.009) {
        continue;
      }

      const completedAt =
        new Date(repairOrder.completed_at);

      let daysOutstanding = 0;

      if (!Number.isNaN(completedAt.getTime())) {
        daysOutstanding = Math.max(
          0,
          Math.floor(
            (Date.now() - completedAt.getTime()) /
            (24 * 60 * 60 * 1000)
          )
        );
      }

      outstandingBalances.push({
        id: repairOrder.id,
        customer_name:
          repairOrder.customer_name || 'Unknown Customer',
        customer_phone:
          repairOrder.customer_phone || '',
        vehicle_year:
          repairOrder.vehicle_year || '',
        vehicle_make:
          repairOrder.vehicle_make || '',
        vehicle_model:
          repairOrder.vehicle_model || '',
        completed_at:
          repairOrder.completed_at,
        subtotal,
        tax,
        total,
        amount_paid: amountPaid,
        balance_due: balanceDue,
        days_outstanding: daysOutstanding,
        balance_reminder_sent_at:
          repairOrder.balance_reminder_sent_at,
        balance_reminder_count:
          Number(repairOrder.balance_reminder_count || 0)
      });
    }

    outstandingBalances.sort(
      (a, b) =>
        b.days_outstanding - a.days_outstanding
    );

    res.json({
      outstandingBalances
    });

  } catch (err) {
    console.error(
      'Get outstanding balances error:',
      err
    );

    res.status(500).json({
      error: 'Unable to retrieve outstanding balances.'
    });
  }
});

// ===== S&K AUTO - SEND OUTSTANDING BALANCE REMINDER =====
app.post('/api/repair-orders/:id/balance-reminder', async (req, res) => {
  try {
    const shopId = req.session?.employee?.shop_id;
    const repairOrderId = Number(req.params.id);

    if (!shopId) {
      return res.status(401).json({
        error: 'Not authorized.'
      });
    }

    if (!repairOrderId) {
      return res.status(400).json({
        error: 'Invalid repair order.'
      });
    }

    // Get repair order and customer
    const repairOrder = db.prepare(`
      SELECT
        r.id,
        r.completed_at,
        r.balance_reminder_count,
        c.name AS customer_name,
        c.phone AS customer_phone
      FROM repair_orders r
      LEFT JOIN customers c
        ON r.customer_id = c.id
      WHERE r.id = ?
        AND r.shop_id = ?
        AND r.status = 'completed'
    `).get(repairOrderId, shopId);

    if (!repairOrder) {
      return res.status(404).json({
        error: 'Completed repair order not found.'
      });
    }

    if (!repairOrder.customer_phone) {
      return res.status(400).json({
        error: 'Customer does not have a phone number.'
      });
    }

    // Calculate invoice total
    const items = db.prepare(`
      SELECT parts, labor
      FROM repair_order_items
      WHERE repair_order_id = ?
    `).all(repairOrderId);

    const subtotal = items.reduce(
      (sum, item) =>
        sum +
        Number(item.parts || 0) +
        Number(item.labor || 0),
      0
    );

    const tax =
      Math.round(subtotal * 0.075 * 100) / 100;

    const total =
      Math.round((subtotal + tax) * 100) / 100;

    // Calculate payments
    const paymentRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount_paid
      FROM repair_order_payments
      WHERE repair_order_id = ?
        AND COALESCE(voided, 0) = 0
    `).get(repairOrderId);

    const amountPaid =
      Number(paymentRow?.amount_paid || 0);

    const balanceDue = Math.max(
      0,
      Math.round((total - amountPaid) * 100) / 100
    );

    if (balanceDue <= 0.009) {
      return res.status(400).json({
        error: 'This invoice is already paid in full.'
      });
    }

    const customerName =
      repairOrder.customer_name || 'Customer';

    const messageBody =
      `Hello ${customerName}, this is a friendly reminder from S&K Auto that your account has an outstanding balance of $${balanceDue.toFixed(2)}. ` +
      `Please contact us at (620) 899-0425 to arrange payment. Thank you for choosing S&K Auto.`;

    // Send SMS
    const message = await twilioClient.messages.create({
      body: messageBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: repairOrder.customer_phone
    });

    // Record successful reminder
    db.prepare(`
      UPDATE repair_orders
      SET
        balance_reminder_sent_at = CURRENT_TIMESTAMP,
        balance_reminder_count =
          COALESCE(balance_reminder_count, 0) + 1
      WHERE id = ?
        AND shop_id = ?
    `).run(repairOrderId, shopId);

    console.log(
      'Balance reminder SMS sent:',
      message.sid
    );

    res.json({
      success: true,
      message: 'Balance reminder sent.',
      balance_due: balanceDue
    });

  } catch (err) {
    console.error(
      'Balance reminder SMS failed:',
      err
    );

    res.status(500).json({
      error: 'Unable to send balance reminder.'
    });
  }
});

// ===== S&K AUTO - AUTOMATIC BALANCE REMINDERS =====

async function runAutomaticBalanceReminders() {
  console.log('Checking for automatic balance reminders...');

  try {
    // Get completed repair orders from every shop.
    // Each order is checked again below to make sure money is still owed.
    const repairOrders = db.prepare(`
      SELECT
        r.id,
        r.shop_id,
        r.completed_at,
        r.balance_reminder_sent_at,
        r.balance_reminder_count,
        c.name AS customer_name,
        c.phone AS customer_phone
      FROM repair_orders r
      LEFT JOIN customers c
        ON r.customer_id = c.id
      WHERE r.status = 'completed'
        AND r.completed_at IS NOT NULL
    `).all();

    for (const repairOrder of repairOrders) {
      try {
        if (!repairOrder.customer_phone) {
          continue;
        }

        // Calculate invoice subtotal.
        const items = db.prepare(`
          SELECT parts, labor
          FROM repair_order_items
          WHERE repair_order_id = ?
        `).all(repairOrder.id);

        const subtotal = items.reduce(
          (sum, item) =>
            sum +
            Number(item.parts || 0) +
            Number(item.labor || 0),
          0
        );

        // Keep this identical to the invoice calculation.
        const tax =
          Math.round(subtotal * 0.075 * 100) / 100;

        const total =
          Math.round((subtotal + tax) * 100) / 100;

        // Count only non-voided payments.
        const paymentRow = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS amount_paid
          FROM repair_order_payments
          WHERE repair_order_id = ?
            AND COALESCE(voided, 0) = 0
        `).get(repairOrder.id);

        const amountPaid =
          Math.round(
            Number(paymentRow.amount_paid || 0) * 100
          ) / 100;

        const balanceDue = Math.max(
          0,
          Math.round((total - amountPaid) * 100) / 100
        );

        // Never send a reminder for a paid invoice.
        if (balanceDue <= 0.009) {
          continue;
        }

        const completedAt =
          new Date(repairOrder.completed_at);

        if (Number.isNaN(completedAt.getTime())) {
          continue;
        }

        const daysOutstanding = Math.max(
          0,
          Math.floor(
            (Date.now() - completedAt.getTime()) /
            (24 * 60 * 60 * 1000)
          )
        );

       // Send at 7 days, 14 days, 30 days,
// then every 30 days after that.
const isAutomaticReminderDay =
    daysOutstanding === 7 ||
    daysOutstanding === 14 ||
    (daysOutstanding >= 30 && daysOutstanding % 30 === 0);

if (!isAutomaticReminderDay) {
    continue;
}

        // Prevent duplicate automatic reminders on the same day.
        if (repairOrder.balance_reminder_sent_at) {
          const lastReminder =
            new Date(repairOrder.balance_reminder_sent_at);

          if (!Number.isNaN(lastReminder.getTime())) {
            const hoursSinceLastReminder =
              (Date.now() - lastReminder.getTime()) /
              (60 * 60 * 1000);

            if (hoursSinceLastReminder < 24) {
              continue;
            }
          }
        }

        const customerName =
          repairOrder.customer_name || 'Customer';

        const message = await twilioClient.messages.create({
          body:
`Hello ${customerName}, this is a friendly reminder from S&K Auto that your account has an outstanding balance of $${balanceDue.toFixed(2)}. Please contact us at (620) 899-0425 to arrange payment. Thank you for choosing S&K Auto.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: repairOrder.customer_phone
        });

        // Record successful reminder.
        db.prepare(`
          UPDATE repair_orders
          SET
            balance_reminder_sent_at = CURRENT_TIMESTAMP,
            balance_reminder_count =
              COALESCE(balance_reminder_count, 0) + 1
          WHERE id = ?
            AND shop_id = ?
        `).run(
          repairOrder.id,
          repairOrder.shop_id
        );

        console.log(
          `Automatic balance reminder sent for repair order ${repairOrder.id}:`,
          message.sid
        );

      } catch (orderError) {
        // One failed customer should not stop reminders for everyone else.
        console.error(
          `Automatic reminder failed for repair order ${repairOrder.id}:`,
          orderError
        );
      }
    }

  } catch (error) {
    console.error(
      'Automatic balance reminder check failed:',
      error
    );
  }
}

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
if (!estimate) {
    return res.status(404).send("Estimate not found");
}

const items = db.prepare(`
    SELECT description, parts, labor
    FROM estimate_items
    WHERE estimate_id = ?
    ORDER BY id ASC
`).all(estimate.id);

estimate.items = items;

const subtotal = items.reduce((sum, item) => {
    return sum + Number(item.parts || 0) + Number(item.labor || 0);
}, 0);

estimate.subtotal = subtotal;

const taxRate = 0.075;
estimate.tax = Math.round(subtotal * taxRate * 100) / 100;

estimate.total =
    Math.round((subtotal + estimate.tax) * 100) / 100;

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

// ===== S&K AUTO SaaS - REPAIR ORDER SHOP MIGRATION =====
const repairOrderShopColumns = db.prepare(`
  PRAGMA table_info(repair_orders)
`).all().map(column => column.name);

if (!repairOrderShopColumns.includes("shop_id")) {
  db.prepare(`
    ALTER TABLE repair_orders
    ADD COLUMN shop_id INTEGER
  `).run();
}

// ===== S&K AUTO SaaS - ASSIGN EXISTING REPAIR ORDERS =====
if (primaryShop) {
  db.prepare(`
    UPDATE repair_orders
    SET shop_id = ?
    WHERE shop_id IS NULL
  `).run(primaryShop.id);
}
// ===== S&K AUTO SaaS - BOOKING SHOP MIGRATION =====
const bookingShopColumns = db.prepare(`
  PRAGMA table_info(bookings)
`).all().map(column => column.name);

if (!bookingShopColumns.includes("shop_id")) {
  db.prepare(`
    ALTER TABLE bookings
    ADD COLUMN shop_id INTEGER
  `).run();
}

// ===== S&K AUTO SaaS - ASSIGN EXISTING BOOKINGS =====
if (primaryShop) {
  db.prepare(`
    UPDATE bookings
    SET shop_id = ?
    WHERE shop_id IS NULL
  `).run(primaryShop.id);
}
// ===== S&K AUTO SaaS - ESTIMATE SHOP MIGRATION =====
const estimateShopColumns = db.prepare(`
  PRAGMA table_info(estimates)
`).all().map(column => column.name);

if (!estimateShopColumns.includes("shop_id")) {
  db.prepare(`
    ALTER TABLE estimates
    ADD COLUMN shop_id INTEGER
  `).run();
}

// ===== S&K AUTO SaaS - ASSIGN EXISTING ESTIMATES =====
if (primaryShop) {
  db.prepare(`
    UPDATE estimates
    SET shop_id = ?
    WHERE shop_id IS NULL
  `).run(primaryShop.id);
}

// ===== S&K AUTO SaaS - REGISTER NEW SHOP =====
app.post("/api/register-shop", async (req, res) => {
  try {
  const {
    shopName,
    ownerName,
    ownerEmail,
    shopEmail,
    password,
    phone,
    address,
    city,
    state,
    zip
} = req.body;
    // Required fields
   if (!shopName || !ownerName || !ownerEmail || !password) {
    return res.status(400).json({
        error: "Shop name, owner name, owner email, and password are required."
    });
}
    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters."
      });
    }

    const cleanEmail = ownerEmail.trim().toLowerCase();

    // Make sure this email is not already being used
    const existingEmployee = db.prepare(`
      SELECT id
      FROM employees
      WHERE LOWER(email) = ?
      LIMIT 1
    `).get(cleanEmail);

    if (existingEmployee) {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    // Create a URL-safe unique shop slug
    const baseSlug = shopName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "shop";

    let slug = baseSlug;
    let counter = 2;

    while (db.prepare(`
      SELECT id FROM shops WHERE slug = ?
    `).get(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create the shop and its owner together
    const createShop = db.transaction(() => {
      const shopResult = db.prepare(`
        INSERT INTO shops
        (
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
        shopName.trim(),
        slug,
        phone ? phone.trim() : "",
        shopEmail ? shopEmail.trim().toLowerCase() : cleanEmail,
        address ? address.trim() : "",
        city ? city.trim() : "",
        state ? state.trim() : "",
        zip ? zip.trim() : ""
      );

      const shopId = Number(shopResult.lastInsertRowid);

      const employeeResult = db.prepare(`
        INSERT INTO employees
        (
          name,
          email,
          password_hash,
          role,
          active,
          shop_id,
          must_change_password
        )
        VALUES (?, ?, ?, 'owner', 1, ?, 0)
      `).run(
        ownerName.trim(),
        cleanEmail,
        passwordHash,
        shopId
      );

      return {
        shopId,
        employeeId: Number(employeeResult.lastInsertRowid)
      };
    });

    const newAccount = createShop();

    return res.status(201).json({
      success: true,
      message: "Shop account created successfully.",
      shop: {
        id: newAccount.shopId,
        name: shopName.trim(),
        slug
      }
    });

  } catch (err) {
    console.error("Register shop error:", err);

    return res.status(500).json({
      error: "Unable to create shop account."
    });
  }
});

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
  AND shop_id = ?
`).run(
    passwordHash,
    employeeId,
    req.session.employee.shop_id
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
   // Check whether another customer already uses this phone or email
const cleanPhone = phone ? phone.replace(/\D/g, "") : "";
const cleanEmail = email ? email.trim().toLowerCase() : "";

const otherCustomers = db.prepare(`
    SELECT id, name, phone, email
    FROM customers
    WHERE id != ?
      AND shop_id = ?
`).all(
    req.params.id,
    req.session.employee.shop_id
);

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
      AND shop_id = ?
`).run(
    name.trim(),
    phone ? phone.trim() : "",
    email ? email.trim() : "",
    req.params.id,
    req.session.employee.shop_id
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
      AND shop_id = ?
`).get(
    keepCustomerId,
    req.session.employee.shop_id
);

const duplicateCustomer = db.prepare(`
    SELECT id
    FROM customers
    WHERE id = ?
      AND shop_id = ?
`).get(
    duplicateCustomerId,
    req.session.employee.shop_id
);

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
      AND shop_id = ?
`).run(
    keepCustomerId,
    duplicateCustomerId,
    req.session.employee.shop_id
);

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

      db.prepare(`
    DELETE FROM customers
    WHERE id = ?
      AND shop_id = ?
`).run(
    duplicateCustomerId,
    req.session.employee.shop_id
);
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
      AND shop_id = ?
`).run(
    customerId,
    req.session.employee.shop_id
);
    // Delete vehicles belonging to this customer
  db.prepare(`
    DELETE FROM vehicles
    WHERE customer_id = ?
      AND shop_id = ?
`).run(
    customerId,
    req.session.employee.shop_id
);

    // Delete the customer
  db.prepare(`
    DELETE FROM customers
    WHERE id = ?
      AND shop_id = ?
`).run(
    customerId,
    req.session.employee.shop_id
);
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
  AND shop_id = ?
ORDER BY year DESC, make ASC, model ASC
`).all(
  customer.id,
  req.session.employee.shop_id
);


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
AND r.shop_id = ?
ORDER BY r.id DESC
`).all(
    customer.id,
    req.session.employee.shop_id
);

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
// Load recommended repairs for this repair order
repairOrder.recommendations = db.prepare(`
  SELECT
    id,
    description,
    parts,
    labor,
    status,
    created_at
  FROM repair_order_recommendations
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

// ===== S&K AUTO - ADD VEHICLE =====
app.post("/api/vehicles", (req, res) => {
  try {
    if (!req.session || !req.session.employee) {
      return res.status(401).json({
        error: "You must be logged in."
      });
    }

    const {
      customer_id,
      year,
      make,
      model,
      vin,
      mileage
    } = req.body;

    if (!customer_id) {
      return res.status(400).json({
        error: "Customer is required."
      });
    }

    // Make sure the customer belongs to this shop
    const customer = db.prepare(`
      SELECT id
      FROM customers
      WHERE id = ?
        AND shop_id = ?
      LIMIT 1
    `).get(
      customer_id,
      req.session.employee.shop_id
    );

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found."
      });
    }

    const result = db.prepare(`
      INSERT INTO vehicles
      (
        customer_id,
        year,
        make,
        model,
        vin,
        mileage,
        shop_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      customer_id,
      year || null,
      make ? make.trim() : null,
      model ? model.trim() : null,
      vin ? vin.trim().toUpperCase() : null,
      mileage || null,
      req.session.employee.shop_id
    );

    res.status(201).json({
      success: true,
      vehicle: {
        id: Number(result.lastInsertRowid),
        customer_id: Number(customer_id),
        year: year || null,
        make: make ? make.trim() : null,
        model: model ? model.trim() : null,
        vin: vin ? vin.trim().toUpperCase() : null,
        mileage: mileage || null
      }
    });

  } catch (err) {
    console.error("Add vehicle error:", err);

    res.status(500).json({
      error: "Unable to add vehicle."
    });
  }
});

// ===== S&K AUTO - UPDATE VEHICLE =====
app.put("/api/vehicles/:id", (req, res) => {
  try {
    if (!req.session || !req.session.employee) {
      return res.status(401).json({
        error: "You must be logged in."
      });
    }

    const vehicleId = req.params.id;

    const {
      year,
      make,
      model,
      vin,
      mileage
    } = req.body;

    if (!year || !make || !model) {
      return res.status(400).json({
        error: "Year, make, and model are required."
      });
    }

    // Make sure vehicle belongs to this shop
    const vehicle = db.prepare(`
      SELECT id
      FROM vehicles
      WHERE id = ?
        AND shop_id = ?
      LIMIT 1
    `).get(
      vehicleId,
      req.session.employee.shop_id
    );

    if (!vehicle) {
      return res.status(404).json({
        error: "Vehicle not found."
      });
    }

    db.prepare(`
      UPDATE vehicles
      SET
        year = ?,
        make = ?,
        model = ?,
        vin = ?,
        mileage = ?
      WHERE id = ?
        AND shop_id = ?
    `).run(
      year || null,
      make ? make.trim() : null,
      model ? model.trim() : null,
      vin ? vin.trim().toUpperCase() : null,
      mileage || null,
      vehicleId,
      req.session.employee.shop_id
    );

    res.json({
      success: true
    });

  } catch (err) {
    console.error("Update vehicle error:", err);

    res.status(500).json({
      error: "Unable to update vehicle."
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
      AND shop_id = ?
`).get(
    vehicleId,
    req.session.employee.shop_id
);

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
      AND shop_id = ?
`).run(
    vehicleId,
    req.session.employee.shop_id
);

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

// ===== S&K AUTO - VEHICLE SERVICE HISTORY =====
app.get("/api/vehicles/:vehicleId/service-history", (req, res) => {
  try {
    if (!req.session.employee || !req.session.employee.id) {
      return res.status(401).json({
        error: "You must be signed in to view service history."
      });
    }

    const shopId = req.session.employee.shop_id;
    const vehicleId = Number(req.params.vehicleId);

    if (!shopId) {
      return res.status(403).json({
        error: "No shop is associated with this employee."
      });
    }

    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({
        error: "Invalid vehicle ID."
      });
    }

    // Verify this vehicle belongs to a repair order for this shop.
    const vehicle = db.prepare(`
      SELECT
        v.id,
        v.year,
        v.make,
        v.model,
        v.vin,
        v.mileage
      FROM vehicles v
      INNER JOIN repair_orders r
        ON r.vehicle_id = v.id
      WHERE v.id = ?
        AND r.shop_id = ?
      LIMIT 1
    `).get(vehicleId, shopId);

    if (!vehicle) {
      return res.status(404).json({
        error: "Vehicle not found."
      });
    }

    const history = db.prepare(`
      SELECT
        r.id,
        r.customer_id,
        r.vehicle_id,
        r.status,
        r.technician_notes,
        r.payment_status,
        r.payment_method,
        r.paid_at,
        r.created_at,
        r.completed_at,
        c.name AS customer_name
      FROM repair_orders r
      LEFT JOIN customers c
        ON r.customer_id = c.id
      WHERE r.vehicle_id = ?
        AND r.shop_id = ?
        AND r.status = 'completed'
      ORDER BY r.completed_at DESC, r.id DESC
    `).all(vehicleId, shopId);

    for (const repairOrder of history) {

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

      repairOrder.subtotal = repairOrder.items.reduce(
        (sum, item) =>
          sum +
          (Number(item.parts) || 0) +
          (Number(item.labor) || 0),
        0
      );
    }

    res.json({
      vehicle: vehicle,
      history: history
    });

  } catch (err) {
    console.error("Vehicle service history error:", err);

    res.status(500).json({
      error: "Unable to retrieve vehicle service history."
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
  AND r.shop_id = ?
`).get(
  req.params.id,
  req.session.employee.shop_id
);

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
// ===== S&K AUTO - GET RECOMMENDED REPAIRS =====
repairOrder.recommendations = db.prepare(`
  SELECT
    id,
    description,
    parts,
    labor,
    status,
    created_at
  FROM repair_order_recommendations
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
    SELECT
        id,
        amount,
        payment_method,
        paid_at,
        voided,
        voided_at,
        void_reason
    FROM repair_order_payments
    WHERE repair_order_id = ?
    ORDER BY id ASC
`).all(repairOrder.id);
// ===== S&K AUTO - CALCULATE ACTIVE PAYMENT TOTAL =====
repairOrder.amount_paid = repairOrder.payments.reduce(
    (sum, payment) =>
        payment.voided
            ? sum
            : sum + Number(payment.amount || 0),
    0
);
repairOrder.balance_due = Math.max(
  0,
  Number(repairOrder.total || repairOrder.subtotal || 0) -
    repairOrder.amount_paid
);  
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

// ===== S&K AUTO - TEXT PAYMENT RECEIPT =====
app.post("/api/repair-orders/:id/payments/:paymentId/text-receipt", async (req, res) => {
  try {
    const repairOrderId = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);

    const repairOrder = db.prepare(`
      SELECT
        r.id,
        c.name AS customer_name,
        c.phone AS customer_phone
      FROM repair_orders r
      LEFT JOIN customers c ON r.customer_id = c.id
      WHERE r.id = ?
    `).get(repairOrderId);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    if (!repairOrder.customer_phone) {
      return res.status(400).json({
        error: "This customer does not have a phone number."
      });
    }

    const payment = db.prepare(`
      SELECT
        id,
        amount,
        payment_method,
        paid_at,
        voided
      FROM repair_order_payments
      WHERE id = ?
        AND repair_order_id = ?
    `).get(paymentId, repairOrderId);

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found."
      });
    }

    if (payment.voided) {
      return res.status(400).json({
        error: "A voided payment receipt cannot be texted."
      });
    }

    const digits = String(repairOrder.customer_phone).replace(/\D/g, "");

    const customerPhone =
      digits.length === 10
        ? "+1" + digits
        : digits.length === 11 && digits.startsWith("1")
        ? "+" + digits
        : null;

    if (!customerPhone) {
      return res.status(400).json({
        error: "Customer phone number is invalid."
      });
    }

    const receiptUrl =
      `https://skautohutch.com/receipt.html?orderId=${encodeURIComponent(repairOrderId)}` +
      `&paymentId=${encodeURIComponent(paymentId)}`;

    const messageBody =
      `S&K Auto: Hi ${repairOrder.customer_name || "Customer"}, ` +
      `thank you for your payment of $${Number(payment.amount || 0).toFixed(2)}. ` +
      `Payment method: ${payment.payment_method || "Not listed"}. ` +
      `View your receipt: ${receiptUrl}`;

    const message = await twilioClient.messages.create({
      body: messageBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone
    });

    console.log("Payment receipt SMS sent:", message.sid);

    res.json({
      success: true,
      phone: repairOrder.customer_phone,
      message: "Payment receipt texted successfully."
    });

  } catch (err) {
    console.error("Text payment receipt error:", err);

    res.status(500).json({
      error: "Unable to text payment receipt."
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

// ===== S&K AUTO - VOID PAYMENT =====
app.post("/api/repair-orders/:id/payments/:paymentId/void", (req, res) => {
  try {
    const repairOrderId = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);
    const reason = String(req.body.reason || "").trim();

    if (!reason) {
      return res.status(400).json({
        error: "A reason is required to void a payment."
      });
    }

    const payment = db.prepare(`
      SELECT id, repair_order_id, amount, payment_method, paid_at, voided
      FROM repair_order_payments
      WHERE id = ? AND repair_order_id = ?
    `).get(paymentId, repairOrderId);

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found."
      });
    }

    if (payment.voided) {
      return res.status(400).json({
        error: "This payment has already been voided."
      });
    }

    db.prepare(`
      UPDATE repair_order_payments
      SET
        voided = 1,
        voided_at = CURRENT_TIMESTAMP,
        void_reason = ?
      WHERE id = ? AND repair_order_id = ?
    `).run(reason, paymentId, repairOrderId);

    const activePayments = db.prepare(`
      SELECT amount
      FROM repair_order_payments
      WHERE repair_order_id = ?
        AND (voided = 0 OR voided IS NULL)
    `).all(repairOrderId);

    const amountPaid = activePayments.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0
    );

    db.prepare(`
      UPDATE repair_orders
      SET amount_paid = ?
      WHERE id = ?
    `).run(amountPaid, repairOrderId);
// Recalculate payment status after voiding a payment
const orderTotals = db.prepare(`
  SELECT
    COALESCE(SUM(parts), 0) AS parts_total,
    COALESCE(SUM(labor), 0) AS labor_total
  FROM repair_order_items
  WHERE repair_order_id = ?
`).get(repairOrderId);

const subtotal =
  Number(orderTotals.parts_total || 0) +
  Number(orderTotals.labor_total || 0);

const total = subtotal + (subtotal * 0.075);

let paymentStatus = "unpaid";

if (amountPaid > 0 && amountPaid < total) {
  paymentStatus = "partial";
} else if (amountPaid >= total && total > 0) {
  paymentStatus = "paid";
}

db.prepare(`
  UPDATE repair_orders
  SET payment_status = ?
  WHERE id = ?
`).run(paymentStatus, repairOrderId);
 res.json({
  success: true,
  message: "Payment voided successfully.",
  amount_paid: amountPaid,
  payment_status: paymentStatus
});

  } catch (err) {
    console.error("Void payment error:", err);

    res.status(500).json({
      error: "Unable to void payment."
    });
  }
});

// ===== S&K AUTO - SECURE CUSTOMER INVOICE =====
app.get("/api/customer-invoice/:token", (req, res) => {
  try {
    const token = String(req.params.token || "").trim();

    if (!token) {
      return res.status(400).json({
        error: "Invoice token is required."
      });
    }

    const repairOrder = db.prepare(`
      SELECT
        r.id,
        r.status,
        r.payment_status,
        r.payment_method,
        r.amount_paid,
        r.created_at,
        r.completed_at,
        c.name AS customer_name,
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
      WHERE r.invoice_token = ?
      LIMIT 1
    `).get(token);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Invoice not found or link is invalid."
      });
    }

    const items = db.prepare(`
      SELECT
        id,
        description,
        parts,
        labor
      FROM repair_order_items
      WHERE repair_order_id = ?
      ORDER BY id ASC
    `).all(repairOrder.id);

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

    res.json({
      success: true,

      invoice: {
        id: repairOrder.id,
        status: repairOrder.status,
        payment_status: repairOrder.payment_status,
        payment_method: repairOrder.payment_method,
        created_at: repairOrder.created_at,
        completed_at: repairOrder.completed_at,

        customer_name: repairOrder.customer_name,

        vehicle: {
          year: repairOrder.vehicle_year,
          make: repairOrder.vehicle_make,
          model: repairOrder.vehicle_model,
          vin: repairOrder.vehicle_vin,
          mileage: repairOrder.vehicle_mileage
        },

        items,

        subtotal: Number(subtotal.toFixed(2)),
        tax: Number(tax.toFixed(2)),
        total: Number(total.toFixed(2)),
        amount_paid: Number(amountPaid.toFixed(2)),
        balance: Number(balance.toFixed(2))
      }
    });

  } catch (err) {
    console.error("Customer invoice error:", err);

    res.status(500).json({
      error: "Unable to load invoice."
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
        r.invoice_token,
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
// ===== S&K AUTO - CREATE SECURE INVOICE LINK =====
let invoiceToken = repairOrder.invoice_token;

if (!invoiceToken) {
    invoiceToken = require("crypto").randomBytes(32).toString("hex");

    db.prepare(`
        UPDATE repair_orders
        SET invoice_token = ?
        WHERE id = ?
    `).run(invoiceToken, repairOrder.id);
}

const invoiceUrl =
    `https://skautohutch.com/invoice.html?id=${encodeURIComponent(req.params.id)}&token=${encodeURIComponent(invoiceToken)}`;
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
<div style="text-align:center;margin:25px 0;">
    <a
        href="${invoiceUrl}"
        style="display:inline-block;background:#d32f2f;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:16px;font-weight:bold;"
    >
        View Invoice
    </a>
</div>
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

// ===== S&K AUTO - EMAIL PAYMENT RECEIPT =====
app.post("/api/repair-orders/:id/payments/:paymentId/email-receipt", async (req, res) => {
  try {
    const repairOrderId = Number(req.params.id);
    const paymentId = Number(req.params.paymentId);

    const repairOrder = db.prepare(`
      SELECT
        r.id,
        c.name AS customer_name,
        c.email AS customer_email,
        v.year AS vehicle_year,
        v.make AS vehicle_make,
        v.model AS vehicle_model
      FROM repair_orders r
      LEFT JOIN customers c
        ON r.customer_id = c.id
      LEFT JOIN vehicles v
        ON r.vehicle_id = v.id
      WHERE r.id = ?
    `).get(repairOrderId);

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

    const payment = db.prepare(`
      SELECT
        id,
        amount,
        payment_method,
        paid_at,
        voided
      FROM repair_order_payments
      WHERE id = ?
        AND repair_order_id = ?
    `).get(paymentId, repairOrderId);

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found."
      });
    }

    if (payment.voided) {
      return res.status(400).json({
        error: "A receipt cannot be emailed for a voided payment."
      });
    }

    const items = db.prepare(`
      SELECT
        parts,
        labor
      FROM repair_order_items
      WHERE repair_order_id = ?
    `).all(repairOrderId);

    const subtotal = items.reduce(
      (sum, item) =>
        sum +
        Number(item.parts || 0) +
        Number(item.labor || 0),
      0
    );

    const tax =
      Math.round(subtotal * 0.075 * 100) / 100;

    const total =
      Math.round((subtotal + tax) * 100) / 100;

    const previousPayments = db.prepare(`
      SELECT amount
      FROM repair_order_payments
      WHERE repair_order_id = ?
        AND voided = 0
        AND id < ?
    `).all(repairOrderId, paymentId);

    const paidBefore = previousPayments.reduce(
      (sum, p) => sum + Number(p.amount || 0),
      0
    );

    const previousBalance =
      Math.max(0, total - paidBefore);

    const remainingBalance =
      Math.max(
        0,
        previousBalance - Number(payment.amount || 0)
      );

    const vehicleDescription = [
      repairOrder.vehicle_year,
      repairOrder.vehicle_make,
      repairOrder.vehicle_model
    ].filter(Boolean).join(" ");

    const paymentDate = payment.paid_at
      ? new Date(payment.paid_at + " UTC").toLocaleString("en-US")
      : "";

    const receiptNumber =
      `R-${String(repairOrderId).padStart(5, "0")}-${String(paymentId).padStart(4, "0")}`;

    await resend.emails.send({
      from: "S&K Auto <appointments@skautohutch.com>",
      to: [repairOrder.customer_email],
      subject: `S&K Auto Payment Receipt ${receiptNumber}`,
      html: `
        <div style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;">
          <div style="max-width:650px;margin:auto;background:#ffffff;border-radius:10px;overflow:hidden;">

            <div style="background:#151515;color:#ffffff;padding:22px;text-align:center;">
              <img
                src="https://skautohutch.com/sk-auto-invoice-logo.png"
                alt="S&K Auto"
                style="display:block;width:180px;max-width:100%;height:auto;margin:0 auto 8px auto;"
              >
              <p style="margin:5px 0;color:#cccccc;">
                The Art of Automotive Repair
              </p>
            </div>

            <div style="padding:25px;">
              <h2 style="margin-top:0;color:#d32f2f;">
                PAYMENT RECEIPT
              </h2>

              <p>
                Thank you, ${repairOrder.customer_name || "Customer"}.
              </p>

              <p>
                We received your payment to S&K Auto.
              </p>

              <table style="width:100%;border-collapse:collapse;margin-top:20px;">
                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Receipt #
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;font-weight:bold;">
                    ${receiptNumber}
                  </td>
                </tr>

                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Repair Order #
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;">
                    ${repairOrderId}
                  </td>
                </tr>

                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Vehicle
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;">
                    ${vehicleDescription || "Not listed"}
                  </td>
                </tr>

                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Payment Amount
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;font-weight:bold;">
                    $${Number(payment.amount || 0).toFixed(2)}
                  </td>
                </tr>

                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Payment Method
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;">
                    ${payment.payment_method || "Not listed"}
                  </td>
                </tr>

                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Payment Date
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;">
                    ${paymentDate}
                  </td>
                </tr>

                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Invoice Total
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;">
                    $${total.toFixed(2)}
                  </td>
                </tr>

                <tr>
                  <td style="padding:10px;border-bottom:1px solid #ddd;">
                    Previous Balance
                  </td>
                  <td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;">
                    $${previousBalance.toFixed(2)}
                  </td>
                </tr>

                <tr>
                  <td style="padding:12px;font-size:18px;font-weight:bold;">
                    Remaining Balance
                  </td>
                  <td style="padding:12px;text-align:right;font-size:18px;font-weight:bold;">
                    $${remainingBalance.toFixed(2)}
                  </td>
                </tr>
              </table>

              <p style="margin-top:25px;color:#666;">
                Thank you for choosing S&K Auto.
              </p>

              <p style="color:#666;">
                3107 Homestead<br>
                Hutchinson, KS 67502<br>
                (620) 899-0425
              </p>
            </div>
          </div>
        </div>
      `
    });

    console.log(
      `Payment receipt ${receiptNumber} emailed to ${repairOrder.customer_email}`
    );

    res.json({
      success: true,
      email: repairOrder.customer_email,
      receipt_number: receiptNumber
    });

  } catch (err) {
    console.error("Email payment receipt error:", err);

    res.status(500).json({
      error: "Unable to email payment receipt."
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

// ===== S&K AUTO - CREATE REPAIR ORDER =====
app.post("/api/repair-orders", (req, res) => {
  try {
    // Require a logged-in employee
    if (!req.session.employee || !req.session.employee.id) {
      return res.status(401).json({
        error: "You must be signed in to create a repair order."
      });
    }

    const shopId = req.session.employee.shop_id;

    if (!shopId) {
      return res.status(403).json({
        error: "No shop is associated with this employee."
      });
    }

    const { customer_id, vehicle_id, estimate_id } = req.body;

    if (!customer_id) {
      return res.status(400).json({
        error: "Customer ID is required."
      });
    }

    // Make sure the customer belongs to the logged-in shop
    const customer = db.prepare(`
      SELECT id
      FROM customers
      WHERE id = ?
        AND shop_id = ?
    `).get(
      customer_id,
      shopId
    );

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found."
      });
    }

    // If a vehicle was supplied, make sure it belongs
    // to this customer AND this shop
    if (vehicle_id) {
      const vehicle = db.prepare(`
        SELECT id
        FROM vehicles
        WHERE id = ?
          AND customer_id = ?
          AND shop_id = ?
      `).get(
        vehicle_id,
        customer_id,
        shopId
      );

      if (!vehicle) {
        return res.status(404).json({
          error: "Vehicle not found for this customer."
        });
      }
    }

    const result = db.prepare(`
      INSERT INTO repair_orders (
        estimate_id,
        customer_id,
        vehicle_id,
        status,
        payment_status,
        shop_id
      )
      VALUES (?, ?, ?, 'waiting', 'unpaid', ?)
    `).run(
      estimate_id || null,
      customer_id,
      vehicle_id || null,
      shopId
    );

    res.json({
      success: true,
      repair_order_id: Number(result.lastInsertRowid)
    });

  } catch (err) {
    console.error("Create repair order error:", err);

    res.status(500).json({
      error: "Unable to create repair order."
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

// ===== S&K AUTO - ADD RECOMMENDED REPAIR =====
app.post("/api/repair-orders/:id/recommendations", async (req, res) => {
  try {
    const { description, parts, labor } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({
        error: "Recommended repair description is required."
      });
    }

   const repairOrder = db.prepare(`
    SELECT
        ro.id,
        ro.customer_id,
        c.name AS customer_name,
        c.phone AS customer_phone
    FROM repair_orders ro
    JOIN customers c ON c.id = ro.customer_id
    WHERE ro.id = ?
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

   const authorizationToken = require("crypto")
  .randomBytes(32)
  .toString("hex");

const result = db.prepare(`
  INSERT INTO repair_order_recommendations
    (
      repair_order_id,
      description,
      parts,
      labor,
      status,
      authorization_token
    )
  VALUES (?, ?, ?, ?, 'pending', ?)
`).run(
  req.params.id,
  description.trim(),
  partsAmount,
  laborAmount,
  authorizationToken
);

 // Send recommended repair authorization text to customer
try {
  if (repairOrder.customer_phone) {
    const authorizationUrl =
      `https://skautohutch.com/repair-authorization.html?order=${encodeURIComponent(req.params.id)}` +
      `&repair=${encodeURIComponent(result.lastInsertRowid)}` +
      `&token=${encodeURIComponent(authorizationToken)}`;

    await twilioClient.messages.create({
      body:
        `S&K Auto: Hi ${repairOrder.customer_name}, ` +
        `we have recommended an additional repair for your vehicle: ` +
        `${description.trim()}. ` +
        `Parts: $${partsAmount.toFixed(2)}, Labor: $${laborAmount.toFixed(2)}, ` +
        `Total: $${(partsAmount + laborAmount).toFixed(2)}. ` +
        `Please approve or decline the repair here: ${authorizationUrl}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: repairOrder.customer_phone
    });

    console.log("Repair authorization SMS sent to customer.");
  }
} catch (smsError) {
  console.error("Repair authorization SMS failed:", smsError);
}   

res.status(201).json({
  success: true,
  id: Number(result.lastInsertRowid),
  description: description.trim(),
  parts: partsAmount,
  labor: laborAmount,
  status: "pending",
  authorizationToken: authorizationToken
});

  } catch (err) {
    console.error("Add recommended repair error:", err);

    res.status(500).json({
      error: "Unable to add recommended repair."
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

// ===== S&K AUTO - GET RECOMMENDED REPAIRS =====
app.get("/api/repair-orders/:id/recommendations", (req, res) => {
  try {
    const recommendations = db.prepare(`
      SELECT id, repair_order_id, description, parts, labor, status, created_at
      FROM repair_order_recommendations
      WHERE repair_order_id = ?
      ORDER BY id ASC
    `).all(req.params.id);

    res.json(recommendations);

  } catch (err) {
    console.error("Get recommended repairs error:", err);

    res.status(500).json({
      error: "Unable to load recommended repairs."
    });
  }
});

// ===== S&K AUTO - DELETE RECOMMENDED REPAIR =====
app.delete("/api/repair-orders/:repairOrderId/recommendations/:recommendationId", (req, res) => {
  try {
    const recommendation = db.prepare(`
      SELECT id
      FROM repair_order_recommendations
      WHERE id = ?
        AND repair_order_id = ?
    `).get(
      req.params.recommendationId,
      req.params.repairOrderId
    );

    if (!recommendation) {
      return res.status(404).json({
        error: "Recommended repair not found."
      });
    }

    db.prepare(`
      DELETE FROM repair_order_recommendations
      WHERE id = ?
        AND repair_order_id = ?
    `).run(
      req.params.recommendationId,
      req.params.repairOrderId
    );

    res.json({
      success: true
    });

  } catch (err) {
    console.error("Delete recommended repair error:", err);

    res.status(500).json({
      error: "Unable to delete recommended repair."
    });
  }
});
// ===== S&K AUTO - APPROVE RECOMMENDED REPAIR =====
app.patch(
  "/api/repair-orders/:repairOrderId/recommendations/:recommendationId/approve",
  (req, res) => {
    try {
      const repairOrderId = req.params.repairOrderId;
      const recommendationId = req.params.recommendationId;

      // Make sure the repair order exists
      const repairOrder = db.prepare(`
        SELECT id
        FROM repair_orders
        WHERE id = ?
      `).get(repairOrderId);

      if (!repairOrder) {
        return res.status(404).json({
          error: "Repair order not found."
        });
      }

      // Get the recommended repair
      const recommendation = db.prepare(`
       SELECT id, description, parts, labor, status
        FROM repair_order_recommendations
        WHERE id = ?
          AND repair_order_id = ?
      `).get(
        recommendationId,
        repairOrderId
      );

      if (!recommendation) {
        return res.status(404).json({
          error: "Recommended repair not found."
        });
      }
if ((recommendation.status || '').toLowerCase() === 'approved') {
    return res.status(409).json({
        error: "This recommended repair has already been approved."
    });
}
      // Add approved recommendation to active repair items
      const result = db.prepare(`
        INSERT INTO repair_order_items (
          repair_order_id,
          description,
          parts,
          labor
        )
        VALUES (?, ?, ?, ?)
      `).run(
        repairOrderId,
        recommendation.description,
        Number(recommendation.parts) || 0,
        Number(recommendation.labor) || 0
      );

      // Mark recommendation approved
      db.prepare(`
        UPDATE repair_order_recommendations
        SET status = 'approved'
        WHERE id = ?
          AND repair_order_id = ?
      `).run(
        recommendationId,
        repairOrderId
      );

      res.json({
        success: true,
        message: "Recommended repair approved and added to repair order.",
        itemId: result.lastInsertRowid
      });

    } catch (err) {
      console.error(
        "Approve recommended repair error:",
        err
      );

      res.status(500).json({
        error: "Unable to approve recommended repair."
      });
    }
  }
);

// ===== S&K AUTO - DECLINE RECOMMENDED REPAIR =====
app.patch(
  "/api/repair-orders/:repairOrderId/recommendations/:recommendationId/decline",
  (req, res) => {
    try {
      const repairOrderId = req.params.repairOrderId;
      const recommendationId = req.params.recommendationId;

      const recommendation = db.prepare(`
        SELECT id
        FROM repair_order_recommendations
        WHERE id = ?
          AND repair_order_id = ?
      `).get(
        recommendationId,
        repairOrderId
      );

      if (!recommendation) {
        return res.status(404).json({
          error: "Recommended repair not found."
        });
      }

      db.prepare(`
        UPDATE repair_order_recommendations
        SET status = 'declined'
        WHERE id = ?
          AND repair_order_id = ?
      `).run(
        recommendationId,
        repairOrderId
      );

      res.json({
        success: true,
        message: "Recommended repair declined."
      });

    } catch (err) {
      console.error(
        "Decline recommended repair error:",
        err
      );

      res.status(500).json({
        error: "Unable to decline recommended repair."
      });
    }
  }
);

// ===== S&K AUTO - CUSTOMER REPAIR AUTHORIZATION =====

// Customer opens secure repair authorization link
app.get(
  "/api/customer-repair-authorization/:repairOrderId/:recommendationId",
  (req, res) => {
    try {
      const { repairOrderId, recommendationId } = req.params;
      const token = req.query.token;

      if (!token) {
        return res.status(401).json({
          error: "Authorization token required."
        });
      }

      const recommendation = db.prepare(`
        SELECT
          id,
          repair_order_id,
          description,
          parts,
          labor,
          status,
          authorized_at
        FROM repair_order_recommendations
        WHERE id = ?
          AND repair_order_id = ?
          AND authorization_token = ?
      `).get(
        recommendationId,
        repairOrderId,
        token
      );

      if (!recommendation) {
        return res.status(404).json({
          error: "Repair authorization link is invalid or expired."
        });
      }

      res.json(recommendation);

    } catch (err) {
      console.error(
        "Customer repair authorization lookup error:",
        err
      );

      res.status(500).json({
        error: "Unable to retrieve repair authorization."
      });
    }
  }
);


// Customer APPROVES recommended repair
app.patch(
  "/api/customer-repair-authorization/:repairOrderId/:recommendationId/approve",
  async (req, res) => {
    try {
      const { repairOrderId, recommendationId } = req.params;
      const token = req.body.token;

      if (!token) {
        return res.status(401).json({
          error: "Authorization token required."
        });
      }

      const recommendation = db.prepare(`
        SELECT
          id,
          description,
          parts,
          labor,
          status
        FROM repair_order_recommendations
        WHERE id = ?
          AND repair_order_id = ?
          AND authorization_token = ?
      `).get(
        recommendationId,
        repairOrderId,
        token
      );

      if (!recommendation) {
        return res.status(404).json({
          error: "Repair authorization link is invalid or expired."
        });
      }

      if (recommendation.status !== "pending") {
        return res.status(409).json({
          error: "This repair has already been approved or declined."
        });
      }

      const approveRepair = db.transaction(() => {

        const result = db.prepare(`
          INSERT INTO repair_order_items (
            repair_order_id,
            description,
            parts,
            labor
          )
          VALUES (?, ?, ?, ?)
        `).run(
          repairOrderId,
          recommendation.description,
          Number(recommendation.parts) || 0,
          Number(recommendation.labor) || 0
        );

        db.prepare(`
          UPDATE repair_order_recommendations
          SET
            status = 'approved',
            authorized_at = CURRENT_TIMESTAMP,
            authorization_source = 'customer'
          WHERE id = ?
            AND repair_order_id = ?
            AND status = 'pending'
        `).run(
          recommendationId,
          repairOrderId
        );

        return result;
      });

      const result = approveRepair();
// ===== S&K AUTO - SHOP SMS WHEN CUSTOMER APPROVES REPAIR =====
try {
  await twilioClient.messages.create({
    body:
      `S&K Auto - CUSTOMER APPROVED REPAIR\n\n` +
      `Repair Order: #${repairOrderId}\n` +
      `Repair: ${recommendation.description}\n` +
      `Parts: $${Number(recommendation.parts || 0).toFixed(2)}\n` +
      `Labor: $${Number(recommendation.labor || 0).toFixed(2)}\n` +
      `Total: $${(
        Number(recommendation.parts || 0) +
        Number(recommendation.labor || 0)
      ).toFixed(2)}\n\n` +
      `Customer approved this repair through the authorization link.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: process.env.SMS_TO_NUMBER
  });

  console.log("Customer repair approval SMS sent to shop.");
} catch (smsError) {
  console.error(
    "Customer repair approval SMS failed:",
    smsError
  );
}
      res.json({
        success: true,
        status: "approved",
        message: "Repair authorized successfully.",
        itemId: result.lastInsertRowid
      });

    } catch (err) {
      console.error(
        "Customer repair approval error:",
        err
      );

      res.status(500).json({
        error: "Unable to authorize repair."
      });
    }
  }
);


// Customer DECLINES recommended repair
app.patch(
  "/api/customer-repair-authorization/:repairOrderId/:recommendationId/decline",
  async (req, res) => {
    try {
      const { repairOrderId, recommendationId } = req.params;
      const token = req.body.token;

      if (!token) {
        return res.status(401).json({
          error: "Authorization token required."
        });
      }

      const recommendation = db.prepare(`
        SELECT id, status
        FROM repair_order_recommendations
        WHERE id = ?
          AND repair_order_id = ?
          AND authorization_token = ?
      `).get(
        recommendationId,
        repairOrderId,
        token
      );

      if (!recommendation) {
        return res.status(404).json({
          error: "Repair authorization link is invalid or expired."
        });
      }

      if (recommendation.status !== "pending") {
        return res.status(409).json({
          error: "This repair has already been approved or declined."
        });
      }

      db.prepare(`
        UPDATE repair_order_recommendations
        SET
          status = 'declined',
          authorized_at = CURRENT_TIMESTAMP,
          authorization_source = 'customer'
        WHERE id = ?
          AND repair_order_id = ?
          AND status = 'pending'
      `).run(
        recommendationId,
        repairOrderId
      );
// ===== S&K AUTO - SHOP SMS WHEN CUSTOMER DECLINES REPAIR =====
try {
  await twilioClient.messages.create({
    body:
      `S&K Auto - CUSTOMER DECLINED REPAIR\n\n` +
      `Repair Order: #${repairOrderId}\n` +
      `Recommended Repair ID: #${recommendationId}\n\n` +
      `Customer declined this recommended repair.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: process.env.SMS_TO_NUMBER
  });

  console.log("Customer repair decline SMS sent to shop.");
} catch (smsError) {
  console.error("Customer repair decline SMS failed:", smsError);
}
      res.json({
        success: true,
        status: "declined",
        message: "Repair declined."
      });

    } catch (err) {
      console.error(
        "Customer repair decline error:",
        err
      );

      res.status(500).json({
        error: "Unable to decline repair."
      });
    }
  }
);

// ===== S&K AUTO - UPDATE CUSTOMER CONCERN =====
app.patch("/api/repair-orders/:id/concern", (req, res) => {
  try {
    if (!req.session.employee || !req.session.employee.id) {
      return res.status(401).json({
        error: "You must be signed in to update the customer concern."
      });
    }

    const shopId = req.session.employee.shop_id;

    if (!shopId) {
      return res.status(403).json({
        error: "No shop is associated with this employee."
      });
    }

    const { customer_concern } = req.body;

    const concern =
      typeof customer_concern === "string"
        ? customer_concern.trim()
        : "";

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE id = ?
        AND shop_id = ?
    `).get(
      req.params.id,
      shopId
    );

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    db.prepare(`
      UPDATE repair_orders
      SET customer_concern = ?
      WHERE id = ?
        AND shop_id = ?
    `).run(
      concern,
      req.params.id,
      shopId
    );

    res.json({
      success: true,
      customer_concern: concern
    });

  } catch (err) {
    console.error("Update customer concern error:", err);

    res.status(500).json({
      error: "Unable to update customer concern."
    });
  }
});
// ===== S&K AUTO - MARK REPAIR ORDER COMPLETED =====
app.patch("/api/repair-orders/:id/complete", async (req, res) => {
  try {
    if (!req.session.employee || !req.session.employee.id) {
      return res.status(401).json({
        error: "You must be signed in to complete a repair order."
      });
    }

    const shopId = req.session.employee.shop_id;

    if (!shopId) {
      return res.status(403).json({
        error: "No shop is associated with this employee."
      });
    }

    const repairOrder = db.prepare(`
      SELECT id, status
      FROM repair_orders
      WHERE id = ?
        AND shop_id = ?
    `).get(req.params.id, shopId);

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    if (repairOrder.status === "completed") {
      return res.status(409).json({
        error: "This repair order has already been completed."
      });
    }

    db.prepare(`
      UPDATE repair_orders
      SET
        status = 'completed',
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND shop_id = ?
    `).run(req.params.id, shopId);
// ===== S&K AUTO - AUTOMATIC VEHICLE READY SMS =====
try {
    const readyInfo = db.prepare(`
        SELECT
            r.id,
            c.name AS customer_name,
            c.phone AS customer_phone,
            v.year AS vehicle_year,
            v.make AS vehicle_make,
            v.model AS vehicle_model
        FROM repair_orders r
        LEFT JOIN customers c
            ON r.customer_id = c.id
        LEFT JOIN vehicles v
            ON r.vehicle_id = v.id
        WHERE r.id = ?
          AND r.shop_id = ?
    `).get(req.params.id, shopId);

    if (readyInfo && readyInfo.customer_phone) {
        const customerPhone =
            normalizePhoneNumber(readyInfo.customer_phone);

        if (customerPhone) {
            const customerFirstName =
                String(readyInfo.customer_name || "")
                    .trim()
                    .split(/\s+/)[0];

            const vehicleDescription = [
                readyInfo.vehicle_year,
                readyInfo.vehicle_make,
                readyInfo.vehicle_model
            ]
                .filter(Boolean)
                .join(" ");

            await twilioClient.messages.create({
                body:
                    `S&K Auto: ` +
                    `${customerFirstName ? customerFirstName + ", " : ""}` +
                    `your ${vehicleDescription || "vehicle"} is ready! ` +
                    `Your repairs have been completed. ` +
                    `Please contact S&K Auto if you have any questions. ` +
                    `Thank you for choosing S&K Auto!`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: customerPhone
            });

            console.log(
                `Vehicle ready SMS sent for repair order ${req.params.id}`
            );
        }
    }
} catch (smsError) {
    console.error(
        "Vehicle ready SMS error:",
        smsError
    );
}
// ===== END AUTOMATIC VEHICLE READY SMS =====
    res.json({
      success: true,
      status: "completed",
      message: "Repair order marked completed."
    });

  } catch (err) {
    console.error("Complete repair order error:", err);

    res.status(500).json({
      error: "Unable to complete repair order."
    });
  }
});

// ===== S&K AUTO - PAYMENT ROUTE =====

// ===== S&K AUTO - RECORD PAYMENT =====
app.post("/api/repair-orders/:id/payments", (req, res) => {
  try {
    if (!req.session.employee || !req.session.employee.id) {
      return res.status(401).json({
        error: "You must be signed in to record a payment."
      });
    }

    const shopId = req.session.employee.shop_id;

    if (!shopId) {
      return res.status(403).json({
        error: "No shop is associated with this employee."
      });
    }

    const amount = Number(req.body.amount);
    const paymentMethod =
      typeof req.body.payment_method === "string"
        ? req.body.payment_method.trim()
        : "";

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Enter a valid payment amount."
      });
    }

    if (!paymentMethod) {
      return res.status(400).json({
        error: "Select a payment method."
      });
    }

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE id = ?
        AND shop_id = ?
    `).get(
      req.params.id,
      shopId
    );

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }
// ===== S&K AUTO - PREVENT OVERPAYMENT =====
const totals = db.prepare(`
  SELECT
    COALESCE((
      SELECT SUM(parts + labor)
      FROM repair_order_items
      WHERE repair_order_id = ?
    ), 0) AS subtotal,

    COALESCE((
      SELECT SUM(amount)
      FROM repair_order_payments
      WHERE repair_order_id = ?
        AND (voided = 0 OR voided IS NULL)
    ), 0) AS amount_paid
`).get(req.params.id, req.params.id);

const subtotal = Number(totals.subtotal || 0);

const tax = Math.round(
  subtotal * 0.075 * 100
) / 100;

const total = Math.round(
  (subtotal + tax) * 100
) / 100;

const amountPaid = Number(totals.amount_paid || 0);

const balanceDue = Math.max(
  0,
  Math.round((total - amountPaid) * 100) / 100
);

if (amount > balanceDue + 0.001) {
  return res.status(400).json({
    error: `Payment cannot exceed the remaining balance of $${balanceDue.toFixed(2)}.`
  });
}
    const result = db.prepare(`
      INSERT INTO repair_order_payments (
        repair_order_id,
        amount,
        payment_method
      )
      VALUES (?, ?, ?)
    `).run(
      req.params.id,
      amount,
      paymentMethod
    );

    res.status(201).json({
      success: true,
      id: Number(result.lastInsertRowid),
      amount: amount,
      payment_method: paymentMethod,
      message: "Payment recorded successfully."
    });

  } catch (err) {
    console.error("Record payment error:", err);

    res.status(500).json({
      error: "Unable to record payment."
    });
  }
});
// ===== S&K AUTO - UPDATE TECHNICIAN DIAGNOSIS =====
app.patch("/api/repair-orders/:id/diagnosis", (req, res) => {
    try {
        if (!req.session.employee || !req.session.employee.id) {
            return res.status(401).json({
                error: "You must be signed in to update the technician diagnosis."
            });
        }

        const shopId = req.session.employee.shop_id;

        if (!shopId) {
            return res.status(403).json({
                error: "No shop is associated with this employee."
            });
        }

        const { technician_diagnosis } = req.body;

        const diagnosis =
            typeof technician_diagnosis === "string"
                ? technician_diagnosis.trim()
                : "";

        const repairOrder = db.prepare(`
            SELECT id
            FROM repair_orders
            WHERE id = ?
              AND shop_id = ?
        `).get(
            req.params.id,
            shopId
        );

        if (!repairOrder) {
            return res.status(404).json({
                error: "Repair order not found."
            });
        }

        db.prepare(`
            UPDATE repair_orders
            SET technician_diagnosis = ?
            WHERE id = ?
              AND shop_id = ?
        `).run(
            diagnosis,
            req.params.id,
            shopId
        );

        res.json({
            success: true,
            technician_diagnosis: diagnosis
        });

    } catch (err) {
        console.error("Update technician diagnosis error:", err);

        res.status(500).json({
            error: "Unable to update technician diagnosis."
        });
    }
});

// ===== S&K AUTO - UPDATE TECHNICIAN NOTES =====
app.patch("/api/repair-orders/:id/notes", (req, res) => {
  try {
    if (!req.session.employee || !req.session.employee.id) {
      return res.status(401).json({
        error: "You must be signed in to update the technician diagnosis."
      });
    }

    const shopId = req.session.employee.shop_id;

    if (!shopId) {
      return res.status(403).json({
        error: "No shop is associated with this employee."
      });
    }

    const { technician_notes } = req.body;

    const notes =
      typeof technician_notes === "string"
        ? technician_notes.trim()
        : "";

    const repairOrder = db.prepare(`
      SELECT id
      FROM repair_orders
      WHERE id = ?
        AND shop_id = ?
    `).get(
      req.params.id,
      shopId
    );

    if (!repairOrder) {
      return res.status(404).json({
        error: "Repair order not found."
      });
    }

    db.prepare(`
      UPDATE repair_orders
      SET technician_notes = ?
      WHERE id = ?
        AND shop_id = ?
    `).run(
      notes,
      req.params.id,
      shopId
    );

    res.json({
      success: true,
      technician_notes: notes
    });

  } catch (err) {
    console.error("Update technician notes error:", err);

    res.status(500).json({
      error: "Unable to update technician diagnosis."
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
  AND shop_id = ?
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

// ===== S&K AUTO - TEXT INVOICE =====
app.post('/api/text-invoice', async (req, res) => {
  try {
    const {
      phone,
      customerName,
      invoiceNumber,
      total,
      balanceDue,
      invoiceUrl
    } = req.body;

    if (!phone) {
      return res.status(400).json({
        error: 'Customer phone number is required.'
      });
    }

    // Convert customer phone number to +1XXXXXXXXXX format
    const digits = String(phone).replace(/\D/g, '');
    const customerPhone =
      digits.length === 10 ? '+1' + digits :
      digits.length === 11 && digits.startsWith('1') ? '+' + digits :
      null;

    if (!customerPhone) {
      return res.status(400).json({
        error: 'Customer phone number is invalid.'
      });
    }

    const balance = Number(balanceDue || 0);
    const invoiceTotal = Number(total || 0);

    let messageBody;

    if (balance <= 0) {
      messageBody =
`S&K Auto
Payment received - thank you${customerName ? ', ' + customerName : ''}!

Invoice: ${invoiceNumber || ''}
Total: $${invoiceTotal.toFixed(2)}
Balance Due: $0.00

View Invoice:
${invoiceUrl}

Thank you for choosing S&K Auto!
(620) 899-0425`;
    } else {
      messageBody =
`S&K Auto
Your invoice is ready${customerName ? ', ' + customerName : ''}.

Invoice: ${invoiceNumber || ''}
Total: $${invoiceTotal.toFixed(2)}
Balance Due: $${balance.toFixed(2)}

View Invoice:
${invoiceUrl}

Questions? Call (620) 899-0425`;
    }

    const message = await twilioClient.messages.create({
      body: messageBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone
    });

    console.log('Invoice SMS sent:', message.sid);

    res.json({
      success: true,
      message: 'Invoice text sent successfully.'
    });

  } catch (err) {
    console.error('Invoice SMS failed:', err);

    res.status(500).json({
      error: 'Unable to send invoice text.'
    });
  }
});

// ===== S&K AUTO - TEXT REPAIR AUTHORIZATION =====
app.post('/api/text-authorization', async (req, res) => {
  try {
    const {
      phone,
      customerName,
      description,
      parts,
      labor,
      authorizationUrl
    } = req.body;

    if (!phone) {
      return res.status(400).json({
        error: 'Customer phone number is required.'
      });
    }

    if (!authorizationUrl) {
      return res.status(400).json({
        error: 'Authorization link is required.'
      });
    }

    // Convert customer phone number to +1XXXXXXXXXX format
    const digits = String(phone).replace(/\D/g, '');
    const customerPhone =
      digits.length === 10 ? '+1' + digits :
      digits.length === 11 && digits.startsWith('1') ? '+' + digits :
      null;

    if (!customerPhone) {
      return res.status(400).json({
        error: 'Customer phone number is invalid.'
      });
    }

    const partsAmount = Number(parts || 0);
    const laborAmount = Number(labor || 0);
    const total = partsAmount + laborAmount;

    const messageBody =
`S&K Auto

${customerName ? customerName + ', ' : ''}we have a recommended repair that requires your authorization.

Recommended Repair:
${description || 'Additional repair'}

Parts: $${partsAmount.toFixed(2)}
Labor: $${laborAmount.toFixed(2)}
Total: $${total.toFixed(2)}

Review and approve or decline here:
${authorizationUrl}

Questions? Call (620) 899-0425`;

    const message = await twilioClient.messages.create({
      body: messageBody,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone
    });

    console.log('Authorization SMS sent:', message.sid);

    res.json({
      success: true,
      message: 'Authorization text sent successfully.'
    });

  } catch (err) {
    console.error('Authorization SMS failed:', err);

    res.status(500).json({
      error: 'Unable to send authorization text.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`S&K Auto website running on http://localhost:${PORT}`);

  // ===== AUTOMATIC BALANCE REMINDER SCHEDULER =====
  // Wait 5 minutes after startup before the first check.
  setTimeout(() => {
    runAutomaticBalanceReminders();

    // Check once every hour after that.
    setInterval(() => {
      runAutomaticBalanceReminders();
    }, 60 * 60 * 1000);

  }, 5 * 60 * 1000);
});

