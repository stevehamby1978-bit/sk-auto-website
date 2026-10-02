'use strict';

/*
 * Removes duplicate inactive owner rows for S&K Auto (shop_id=1) so the owner
 * login repair script is no longer blocked by "refusing ambiguous repair".
 *
 * Scope: only employees with shop_id=1 and role='owner'. Only inactive owner
 * rows are ever deleted, and only when 2+ owner rows exist. Idempotent.
 * Passwords and password hashes are never read into logs.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SHOP_ID = 1;
const PREFIX = 'V2 owner dedup:';

function main() {
  const dataDir = process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, '..', 'data');
  const dbPath = path.join(dataDir, 'bookings.db');
  if (!fs.existsSync(dbPath)) {
    console.log(`${PREFIX} database not found at ${dbPath}; nothing to do.`);
    return 0;
  }

  const db = new Database(dbPath);
  try {
    const listOwners = () => db.prepare(`
      SELECT id, active, CASE WHEN LENGTH(COALESCE(password_hash,''))>0 THEN 1 ELSE 0 END AS has_hash
      FROM employees
      WHERE shop_id = ? AND LOWER(TRIM(role)) = 'owner'
      ORDER BY id
    `).all(SHOP_ID);

    const owners = listOwners();
    if (owners.length === 0) {
      console.log(`${PREFIX} S&K Auto shop_id=${SHOP_ID} has 0 owner rows; nothing to fix.`);
      return 0;
    }
    if (owners.length === 1) {
      console.log(`${PREFIX} S&K Auto shop_id=${SHOP_ID} has exactly 1 owner row (id=${owners[0].id}); already fixed.`);
      return 0;
    }

    console.log(`${PREFIX} S&K Auto shop_id=${SHOP_ID} has ${owners.length} owner rows: ${owners.map(o => `id=${o.id} active=${o.active ? 1 : 0}`).join(', ')}.`);

    const inactiveIds = owners.filter(o => !o.active).map(o => o.id);
    if (inactiveIds.length) {
      const del = db.prepare(`DELETE FROM employees WHERE id = ? AND shop_id = ? AND LOWER(TRIM(role)) = 'owner' AND (active = 0 OR active IS NULL)`);
      db.transaction(() => {
        for (const id of inactiveIds) {
          const result = del.run(id, SHOP_ID);
          if (result.changes !== 1) throw new Error(`${PREFIX} delete of inactive owner id=${id} did not affect exactly one row.`);
        }
      })();
      console.log(`${PREFIX} deleted ${inactiveIds.length} inactive owner row(s): ${inactiveIds.map(id => `id=${id}`).join(', ')}.`);
    } else {
      console.log(`${PREFIX} no inactive owner rows to delete.`);
    }

    const remaining = listOwners();
    if (remaining.length > 1) {
      console.error(`${PREFIX} ERROR: ${remaining.length} active owner rows remain for shop_id=${SHOP_ID} (${remaining.map(o => `id=${o.id}`).join(', ')}); manual investigation required.`);
      return 1;
    }
    if (remaining.length === 0) {
      console.log(`${PREFIX} no owner rows remain for shop_id=${SHOP_ID}; the repair script will create the owner.`);
      return 0;
    }

    const owner = remaining[0];
    if (!owner.active) {
      console.log(`${PREFIX} remaining owner id=${owner.id} is inactive; leaving unchanged for the repair script.`);
      return 0;
    }
    if (!owner.has_hash) {
      console.log(`${PREFIX} remaining active owner id=${owner.id} has no password hash; leaving unchanged for the repair script.`);
      return 0;
    }
    console.log(`${PREFIX} verified exactly 1 active owner (id=${owner.id}) with a password hash for shop_id=${SHOP_ID}.`);
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
}
