const { permissionMiddleware } = require('./v2-permissions');

function installV2PartsRequests(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 parts requests require app and db.');
  if (!requireLogin) throw new Error('V2 parts requests require login middleware.');

  const requireParts = permissionMiddleware('parts');
  const validId = value => Number.isInteger(value) && value > 0;
  const sid = req => Number(req.session?.employee?.shop_id || 0);
  const eid = req => Number(req.session?.employee?.id || 0);
  const allowed = ['requested','ordered','received','installed','cancelled'];
  const transitions = { requested:['ordered','cancelled'], ordered:['received','cancelled'], received:['installed','cancelled'], installed:[], cancelled:[] };

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_parts_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, repair_order_id INTEGER NOT NULL,
      description TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'requested',
      vendor TEXT, eta DATETIME, requested_by INTEGER, requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_v2_parts_requests_shop_status ON v2_parts_requests(shop_id,status,requested_at);
    CREATE INDEX IF NOT EXISTS idx_v2_parts_requests_ro ON v2_parts_requests(shop_id,repair_order_id,status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_parts_request_active_exact
      ON v2_parts_requests(shop_id,repair_order_id,LOWER(TRIM(description)),quantity)
      WHERE status IN ('requested','ordered','received');
  `);

  const auth=(req,res)=>{const s=sid(req),e=eid(req);if(!validId(s)||!validId(e)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{s,e};};
  const normalizeEta=value=>{if(value===null||value==='')return null;const ms=Date.parse(String(value));return Number.isNaN(ms)?undefined:new Date(ms).toISOString();};

  app.get('/api/v2/parts-requests', requireLogin, requireParts, (req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const rows=db.prepare(`SELECT p.*,c.name customer_name,v.year,v.make,v.model,e.name requested_by_name,CASE WHEN p.status='ordered' AND p.eta IS NOT NULL AND datetime(p.eta)<datetime('now') THEN 1 ELSE 0 END overdue FROM v2_parts_requests p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id LEFT JOIN employees e ON e.id=p.requested_by AND e.shop_id=p.shop_id WHERE p.shop_id=? AND p.status NOT IN ('cancelled','installed') ORDER BY overdue DESC,CASE p.status WHEN 'requested' THEN 0 WHEN 'ordered' THEN 1 WHEN 'received' THEN 2 ELSE 3 END,p.requested_at,p.id LIMIT 250`).all(a.s);
      return res.json(rows);
    }catch(err){console.error('Garavex V2 parts request list error:',err);return res.status(500).json({error:'Unable to load parts requests.'});}
  });

  app.post('/api/v2/repair-orders/:id/parts-requests', requireLogin, requireParts, (req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const ro=Number(req.params.id);if(!validId(ro))return res.status(400).json({error:'Valid repair order ID is required.'});
      const order=db.prepare(`SELECT r.id,r.status,r.workflow_status,r.customer_id,c.id verified_customer_id FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE r.id=? AND r.shop_id=?`).get(ro,a.s);
      if(!order)return res.status(404).json({error:'Repair order or customer not found.'});
      if(order.status==='completed'||String(order.workflow_status||'').toLowerCase()==='delivered')return res.status(409).json({error:'Completed or delivered repair orders cannot receive new parts requests.'});
      const description=String(req.body?.description||'').trim(),qty=Number(req.body?.quantity??1);
      if(!description)return res.status(400).json({error:'Part description is required.'});
      if(description.length>1000)return res.status(400).json({error:'Part description cannot exceed 1000 characters.'});
      if(!Number.isFinite(qty)||qty<=0||qty>10000)return res.status(400).json({error:'Part quantity must be greater than zero and no more than 10,000.'});
      const duplicate=db.prepare(`SELECT id FROM v2_parts_requests WHERE shop_id=? AND repair_order_id=? AND LOWER(TRIM(description))=LOWER(TRIM(?)) AND quantity=? AND status IN ('requested','ordered','received') LIMIT 1`).get(a.s,ro,description,qty);
      if(duplicate)return res.status(409).json({error:'An identical active parts request already exists.',id:duplicate.id});
      const tx=db.transaction(()=>{const info=db.prepare(`INSERT INTO v2_parts_requests(shop_id,repair_order_id,description,quantity,requested_by) VALUES(?,?,?,?,?)`).run(a.s,ro,description,qty,a.e);db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'parts_request.created','repair_order',ro,JSON.stringify({parts_request_id:info.lastInsertRowid,description,quantity:qty}));return info.lastInsertRowid;});
      try{return res.json({ok:true,id:tx()});}catch(err){if(String(err?.message||'').includes('UNIQUE'))return res.status(409).json({error:'An identical active parts request already exists.'});throw err;}
    }catch(err){console.error('Garavex V2 parts request creation error:',err);return res.status(500).json({error:'Unable to create the parts request.'});}
  });

  app.patch('/api/v2/parts-requests/:id', requireLogin, requireParts, (req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const id=Number(req.params.id),status=String(req.body?.status||'').trim().toLowerCase();
      if(!validId(id))return res.status(400).json({error:'Valid parts request ID is required.'});if(!allowed.includes(status))return res.status(400).json({error:'Invalid parts status.'});
      const row=db.prepare(`SELECT p.*,r.status repair_order_status,r.workflow_status FROM v2_parts_requests p JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id WHERE p.id=? AND p.shop_id=?`).get(id,a.s);
      if(!row)return res.status(404).json({error:'Parts request not found.'});
      if(row.repair_order_status==='completed'||String(row.workflow_status||'').toLowerCase()==='delivered')return res.status(409).json({error:'Cannot change parts workflow after repair-order completion or vehicle delivery.'});
      if(['cancelled','installed'].includes(row.status))return res.status(409).json({error:`This parts request is already ${row.status}.`});
      if(status!==row.status&&!(transitions[row.status]||[]).includes(status))return res.status(409).json({error:`Cannot change parts status from ${row.status} to ${status}.`});
      const vendor=req.body?.vendor===undefined?String(row.vendor||''):String(req.body.vendor||'').trim();if(vendor.length>300)return res.status(400).json({error:'Vendor cannot exceed 300 characters.'});
      const rawEta=req.body?.eta===undefined?row.eta:req.body.eta,eta=normalizeEta(rawEta);if(eta===undefined)return res.status(400).json({error:'Valid ETA is required.'});
      if(status==='ordered'&&!vendor)return res.status(400).json({error:'Vendor is required when marking a part ordered.'});
      if(status==='ordered'&&!eta)return res.status(400).json({error:'ETA is required when marking a part ordered.'});
      if(status==='ordered'&&Date.parse(eta)<Date.now()-60000)return res.status(400).json({error:'Ordered-part ETA cannot be in the past.'});
      if(status==='ordered'&&Date.parse(eta)>Date.now()+1000*60*60*24*730)return res.status(400).json({error:'Ordered-part ETA is too far in the future.'});
      if(status===row.status&&vendor===String(row.vendor||'')&&String(eta||'')===String(normalizeEta(row.eta)||''))return res.json({ok:true,status,unchanged:true});
      const tx=db.transaction(()=>{const changed=db.prepare(`UPDATE v2_parts_requests SET status=?,vendor=?,eta=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status=?`).run(status,vendor,eta,a.e,id,a.s,row.status);if(changed.changes!==1)throw new Error('PARTS_CHANGED');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'parts_request.updated','repair_order',row.repair_order_id,JSON.stringify({parts_request_id:id,previous_status:row.status,status,previous_vendor:row.vendor,vendor,previous_eta:row.eta,eta}));});
      try{tx();}catch(err){if(String(err?.message||'').includes('PARTS_CHANGED'))return res.status(409).json({error:'Parts request changed before this update could be saved.'});throw err;}
      return res.json({ok:true,status});
    }catch(err){console.error('Garavex V2 parts request update error:',err);return res.status(500).json({error:'Unable to update the parts request.'});}
  });
}
module.exports={installV2PartsRequests};
