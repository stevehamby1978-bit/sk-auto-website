/* Garavex V2 subscription tier framework.
 * Server-side helpers only: no billing is activated until Stripe price IDs are configured.
 */
const GARAVEX_PLANS = Object.freeze({
  starter: Object.freeze({
    key: 'starter',
    name: 'Garavex Starter',
    employeeLimit: 2,
    features: Object.freeze([
      'customers', 'vehicles', 'appointments', 'estimates',
      'repair_orders', 'invoices', 'payments', 'service_history'
    ])
  }),
  professional: Object.freeze({
    key: 'professional',
    name: 'Garavex Professional',
    employeeLimit: 8,
    features: Object.freeze([
      'customers', 'vehicles', 'appointments', 'estimates',
      'repair_orders', 'invoices', 'payments', 'service_history',
      'dvi', 'inventory', 'recommended_repairs',
      'sms', 'reports', 'deferred_services'
    ])
  }),
  elite: Object.freeze({
    key: 'elite',
    name: 'Garavex Elite',
    employeeLimit: null,
    features: Object.freeze([
      'customers', 'vehicles', 'appointments', 'estimates',
      'repair_orders', 'invoices', 'payments', 'service_history',
      'dvi', 'inventory', 'recommended_repairs',
      'sms', 'reports', 'deferred_services',
      'loaners', 'profitability',
      'advanced_workflow', 'warranty_comebacks'
    ])
  })
});

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

function normalizePlan(plan) {
  const key = String(plan || '').trim().toLowerCase();
  return GARAVEX_PLANS[key] ? key : 'starter';
}

function getPlan(plan) {
  return GARAVEX_PLANS[normalizePlan(plan)];
}

function subscriptionIsActive(status) {
  return ACTIVE_SUBSCRIPTION_STATUSES.has(String(status || '').trim().toLowerCase());
}

function trialIsActive(shop) {
  if (!shop || shop.stripe_subscription_id) return false;
  const status = String(shop.subscription_status || '').trim().toLowerCase();
  if (status !== 'trialing' || !shop.trial_ends_at) return false;
  const end = Date.parse(String(shop.trial_ends_at).replace(' ', 'T') + (String(shop.trial_ends_at).includes('Z') ? '' : 'Z'));
  return Number.isFinite(end) && end > Date.now();
}

function ownerTestShop(shop) {
  // Shops explicitly promoted to permanent Elite beta access remain active
  // independently of the optional owner-test environment flag.
  if (String(shop?.subscription_status || '').trim().toLowerCase() === 'beta'
      && normalizePlan(shop?.subscription_plan) === 'elite') {
    return true;
  }

  const enabled = String(process.env.GARAVEX_OWNER_TEST_PLAN_ENABLED || '').trim() === '1';
  if (!enabled) return false;

  const configuredIds = [
    process.env.GARAVEX_OWNER_TEST_SHOP_ID,
    ...(String(process.env.GARAVEX_OWNER_TEST_SHOP_IDS || '').split(','))
  ]
    .map(value => Number(String(value || '').trim()))
    .filter(id => Number.isInteger(id) && id > 0);

  if (configuredIds.includes(Number(shop?.id || 0))) return true;

  // Beta shops promoted by the startup bootstrap are intentionally permanent
  // Elite accounts. Ordinary paid shops still require a Stripe subscription.
  return String(shop?.subscription_status || '').trim().toLowerCase() === 'beta'
    && normalizePlan(shop?.subscription_plan) === 'elite';
}

function shopPlan(shop) {
  if (!shop) return getPlan('starter');

  // Explicitly configured owner/beta shops may use their assigned plan without Stripe.
  if (ownerTestShop(shop)) return getPlan(shop.subscription_plan);

  // A new ordinary shop receives the plan it selected during its server-recorded 30-day trial.
  // Registration validates the stored plan against GARAVEX_PLANS before saving it.
  if (trialIsActive(shop)) return getPlan(shop.subscription_plan);

  // Paid tiers are never granted to ordinary shops from a database plan value alone.
  if (!shop.stripe_subscription_id || !subscriptionIsActive(shop.subscription_status)) return getPlan('starter');
  return getPlan(shop.subscription_plan);
}

function shopAccessActive(shop) {
  if (!shop) return false;
  if (ownerTestShop(shop)) return true;
  if (trialIsActive(shop)) return true;
  return Boolean(shop.stripe_subscription_id) && subscriptionIsActive(shop.subscription_status);
}

function shopHasFeature(shop, feature) {
  return shopAccessActive(shop) && shopPlan(shop).features.includes(String(feature || '').trim());
}

function requireFeature(db, feature) {
  return (req, res, next) => {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    if (!shopId) return res.status(401).json({ error: 'Login required.' });
    const shop = db.prepare(`
      SELECT id, subscription_plan, subscription_status,
             stripe_subscription_id, subscription_current_period_end, trial_ends_at
      FROM shops WHERE id = ? LIMIT 1
    `).get(shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found.' });
    if (!shopAccessActive(shop)) {
      return res.status(402).json({
        error: 'Your Garavex trial has ended or the subscription is inactive. Choose a plan to continue.',
        code: 'SUBSCRIPTION_REQUIRED'
      });
    }
    if (!shopHasFeature(shop, feature)) {
      return res.status(403).json({
        error: 'This feature is not included in the current Garavex plan.',
        code: 'PLAN_UPGRADE_REQUIRED',
        feature,
        plan: shopPlan(shop).key
      });
    }
    req.garavexPlan = shopPlan(shop);
    next();
  };
}

function getEmployeeLimit(shop) {
  return shopPlan(shop).employeeLimit;
}

module.exports = {
  GARAVEX_PLANS,
  normalizePlan,
  getPlan,
  shopPlan,
  shopHasFeature,
  requireFeature,
  getEmployeeLimit,
  subscriptionIsActive,
  trialIsActive,
  shopAccessActive,
  ownerTestShop
};
