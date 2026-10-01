const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

(async () => {
  const email = String(process.env.V2_REPAIR_OWNER_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.V2_REPAIR_OWNER_PASSWORD || '');
  if (!email || !password) {
    console.log('V2 login repair skipped: repair credentials not configured.');
    return;
  }

  const dataDir = process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'bookings.db');
  if (!fs.existsSync(dbPath)) throw new Error(`V2 login repair: database not found at ${dbPath}`);

  const db = new Database(dbPath);
  try {
    const employee = db.prepare(`SELECT id, shop_id, role, active FROM employees WHERE LOWER(email) = ? LIMIT 1`).get(email);
    if (!employee) throw new Error(`V2 login repair: owner account ${email} was not found; no account was created.`);
    if (employee.role !== 'owner') throw new Error(`V2 login repair: ${email} is not an owner account; refusing to modify it.`);

    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(`UPDATE employees SET password_hash = ?, active = 1, must_change_password = 0 WHERE id = ? AND shop_id = ? AND role = 'owner'`).run(hash, employee.id, employee.shop_id);
    if (result.changes !== 1) throw new Error('V2 login repair: expected exactly one owner row to be updated.');

    console.log(`V2 login repair complete for owner account ${email}; shop_id=${employee.shop_id}. No other shop accounts were changed.`);
  } finally {
    db.close();
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
