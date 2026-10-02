'use strict';

const { GARAVEX_PLANS, shopPlan } = require('./garavex-subscription-tiers');

const SUBSCRIPTION_COLUMNS = [
  ['subscription_plan', "TEXT NOT NULL DEFAULT 'starter'"],
  ['subscription_status', "TEXT NOT NULL DEFAULT 'active'"],
  ['stripe_customer_id', 'TEXT'],
  ['stripe_subscription_id', 'TEXT'],
  ['stripe_price_id', 'TEXT'],
  ['subscription_current_period_end', 'TEXT'],
  ['subscription_cancel_at_period_end', 'INTEGER NOT NULL DEFAULT 0'],
  ['founding_offer_reserved_until', 'TEXT']
];

const PRICE_ENV = Object.freeze({
  starter: 'STRIPE_STARTER_PRICE_ID',
  professional: 'STRIPE_PROFESSIONAL_PRICE_ID',
  elite: 'STRIPE_ELITE_PRICE_ID'
});

function installSubscriptionSchema(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(shops)').all().map(c => c.name));
  for (const [name, definition] of SUBSCRIPTION_COLUMNS) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE shops ADD COLUMN ${name} ${definition}`);
      console.log(`[V2 SUBSCRIPTIONS] added shops.${name}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_shops_stripe_customer_id ON shops(stripe_customer_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shops_stripe_subscription_id ON shops(stripe_subscription_id)');
}

function getShop(db, shopId) {
  return db.prepare(`SELECT id,name,email,subscription_plan,subscription_status,stripe_customer_id,stripe_subscription_id,stripe_price_id,subscription_current_period_end,subscription_cancel_at_period_end,founding_offer_reserved_until FROM shops WHERE id=? LIMIT 1`).get(shopId);
}

function publicPlan(plan) {
  return { key: plan.key, name: plan.name, employeeLimit: plan.employeeLimit, features: [...plan.features] };
}

function configuredPrice(planKey) {
  const envName = PRICE_ENV[planKey];
  return envName ? String(process.env[envName] || '').trim() : '';
}

function foundingPrice() {
  return String(process.env.STRIPE_FOUNDING_STARTER_PRICE_ID || '').trim();
}

function foundingLimit() {
  const n = Number(process.env.GARAVEX_FOUNDING_SHOP_LIMIT || 10);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

function foundingSoldCount(db) {
  const price = foundingPrice();
  if (!price) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM shops WHERE stripe_price_id=? AND stripe_subscription_id IS NOT NULL AND TRIM(stripe_subscription_id)!=''`).get(price)?.count || 0);
}

function foundingClaimedCount(db) {
  const price = foundingPrice();
  if (!price) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM shops WHERE (stripe_price_id=? AND stripe_subscription_id IS NOT NULL AND TRIM(stripe_subscription_id)!='') OR (founding_offer_reserved_until IS NOT NULL AND founding_offer_reserved_until > datetime('now'))`).get(price)?.count || 0);
}

function starterOffer(db) {
  const sold = foundingSoldCount(db);
  const claimed = foundingClaimedCount(db);
  const limit = foundingLimit();
  const foundingAvailable = Boolean(foundingPrice()) && claimed < limit;
  return {
    foundingAvailable,
    foundingSold: sold,
    foundingReserved: Math.max(0, claimed - sold),
    foundingLimit: limit,
    monthlyPrice: foundingAvailable ? 99 : 149,
    offer: foundingAvailable ? 'founding' : 'standard'
  };
}

function reserveFoundingOffer(db, shopId) {
  const price = foundingPrice();
  if (!price) return false;
  const claim = db.transaction(() => {
    const shop = getShop(db, shopId);
    if (!shop) return false;
    if (shop.stripe_price_id === price && shop.stripe_subscription_id) return true;
    if (shop.founding_offer_reserved_until && new Date(shop.founding_offer_reserved_until.replace(' ', 'T') + 'Z').getTime() > Date.now()) return true;
    if (foundingClaimedCount(db) >= foundingLimit()) return false;
    db.prepare(`UPDATE shops SET founding_offer_reserved_until=datetime('now','+24 hours') WHERE id=?`).run(shopId);
    return true;
  });
  return claim.immediate();
}

