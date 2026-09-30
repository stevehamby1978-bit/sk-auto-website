function installV2Health(app, db, { requireLogin, requireOwner }) {
  if (!app || !db) throw new Error('V2 health requires app and db.');
  if (!requireLogin || !requireOwner) throw new Error('V2 health requires authentication middleware.');

  const table = name => {
    try { return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)); }
    catch { return false; }
  };
  const validId = value => Number.isInteger(value) && value > 0;

  app.get('/api/v2/health', requireLogin, requireOwner, (req, res) => {
    const shopId = Number(req.session?.employee?.shop_id || 0);
    const employeeId = Number(req.session?.employee?.id || 0);
    const required = [
      'dvi_inspections','dvi_items','dvi_attachments','technician_time_entries','deferred_services',
      'inventory_items','vendors','purchase_orders','purchase_order_items','audit_log','customer_portal_tokens','canned_jobs',
      'v2_comebacks','v2_tasks','v2_ro_blockers','v2_ro_promises','v2_parts_requests','v2_vehicle_keys','v2_road_tests',
      'v2_deliveries','v2_customer_requests','v2_shop_handoffs'
    ];
    const tables = required.map(name => ({ name, ok: table(name) }));
    const env = [
      ['stripe_secret','Stripe server key configured','STRIPE_SECRET_KEY',true],
      ['stripe_webhook','Stripe webhook secret configured','STRIPE_WEBHOOK_SECRET',true],
      ['session_secret','Session secret configured','SESSION_SECRET',true],
      ['sms_number','Twilio SMS sender configured','TWILIO_PHONE_NUMBER',false],
      ['twilio_sid','Twilio account configured','TWILIO_ACCOUNT_SID',false],
      ['twilio_token','Twilio auth configured','TWILIO_AUTH_TOKEN',false]
    ].map(([key,label,name,required]) => ({ key,label,ok:Boolean(process.env[name]),required }));

    let dbRead = false;
    let dbWrite = false;
    try {
      db.prepare(`SELECT 1 AS ok`).get();
      dbRead = true;
    } catch {}
    try {
      db.prepare(`CREATE TABLE IF NOT EXISTS v2_health_probe(id INTEGER PRIMARY KEY,checked_at DATETIME)`).run();
      db.prepare(`INSERT INTO v2_health_probe(id,checked_at) VALUES(1,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET checked_at=CURRENT_TIMESTAMP`).run();
      dbWrite = true;
    } catch {}

    const checks = [
      { key:'database_read',label:'Database readable',ok:dbRead,required:true },
      { key:'database_write',label:'Database writable',ok:dbWrite,required:true },
      { key:'shop_scope',label:'Logged-in shop context',ok:validId(shopId),required:true },
      { key:'employee',label:'Authenticated employee context',ok:validId(employeeId),required:true },
      { key:'schema',label:'All required V2 tables available',ok:tables.every(x => x.ok),required:true },
      ...env
    ];
    const blockers = checks.filter(x => x.required && !x.ok);
    const warnings = checks.filter(x => !x.required && !x.ok);
    return res.json({
      ok: blockers.length === 0,
      release_ready: blockers.length === 0,
      blockers,
      warnings,
      checks,
      tables,
      version:'2.0-development',
      payment_provider:'stripe',
      quickbooks_required:false,
      timestamp:new Date().toISOString()
    });
  });
}

module.exports = { installV2Health };
