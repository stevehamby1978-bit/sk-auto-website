'use strict';

const { shopPlan } = require('./garavex-subscription-tiers');

function installV2SubscriptionEnforcement(app, db, { requireLogin, requireOwner }) {
  if (!app || !db) throw new Error('Subscription enforcement requires app and db.');

  const shopFor = req => Number(req.session?.employee?.shop_id || 0);
  const subscriptionForShop = shopId => db.prepare(`
    SELECT id, subscription_plan, subscription_status, stripe_subscription_id,
           subscription_current_period_end
    FROM shops WHERE id=? LIMIT 1
  `).get(shopId);

  function requireEmployeeCapacity(req, res, next) {
    const shopId = shopFor(req);
    if (!shopId) return res.status(401).json({ error: 'Login required.' });
    const shop = subscriptionForShop(shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found.' });
    const plan = shopPlan(shop);
    if (plan.employeeLimit == null) return next();
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM employees WHERE shop_id=? AND active=1').get(shopId)?.count || 0);
    if (count >= plan.employeeLimit) {
      return res.status(403).json({
        error: `${plan.name} allows up to ${plan.employeeLimit} active employees. Upgrade the shop plan to add another employee.`,
        code: 'EMPLOYEE_LIMIT_REACHED',
        plan: plan.key,
        employeeLimit: plan.employeeLimit,
        employeeCount: count
      });
    }
    next();
  }

  // Authoritative V2 employee creation route. It is deliberately shop-scoped and
  // owner-only; the legacy route remains untouched until this branch is validated.
  app.post('/api/v2/employees', requireLogin, requireOwner, requireEmployeeCapacity, async (req, res) => {
    try {
      const bcrypt = require('bcryptjs');
      const shopId = shopFor(req);
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const allowedRoles = new Set(['owner', 'manager', 'service_writer', 'technician']);
      const role = allowedRoles.has(req.body?.role) ? req.body.role : 'technician';
      if (!name) return res.status(400).json({ error: 'Employee name is required.' });
      if (!email) return res.status(400).json({ error: 'Employee email is required.' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      if (db.prepare('SELECT id FROM employees WHERE LOWER(email)=? LIMIT 1').get(email)) return res.status(409).json({ error: 'An employee with this email already exists.' });
      const passwordHash = await bcrypt.hash(password, 12);
      const result = db.prepare(`INSERT INTO employees(name,email,password_hash,role,active,must_change_password,shop_id) VALUES(?,?,?,?,1,1,?)`).run(name,email,passwordHash,role,shopId);
      res.status(201).json({ success: true, employee: { id: Number(result.lastInsertRowid), name, email, role, active: 1, shop_id: shopId } });
    } catch (err) {
      console.error('[V2 SUBSCRIPTIONS] employee create error:', err);
      res.status(500).json({ error: 'Unable to add employee.' });
    }
  });

  app.get('/api/v2/subscription/employee-capacity', requireLogin, (req, res) => {
    const shopId = shopFor(req);
    const shop = subscriptionForShop(shopId);
    if (!shop) return res.status(404).json({ error: 'Shop not found.' });
    const plan = shopPlan(shop);
    const count = Number(db.prepare('SELECT COUNT(*) AS count FROM employees WHERE shop_id=? AND active=1').get(shopId)?.count || 0);
    res.json({ plan: plan.key, employeeCount: count, employeeLimit: plan.employeeLimit, canAddEmployee: plan.employeeLimit == null || count < plan.employeeLimit });
  });

  console.log('[V2 SUBSCRIPTIONS] employee-limit enforcement installed.');
}

module.exports = { installV2SubscriptionEnforcement };