function releaseFoundingOffer(db, shopId) {
  db.prepare("UPDATE shops SET founding_offer_reserved_until=NULL WHERE id=? AND (stripe_subscription_id IS NULL OR TRIM(stripe_subscription_id)='')").run(shopId);
}

function safeAppOrigin(req) {
  const configured = String(process.env.GARAVEX_APP_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function isMissingStripeCustomer(err) {
  const code = String(err?.code || err?.raw?.code || '').toLowerCase();
  const param = String(err?.param || err?.raw?.param || '').toLowerCase();
  const message = String(err?.message || err?.raw?.message || '').toLowerCase();
  return code === 'resource_missing' && (param === 'customer' || message.includes('no such customer')) || message.includes('no such customer');
}

async function createStripeCustomer(stripe, db, shop, shopId) {
  const customer = await stripe.customers.create({
    name: shop.name,
    email: shop.email || undefined,
    metadata: { garavex_shop_id: String(shopId) }
  });
  db.prepare('UPDATE shops SET stripe_customer_id=? WHERE id=?').run(customer.id, shopId);
  console.log('[V2 SUBSCRIPTIONS] Stripe customer created/repaired', { shopId, customerId: customer.id });
  return customer.id;
}

async function ensureStripeCustomer(stripe, db, shop, shopId) {
  let customerId = String(shop.stripe_customer_id || '').trim();
  if (!customerId) return createStripeCustomer(stripe, db, shop, shopId);

  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer || customer.deleted) {
      return createStripeCustomer(stripe, db, shop, shopId);
    }
    return customerId;
  } catch (err) {
    if (!isMissingStripeCustomer(err)) throw err;
    console.warn('[V2 SUBSCRIPTIONS] stale Stripe customer ID detected; creating replacement', { shopId, staleCustomerId: customerId });
    return createStripeCustomer(stripe, db, shop, shopId);
  }
}

function ownerTestPlanEnabled() {
  return String(process.env.GARAVEX_OWNER_TEST_PLAN_ENABLED || '').trim() === '1';
}

