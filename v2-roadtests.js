const { permissionMiddleware } = require('./v2-permissions');

function installV2RoadTests(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 road tests require app and db.');
  if (!requireLogin) throw new Error('V2 road tests require login middleware.');

  const requireRoadTests = permissionMiddleware('road_tests');
  const validId = value => Number.isInteger(value) && value > 0;
  const sid = req => Number(req.session?.employee?.shop_id || 0);
  const eid = req => Number(req.session?.employee?.id || 0);
  const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const phases = ['pre_repair','post_repair','diagnostic'];

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_road_tests(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      repair_order_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'post_repair',
      status TEXT NOT NULL DEFAULT 'in_progress',
      start_mileage INTEGER,
      end_mileage INTEGER,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      result TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_v2_road_tests_shop_ro ON v2_road_tests(shop_id,repair_order_id,started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_road_tests_one_active ON v2_road_tests(shop_id,repair_order_id) WHERE status='in_progress';
  `);

  const blockerCols = () => has('v2_ro_blockers') ? db.prepare(`PRAGMA table_info(v2_ro_blockers)`).all().map(x => x.name) : [];
  const auth = (req, res) => {
    const s = sid(req), e = eid(req);
    if (!validId(s) || !validId(e)) {
      res.status(401).json({ error: 'A valid employee shop session is required.' });
      return null;
    }
    return { s, e };
  };

  app.get('/api/v2/road-tests', requireLogin, requireRoadTests, (req, res) => {
    try {
      const a = auth(req, res); if (!a) return;
      const rows = db.prepare(`
        SELECT t.*,c.name customer_name,v.year,v.make,v.model,e.name employee_name
        FROM v2_road_tests t
        JOIN repair_orders r ON r.id=t.repair_order_id AND r.shop_id=t.shop_id
        JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        LEFT JOIN employees e ON e.id=t.employee_id AND e.shop_id=t.shop_id
        WHERE t.shop_id=?
        ORDER BY CASE WHEN t.status='in_progress' THEN 0 ELSE 1 END,t.started_at DESC,t.id DESC
        LIMIT 150
      `).all(a.s);
      return res.json(rows);
    } catch (err) {
      console.error('Garavex V2 road tests list error:', err);
      return res.status(500).json({ error: 'Unable to load road tests.' });
    }
  });

  app.post('/api/v2/repair-orders/:id/road-tests', requireLogin, requireRoadTests, (req, res) => {
    try {
      const a = auth(req, res); if (!a) return;
      const ro = Number(req.params.id);
      if (!validId(ro)) return res.status(400).json({ error: 'Valid repair order ID is required.' });
      const rawMileage = req.body?.start_mileage;
      const start = rawMileage === undefined || rawMileage === null || rawMileage === '' ? null : Number(rawMileage);
      if (start !== null && (!Number.isInteger(start) || start < 0 || start > 10000000)) return res.status(400).json({ error: 'Starting mileage is invalid.' });
      const requestedPhase = String(req.body?.phase || 'post_repair').trim().toLowerCase();
      if (!phases.includes(requestedPhase)) return res.status(400).json({ error: `Road test phase must be one of: ${phases.join(', ')}.` });
      const phase = requestedPhase;
      const notes = String(req.body?.notes || '').trim().slice(0, 3000);

      const tx = db.transaction(() => {
        const order = db.prepare(`SELECT id,status,workflow_status,vehicle_id FROM repair_orders WHERE id=? AND shop_id=?`).get(ro, a.s);
        if (!order) throw new Error('RO_NOT_FOUND');
        if (order.status === 'completed' || String(order.workflow_status || '').toLowerCase() === 'delivered') throw new Error('RO_CLOSED');
        if (!validId(Number(order.vehicle_id))) throw new Error('VEHICLE_REQUIRED');
        const info = db.prepare(`INSERT INTO v2_road_tests(shop_id,repair_order_id,employee_id,phase,start_mileage,notes) VALUES(?,?,?,?,?,?)`).run(a.s, ro, a.e, phase, start, notes);
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s, a.e, 'repair_order.road_test_started', 'repair_order', ro, JSON.stringify({ road_test_id: info.lastInsertRowid, phase, start_mileage: start }));
        return info.lastInsertRowid;
      });
      try { return res.json({ ok: true, id: tx() }); }
      catch (err) { const code=String(err.message||''); if(code==='RO_NOT_FOUND')return res.status(404).json({error:'Repair order not found.'});if(code==='RO_CLOSED')return res.status(409).json({error:'A completed or delivered repair order cannot start a new road test.'});if(code==='VEHICLE_REQUIRED')return res.status(409).json({error:'A road test requires a vehicle on the repair order.'});if (code.includes('UNIQUE')) return res.status(409).json({ error: 'This repair order already has a road test in progress.' }); throw err; }
    } catch (err) {
      console.error('Garavex V2 road test start error:', err);
      return res.status(500).json({ error: 'Unable to start the road test.' });
    }
  });

  app.patch('/api/v2/road-tests/:id/complete', requireLogin, requireRoadTests, (req, res) => {
    try {
      const a = auth(req, res); if (!a) return;
      const id = Number(req.params.id);
      const result = String(req.body?.result || '').trim().toLowerCase();
      if (!validId(id)) return res.status(400).json({ error: 'Valid road test ID is required.' });
      if (!['passed','failed','inconclusive'].includes(result)) return res.status(400).json({ error: 'Road test result is required.' });
      const rawEnd = req.body?.end_mileage;
      const end = rawEnd === undefined || rawEnd === null || rawEnd === '' ? null : Number(rawEnd);
      if (end !== null && (!Number.isInteger(end) || end < 0 || end > 10000000)) return res.status(400).json({ error: 'Ending mileage is invalid.' });
      const requestedNotes = req.body?.notes;
      if(requestedNotes!==undefined&&requestedNotes!==null&&String(requestedNotes).length>3000)return res.status(400).json({error:'Road test notes cannot exceed 3000 characters.'});

      const tx = db.transaction(() => {
        const test = db.prepare(`SELECT t.*,r.status repair_order_status,r.workflow_status FROM v2_road_tests t JOIN repair_orders r ON r.id=t.repair_order_id AND r.shop_id=t.shop_id WHERE t.id=? AND t.shop_id=? AND t.status='in_progress'`).get(id, a.s);
        if (!test) throw new Error('ROAD_TEST_NOT_FOUND');
        if (test.repair_order_status === 'completed' || String(test.workflow_status || '').toLowerCase() === 'delivered') throw new Error('RO_CLOSED');
        if (test.start_mileage !== null && end !== null && end < test.start_mileage) throw new Error('MILEAGE_DECREASED');
        const notes = String(requestedNotes ?? test.notes ?? '').trim().slice(0, 3000);
        if (result !== 'passed' && !notes) throw new Error('NOTES_REQUIRED');
        const changed = db.prepare(`UPDATE v2_road_tests SET status='completed',end_mileage=?,result=?,notes=?,completed_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status='in_progress'`).run(end, result, notes, id, a.s);
        if (changed.changes !== 1) throw new Error('ROAD_TEST_CHANGED');
        if (has('v2_ro_blockers')) {
          const cols = blockerCols();
          const descriptionColumn = cols.includes('description') ? 'description' : cols.includes('reason') ? 'reason' : null;
          if (descriptionColumn) {
            const existing = db.prepare(`SELECT id FROM v2_ro_blockers WHERE shop_id=? AND repair_order_id=? AND status='open' AND ${descriptionColumn} LIKE 'Road test:%' ORDER BY id DESC LIMIT 1`).get(a.s, test.repair_order_id);
            if (result === 'passed') {
              if (existing) {
                const sets = [`status='resolved'`], values = [];
                if (cols.includes('resolved_at')) sets.push(`resolved_at=CURRENT_TIMESTAMP`);
                if (cols.includes('resolved_by')) { sets.push(`resolved_by=?`); values.push(a.e); }
                db.prepare(`UPDATE v2_ro_blockers SET ${sets.join(',')} WHERE id=? AND shop_id=? AND status='open'`).run(...values, existing.id, a.s);
              }
            } else if (!existing) {
              const msg = `Road test: ${result} — ${notes}`.slice(0, 1000), fields = ['shop_id','repair_order_id'], values = [a.s,test.repair_order_id];
              if (cols.includes('type')) { fields.push('type'); values.push('road_test'); }
              if (cols.includes('description')) { fields.push('description'); values.push(msg); }
              if (cols.includes('reason')) { fields.push('reason'); values.push(msg); }
              if (cols.includes('created_by')) { fields.push('created_by'); values.push(a.e); }
              db.prepare(`INSERT INTO v2_ro_blockers(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...values);
            }
          }
        }
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s, a.e, 'repair_order.road_test_completed', 'repair_order', test.repair_order_id, JSON.stringify({ road_test_id: id, result, start_mileage: test.start_mileage, end_mileage: end }));
      });
      try { tx(); } catch (err) { const code=String(err.message||'');if(code==='ROAD_TEST_NOT_FOUND')return res.status(404).json({error:'Active road test not found.'});if(code==='RO_CLOSED')return res.status(409).json({error:'Cannot complete a road test after repair-order completion or delivery.'});if(code==='MILEAGE_DECREASED')return res.status(400).json({error:'Ending mileage cannot be lower than starting mileage.'});if(code==='NOTES_REQUIRED')return res.status(400).json({error:'Notes are required for a failed or inconclusive road test.'});return res.status(409).json({ error: 'Road test changed before completion could be saved.' }); }
      return res.json({ ok: true, result, workflow_blocked: result !== 'passed' });
    } catch (err) {
      console.error('Garavex V2 road test completion error:', err);
      return res.status(500).json({ error: 'Unable to complete the road test.' });
    }
  });
}

module.exports = { installV2RoadTests };
