'use strict';

const { GARAVEX_PLANS } = require('./garavex-subscription-tiers');

function isoFromUnix(value) {
  const n = Number(value || 0);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

function planFromPrice(priceId) {
  const value = String(priceId || '');
  for (const [plan, env] of Object.entries({ starter:'STRIPE_STARTER_PRICE_ID', professional:'STRIPE_PROFESSIONAL_PRICE_ID', elite:'STRIPE_ELITE_PRICE_ID' })) {
    if (value && value === String(process.env[env] || '')) return plan;
  }
  return null;
}

function findShop(db, object) {
  const metadata = object?.metadata || {};
  const shopId = Number(metadata.garavex_shop_id || object?.client_reference_id || 0);
  if (shopId) return db.prepare('SELECT id FROM shops WHERE id=? LIMIT 1').get(shopId);
  const subscriptionId = typeof object?.subscription === 'string' ? object.subscription : object?.id?.startsWith?.('sub_') ? object.id : '';
  if (subscriptionId) {
    const row = db.prepare('SELECT id FROM shops WHERE stripe_subscription_id=? LIMIT 1').get(subscriptionId);
    if (row) return row;
  }
  const customerId = typeof object?.customer === 'string' ? object.customer : '';
  if (customerId) return db.prepare('SELECT id FROM shops WHERE stripe_customer_id=? LIMIT 1').get(customerId);
  return null;
}

function applySubscription(db, sub) {
  const shop = findShop(db, sub);
  if (!shop) return { handled:false, reason:'shop not found' };
  const priceId = sub?.items?.data?.[0]?.price?.id || '';
  const metadataPlan = String(sub?.metadata?.garavex_plan || '').toLowerCase();
  const plan = GARAVEX_PLANS[metadataPlan] ? metadataPlan : (planFromPrice(priceId) || 'starter');
  db.prepare(`UPDATE shops SET subscription_plan=?,subscription_status=?,stripe_customer_id=COALESCE(?,stripe_customer_id),stripe_subscription_id=?,stripe_price_id=?,subscription_current_period_end=?,subscription_cancel_at_period_end=? WHERE id=?`).run(
    plan,
    String(sub.status || 'inactive'),
    typeof sub.customer === 'string' ? sub.customer : null,
    String(sub.id || ''),
    priceId || null,
    isoFromUnix(sub.current_period_end),
    sub.cancel_at_period_end ? 1 : 0,
    shop.id
  );
  return { handled:true, shopId:shop.id, plan, status:String(sub.status || '') };
}

function handleGaravexSubscriptionEvent(db, event) {
  const type = String(event?.type || '');
  const object = event?.data?.object || {};

  if (type === 'customer.subscription.created' || type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    return applySubscription(db, object);
  }

  if (type === 'checkout.session.completed' && object.mode === 'subscription') {
    const shop = findShop(db, object);
    if (!shop) return { handled:false, reason:'shop not found' };
    const planKey = String(object.metadata?.garavex_plan || '').toLowerCase();
    const plan = GARAVEX_PLANS[planKey] ? planKey : 'starter';
    db.prepare(`UPDATE shops SET subscription_plan=?,subscription_status='active',stripe_customer_id=COALESCE(?,stripe_customer_id),stripe_subscription_id=COALESCE(?,stripe_subscription_id) WHERE id=?`).run(
      plan,
      typeof object.customer === 'string' ? object.customer : null,
      typeof object.subscription === 'string' ? object.subscription : null,
      shop.id
    );
    return { handled:true, shopId:shop.id, plan, status:'active' };
  }

  if (type === 'invoice.payment_failed' || type === 'invoice.paid') {
    const shop = findShop(db, object);
    if (!shop) return { handled:false, reason:'shop not found' };
    if (type === 'invoice.payment_failed') db.prepare(`UPDATE shops SET subscription_status='past_due' WHERE id=?`).run(shop.id);
    // invoice.paid does not force a plan; subscription.updated is authoritative.
    return { handled:true, shopId:shop.id, status:type === 'invoice.payment_failed' ? 'past_due' : 'paid' };
  }

  return { handled:false, reason:'not a Garavex subscription event' };
}

module.exports = { handleGaravexSubscriptionEvent, planFromPrice };
