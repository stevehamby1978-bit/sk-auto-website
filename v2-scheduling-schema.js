'use strict';

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columns(db, name) {
  return tableExists(db, name) ? db.prepare(`PRAGMA table_info(${name})`).all() : [];
}
function tableSql(db, name) {
  return String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql || '');
}
function primaryShopId(db) {
  if (!tableExists(db, 'shops')) return null;
  return db.prepare("SELECT id FROM shops WHERE slug='sk-auto' ORDER BY id LIMIT 1").get()?.id ||
    db.prepare('SELECT id FROM shops ORDER BY id LIMIT 1').get()?.id || null;
}

function migrateBookings(db, fallbackShopId) {
  if (!tableExists(db, 'bookings')) return;
  const names = new Set(columns(db, 'bookings').map(c => c.name));
  const sql = tableSql(db, 'bookings');
  const hasGlobalSlotUnique = /UNIQUE\s*\(\s*date\s*,\s*time\s*\)/i.test(sql);
  const needsRebuild = !names.has('shop_id') || hasGlobalSlotUnique;
  if (!needsRebuild) {
    if (fallbackShopId) db.prepare('UPDATE bookings SET shop_id=? WHERE shop_id IS NULL').run(fallbackShopId);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_shop_date_time ON bookings(shop_id,date,time) WHERE shop_id IS NOT NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_shop_date ON bookings(shop_id,date)');
    return;
  }

  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE bookings_v2_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          confirmation TEXT NOT NULL UNIQUE,
          service TEXT NOT NULL,
          vehicle TEXT NOT NULL,
          date TEXT NOT NULL,
          time TEXT NOT NULL,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          email TEXT,
          notes TEXT,
          reminder_sent INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          status TEXT NOT NULL DEFAULT 'scheduled',
          shop_id INTEGER NOT NULL
        )
      `);
      const shopExpr = names.has('shop_id')
        ? `COALESCE(shop_id, ${Number(fallbackShopId || 0)})`
        : String(Number(fallbackShopId || 0));
      if (!fallbackShopId) throw new Error('Primary shop is required before scheduling migration.');
      const reminderExpr = names.has('reminder_sent') ? 'reminder_sent' : '0';
      const createdExpr = names.has('created_at') ? 'created_at' : 'CURRENT_TIMESTAMP';
      const statusExpr = names.has('status') ? 'status' : "'scheduled'";
      db.exec(`
        INSERT INTO bookings_v2_new
          (id,confirmation,service,vehicle,date,time,name,phone,email,notes,reminder_sent,created_at,status,shop_id)
        SELECT id,confirmation,service,vehicle,date,time,name,phone,email,notes,
               ${reminderExpr},${createdExpr},${statusExpr},${shopExpr}
        FROM bookings
      `);
      db.exec('DROP TABLE bookings');
      db.exec('ALTER TABLE bookings_v2_new RENAME TO bookings');
      db.exec('CREATE UNIQUE INDEX idx_bookings_shop_date_time ON bookings(shop_id,date,time)');
      db.exec('CREATE INDEX idx_bookings_shop_date ON bookings(shop_id,date)');
    })();
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}

function migrateBlockedDates(db, fallbackShopId) {
  if (!tableExists(db, 'blocked_dates')) return;
  const names = new Set(columns(db, 'blocked_dates').map(c => c.name));
  const sql = tableSql(db, 'blocked_dates');
  const needsRebuild = !names.has('shop_id') || /date\s+TEXT\s+PRIMARY\s+KEY/i.test(sql);
  if (!needsRebuild) return;
  if (!fallbackShopId) throw new Error('Primary shop is required before blocked-date migration.');
  db.transaction(() => {
    db.exec(`CREATE TABLE blocked_dates_v2_new (shop_id INTEGER NOT NULL, date TEXT NOT NULL, reason TEXT DEFAULT '', PRIMARY KEY(shop_id,date))`);
    const shopExpr = names.has('shop_id') ? `COALESCE(shop_id, ${Number(fallbackShopId)})` : String(Number(fallbackShopId));
    db.exec(`INSERT OR IGNORE INTO blocked_dates_v2_new(shop_id,date,reason) SELECT ${shopExpr},date,COALESCE(reason,'') FROM blocked_dates`);
    db.exec('DROP TABLE blocked_dates');
    db.exec('ALTER TABLE blocked_dates_v2_new RENAME TO blocked_dates');
  })();
}

function migrateBlockedTimes(db, fallbackShopId) {
  if (!tableExists(db, 'blocked_times')) return;
  const names = new Set(columns(db, 'blocked_times').map(c => c.name));
  const sql = tableSql(db, 'blocked_times');
  const needsRebuild = !names.has('shop_id') || /PRIMARY\s+KEY\s*\(\s*date\s*,\s*time\s*\)/i.test(sql);
  if (!needsRebuild) return;
  if (!fallbackShopId) throw new Error('Primary shop is required before blocked-time migration.');
  db.transaction(() => {
    db.exec(`CREATE TABLE blocked_times_v2_new (shop_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, reason TEXT DEFAULT '', PRIMARY KEY(shop_id,date,time))`);
    const shopExpr = names.has('shop_id') ? `COALESCE(shop_id, ${Number(fallbackShopId)})` : String(Number(fallbackShopId));
    db.exec(`INSERT OR IGNORE INTO blocked_times_v2_new(shop_id,date,time,reason) SELECT ${shopExpr},date,time,COALESCE(reason,'') FROM blocked_times`);
    db.exec('DROP TABLE blocked_times');
    db.exec('ALTER TABLE blocked_times_v2_new RENAME TO blocked_times');
  })();
}

function installV2SchedulingSchema(db) {
  const fallbackShopId = primaryShopId(db);
  migrateBookings(db, fallbackShopId);
  migrateBlockedDates(db, fallbackShopId);
  migrateBlockedTimes(db, fallbackShopId);
  console.log('Garavex V2 tenant scheduling schema verified.');
}

module.exports = { installV2SchedulingSchema };
