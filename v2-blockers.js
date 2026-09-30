const { permissionMiddleware } = require('./v2-permissions');

function installV2Blockers(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 blockers require app and db.');
  if (!requireLogin) throw new Error('V2 blockers require login middleware.');

  const requireRepairOrders = permissionMiddleware('repair_orders');
  const validId = value => Number.isInteger(value) && value > 0;
  const sid = req => Number(req.session?.employee?.shop_id || 0);
  const eid = req => Number(req.session?.employee?.id || 0);

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_ro_blockers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      repair_order_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_by INTEGER,
      resolved_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_v2_blockers_open ON v2_ro_blockers(shop_id,status,created_at);
    CREATE INDEX IF NOT EXISTS idx_v2_blockers_ro ON v2_ro_blockers(shop_id,repair_order_id,status);
  `);

  const columns = () => db.prepare(`PRAGMA table_info(v2_ro_blockers)`).all().map(x => x.name);
  const add = (name, sql) => { if (!columns().includes(name)) db.exec(`ALTER TABLE v2_ro_blockers ADD COLUMN ${name} ${sql}`); };
  add('type', `TEXT NOT NULL DEFAULT 'other'`);
  add('description', `TEXT`);
  add('status', `TEXT NOT NULL DEFAULT 'open'`);
  add('created_by', `INTEGER`);
  add('resolved_by', `INTEGER`);
  add('resolved_at', `DATETIME`);

  const names = columns();
  const reasonExpr = names.includes('reason') ? `COALESCE(NULLIF(b.description,''),b.reason)` : `b.description`;
  const auth = (req, res) => {
    const s = sid(req), e = eid(req);
    if (!validId(s) || !validId(e)) {
      res.status(401).json({ error: 'A valid employee shop session is required.' });
      return null;
    }
    return { s, e };
  };

  app.get('/api/v2/blockers', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const a = auth(req, res); if (!a) return;
      const rows = db.prepare(`
        SELECT b.*,${reasonExpr} display_description,c.name customer_name,
               v.year,v.make,v.model,e.name technician_name
        FROM v2_ro_blockers b
        JOIN repair_orders r ON r.id=b.repair_order_id AND r.shop_id=b.shop_id
        JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        LEFT JOIN v2_ro_assignments a ON a.repair_order_id=r.id AND a.shop_id=r.shop_id
        LEFT JOIN employees e ON e.id=a.employee_id AND e.shop_id=r.shop_id
        WHERE b.shop_id=? AND b.status='open'
        ORDER BY b.created_at,b.id
        LIMIT 500
      `).all(a.s);
      return res.json(rows);
    } catch (err) {
      console.error('Garavex V2 blockers list error:', err);
      return res.status(500).json({ error: 'Unable to load workflow blockers.' });
    }
  });

  app.post('/api/v2/repair-orders/:id/blockers', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const a = auth(req, res); if (!a) return;
      const ro = Number(req.params.id);
      if (!validId(ro)) return res.status(400).json({ error: 'Valid repair order ID is required.' });
      const order = db.prepare(`SELECT id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(ro, a.s);
      if (!order) return res.status(404).json({ error: 'Repair order not found.' });
      if (order.status === 'completed' || String(order.workflow_status || '').toLowerCase() === 'delivered') return res.status(409).json({ error: 'Completed or delivered repair orders cannot receive new blockers.' });

      const type = String(req.body?.type || 'other').trim().slice(0, 100) || 'other';
      const description = String(req.body?.description || req.body?.reason || '').trim().slice(0, 1000);
      if (!description) return res.status(400).json({ error: 'Blocker description is required.' });

      const duplicateField = names.includes('description') ? 'description' : 'reason';
      const duplicate = db.prepare(`SELECT id FROM v2_ro_blockers WHERE shop_id=? AND repair_order_id=? AND status='open' AND ${duplicateField}=? LIMIT 1`).get(a.s, ro, description);
      if (duplicate) return res.status(409).json({ error: 'An identical blocker is already open.', id: duplicate.id });

      const tx = db.transaction(() => {
        const fields = ['shop_id','repair_order_id','type','description','created_by'];
        const values = [a.s,ro,type,description,a.e];
        if (names.includes('reason')) { fields.push('reason'); values.push(description); }
        const info = db.prepare(`INSERT INTO v2_ro_blockers(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...values);
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'repair_order.blocked','repair_order',ro,JSON.stringify({ blocker_id: info.lastInsertRowid,type,description }));
        return info.lastInsertRowid;
      });
      return res.json({ ok: true, id: tx() });
    } catch (err) {
      console.error('Garavex V2 blocker creation error:', err);
      return res.status(500).json({ error: 'Unable to create the workflow blocker.' });
    }
  });

  app.patch('/api/v2/blockers/:id/resolve', requireLogin, requireRepairOrders, (req, res) => {
    try {
      const a = auth(req, res); if (!a) return;
      const id = Number(req.params.id);
      if (!validId(id)) return res.status(400).json({ error: 'Valid blocker ID is required.' });
      const blocker = db.prepare(`
        SELECT b.*,r.status repair_order_status,r.workflow_status
        FROM v2_ro_blockers b
        JOIN repair_orders r ON r.id=b.repair_order_id AND r.shop_id=b.shop_id
        WHERE b.id=? AND b.shop_id=? AND b.status='open'
      `).get(id,a.s);
      if (!blocker) return res.status(404).json({ error: 'Open blocker not found.' });
      if (blocker.repair_order_status === 'completed' || String(blocker.workflow_status || '').toLowerCase() === 'delivered') return res.status(409).json({ error: 'Cannot change blockers after repair-order completion or vehicle delivery.' });

      const tx = db.transaction(() => {
        const changed = db.prepare(`UPDATE v2_ro_blockers SET status='resolved',resolved_by=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status='open'`).run(a.e,id,a.s);
        if (changed.changes !== 1) throw new Error('Blocker changed before resolution.');
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'repair_order.blocker_resolved','repair_order',blocker.repair_order_id,JSON.stringify({ blocker_id:id,type:blocker.type }));
      });
      try { tx(); } catch (err) { return res.status(409).json({ error: 'Blocker changed before resolution could be saved.' }); }
      return res.json({ ok: true });
    } catch (err) {
      console.error('Garavex V2 blocker resolution error:', err);
      return res.status(500).json({ error: 'Unable to resolve the workflow blocker.' });
    }
  });
}

module.exports = { installV2Blockers };
