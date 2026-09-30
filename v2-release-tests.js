function installV2ReleaseTests(app, db, { requireLogin, requireOwner }) {
  if (!app || !db) throw new Error('V2 release tests require app and db.');
  if (!requireLogin || !requireOwner) throw new Error('V2 release tests require authentication middleware.');

  const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const columns = table => exists(table) ? db.prepare(`PRAGMA table_info(${table})`).all() : [];
  const hasCol = (table, col) => columns(table).some(c => c.name === col);
  const validId = value => Number.isInteger(value) && value > 0;

  app.get('/api/v2/release-tests', requireLogin, requireOwner, (req, res) => {
    try {
      const shopId = Number(req.session?.employee?.shop_id || 0);
      const scoped = [
        'customers','vehicles','repair_orders','appointments','employees','dvi_inspections','dvi_items','dvi_attachments',
        'technician_time_entries','deferred_services','inventory_items','vendors','purchase_orders','purchase_order_items',
        'canned_jobs','audit_log','customer_portal_tokens','v2_comebacks','v2_tasks','v2_ro_blockers','v2_ro_promises',
        'v2_parts_requests','v2_vehicle_keys','v2_road_tests','v2_deliveries','v2_customer_requests','v2_shop_handoffs'
      ];

      const isolation = scoped.map(table => {
        if (!exists(table)) return { table, ok: false, detail: 'table missing' };
        const scopedTable = hasCol(table, 'shop_id');
        return { table, ok: scopedTable, detail: scopedTable ? 'shop_id present' : 'shop_id missing' };
      });

      const dataChecks = [];
      const run = (name, sql) => {
        try {
          const n = Number(db.prepare(sql).get()?.n || 0);
          dataChecks.push({ name, ok: n === 0, count: n });
        } catch (err) {
          dataChecks.push({ name, ok: false, count: null, error: err.message });
        }
      };
      const link = (name, child, childKey, parent, parentKey = 'id') => {
        if (exists(child) && exists(parent) && hasCol(child, 'shop_id') && hasCol(parent, 'shop_id') && hasCol(child, childKey)) {
          run(name, `SELECT COUNT(*) n FROM ${child} c JOIN ${parent} p ON p.${parentKey}=c.${childKey} WHERE c.${childKey} IS NOT NULL AND c.shop_id!=p.shop_id`);
        }
      };

      link('Vehicles linked across shops','vehicles','customer_id','customers');
      link('Repair orders linked to customers across shops','repair_orders','customer_id','customers');
      link('Repair orders linked to vehicles across shops','repair_orders','vehicle_id','vehicles');
      link('DVI inspections linked to repair orders across shops','dvi_inspections','repair_order_id','repair_orders');
      link('DVI inspections linked to customers across shops','dvi_inspections','customer_id','customers');
      link('DVI inspections linked to vehicles across shops','dvi_inspections','vehicle_id','vehicles');
      link('DVI items linked to inspections across shops','dvi_items','inspection_id','dvi_inspections');
      link('DVI attachments linked to inspections across shops','dvi_attachments','inspection_id','dvi_inspections');
      link('Technician time linked to repair orders across shops','technician_time_entries','repair_order_id','repair_orders');
      link('Deferred services linked to customers across shops','deferred_services','customer_id','customers');
      link('Deferred services linked to vehicles across shops','deferred_services','vehicle_id','vehicles');
      link('Deferred services linked to repair orders across shops','deferred_services','repair_order_id','repair_orders');
      link('Inventory linked to vendors across shops','inventory_items','vendor_id','vendors');
      link('Purchase orders linked to vendors across shops','purchase_orders','vendor_id','vendors');
      link('Purchase orders linked to repair orders across shops','purchase_orders','repair_order_id','repair_orders');
      link('Purchase-order items linked across shops','purchase_order_items','purchase_order_id','purchase_orders');
      link('Portal tokens linked to customers across shops','customer_portal_tokens','customer_id','customers');

      [
        ['v2_tasks','repair_order_id'],['v2_ro_blockers','repair_order_id'],['v2_ro_promises','repair_order_id'],
        ['v2_parts_requests','repair_order_id'],['v2_vehicle_keys','repair_order_id'],['v2_road_tests','repair_order_id'],
        ['v2_deliveries','repair_order_id'],['v2_customer_requests','repair_order_id']
      ].forEach(([table, key]) => link(`${table} linked across shops`, table, key, 'repair_orders'));

      if (exists('dvi_items')) run('DVI items with invalid condition', `SELECT COUNT(*) n FROM dvi_items WHERE condition NOT IN ('green','yellow','red')`);
      if (exists('dvi_items')) run('DVI items with invalid customer decision', `SELECT COUNT(*) n FROM dvi_items WHERE customer_decision NOT IN ('pending','approved','declined')`);
      if (exists('technician_time_entries')) run('Technician time with negative minutes', `SELECT COUNT(*) n FROM technician_time_entries WHERE minutes IS NOT NULL AND minutes<0`);
      if (exists('customer_portal_tokens')) run('Duplicate active portal tokens', `SELECT COUNT(*) n FROM (SELECT token FROM customer_portal_tokens WHERE revoked_at IS NULL GROUP BY token HAVING COUNT(*)>1)`);
      if (exists('dvi_inspections')) run('Duplicate DVI public tokens', `SELECT COUNT(*) n FROM (SELECT public_token FROM dvi_inspections WHERE public_token IS NOT NULL GROUP BY public_token HAVING COUNT(*)>1)`);
      if (exists('v2_deliveries')) run('Delivered records without delivered workflow state', `SELECT COUNT(*) n FROM v2_deliveries d JOIN repair_orders r ON r.id=d.repair_order_id AND r.shop_id=d.shop_id WHERE d.delivered_at IS NOT NULL AND COALESCE(r.workflow_status,'')!='delivered'`);
      if (exists('v2_vehicle_keys')) run('Delivered ROs with missing keys', `SELECT COUNT(*) n FROM repair_orders r JOIN v2_vehicle_keys k ON k.repair_order_id=r.id AND k.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND k.status='missing'`);
      if (exists('v2_ro_blockers')) run('Delivered ROs with open blockers', `SELECT COUNT(*) n FROM repair_orders r JOIN v2_ro_blockers b ON b.repair_order_id=r.id AND b.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND b.status='open'`);
      if (exists('v2_parts_requests')) run('Delivered ROs with parts still requested or ordered', `SELECT COUNT(*) n FROM repair_orders r JOIN v2_parts_requests p ON p.repair_order_id=r.id AND p.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND p.status IN ('requested','ordered')`);
      if (exists('v2_road_tests')) run('Delivered ROs with active road tests', `SELECT COUNT(*) n FROM repair_orders r JOIN v2_road_tests t ON t.repair_order_id=r.id AND t.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND t.status='in_progress'`);
      if (exists('v2_customer_requests')) run('Delivered ROs with open approvals', `SELECT COUNT(*) n FROM repair_orders r JOIN v2_customer_requests q ON q.repair_order_id=r.id AND q.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND q.status='open' AND q.request_type='approval'`);
      if (exists('v2_loaner_assignments')) run('Delivered ROs with active loaners', `SELECT COUNT(*) n FROM repair_orders r JOIN v2_loaner_assignments l ON l.repair_order_id=r.id AND l.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND l.returned_at IS NULL`);
      if (exists('v2_road_tests')) run('Ready ROs with failed latest road test', `SELECT COUNT(*) n FROM repair_orders r WHERE r.workflow_status='ready' AND EXISTS (SELECT 1 FROM v2_road_tests t WHERE t.shop_id=r.shop_id AND t.repair_order_id=r.id AND t.completed_at IS NOT NULL AND LOWER(COALESCE(t.result,''))='failed' AND t.id=(SELECT t2.id FROM v2_road_tests t2 WHERE t2.shop_id=r.shop_id AND t2.repair_order_id=r.id AND t2.completed_at IS NOT NULL ORDER BY datetime(t2.completed_at) DESC,t2.id DESC LIMIT 1))`);
      if (exists('technician_time_entries')) run('Delivered ROs with technician clock still running', `SELECT COUNT(*) n FROM repair_orders r JOIN technician_time_entries t ON t.repair_order_id=r.id AND t.shop_id=r.shop_id WHERE r.workflow_status='delivered' AND t.clock_out IS NULL`);

      const currentShop = {
        id: shopId,
        customers: validId(shopId) && exists('customers') ? Number(db.prepare(`SELECT COUNT(*) n FROM customers WHERE shop_id=?`).get(shopId)?.n || 0) : 0,
        repair_orders: validId(shopId) && exists('repair_orders') ? Number(db.prepare(`SELECT COUNT(*) n FROM repair_orders WHERE shop_id=?`).get(shopId)?.n || 0) : 0
      };
      const checks = [
        { label: 'All critical V2 tables are shop-scoped', ok: isolation.every(x => x.ok) },
        { label: 'No detected cross-shop or workflow integrity problems', ok: dataChecks.every(x => x.ok) },
        { label: 'Current session has shop scope', ok: validId(shopId) }
      ];

      return res.json({ ok: checks.every(x => x.ok), checks, isolation, data_checks: dataChecks, current_shop: currentShop, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('Garavex V2 release tests error:', err);
      return res.status(500).json({ ok: false, error: 'V2 release integrity tests could not be completed.' });
    }
  });
}

module.exports = { installV2ReleaseTests };
