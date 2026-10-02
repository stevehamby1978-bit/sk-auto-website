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
      'dvi', 'inventory', 'technician_workflow', 'recommended_repairs',
      'customer_approvals', 'sms', 'reports', 'deferred_services'
    ])
  }),
  elite: Object.freeze({
    key: 'elite',
    name: 'Garavex Elite',
    employeeLimit: null,
    features: Object.freeze([
      'customers', 'vehicles', 'appointments', 'estimates',
      'repair_orders', 'invoices', 'payments', 'service_history',
      'dvi', 'inventory', 'technician_workflow', 'recommended_repairs',
      'customer_approvals', 'sms', 'reports', 'deferred_services',
      'quickbooks', 'loaners', 'advanced_reporting', 'profitability',
      'advanced_workflow', 'warranty_comebacks', 'automation'
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

function ownerTestShop(shop) {
  const enabled = String(process.env.GARAVEX_OWNER_TEST_PLAN_ENABLED || '').trim() === '1';
  const testShopId = Number(process.env.GARAVEX_OWNER_TEST_SHOP_ID || 0);
  return enabled && Number.isInteger(testShopId) && testShopId > 0 && Number(shop?.id || 0) === testShopId;
}

function shopPlan(shop) {
  if (!shop) return getPlan('starter');

  // The single explicitly configured owner/beta shop may preview plans without Stripe.
  if (ownerTestShop(shop)) return getPlan(shop.subscription_plan);

  // Paid tiers are never granted to ordinary shops from a database plan value alone.
  // A real Stripe subscription must exist and be in an active/trialing state.
  if (!shop.stripe_subscription_id || !subscriptionIsActive(shop.subscription_status)) {
    return getPlan('starter');
  }
  return getPlan(shop.subscription_plan);
}

function shopHasFeature(shop, feature) {
  return shopPlan(shop).features.includes(String(feature || '').trim());
}

function requireFeature(db, feature) {
  return (req, res, next) => {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    if (!shopId) return res.status(401).json({ error: 'Login required.' });
    const shop = db.prepare(`
      SELECT id, subscription_plan, subscription_status,
             stripe_subscription_id, subscription_current_period_end
      FROM shops WHERE id = ? LIMIT 1
    `).get(shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found.' });
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
  subscriptionIsActive
};
