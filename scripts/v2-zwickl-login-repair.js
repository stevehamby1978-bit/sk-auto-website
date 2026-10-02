'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

(async () => {
  const email = String(process.env.V2_ZWICKL_OWNER_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.V2_ZWICKL_OWNER_PASSWORD || '');
  if (!email || !password) throw new Error('V2 Zwickl login repair: credentials are not configured.');

  const dataDir = process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'bookings.db');
  if (!fs.existsSync(dbPath)) throw new Error(`V2 Zwickl login repair: database not found at ${dbPath}`);

  const db = new Database(dbPath);
  try {
    const candidates = db.prepare(`
      SELECT e.id,e.email,e.shop_id,e.role,e.active,
             s.name AS shop_name,s.email AS shop_email,s.active AS shop_active
      FROM employees e
      JOIN shops s ON s.id=e.shop_id
      WHERE LOWER(TRIM(e.role))='owner'
        AND (LOWER(TRIM(e.email))=? OR LOWER(TRIM(COALESCE(s.email,'')))=?)
      ORDER BY e.id
    `).all(email, email);

    if (candidates.length !== 1) {
      throw new Error(`V2 Zwickl login repair: expected exactly one owner for ${email}, found ${candidates.length}; refusing ambiguous repair.`);
    }

    const owner = candidates[0];
    if (!owner.shop_active) throw new Error(`V2 Zwickl login repair: shop_id=${owner.shop_id} is inactive; refusing automatic activation.`);

    const collision = db.prepare(`SELECT id,shop_id FROM employees WHERE LOWER(TRIM(email))=? AND id<>? LIMIT 1`).get(email, owner.id);
    if (collision) throw new Error(`V2 Zwickl login repair: email collision with employee id=${collision.id}, shop_id=${collision.shop_id}.`);

    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(`
      UPDATE employees
      SET email=?,password_hash=?,active=1,must_change_password=0
      WHERE id=? AND shop_id=? AND LOWER(TRIM(role))='owner'
    `).run(email, hash, owner.id, owner.shop_id);
    if (result.changes !== 1) throw new Error('V2 Zwickl login repair: owner update did not affect exactly one row.');

    const verify = db.prepare(`
      SELECT e.id,e.email,e.shop_id,e.role,e.active,s.active AS shop_active
      FROM employees e JOIN shops s ON s.id=e.shop_id WHERE e.id=?
    `).get(owner.id);
    if (!verify || !verify.active || !verify.shop_active || verify.role !== 'owner' || String(verify.email).trim().toLowerCase() !== email) {
      throw new Error('V2 Zwickl login repair: post-repair verification failed.');
    }

    console.log(`V2 Zwickl login repair complete: shop_id=${verify.shop_id} owner_id=${verify.id} email=${email}.`);
  } finally {
    db.close();
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
