'use strict';

/*
 * Garavex V2 owner setup.
 *
 * Idempotent bootstrap that guarantees each configured shop exists and has an
 * active owner employee that can sign in through the V2 auth preload.
 *
 * - Shops are matched by slug (unique) and created when missing.
 * - Owners are matched by email (unique). An existing employee is never
 *   re-hashed, re-assigned to another shop, or otherwise modified, except that
 *   an owner of the same shop with an empty password hash receives one.
 * - Plaintext passwords and password hashes are never logged or returned.
 * - Customer, appointment, invoice and payment data is never touched.
 */
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const BCRYPT_COST = 12;

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Matches the slug server.js assigns to the primary shop.
function shopSlug(name) {
  return name === 'S&K Auto' ? 'sk-auto' : slugify(name);
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}

function setupShop(db, config) {
  const result = { shop: config.shopName, shopStatus: 'skipped', ownerStatus: 'skipped', status: 'skipped' };
  const shopName = String(config.shopName || '').trim();
  const email = String(config.ownerEmail || '').trim().toLowerCase();
  const password = typeof config.ownerPassword === 'string' ? config.ownerPassword : '';

  if (!shopName || !email || !password) {
    result.status = 'skipped: missing shop name, owner email or owner password';
    return result;
  }

  const slug = shopSlug(shopName);

  const run = db.transaction(() => {
    // Shop: create if missing, otherwise align name/active.
    const insertShop = db.prepare('INSERT OR IGNORE INTO shops (name, slug, active) VALUES (?, ?, 1)').run(shopName, slug);
    const shop = db.prepare('SELECT id, name, active FROM shops WHERE slug = ?').get(slug);
    if (!shop) throw new Error('shop lookup failed');

    if (insertShop.changes > 0) {
      result.shopStatus = 'created';
    } else if (shop.name !== shopName || !shop.active) {
      db.prepare('UPDATE shops SET name = ?, active = 1 WHERE id = ?').run(shopName, shop.id);
      result.shopStatus = 'updated';
    } else {
      result.shopStatus = 'exists';
    }

    // Owner: only hash when an insert is actually needed.
    const existing = db.prepare('SELECT id, shop_id, role, active, password_hash FROM employees WHERE LOWER(email) = ?').get(email);
    if (!existing) {
      const hash = bcrypt.hashSync(password, BCRYPT_COST);
      db.prepare(`
        INSERT OR IGNORE INTO employees (name, email, password_hash, role, active, shop_id, must_change_password)
        VALUES (?, ?, ?, 'owner', 1, ?, 0)
      `).run(`${shopName} Owner`, email, hash, shop.id);
      result.ownerStatus = 'created';
      result.status = 'ok';
      return;
    }

    if (existing.shop_id !== shop.id) {
      result.ownerStatus = 'conflict: email belongs to a different shop (left unchanged)';
      result.status = 'conflict';
      return;
    }

    if (!existing.password_hash) {
      db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, BCRYPT_COST), existing.id);
      result.ownerStatus = 'exists (password initialized)';
    } else {
      result.ownerStatus = 'exists';
    }
    if (existing.role !== 'owner' || !existing.active) {
      db.prepare("UPDATE employees SET role = 'owner', active = 1 WHERE id = ?").run(existing.id);
      result.ownerStatus += ' (role/active corrected)';
    }
    result.status = 'ok';
  });

  try {
    run();
  } catch (err) {
    // Never include config values in the message.
    result.status = `error: ${err && err.code ? err.code : 'setup failed'}`;
  }
  return result;
}

/**
 * @param {Array<{shopName: string, ownerEmail: string, ownerPassword: string}>} shopConfigs
 * @param {{dataDir?: string}} [options]
 * @returns {Array<object>} per-shop results containing no secrets
 */
function setupOwners(shopConfigs, options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const db = new Database(path.join(dataDir, 'bookings.db'));
  try {
    db.pragma('busy_timeout = 5000');

    const shopCols = columnsOf(db, 'shops');
    const empCols = columnsOf(db, 'employees');
    const ready = shopCols.has('slug') && empCols.has('shop_id') && empCols.has('must_change_password');
    if (!ready) {
      return shopConfigs.map(c => ({
        shop: c.shopName,
        shopStatus: 'skipped',
        ownerStatus: 'skipped',
        status: 'skipped: schema not initialized yet (start the server once, then redeploy)'
      }));
    }

    return shopConfigs.map(c => setupShop(db, c));
  } finally {
    db.close();
  }
}

module.exports = { setupOwners };
