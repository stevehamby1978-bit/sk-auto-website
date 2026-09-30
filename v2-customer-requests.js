const { permissionMiddleware } = require('./v2-permissions');

function installV2CustomerRequests(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 customer requests require app and db.');
  if (!requireLogin) throw new Error('V2 customer requests require login middleware.');

  const requireCustomerContact = permissionMiddleware('customer_contact');
  const validId = value => Number.isInteger(value) && value > 0;
  const sid = req => Number(req.session?.employee?.shop_id || 0);
  const eid = req => Number(req.session?.employee?.id || 0);
  const types = ['call','text','email','approval','update'];
  const priorities = ['normal','high','urgent'];

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_customer_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      repair_order_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      request_type TEXT NOT NULL DEFAULT 'call',
      reason TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER,
      resolved_by INTEGER,
      resolution TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_v2_customer_requests_open ON v2_customer_requests(shop_id,status,priority,created_at);
    CREATE INDEX IF NOT EXISTS idx_v2_customer_requests_ro ON v2_customer_requests(shop_id,repair_order_id,status,request_type);
  `);

  const auth = (req, res) => {
    const s = sid(req), e = eid(req);
    if (!validId(s) || !validId(e)) {
      res.status(401).json({ error: 'A valid employee shop session is required.' });
      return null;
    }
    return { s, e };
  };

  app.get('/api/v2/customer-requests', requireLogin, requireCustomerContact, (req, res) => {
    try {
      const a = auth(req,res); if (!a) return;
      const rows = db.prepare(`
        SELECT q.*,c.name customer_name,c.phone,c.email,v.year,v.make,v.model,r.workflow_status
        FROM v2_customer_requests q
        JOIN repair_orders r ON r.id=q.repair_order_id AND r.shop_id=q.shop_id AND r.customer_id=q.customer_id
        JOIN customers c ON c.id=q.customer_id AND c.shop_id=q.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        WHERE q.shop_id=? AND q.status='open' AND COALESCE(r.workflow_status,'')!='delivered'
        ORDER BY CASE q.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,q.created_at,q.id
        LIMIT 500
      `).all(a.s);
      return res.json(rows);
    } catch (err) {
      console.error('Garavex V2 customer request list error:',err);
      return res.status(500).json({ error:'Unable to load customer requests.' });
    }
  });

  app.post('/api/v2/customer-requests', requireLogin, requireCustomerContact, (req,res) => {
    try {
      const a = auth(req,res); if (!a) return;
      const ro = Number(req.body?.repair_order_id);
      if (!validId(ro)) return res.status(400).json({ error:'Valid repair order ID is required.' });
      const reason = String(req.body?.reason || '').trim().slice(0,1000);
      if (!reason) return res.status(400).json({ error:'Reason is required.' });

      const order = db.prepare(`SELECT id,customer_id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(ro,a.s);
      if (!order) return res.status(404).json({ error:'Repair order not found.' });
      if (order.status === 'completed' || String(order.workflow_status || '').toLowerCase() === 'delivered') return res.status(409).json({ error:'Completed or delivered repair orders cannot receive new customer workflow requests.' });

      const requestedType = String(req.body?.request_type || 'call').trim().toLowerCase();
      const requestedPriority = String(req.body?.priority || 'normal').trim().toLowerCase();
      if (!types.includes(requestedType)) return res.status(400).json({ error:`Request type must be one of: ${types.join(', ')}.` });
      if (!priorities.includes(requestedPriority)) return res.status(400).json({ error:`Priority must be one of: ${priorities.join(', ')}.` });
      const type = requestedType;
      const priority = requestedPriority;
      const duplicate = db.prepare(`SELECT id FROM v2_customer_requests WHERE shop_id=? AND repair_order_id=? AND request_type=? AND status='open' AND reason=? LIMIT 1`).get(a.s,ro,type,reason);
      if (duplicate) return res.status(409).json({ error:'An identical customer request is already open.',id:duplicate.id });

      const tx = db.transaction(() => {
        const info = db.prepare(`INSERT INTO v2_customer_requests(shop_id,repair_order_id,customer_id,request_type,reason,priority,created_by) VALUES(?,?,?,?,?,?,?)`).run(a.s,ro,order.customer_id,type,reason,priority,a.e);
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'customer_request.created','repair_order',ro,JSON.stringify({ request_id:info.lastInsertRowid,request_type:type,priority,reason }));
        return info.lastInsertRowid;
      });
      return res.json({ ok:true,id:tx() });
    } catch (err) {
      console.error('Garavex V2 customer request creation error:',err);
      return res.status(500).json({ error:'Unable to create the customer request.' });
    }
  });

  app.patch('/api/v2/customer-requests/:id/resolve', requireLogin, requireCustomerContact, (req,res) => {
    try {
      const a = auth(req,res); if (!a) return;
      const id = Number(req.params.id);
      if (!validId(id)) return res.status(400).json({ error:'Valid customer request ID is required.' });
      const resolution = String(req.body?.resolution || '').trim().slice(0,1000);
      if (!resolution) return res.status(400).json({ error:'Resolution is required.' });

      const row = db.prepare(`
        SELECT q.*,r.status repair_order_status,r.workflow_status
        FROM v2_customer_requests q
        JOIN repair_orders r ON r.id=q.repair_order_id AND r.shop_id=q.shop_id AND r.customer_id=q.customer_id
        WHERE q.id=? AND q.shop_id=? AND q.status='open'
      `).get(id,a.s);
      if (!row) return res.status(404).json({ error:'Open request not found.' });
      if (row.repair_order_status === 'completed' || String(row.workflow_status || '').toLowerCase() === 'delivered') return res.status(409).json({ error:'Cannot change customer workflow requests after repair-order completion or vehicle delivery.' });

      const tx = db.transaction(() => {
        const changed = db.prepare(`UPDATE v2_customer_requests SET status='resolved',resolved_by=?,resolution=?,resolved_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status='open'`).run(a.e,resolution,id,a.s);
        if (changed.changes !== 1) throw new Error('Customer request changed before resolution.');
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'customer_request.resolved','repair_order',row.repair_order_id,JSON.stringify({ request_id:id,request_type:row.request_type,resolution }));
      });
      try { tx(); } catch (err) { return res.status(409).json({ error:'Customer request changed before resolution could be saved.' }); }
      return res.json({ ok:true });
    } catch (err) {
      console.error('Garavex V2 customer request resolution error:',err);
      return res.status(500).json({ error:'Unable to resolve the customer request.' });
    }
  });
}

module.exports = { installV2CustomerRequests };
