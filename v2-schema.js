/* Garavex V2 database foundation.
 * Additive migrations only: this module does not remove or rename V1 tables/columns.
 */
function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function ensureColumn(db, table, name, definition) {
  if (!tableExists(db, table)) {
    throw new Error(`Garavex V2 schema requires existing base table: ${table}`);
  }
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function assertBaseSchema(db) {
  const required = ['repair_orders','repair_order_items','vehicles','employees','shops'];
  const missing = required.filter(table => !tableExists(db, table));
  if (missing.length) {
    throw new Error(`Garavex V2 cannot install before the V1 base schema. Missing table(s): ${missing.join(', ')}`);
  }
}

function applyV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dvi_inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, repair_order_id INTEGER, customer_id INTEGER, vehicle_id INTEGER, technician_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft', public_token TEXT UNIQUE, customer_notes TEXT, sent_at TEXT, viewed_at TEXT, completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dvi_shop ON dvi_inspections(shop_id);
    CREATE INDEX IF NOT EXISTS idx_dvi_ro ON dvi_inspections(repair_order_id);

    CREATE TABLE IF NOT EXISTS dvi_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, inspection_id INTEGER NOT NULL, category TEXT NOT NULL, item_name TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'green', notes TEXT, recommendation TEXT, parts REAL NOT NULL DEFAULT 0, labor REAL NOT NULL DEFAULT 0,
      customer_decision TEXT NOT NULL DEFAULT 'pending', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(inspection_id) REFERENCES dvi_inspections(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_dvi_items_inspection ON dvi_items(shop_id,inspection_id);

    CREATE TABLE IF NOT EXISTS dvi_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, inspection_id INTEGER NOT NULL, item_id INTEGER, filename TEXT NOT NULL,
      original_name TEXT, mime_type TEXT, media_type TEXT NOT NULL DEFAULT 'photo', caption TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS technician_time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, repair_order_id INTEGER, repair_order_item_id INTEGER,
      clock_in TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, clock_out TEXT, minutes INTEGER, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_time_shop_employee ON technician_time_entries(shop_id, employee_id);
    CREATE INDEX IF NOT EXISTS idx_time_shop_ro ON technician_time_entries(shop_id, repair_order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_time_one_open_per_employee ON technician_time_entries(shop_id,employee_id) WHERE clock_out IS NULL;

    CREATE TABLE IF NOT EXISTS deferred_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, vehicle_id INTEGER, repair_order_id INTEGER, dvi_item_id INTEGER,
      description TEXT NOT NULL, estimated_total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'deferred', follow_up_date TEXT, last_reminder_at TEXT,
      reminder_count INTEGER NOT NULL DEFAULT 0, resolved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_deferred_shop_status ON deferred_services(shop_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deferred_dvi_item_unique ON deferred_services(dvi_item_id) WHERE dvi_item_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, name TEXT NOT NULL, contact_name TEXT, phone TEXT, email TEXT, website TEXT,
      account_number TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vendors_shop ON vendors(shop_id,active,name);

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, vendor_id INTEGER, sku TEXT, part_number TEXT, description TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0, reorder_level REAL NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, sell_price REAL NOT NULL DEFAULT 0,
      location TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_shop ON inventory_items(shop_id);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, vendor_id INTEGER, repair_order_id INTEGER, po_number TEXT,
      status TEXT NOT NULL DEFAULT 'draft', ordered_at TEXT, received_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_po_shop_number ON purchase_orders(shop_id,po_number) WHERE po_number IS NOT NULL;

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, purchase_order_id INTEGER NOT NULL, inventory_item_id INTEGER, part_number TEXT,
      description TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, unit_cost REAL NOT NULL DEFAULT 0, received_quantity REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_po_items_order ON purchase_order_items(shop_id,purchase_order_id);

    CREATE TABLE IF NOT EXISTS canned_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT, description TEXT, labor_hours REAL NOT NULL DEFAULT 0,
      labor_rate REAL, parts_price REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, employee_id INTEGER, action TEXT NOT NULL, entity_type TEXT, entity_id INTEGER,
      details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_shop_created ON audit_log(shop_id, created_at);

    CREATE TABLE IF NOT EXISTS customer_portal_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, expires_at TEXT,
      revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_portal_customer ON customer_portal_tokens(shop_id,customer_id,created_at);
  `);

  // Existing installations may already have these V2 tables, so keep migrations additive.
  ensureColumn(db, 'deferred_services', 'updated_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP');

  // Existing V1 tables gain V2 fields without destructive migration.
  ensureColumn(db, 'repair_orders', 'assigned_technician_id', 'INTEGER');
  ensureColumn(db, 'repair_orders', 'workflow_status', "TEXT NOT NULL DEFAULT 'waiting'");
  ensureColumn(db, 'repair_orders', 'parts_status', "TEXT NOT NULL DEFAULT 'not_ordered'");
  ensureColumn(db, 'repair_orders', 'promised_at', 'TEXT');
  ensureColumn(db, 'repair_orders', 'internal_notes', 'TEXT');
  ensureColumn(db, 'repair_order_items', 'part_number', 'TEXT');
  ensureColumn(db, 'repair_order_items', 'parts_cost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'repair_order_items', 'labor_hours', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'repair_order_items', 'labor_cost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'repair_order_items', 'vendor_id', 'INTEGER');
  ensureColumn(db, 'vehicles', 'engine', 'TEXT');
  ensureColumn(db, 'vehicles', 'trim', 'TEXT');
  ensureColumn(db, 'vehicles', 'license_plate', 'TEXT');
  ensureColumn(db, 'vehicles', 'plate_state', 'TEXT');
  // Nullable on purpose: no foreign key yet. Required by the V2 auth JOIN (employees.shop_id = shops.id).
  ensureColumn(db, 'employees', 'shop_id', 'INTEGER');
  ensureColumn(db, 'employees', 'hourly_cost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'employees', 'permissions_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'shops', 'default_labor_rate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'shops', 'parts_markup_percent', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'shops', 'dvi_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'shops', 'customer_portal_enabled', 'INTEGER NOT NULL DEFAULT 1');

  // Runs after the column exists and inside the migration transaction.
  backfillEmployeeShopIds(db);
}

/* Deterministic, conservative backfill of employees.shop_id. Only unambiguous
 * relationships are assigned; everything else stays NULL and cannot log in until
 * explicitly assigned. Passwords, hashes, and existing assignments are never touched.
 */
function backfillEmployeeShopIds(db) {
  const unassigned = db.prepare(
    "SELECT id, email, role FROM employees WHERE shop_id IS NULL ORDER BY id"
  ).all();
  if (!unassigned.length) return;

  const shops = db.prepare('SELECT id, email FROM shops ORDER BY id').all();
  const setShop = db.prepare('UPDATE employees SET shop_id=? WHERE id=? AND shop_id IS NULL');
  const audit = db.prepare(
    "INSERT INTO audit_log (shop_id, employee_id, action, entity_type, entity_id, details) VALUES (?, ?, 'v2_schema_backfill_employee_shop', 'employee', ?, ?)"
  );
  const normalize = value => String(value || '').trim().toLowerCase();

  for (const employee of unassigned) {
    let shopId = null;
    let reason = null;

    // (a) Exactly one shop exists and the employee is an owner.
    if (shops.length === 1 && employee.role === 'owner') {
      shopId = shops[0].id;
      reason = 'single_shop_owner';
    } else {
      // (b) Employee email matches exactly one shop's email.
      const employeeEmail = normalize(employee.email);
      if (employeeEmail) {
        const matches = shops.filter(shop => normalize(shop.email) === employeeEmail);
        if (matches.length === 1) {
          shopId = matches[0].id;
          reason = 'email_match';
        }
      }
    }

    // (c) Ambiguous or unknown: leave NULL.
    if (shopId === null) {
      console.log(`[v2-schema] employee ${employee.id} left without shop_id (no unambiguous match)`);
      continue;
    }

    const result = setShop.run(shopId, employee.id);
    if (result.changes) {
      console.log(`[v2-schema] assigned employee ${employee.id} to shop ${shopId} (${reason})`);
      audit.run(shopId, employee.id, employee.id, JSON.stringify({ shop_id: shopId, reason }));
    }
  }
}

function installV2Schema(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new Error('Garavex V2 schema requires an initialized SQLite database connection.');
  }

  // V2 extends these V1 tables. Fail before opening the migration transaction if
  // the base schema is not ready.
  assertBaseSchema(db);

  // SQLite DDL is transactional. If any V2 table/index/column migration fails,
  // roll the entire V2 schema change back instead of leaving a half-migrated DB.
  db.exec('BEGIN IMMEDIATE');
  try {
    applyV2Schema(db);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw new Error(`Garavex V2 schema migration failed and was rolled back: ${err.message}`, { cause: err });
  }
}
module.exports = { installV2Schema };
