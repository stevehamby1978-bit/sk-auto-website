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
    const shop = db.prepare('SELECT id,name,active FROM shops WHERE id=?').get(shopId);
    if (!shop || !shop.active) throw new Error(`V2 Zwickl login repair: active shop_id=${shopId} not found.`);

    const owners = db.prepare("SELECT id,email,shop_id,role,active,name FROM employees WHERE shop_id=? AND LOWER(TRIM(role))='owner' ORDER BY id").all(shopId);
    if (owners.length !== 1) throw new Error(`V2 Zwickl login repair: expected exactly one owner in shop_id=${shopId}, found ${owners.length}.`);
    const owner = owners[0];

    const collision = db.prepare('SELECT id,shop_id FROM employees WHERE LOWER(TRIM(email))=? AND id<>? LIMIT 1').get(email, owner.id);
    if (collision) throw new Error(`V2 Zwickl login repair: email collision with employee id=${collision.id}, shop_id=${collision.shop_id}.`);

    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare("UPDATE employees SET email=?,password_hash=?,active=1,must_change_password=0 WHERE id=? AND shop_id=? AND LOWER(TRIM(role))='owner'").run(email, hash, owner.id, shopId);
    if (result.changes !== 1) throw new Error('V2 Zwickl login repair: owner update did not affect exactly one row.');

    const verify = db.prepare('SELECT id,name,email,shop_id,role,active FROM employees WHERE id=? AND shop_id=?').get(owner.id, shopId);
    if (!verify || !verify.active || String(verify.email).trim().toLowerCase() !== email) throw new Error('V2 Zwickl login repair: post-repair verification failed.');
    console.log(`V2 Zwickl login repair complete: shop_id=${verify.shop_id} owner_id=${verify.id} name=${verify.name} email=${email}.`);
  } finally {
    db.close();
  }
})().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
