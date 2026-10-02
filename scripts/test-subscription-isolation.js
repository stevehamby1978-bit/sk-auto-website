'use strict';

/* In-memory regression test for Garavex subscription tenant isolation.
 * This never opens or mutates the Railway production/staging database.
 */
const Database = require('better-sqlite3');
const { handleGaravexSubscriptionEvent } = require('../v2-subscription-webhook');
const { shopPlan, shopHasFeature } = require('../garavex-subscription-tiers');

function assert(condition, message) { if (!condition) throw new Error(message); }
const db = new Database(':memory:');
db.exec(`CREATE TABLE shops (
 id INTEGER PRIMARY KEY, name TEXT, subscription_plan TEXT NOT NULL DEFAULT 'starter',
 subscription_status TEXT NOT NULL DEFAULT 'active', stripe_customer_id TEXT,
 stripe_subscription_id TEXT, stripe_price_id TEXT, subscription_current_period_end TEXT,
 subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0
);`);
db.prepare('INSERT INTO shops(id,name,subscription_plan,subscription_status,stripe_customer_id,stripe_subscription_id) VALUES(?,?,?,?,?,?)').run(1,'S&K Auto','starter','active','cus_sk','sub_sk');
db.prepare('INSERT INTO shops(id,name,subscription_plan,subscription_status,stripe_customer_id,stripe_subscription_id) VALUES(?,?,?,?,?,?)').run(2,'ZwicklRepair','starter','active','cus_zw','sub_zw');
process.env.STRIPE_PROFESSIONAL_PRICE_ID='price_prof_test';
process.env.STRIPE_ELITE_PRICE_ID='price_elite_test';

handleGaravexSubscriptionEvent(db,{type:'customer.subscription.updated',data:{object:{id:'sub_sk',customer:'cus_sk',status:'active',items:{data:[{price:{id:'price_elite_test'}}]},metadata:{garavex_shop_id:'1',garavex_plan:'elite'},current_period_end:1893456000,cancel_at_period_end:false}}});
let sk=db.prepare('SELECT * FROM shops WHERE id=1').get();
let zw=db.prepare('SELECT * FROM shops WHERE id=2').get();
assert(sk.subscription_plan==='elite','S&K should become Elite');
assert(zw.subscription_plan==='starter','Zwickl must remain Starter');
assert(shopHasFeature(sk,'loaners')===true,'Elite should include loaners');
assert(shopHasFeature(zw,'loaners')===false,'Starter must not include loaners');

handleGaravexSubscriptionEvent(db,{type:'customer.subscription.updated',data:{object:{id:'sub_zw',customer:'cus_zw',status:'active',items:{data:[{price:{id:'price_prof_test'}}]},metadata:{garavex_shop_id:'2',garavex_plan:'professional'},current_period_end:1893456000,cancel_at_period_end:false}}});
sk=db.prepare('SELECT * FROM shops WHERE id=1').get(); zw=db.prepare('SELECT * FROM shops WHERE id=2').get();
assert(sk.subscription_plan==='elite','Zwickl update must not alter S&K');
assert(zw.subscription_plan==='professional','Zwickl should become Professional');

handleGaravexSubscriptionEvent(db,{type:'invoice.payment_failed',data:{object:{customer:'cus_zw',subscription:'sub_zw'}}});
zw=db.prepare('SELECT * FROM shops WHERE id=2').get(); sk=db.prepare('SELECT * FROM shops WHERE id=1').get();
assert(zw.subscription_status==='past_due','Zwickl failed payment should be past_due');
assert(shopPlan(zw).key==='starter','Past-due Stripe shop must fall back to Starter access');
assert(shopPlan(sk).key==='elite','Zwickl payment failure must not affect S&K');

handleGaravexSubscriptionEvent(db,{type:'customer.subscription.deleted',data:{object:{id:'sub_sk',customer:'cus_sk',status:'canceled',items:{data:[{price:{id:'price_elite_test'}}]},metadata:{garavex_shop_id:'1',garavex_plan:'elite'},current_period_end:1893456000,cancel_at_period_end:false}}});
sk=db.prepare('SELECT * FROM shops WHERE id=1').get(); zw=db.prepare('SELECT * FROM shops WHERE id=2').get();
assert(sk.subscription_status==='canceled','S&K should be canceled');
assert(shopPlan(sk).key==='starter','Canceled Stripe shop must fall back to Starter access');
assert(zw.subscription_status==='past_due','S&K cancellation must not alter Zwickl');
console.log('PASS: subscription events and entitlements remained isolated across two shops.');
db.close();
