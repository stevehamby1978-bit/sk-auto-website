function installV2Health(app, db, { requireLogin, requireOwner }) {
  if (!app || !db) throw new Error('V2 health requires app and db.');
  if (!requireLogin || !requireOwner) throw new Error('V2 health requires authentication middleware.');

  const table = name => {
    try { return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)); }
    catch { return false; }
  };
  const columns = name => {
    try { return table(name) ? db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name) : []; }
    catch { return []; }
  };
  const hasColumn = (name, column) => columns(name).includes(column);
  const validId = value => Number.isInteger(value) && value > 0;

  app.get('/api/v2/health', requireLogin, requireOwner, (req, res) => {
    try {
      const shopId = Number(req.session?.employee?.shop_id || 0);
      const employeeId = Number(req.session?.employee?.id || 0);
      const required = [
        'dvi_inspections','dvi_items','dvi_attachments','technician_time_entries','deferred_services',
        'inventory_items','vendors','purchase_orders','purchase_order_items','audit_log','customer_portal_tokens','canned_jobs',
        'v2_comebacks','v2_tasks','v2_ro_blockers','v2_ro_promises','v2_parts_requests','v2_vehicle_keys','v2_road_tests',
        'v2_deliveries','v2_customer_requests','v2_shop_handoffs','v2_loaner_assignments'
      ];
      const tables = required.map(name => ({ name, ok: table(name), shop_scoped: table(name) && hasColumn(name,'shop_id') }));
      const requiredColumns = [
        ['repair_orders','assigned_technician_id'],['repair_orders','workflow_status'],['repair_orders','parts_status'],['repair_orders','promised_at'],['repair_orders','internal_notes'],
        ['repair_order_items','part_number'],['repair_order_items','parts_cost'],['repair_order_items','labor_hours'],['repair_order_items','labor_cost'],['repair_order_items','vendor_id'],
        ['vehicles','engine'],['vehicles','trim'],['vehicles','license_plate'],['vehicles','plate_state'],['employees','hourly_cost'],['employees','permissions_json'],
        ['shops','default_labor_rate'],['shops','parts_markup_percent'],['shops','dvi_enabled'],['shops','customer_portal_enabled']
      ].map(([tableName,column])=>({table:tableName,column,ok:table(tableName)&&hasColumn(tableName,column)}));
      const env = [
        ['stripe_secret','Stripe server key configured','STRIPE_SECRET_KEY',true],
        ['stripe_webhook','Stripe webhook secret configured','STRIPE_WEBHOOK_SECRET',true],
        ['session_secret','Session secret configured','SESSION_SECRET',true],
        ['sms_number','Twilio SMS sender configured','TWILIO_PHONE_NUMBER',false],
        ['twilio_sid','Twilio account configured','TWILIO_ACCOUNT_SID',false],
        ['twilio_token','Twilio auth configured','TWILIO_AUTH_TOKEN',false],
        ['resend','Resend email key configured','RESEND_API_KEY',false]
      ].map(([key,label,name,required]) => ({ key,label,ok:Boolean(String(process.env[name]||'').trim()),required }));

      let dbRead = false;
      let dbWrite = false;
      try { db.prepare(`SELECT 1 AS ok`).get(); dbRead = true; } catch {}
      try {
        db.exec('SAVEPOINT v2_health_write');
        db.prepare(`CREATE TABLE IF NOT EXISTS v2_health_probe(id INTEGER PRIMARY KEY,checked_at DATETIME)`).run();
        db.prepare(`INSERT INTO v2_health_probe(id,checked_at) VALUES(1,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET checked_at=CURRENT_TIMESTAMP`).run();
        db.exec('ROLLBACK TO v2_health_write');
        db.exec('RELEASE v2_health_write');
        dbWrite = true;
      } catch {
        try { db.exec('ROLLBACK TO v2_health_write'); db.exec('RELEASE v2_health_write'); } catch {}
      }

      let foreignKeys = false;
      let foreignKeyProblems = null;
      try {
        foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys || 0) === 1;
        foreignKeyProblems = db.prepare('PRAGMA foreign_key_check').all().length;
      } catch {}

      const checks = [
        { key:'database_read',label:'Database readable',ok:dbRead,required:true },
        { key:'database_write',label:'Database writable',ok:dbWrite,required:true },
        { key:'foreign_keys',label:'SQLite foreign-key enforcement enabled',ok:foreignKeys,required:true },
        { key:'foreign_key_integrity',label:'No broken foreign-key references',ok:foreignKeyProblems===0,required:true,detail:foreignKeyProblems===null?'check failed':`${foreignKeyProblems} problem(s)` },
        { key:'shop_scope',label:'Logged-in shop context',ok:validId(shopId),required:true },
        { key:'employee',label:'Authenticated employee context',ok:validId(employeeId),required:true },
        { key:'schema',label:'All required V2 tables available',ok:tables.every(x => x.ok),required:true },
        { key:'table_scope',label:'All required V2 tables are shop-scoped',ok:tables.every(x => x.shop_scoped),required:true },
        { key:'columns',label:'All required V2 columns available',ok:requiredColumns.every(x=>x.ok),required:true },
        ...env
      ];
      const blockers = checks.filter(x => x.required && !x.ok);
      const warnings = checks.filter(x => !x.required && !x.ok);
      return res.json({
        ok: blockers.length === 0,
        release_ready: blockers.length === 0,
        blockers,warnings,checks,tables,columns:requiredColumns,
        version:'2.0-development',payment_provider:'stripe',quickbooks_required:false,
        timestamp:new Date().toISOString()
      });
    } catch (err) {
      console.error('Garavex V2 health error:', err);
      return res.status(500).json({ok:false,release_ready:false,error:'V2 release-readiness checks could not be completed.'});
    }
  });
}

module.exports = { installV2Health };
