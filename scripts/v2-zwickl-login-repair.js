'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

(async () => {
  const email = String(process.env.V2_ZWICKL_OWNER_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.V2_ZWICKL_OWNER_PASSWORD || '');
  const shopId = 245;
  if (!email || !password) throw new Error('V2 Zwickl login repair: credentials are not configured.');

  const dataDir = process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'bookings.db');
  if (!fs.existsSync(dbPath)) throw new Error(`V2 Zwickl login repair: database not found at ${dbPath}`);

  const db = new Database(dbPath);
  try {
    let shop = db.prepare('SELECT id,name,slug,active FROM shops WHERE id=?').get(shopId);
    if (!shop) {
      const existingSlug = db.prepare("SELECT id FROM shops WHERE LOWER(TRIM(slug))='zwickl-repair-llc' LIMIT 1").get();
      if (existingSlug) throw new Error(`V2 Zwickl login repair: Zwickl slug already belongs to shop_id=${existingSlug.id}.`);
      db.prepare("INSERT INTO shops (id,name,slug,active) VALUES (245,'Zwickl Repair LLC','zwickl-repair-llc',1)").run();
      shop = db.prepare('SELECT id,name,slug,active FROM shops WHERE id=?').get(shopId);
      console.log('V2 Zwickl login repair: restored missing shop_id=245.');
    }
    if (!shop.active) db.prepare('UPDATE shops SET active=1 WHERE id=?').run(shopId);

    const owners = db.prepare("SELECT id,email,shop_id,role,active,name FROM employees WHERE shop_id=? AND LOWER(TRIM(role))='owner' ORDER BY id").all(shopId);
    if (owners.length > 1) throw new Error(`V2 Zwickl login repair: expected at most one owner in shop_id=${shopId}, found ${owners.length}.`);

    const hash = await bcrypt.hash(password, 12);
    let ownerId;
    if (owners.length === 1) {
      const owner = owners[0];
      const collision = db.prepare('SELECT id,shop_id FROM employees WHERE LOWER(TRIM(email))=? AND id<>? LIMIT 1').get(email, owner.id);
      if (collision) throw new Error(`V2 Zwickl login repair: email collision with employee id=${collision.id}, shop_id=${collision.shop_id}.`);
      const result = db.prepare("UPDATE employees SET email=?,password_hash=?,active=1,must_change_password=0 WHERE id=? AND shop_id=? AND LOWER(TRIM(role))='owner'").run(email, hash, owner.id, shopId);
      if (result.changes !== 1) throw new Error('V2 Zwickl login repair: owner update did not affect exactly one row.');
      ownerId = owner.id;
    } else {
      const collision = db.prepare('SELECT id,shop_id,role FROM employees WHERE LOWER(TRIM(email))=? LIMIT 1').get(email);
      if (collision) throw new Error(`V2 Zwickl login repair: requested email already belongs to employee id=${collision.id}, shop_id=${collision.shop_id}, role=${collision.role}.`);
      const result = db.prepare("INSERT INTO employees (name,email,password_hash,role,shop_id,active,must_change_password) VALUES ('Jeramy Zwickl',?,?,'owner',245,1,0)").run(email, hash);
      if (result.changes !== 1) throw new Error('V2 Zwickl login repair: owner insert failed.');
      ownerId = Number(result.lastInsertRowid);
    }

    const verify = db.prepare('SELECT id,name,email,shop_id,role,active FROM employees WHERE id=? AND shop_id=?').get(ownerId, shopId);
    if (!verify || !verify.active || String(verify.role).trim().toLowerCase() !== 'owner' || String(verify.email).trim().toLowerCase() !== email) throw new Error('V2 Zwickl login repair: post-repair verification failed.');
    console.log(`V2 Zwickl login repair complete: shop_id=${verify.shop_id} owner_id=${verify.id} name=${verify.name} email=${email}.`);
  } finally {
    db.close();
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
