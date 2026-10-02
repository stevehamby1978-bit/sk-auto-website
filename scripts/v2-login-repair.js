const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

(async () => {
  const email = String(process.env.V2_REPAIR_OWNER_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.V2_REPAIR_OWNER_PASSWORD || '');
  if (!email || !password) {
    throw new Error('V2 login repair: repair credentials are not configured.');
  }

  const dataDir = process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'bookings.db');
  if (!fs.existsSync(dbPath)) throw new Error(`V2 login repair: database not found at ${dbPath}`);

  const db = new Database(dbPath);
  try {
    const shop = db.prepare(`
      SELECT id,name,slug,active
      FROM shops
      WHERE id = 1 AND (slug='sk-auto' OR LOWER(TRIM(name))='s&k auto')
      LIMIT 1
    `).get();
    if (!shop) throw new Error('V2 login repair: S&K Auto shop id=1 was not found; refusing to modify database.');
    if (!shop.active) throw new Error('V2 login repair: S&K Auto shop id=1 is inactive.');

    const owners = db.prepare(`SELECT id,email,role,active FROM employees WHERE shop_id=? AND LOWER(TRIM(role))='owner' ORDER BY id`).all(shop.id);
    if (owners.length > 1) throw new Error(`V2 login repair: S&K Auto has ${owners.length} owner rows; refusing ambiguous repair.`);

    const hash = await bcrypt.hash(password, 12);
    const tx = db.transaction(() => {
      if (owners.length === 1) {
        const owner = owners[0];
        const collision = db.prepare(`SELECT id,shop_id FROM employees WHERE LOWER(email)=? AND id<>? LIMIT 1`).get(email, owner.id);
        if (collision) throw new Error(`V2 login repair: requested email is already assigned to employee id=${collision.id}, shop_id=${collision.shop_id}.`);
        const result = db.prepare(`UPDATE employees SET name=?,email=?,password_hash=?,active=1,must_change_password=0 WHERE id=? AND shop_id=? AND LOWER(TRIM(role))='owner'`).run('S&K Auto Owner', email, hash, owner.id, shop.id);
        if (result.changes !== 1) throw new Error('V2 login repair: owner update did not affect exactly one row.');
        return owner.id;
      }

      const collision = db.prepare(`SELECT id,shop_id,role FROM employees WHERE LOWER(email)=? LIMIT 1`).get(email);
      if (collision) throw new Error(`V2 login repair: requested email already belongs to employee id=${collision.id}, shop_id=${collision.shop_id}, role=${collision.role}; refusing duplicate.`);
      const result = db.prepare(`INSERT INTO employees (name,email,password_hash,role,shop_id,active,must_change_password) VALUES (?,?,?,'owner',1,1,0)`).run('S&K Auto Owner', email, hash);
      if (result.changes !== 1) throw new Error('V2 login repair: owner insert failed.');
      return Number(result.lastInsertRowid);
    });

    const ownerId = tx();
    const verify = db.prepare(`SELECT id,email,shop_id,role,active,CASE WHEN LENGTH(COALESCE(password_hash,''))>0 THEN 1 ELSE 0 END has_hash FROM employees WHERE id=?`).get(ownerId);
    if (!verify || verify.shop_id !== 1 || verify.role !== 'owner' || !verify.active || !verify.has_hash || String(verify.email).toLowerCase() !== email) {
      throw new Error('V2 login repair: post-repair verification failed.');
    }
    console.log(`V2 login repair complete: S&K Auto shop_id=1 owner_id=${ownerId} email=${email}.`);
  } finally {
    db.close();
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
