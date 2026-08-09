const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const db = new Database(path.join(dataDir, 'bookings.db'));
const rows = db.prepare(`
  SELECT confirmation, date, time, name, phone, email, vehicle, service, notes, created_at
  FROM bookings ORDER BY date, time
`).all();

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}
const headers = ['confirmation','date','time','name','phone','email','vehicle','service','notes','created_at'];
const lines = [headers.join(',')];
for (const row of rows) lines.push(headers.map(h => csvEscape(row[h])).join(','));
const out = path.join(__dirname, 'appointments.csv');
fs.writeFileSync(out, lines.join('\n'));
console.log(`Exported ${rows.length} appointments to ${out}`);
