const { permissionMiddleware } = require('./v2-permissions');

function installV2Comebacks(app,db,{requireLogin,requireOwner}){
  if(!app||!db)throw new Error('V2 comebacks require app and db.');
  if(!requireLogin||!requireOwner)throw new Error('V2 comebacks require authentication middleware.');
  const requireRepairOrders=permissionMiddleware('repair_orders');
  const validId=v=>Number.isInteger(v)&&v>0;
  const sid=req=>Number(req.session?.employee?.shop_id||0);
  const eid=req=>Number(req.session?.employee?.id||0);

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_comebacks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,shop_id INTEGER NOT NULL,original_repair_order_id INTEGER NOT NULL,
      comeback_repair_order_id INTEGER,customer_id INTEGER NOT NULL,vehicle_id INTEGER,reason TEXT NOT NULL,resolution TEXT,
      status TEXT NOT NULL DEFAULT 'open',labor_cost REAL NOT NULL DEFAULT 0,parts_cost REAL NOT NULL DEFAULT 0,
      created_by INTEGER,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,resolved_by INTEGER,resolved_at DATETIME,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_v2_comebacks_shop ON v2_comebacks(shop_id,status,created_at);
    CREATE INDEX IF NOT EXISTS idx_v2_comebacks_customer ON v2_comebacks(shop_id,customer_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_v2_comebacks_vehicle ON v2_comebacks(shop_id,vehicle_id,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_comebacks_open_original ON v2_comebacks(shop_id,original_repair_order_id) WHERE status IN ('open','in_progress');
  `);
  const cols=db.prepare(`PRAGMA table_info(v2_comebacks)`).all().map(x=>x.name);
  if(!cols.includes('resolved_by'))db.exec(`ALTER TABLE v2_comebacks ADD COLUMN resolved_by INTEGER`);
  if(!cols.includes('updated_at'))db.exec(`ALTER TABLE v2_comebacks ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);

  const auth=(req,res)=>{const s=sid(req),e=eid(req);if(!validId(s)||!validId(e)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{s,e};};

  app.get('/api/v2/comebacks',requireLogin,requireRepairOrders,(req,res)=>{
    try{const a=auth(req,res);if(!a)return;const rows=db.prepare(`SELECT cb.*,c.name customer_name,v.year,v.make,v.model,creator.name created_by_name,resolver.name resolved_by_name FROM v2_comebacks cb JOIN customers c ON c.id=cb.customer_id AND c.shop_id=cb.shop_id LEFT JOIN vehicles v ON v.id=cb.vehicle_id AND v.shop_id=cb.shop_id LEFT JOIN employees creator ON creator.id=cb.created_by AND creator.shop_id=cb.shop_id LEFT JOIN employees resolver ON resolver.id=cb.resolved_by AND resolver.shop_id=cb.shop_id WHERE cb.shop_id=? ORDER BY CASE cb.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,cb.created_at DESC,cb.id DESC LIMIT 300`).all(a.s);return res.json(rows);}catch(err){console.error('Garavex V2 comeback list error:',err);return res.status(500).json({error:'Unable to load comeback records.'});}
  });

  app.post('/api/v2/comebacks',requireLogin,requireRepairOrders,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const roId=Number(req.body?.original_repair_order_id);if(!validId(roId))return res.status(400).json({error:'Valid original repair order is required.'});
      const ro=db.prepare(`SELECT id,customer_id,vehicle_id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(roId,a.s);if(!ro)return res.status(404).json({error:'Original repair order not found.'});
      if(ro.status!=='completed'&&String(ro.workflow_status||'').toLowerCase()!=='delivered')return res.status(409).json({error:'A comeback can only be opened against a completed or delivered repair order.'});
      const reason=String(req.body?.reason||'').trim().slice(0,2000);if(!reason)return res.status(400).json({error:'Comeback reason is required.'});
      const tx=db.transaction(()=>{const info=db.prepare(`INSERT INTO v2_comebacks(shop_id,original_repair_order_id,customer_id,vehicle_id,reason,created_by) VALUES(?,?,?,?,?,?)`).run(a.s,roId,ro.customer_id,ro.vehicle_id,reason,a.e);db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'comeback.created','comeback',info.lastInsertRowid,JSON.stringify({original_repair_order_id:roId,reason}));return info.lastInsertRowid;});
      try{return res.json({ok:true,id:tx()});}catch(err){if(String(err.message).includes('UNIQUE'))return res.status(409).json({error:'This repair order already has an active comeback.'});throw err;}
    }catch(err){console.error('Garavex V2 comeback creation error:',err);return res.status(500).json({error:'Unable to create the comeback record.'});}
  });

  app.patch('/api/v2/comebacks/:id',requireLogin,requireRepairOrders,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid comeback ID is required.'});
      const row=db.prepare(`SELECT * FROM v2_comebacks WHERE id=? AND shop_id=?`).get(id,a.s);if(!row)return res.status(404).json({error:'Comeback not found.'});if(['resolved','dismissed'].includes(row.status))return res.status(409).json({error:'Closed comeback records cannot be changed.'});
      const status=String(req.body?.status||row.status).trim().toLowerCase();if(!['open','in_progress','resolved','dismissed'].includes(status))return res.status(400).json({error:'Invalid status.'});
      if(row.status==='in_progress'&&status==='open')return res.status(409).json({error:'Comeback status cannot move backward to open.'});
      const resolution=String(req.body?.resolution??row.resolution??'').trim().slice(0,3000);if(status==='resolved'&&!resolution)return res.status(400).json({error:'Resolution is required when resolving a comeback.'});
      const labor=Number(req.body?.labor_cost??row.labor_cost??0),parts=Number(req.body?.parts_cost??row.parts_cost??0);if(!Number.isFinite(labor)||labor<0||labor>1000000||!Number.isFinite(parts)||parts<0||parts>1000000)return res.status(400).json({error:'Comeback costs are invalid.'});
      const comebackRoRaw=req.body?.comeback_repair_order_id??row.comeback_repair_order_id;const comebackRo=comebackRoRaw===null||comebackRoRaw===''?null:Number(comebackRoRaw);
      if(comebackRo!==null){if(!validId(comebackRo)||comebackRo===row.original_repair_order_id)return res.status(400).json({error:'Valid comeback repair order is required.'});const linked=db.prepare(`SELECT id,customer_id,vehicle_id FROM repair_orders WHERE id=? AND shop_id=?`).get(comebackRo,a.s);if(!linked||linked.customer_id!==row.customer_id||(row.vehicle_id&&linked.vehicle_id!==row.vehicle_id))return res.status(409).json({error:'Comeback repair order must belong to the same customer and vehicle.'});}
      const closing=['resolved','dismissed'].includes(status);
      const tx=db.transaction(()=>{const changed=db.prepare(`UPDATE v2_comebacks SET status=?,resolution=?,labor_cost=?,parts_cost=?,comeback_repair_order_id=?,resolved_by=CASE WHEN ? THEN ? ELSE resolved_by END,resolved_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE resolved_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status=?`).run(status,resolution,labor,parts,comebackRo,closing?1:0,a.e,closing?1:0,id,a.s,row.status);if(changed.changes!==1)throw new Error('COMEBACK_CHANGED');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'comeback.updated','comeback',id,JSON.stringify({previous_status:row.status,status,labor_cost:labor,parts_cost:parts,comeback_repair_order_id:comebackRo,resolution}));});
      try{tx();}catch(err){return res.status(409).json({error:'Comeback changed before this update could be saved.'});}return res.json({ok:true,status});
    }catch(err){console.error('Garavex V2 comeback update error:',err);return res.status(500).json({error:'Unable to update the comeback record.'});}
  });

  app.get('/api/v2/comebacks/metrics',requireLogin,requireOwner,(req,res)=>{
    try{const a=auth(req,res);if(!a)return;const m=db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status IN('open','in_progress') THEN 1 ELSE 0 END),0) open_count,COALESCE(SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END),0) resolved_count,COALESCE(SUM(labor_cost+parts_cost),0) total_cost FROM v2_comebacks WHERE shop_id=?`).get(a.s);const completed=Number(db.prepare(`SELECT COUNT(*) n FROM repair_orders WHERE shop_id=? AND status='completed'`).get(a.s)?.n||0);m.completed_repair_orders=completed;m.comeback_rate=completed?Number((m.total/completed*100).toFixed(2)):0;return res.json(m);}catch(err){console.error('Garavex V2 comeback metrics error:',err);return res.status(500).json({error:'Unable to load comeback metrics.'});}
  });
}
module.exports={installV2Comebacks};
