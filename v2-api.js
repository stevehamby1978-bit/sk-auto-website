const crypto = require('crypto');

function installV2Api(app, db, { requireLogin, requireOwner }) {
  const shopId = req => Number(req.session.employee.shop_id);
  const employeeId = req => Number(req.session.employee.id);
  const owns = (table, id, sid) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND shop_id = ?`).get(id, sid);
  const audit = (sid, eid, action, entityType, entityId, details = null) => db.prepare(`INSERT INTO audit_log (shop_id, employee_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)`).run(sid, eid, action, entityType, entityId || null, details ? JSON.stringify(details) : null);

  app.get('/api/v2/overview', requireLogin, (req, res) => {
    const sid = shopId(req);
    const one = sql => db.prepare(sql).get(sid).n;
    res.json({
      activeRepairOrders: one(`SELECT COUNT(*) n FROM repair_orders WHERE shop_id=? AND status != 'completed'`),
      inspections: one(`SELECT COUNT(*) n FROM dvi_inspections WHERE shop_id=? AND status != 'completed'`),
      deferred: one(`SELECT COUNT(*) n FROM deferred_services WHERE shop_id=? AND status='deferred'`),
      lowStock: one(`SELECT COUNT(*) n FROM inventory_items WHERE shop_id=? AND active=1 AND quantity <= reorder_level`),
      techniciansClockedIn: one(`SELECT COUNT(DISTINCT employee_id) n FROM technician_time_entries WHERE shop_id=? AND clock_out IS NULL`)
    });
  });

  app.get('/api/v2/shop-board', requireLogin, (req, res) => {
    const rows = db.prepare(`SELECT r.id,r.status,r.workflow_status,r.parts_status,r.promised_at,r.assigned_technician_id,c.name customer_name,v.year,v.make,v.model,e.name technician_name FROM repair_orders r LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN vehicles v ON v.id=r.vehicle_id LEFT JOIN employees e ON e.id=r.assigned_technician_id WHERE r.shop_id=? AND r.status != 'completed' ORDER BY r.created_at`).all(shopId(req));
    res.json(rows);
  });

  app.patch('/api/v2/repair-orders/:id/workflow', requireLogin, (req, res) => {
    const sid=shopId(req), id=Number(req.params.id); if(!owns('repair_orders',id,sid)) return res.status(404).json({error:'Repair order not found.'});
    const allowed=['waiting','assigned','in_progress','waiting_parts','waiting_approval','ready','completed'];
    const status=String(req.body.workflow_status||''); if(!allowed.includes(status)) return res.status(400).json({error:'Invalid workflow status.'});
    db.prepare(`UPDATE repair_orders SET workflow_status=? WHERE id=? AND shop_id=?`).run(status,id,sid); audit(sid,employeeId(req),'workflow.update','repair_order',id,{status}); res.json({ok:true});
  });

  app.patch('/api/v2/repair-orders/:id/assign', requireLogin, (req,res)=>{
    const sid=shopId(req), id=Number(req.params.id), tech=Number(req.body.employee_id||0); if(!owns('repair_orders',id,sid)) return res.status(404).json({error:'Repair order not found.'});
    const employee=db.prepare(`SELECT id FROM employees WHERE id=? AND shop_id=? AND active=1`).get(tech,sid); if(!employee) return res.status(400).json({error:'Technician not found.'});
    db.prepare(`UPDATE repair_orders SET assigned_technician_id=?, workflow_status=CASE WHEN workflow_status='waiting' THEN 'assigned' ELSE workflow_status END WHERE id=? AND shop_id=?`).run(tech,id,sid); audit(sid,employeeId(req),'technician.assign','repair_order',id,{employee_id:tech}); res.json({ok:true});
  });

  app.post('/api/v2/time/clock-in', requireLogin, (req,res)=>{
    const sid=shopId(req), eid=employeeId(req), ro=Number(req.body.repair_order_id||0)||null;
    const open=db.prepare(`SELECT id FROM technician_time_entries WHERE shop_id=? AND employee_id=? AND clock_out IS NULL`).get(sid,eid); if(open) return res.status(409).json({error:'You are already clocked in.'});
    if(ro && !owns('repair_orders',ro,sid)) return res.status(404).json({error:'Repair order not found.'});
    const info=db.prepare(`INSERT INTO technician_time_entries (shop_id,employee_id,repair_order_id,notes) VALUES (?,?,?,?)`).run(sid,eid,ro,String(req.body.notes||'').trim()||null); res.json({ok:true,id:info.lastInsertRowid});
  });

  app.post('/api/v2/time/clock-out', requireLogin, (req,res)=>{
    const sid=shopId(req), eid=employeeId(req); const row=db.prepare(`SELECT * FROM technician_time_entries WHERE shop_id=? AND employee_id=? AND clock_out IS NULL ORDER BY id DESC LIMIT 1`).get(sid,eid); if(!row) return res.status(404).json({error:'No active time entry.'});
    db.prepare(`UPDATE technician_time_entries SET clock_out=CURRENT_TIMESTAMP, minutes=MAX(1,ROUND((julianday(CURRENT_TIMESTAMP)-julianday(clock_in))*1440)) WHERE id=? AND shop_id=?`).run(row.id,sid); res.json({ok:true});
  });

  app.post('/api/v2/dvi', requireLogin, (req,res)=>{
    const sid=shopId(req), ro=Number(req.body.repair_order_id||0); const order=owns('repair_orders',ro,sid); if(!order) return res.status(404).json({error:'Repair order not found.'});
    const token=crypto.randomBytes(24).toString('hex'); const info=db.prepare(`INSERT INTO dvi_inspections (shop_id,repair_order_id,customer_id,vehicle_id,technician_id,public_token) VALUES (?,?,?,?,?,?)`).run(sid,ro,order.customer_id,order.vehicle_id,employeeId(req),token); audit(sid,employeeId(req),'dvi.create','dvi',info.lastInsertRowid,{repair_order_id:ro}); res.json({ok:true,id:info.lastInsertRowid,token});
  });

  app.get('/api/v2/dvi/:id', requireLogin, (req,res)=>{
    const sid=shopId(req), inspection=owns('dvi_inspections',Number(req.params.id),sid); if(!inspection) return res.status(404).json({error:'Inspection not found.'});
    inspection.items=db.prepare(`SELECT * FROM dvi_items WHERE inspection_id=? AND shop_id=? ORDER BY sort_order,id`).all(inspection.id,sid); res.json(inspection);
  });

  app.post('/api/v2/dvi/:id/items', requireLogin, (req,res)=>{
    const sid=shopId(req), iid=Number(req.params.id); if(!owns('dvi_inspections',iid,sid)) return res.status(404).json({error:'Inspection not found.'});
    const condition=String(req.body.condition||'green'); if(!['green','yellow','red'].includes(condition)) return res.status(400).json({error:'Invalid condition.'});
    const info=db.prepare(`INSERT INTO dvi_items (shop_id,inspection_id,category,item_name,condition,notes,recommendation,parts,labor,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(sid,iid,String(req.body.category||'General'),String(req.body.item_name||'').trim(),condition,String(req.body.notes||''),String(req.body.recommendation||''),Number(req.body.parts||0),Number(req.body.labor||0),Number(req.body.sort_order||0)); res.json({ok:true,id:info.lastInsertRowid});
  });

  app.post('/api/v2/dvi/:id/send', requireLogin, (req,res)=>{
    const sid=shopId(req), id=Number(req.params.id); if(!owns('dvi_inspections',id,sid)) return res.status(404).json({error:'Inspection not found.'}); db.prepare(`UPDATE dvi_inspections SET status='sent',sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=?`).run(id,sid); res.json({ok:true});
  });

  app.get('/api/v2/deferred', requireLogin, (req,res)=>res.json(db.prepare(`SELECT d.*,c.name customer_name,v.year,v.make,v.model FROM deferred_services d JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.shop_id=? ORDER BY d.created_at DESC`).all(shopId(req))));

  app.get('/api/v2/inventory', requireLogin, (req,res)=>res.json(db.prepare(`SELECT i.*,v.name vendor_name FROM inventory_items i LEFT JOIN vendors v ON v.id=i.vendor_id WHERE i.shop_id=? AND i.active=1 ORDER BY i.description`).all(shopId(req))));
  app.post('/api/v2/inventory', requireLogin, requireOwner, (req,res)=>{ const sid=shopId(req); const info=db.prepare(`INSERT INTO inventory_items (shop_id,vendor_id,sku,part_number,description,quantity,reorder_level,cost,sell_price,location) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(sid,Number(req.body.vendor_id||0)||null,String(req.body.sku||''),String(req.body.part_number||''),String(req.body.description||'').trim(),Number(req.body.quantity||0),Number(req.body.reorder_level||0),Number(req.body.cost||0),Number(req.body.sell_price||0),String(req.body.location||'')); res.json({ok:true,id:info.lastInsertRowid}); });

  app.get('/api/v2/vendors', requireLogin, (req,res)=>res.json(db.prepare(`SELECT * FROM vendors WHERE shop_id=? AND active=1 ORDER BY name`).all(shopId(req))));
  app.post('/api/v2/vendors', requireLogin, requireOwner, (req,res)=>{ const sid=shopId(req); const info=db.prepare(`INSERT INTO vendors (shop_id,name,contact_name,phone,email,website,account_number,notes) VALUES (?,?,?,?,?,?,?,?)`).run(sid,String(req.body.name||'').trim(),String(req.body.contact_name||''),String(req.body.phone||''),String(req.body.email||''),String(req.body.website||''),String(req.body.account_number||''),String(req.body.notes||'')); res.json({ok:true,id:info.lastInsertRowid}); });

  app.get('/api/v2/search', requireLogin, (req,res)=>{
    const sid=shopId(req), q=`%${String(req.query.q||'').trim()}%`; if(q==='%%') return res.json([]);
    const customers=db.prepare(`SELECT 'customer' type,id,name title,COALESCE(phone,'') subtitle FROM customers WHERE shop_id=? AND (name LIKE ? OR phone LIKE ? OR email LIKE ?) LIMIT 15`).all(sid,q,q,q);
    const vehicles=db.prepare(`SELECT 'vehicle' type,id,(COALESCE(year,'')||' '||COALESCE(make,'')||' '||COALESCE(model,'')) title,COALESCE(vin,'') subtitle FROM vehicles WHERE shop_id=? AND (vin LIKE ? OR make LIKE ? OR model LIKE ? OR license_plate LIKE ?) LIMIT 15`).all(sid,q,q,q,q);
    const orders=db.prepare(`SELECT 'repair_order' type,id,('#'||id) title,COALESCE(workflow_status,status) subtitle FROM repair_orders WHERE shop_id=? AND CAST(id AS TEXT) LIKE ? LIMIT 15`).all(sid,q);
    res.json([...customers,...vehicles,...orders]);
  });

  app.get('/api/v2/profitability', requireLogin, requireOwner, (req,res)=>{
    const sid=shopId(req); const row=db.prepare(`SELECT COALESCE(SUM(i.parts),0) parts_sales,COALESCE(SUM(i.parts_cost),0) parts_cost,COALESCE(SUM(i.labor),0) labor_sales,COALESCE(SUM(i.labor_cost),0) labor_cost FROM repair_order_items i JOIN repair_orders r ON r.id=i.repair_order_id WHERE r.shop_id=?`).get(sid); const sales=row.parts_sales+row.labor_sales,cost=row.parts_cost+row.labor_cost; res.json({...row,sales,cost,gross_profit:sales-cost,gross_margin:sales?((sales-cost)/sales*100):0});
  });
}
module.exports={installV2Api};