function ownerTestShopId() {
  const n = Number(process.env.GARAVEX_OWNER_TEST_SHOP_ID || 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function isOwnerTestShop(shopId) {
  return ownerTestPlanEnabled() && ownerTestShopId() === Number(shopId);
}

function installV2Subscriptions(app, db, { requireLogin, requireOwner, stripe }) {
  if (!app || !db) throw new Error('V2 subscriptions require app and db.');
  installSubscriptionSchema(db);

  app.get('/api/v2/plans', (req, res) => {
    const starter = starterOffer(db);
    res.json({ plans: Object.values(GARAVEX_PLANS).map(plan => ({ ...publicPlan(plan), billingAvailable: Boolean(configuredPrice(plan.key)), ...(plan.key === 'starter' ? { starterOffer: starter } : {}) })) });
  });

  app.get('/api/v2/subscription', requireLogin, (req, res) => {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    const shop = getShop(db, shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found.' });
    const plan = shopPlan(shop);
    const employeeCount = db.prepare('SELECT COUNT(*) AS count FROM employees WHERE shop_id=? AND active=1').get(shopId)?.count || 0;
    res.json({ shopId, shopName: shop.name, plan: publicPlan(plan), status: shop.subscription_status, currentPeriodEnd: shop.subscription_current_period_end || null, cancelAtPeriodEnd: Boolean(shop.subscription_cancel_at_period_end), employeeCount: Number(employeeCount), billingConfigured: Boolean(shop.stripe_customer_id && shop.stripe_subscription_id), ownerTestPlan: isOwnerTestShop(shopId), starterOffer: starterOffer(db) });
  });

  app.post('/api/v2/subscription/checkout', requireLogin, requireOwner, async (req, res) => {
    let foundingReserved = false;
    const shopId = Number(req.session?.employee?.shop_id || 0);
    try {
      if (!stripe) return res.status(503).json({ error: 'Stripe billing is not configured.' });
      const planKey = String(req.body?.plan || '').trim().toLowerCase();
      if (!GARAVEX_PLANS[planKey]) return res.status(400).json({ error: 'Invalid Garavex plan.' });
      const shop = getShop(db, shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });
      if (isOwnerTestShop(shopId)) {
        return res.status(409).json({
          error: 'Owner test shop uses plan preview and is not billed through Stripe.',
          ownerTestPlan: true,
          usePreviewPlan: true
        });
      }
      if (shop.stripe_subscription_id) return res.status(409).json({ error: 'This shop already has a subscription. Use Manage Billing to change plans.' });

      let price = configuredPrice(planKey);
      let offer = 'standard';
      if (planKey === 'starter' && reserveFoundingOffer(db, shopId)) {
        foundingReserved = true;
        price = foundingPrice();
        offer = 'founding';
      }
      if (!price) {
        if (foundingReserved) releaseFoundingOffer(db, shopId);
        return res.status(503).json({ error: `${GARAVEX_PLANS[planKey].name} billing is not configured yet.` });
      }

      const customerId = await ensureStripeCustomer(stripe, db, shop, shopId);
      const origin = safeAppOrigin(req);
      const metadata = { garavex_shop_id: String(shopId), garavex_plan: planKey, garavex_offer: offer };
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price, quantity: 1 }],
        success_url: `${origin}/v2-plans.html?checkout=success`,
        cancel_url: `${origin}/v2-plans.html?checkout=cancelled`,
        client_reference_id: String(shopId),
        subscription_data: { metadata },
        metadata
      });
      res.json({ url: session.url, offer, plan: planKey });
    } catch (err) {
      if (foundingReserved && shopId) releaseFoundingOffer(db, shopId);
      console.error('[V2 SUBSCRIPTIONS] checkout error:', err);
      res.status(500).json({ error: 'Unable to start subscription checkout.' });
    }
  });

  app.post('/api/v2/subscription/portal', requireLogin, requireOwner, async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: 'Stripe billing is not configured.' });
      const shopId = Number(req.session?.employee?.shop_id || 0);
      const shop = getShop(db, shopId);
      if (!shop?.stripe_customer_id) return res.status(400).json({ error: 'This shop does not have a Stripe billing account yet.' });
      const customerId = await ensureStripeCustomer(stripe, db, shop, shopId);
      const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${safeAppOrigin(req)}/v2-plans.html` });
      res.json({ url: session.url });
    } catch (err) {
      console.error('[V2 SUBSCRIPTIONS] portal error:', err);
      res.status(500).json({ error: 'Unable to open billing management.' });
    }
  });

  app.patch('/api/v2/subscription/preview-plan', requireLogin, requireOwner, (req, res) => {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    const ownerTest = isOwnerTestShop(shopId);
    if (!ownerTest && process.env.GARAVEX_ALLOW_PLAN_PREVIEW !== '1') return res.status(403).json({ error: 'Plan preview changes are disabled.' });
    const requested = String(req.body?.plan || '').trim().toLowerCase();
    if (!GARAVEX_PLANS[requested]) return res.status(400).json({ error: 'Invalid Garavex plan.' });
    db.prepare("UPDATE shops SET subscription_plan=?,subscription_status='active' WHERE id=?").run(requested, shopId);
    res.json({ success: true, plan: publicPlan(shopPlan(getShop(db, shopId))), ownerTestPlan: ownerTest });
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

module.exports = { installV2Subscriptions, installSubscriptionSchema, configuredPrice, starterOffer };
