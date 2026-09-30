/* Garavex V2 database foundation.
 * Additive migrations only: this module does not remove or rename V1 tables/columns.
 */
function ensureColumn(db, table, name, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function installV2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dvi_inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      repair_order_id INTEGER,
      customer_id INTEGER,
      vehicle_id INTEGER,
      technician_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      public_token TEXT UNIQUE,
      customer_notes TEXT,
      sent_at TEXT,
      viewed_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_dvi_shop ON dvi_inspections(shop_id);
    CREATE INDEX IF NOT EXISTS idx_dvi_ro ON dvi_inspections(repair_order_id);

    CREATE TABLE IF NOT EXISTS dvi_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      inspection_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      item_name TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'green',
      notes TEXT,
      recommendation TEXT,
      parts REAL NOT NULL DEFAULT 0,
      labor REAL NOT NULL DEFAULT 0,
      customer_decision TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(inspection_id) REFERENCES dvi_inspections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dvi_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      inspection_id INTEGER NOT NULL,
      item_id INTEGER,
      filename TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      media_type TEXT NOT NULL DEFAULT 'photo',
      caption TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS technician_time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      repair_order_id INTEGER,
      repair_order_item_id INTEGER,
      clock_in TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      clock_out TEXT,
      minutes INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_time_shop_employee ON technician_time_entries(shop_id, employee_id);

    CREATE TABLE IF NOT EXISTS deferred_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      repair_order_id INTEGER,
      dvi_item_id INTEGER,
      description TEXT NOT NULL,
      estimated_total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'deferred',
      follow_up_date TEXT,
      last_reminder_at TEXT,
      reminder_count INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_deferred_shop_status ON deferred_services(shop_id, status);

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      account_number TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      vendor_id INTEGER,
      sku TEXT,
      part_number TEXT,
      description TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      sell_price REAL NOT NULL DEFAULT 0,
      location TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_shop ON inventory_items(shop_id);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      vendor_id INTEGER,
      repair_order_id INTEGER,
      po_number TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      ordered_at TEXT,
      received_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      purchase_order_id INTEGER NOT NULL,
      inventory_item_id INTEGER,
      part_number TEXT,
      description TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit_cost REAL NOT NULL DEFAULT 0,
      received_quantity REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS canned_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      labor_hours REAL NOT NULL DEFAULT 0,
      labor_rate REAL,
      parts_price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      employee_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_shop_created ON audit_log(shop_id, created_at);

    CREATE TABLE IF NOT EXISTS customer_portal_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

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

  ensureColumn(db, 'employees', 'hourly_cost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'employees', 'permissions_json', "TEXT NOT NULL DEFAULT '{}'");

  ensureColumn(db, 'shops', 'default_labor_rate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'shops', 'parts_markup_percent', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'shops', 'dvi_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'shops', 'customer_portal_enabled', 'INTEGER NOT NULL DEFAULT 1');
}

module.exports = { installV2Schema };
