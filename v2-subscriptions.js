'use strict';

const { GARAVEX_PLANS, getPlan, shopPlan } = require('./garavex-subscription-tiers');

const SUBSCRIPTION_COLUMNS = [
  ['subscription_plan', "TEXT NOT NULL DEFAULT 'starter'"],
  ['subscription_status', "TEXT NOT NULL DEFAULT 'active'"],
  ['stripe_customer_id', 'TEXT'],
  ['stripe_subscription_id', 'TEXT'],
  ['stripe_price_id', 'TEXT'],
  ['subscription_current_period_end', 'TEXT'],
  ['subscription_cancel_at_period_end', 'INTEGER NOT NULL DEFAULT 0']
];

function installSubscriptionSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(shops)').all().map(c => c.name));
  for (const [name, definition] of SUBSCRIPTION_COLUMNS) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE shops ADD COLUMN ${name} ${definition}`);
      console.log(`[V2 SUBSCRIPTIONS] added shops.${name}`);
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shops_stripe_customer_id ON shops(stripe_customer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shops_stripe_subscription_id ON shops(stripe_subscription_id)`);
}

function getShop(db, shopId) {
  return db.prepare(`
    SELECT id, name, subscription_plan, subscription_status,
           stripe_customer_id, stripe_subscription_id, stripe_price_id,
           subscription_current_period_end, subscription_cancel_at_period_end
    FROM shops WHERE id = ? LIMIT 1
  `).get(shopId);
}

function publicPlan(plan) {
  return {
    key: plan.key,
    name: plan.name,
    employeeLimit: plan.employeeLimit,
    features: [...plan.features]
  };
}

function installV2Subscriptions(app, db, { requireLogin, requireOwner }) {
  if (!app || !db) throw new Error('V2 subscriptions require app and db.');
  installSubscriptionSchema(db);

  app.get('/api/v2/plans', (req, res) => {
    res.json({ plans: Object.values(GARAVEX_PLANS).map(publicPlan) });
  });

  app.get('/api/v2/subscription', requireLogin, (req, res) => {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    const shop = getShop(db, shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found.' });
    const plan = shopPlan(shop);
    const employeeCount = db.prepare('SELECT COUNT(*) AS count FROM employees WHERE shop_id = ? AND active = 1').get(shopId)?.count || 0;
    res.json({
      shopId,
      shopName: shop.name,
      plan: publicPlan(plan),
      status: shop.subscription_status,
      currentPeriodEnd: shop.subscription_current_period_end || null,
      cancelAtPeriodEnd: Boolean(shop.subscription_cancel_at_period_end),
      employeeCount: Number(employeeCount),
      billingConfigured: Boolean(shop.stripe_customer_id && shop.stripe_subscription_id)
    });
  });

  // Owner-only preview endpoint. It does not change billing and is intentionally
  // disabled unless GARAVEX_ALLOW_PLAN_PREVIEW=1 is set in a non-production test environment.
  app.patch('/api/v2/subscription/preview-plan', requireLogin, requireOwner, (req, res) => {
    if (process.env.GARAVEX_ALLOW_PLAN_PREVIEW !== '1') {
      return res.status(403).json({ error: 'Plan preview changes are disabled.' });
    }
    const shopId = Number(req.session?.employee?.shop_id || 0);
    const requested = String(req.body?.plan || '').trim().toLowerCase();
    if (!GARAVEX_PLANS[requested]) return res.status(400).json({ error: 'Invalid Garavex plan.' });
    db.prepare(`UPDATE shops SET subscription_plan = ?, subscription_status = 'active' WHERE id = ?`).run(requested, shopId);
    const shop = getShop(db, shopId);
    res.json({ success: true, plan: publicPlan(shopPlan(shop)) });
  });

  app.get('/api/v2/subscription/entitlement/:feature', requireLogin, (req, res) => {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    const shop = getShop(db, shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found.' });
    const plan = shopPlan(shop);
    const feature = String(req.params.feature || '').trim();
    res.json({ feature, allowed: plan.features.includes(feature), plan: plan.key });
  });

  console.log('[V2 SUBSCRIPTIONS] Starter / Professional / Elite framework installed.');
}

module.exports = { installV2Subscriptions, installSubscriptionSchema };
