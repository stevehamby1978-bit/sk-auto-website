'use strict';

const { requireFeature } = require('./garavex-subscription-tiers');

/*
 * Installs server-side plan gates before the V2 feature routers are registered.
 * Express executes these middleware handlers before the matching module route.
 * Core Starter functionality is intentionally not gated here because every plan
 * includes it. Premium capabilities cannot be reached by typing the API URL.
 */
function installV2FeatureGates(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 feature gates require app and db.');
  const gate = feature => [requireLogin, requireFeature(db, feature)];

  // Professional+
  app.use('/api/v2/dvi', ...gate('dvi'));
  app.use('/api/v2/inventory', ...gate('inventory'));
  app.use('/api/v2/deferred', ...gate('deferred_services'));
  app.use('/api/v2/followups', ...gate('deferred_services'));
  app.use('/api/v2/communications', ...gate('sms'));
  app.use('/api/v2/reports', ...gate('reports'));

  // Elite
  app.use('/api/v2/loaners', ...gate('loaners'));
  app.use('/api/v2/comebacks', ...gate('warranty_comebacks'));
  app.use('/api/v2/warranty', ...gate('warranty_comebacks'));
  app.use('/api/v2/dispatch', ...gate('advanced_workflow'));
  app.use('/api/v2/profitability', ...gate('profitability'));

  console.log('[V2 SUBSCRIPTIONS] premium API feature gates installed.');
}

module.exports = { installV2FeatureGates };
