'use strict';

/*
 * S&K Auto (shop_id=1) duplicate owner cleanup.
 *
 * Removes inactive owner rows for shop_id=1 so that v2-login-repair.js is not
 * blocked by ambiguity. Active owners are never deleted. Idempotent; touches
 * only shop_id=1; never selects or logs passwords or hashes.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SHOP_ID = 1;
const LOG = '[V2 SK OWNER CLEANUP]';

function listOwners(db) {
  return db.prepare(`SELECT id,active FROM employees WHERE shop_id=? AND LOWER(TRIM(role))='owner' ORDER BY id`).all(SHOP_ID);
}

function main() {
  const dataDir = process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'bookings.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`${LOG} database not found at ${dbPath}; nothing to do.`);
    return 1;
  }

  const db = new Database(dbPath);
  try {
    const owners = listOwners(db);

    if (owners.length === 0) {
      console.log(`${LOG} no owners found; repair script will create one`);
      return 0;
    }
    if (owners.length === 1) {
      console.log(`${LOG} already single owner (id=${owners[0].id})`);
      return 0;
    }

    const active = owners.filter(o => Number(o.active) === 1);
    const inactive = owners.filter(o => Number(o.active) !== 1);
    console.log(`${LOG} found ${owners.length} owner rows for shop_id=${SHOP_ID}: active=[${active.map(o => o.id).join(',')}] inactive=[${inactive.map(o => o.id).join(',')}]`);

    if (inactive.length > 0) {
      const del = db.prepare(`DELETE FROM employees WHERE id=? AND shop_id=? AND LOWER(TRIM(role))='owner' AND COALESCE(active,0)<>1`);
      db.transaction(() => {
        for (const owner of inactive) {
          const result = del.run(owner.id, SHOP_ID);
          if (result.changes !== 1) throw new Error(`delete of inactive owner id=${owner.id} did not affect exactly one row`);
        }
      })();
      console.log(`${LOG} deleted inactive owner ids=[${inactive.map(o => o.id).join(',')}]`);
    }

    const remaining = listOwners(db);
    if (remaining.length === 1) {
      console.log(`${LOG} success: single owner remains (id=${remaining[0].id})`);
      return 0;
    }
    if (remaining.length === 0) {
      console.log(`${LOG} no owners remain; repair script will create one`);
      return 0;
    }
    console.error(`${LOG} ERROR: ${remaining.length} active owners remain for shop_id=${SHOP_ID} (ids=[${remaining.map(o => o.id).join(',')}]); manual intervention required.`);
    return 1;
  } finally {
    db.close();
  }
}

try {
  process.exit(main());
} catch (err) {
  console.error(`${LOG} failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
