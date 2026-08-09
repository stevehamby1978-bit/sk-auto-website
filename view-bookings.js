
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'bookings.db'));
const rows = db.prepare(`
  SELECT confirmation, date, time, name, phone, email, vehicle, service, notes, created_at
  FROM bookings ORDER BY date, time
`).all();
console.table(rows);
