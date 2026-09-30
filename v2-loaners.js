const { permissionMiddleware } = require('./v2-permissions');

function installV2Loaners(app,db,{requireLogin}){
  if(!app||!db)throw new Error('V2 loaners require app and db.');
  if(!requireLogin)throw new Error('V2 loaners require login middleware.');
  const requireLoaners=permissionMiddleware('loaners');
  const validId=v=>Number.isInteger(v)&&v>0;
  const sid=req=>Number(req.session?.employee?.shop_id||0);
  const eid=req=>Number(req.session?.employee?.id||0);

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_loaners(id INTEGER PRIMARY KEY AUTOINCREMENT,shop_id INTEGER NOT NULL,name TEXT NOT NULL,year TEXT,make TEXT,model TEXT,plate TEXT,vin TEXT,status TEXT NOT NULL DEFAULT 'available',active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS v2_loaner_assignments(id INTEGER PRIMARY KEY AUTOINCREMENT,shop_id INTEGER NOT NULL,loaner_id INTEGER NOT NULL,repair_order_id INTEGER NOT NULL,customer_id INTEGER NOT NULL,checked_out_at DATETIME DEFAULT CURRENT_TIMESTAMP,due_back_at DATETIME,returned_at DATETIME,out_mileage INTEGER,out_fuel TEXT,note TEXT,employee_id INTEGER);
    CREATE INDEX IF NOT EXISTS idx_v2_loaners_shop ON v2_loaners(shop_id,status);
    CREATE INDEX IF NOT EXISTS idx_v2_loaner_assignments_open ON v2_loaner_assignments(shop_id,returned_at);
    CREATE INDEX IF NOT EXISTS idx_v2_loaner_assignments_ro ON v2_loaner_assignments(shop_id,repair_order_id,returned_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_loaner_one_open_vehicle ON v2_loaner_assignments(shop_id,loaner_id) WHERE returned_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_loaner_one_open_ro ON v2_loaner_assignments(shop_id,repair_order_id) WHERE returned_at IS NULL;
  `);

  const auth=(req,res)=>{const s=sid(req),e=eid(req);if(!validId(s)||!validId(e)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{s,e};};

  app.get('/api/v2/loaners',requireLogin,requireLoaners,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const vehicles=db.prepare(`SELECT * FROM v2_loaners WHERE shop_id=? AND active=1 ORDER BY name LIMIT 250`).all(a.s);
      const assignments=db.prepare(`SELECT a.*,l.name loaner_name,c.name customer_name,v.year vehicle_year,v.make vehicle_make,v.model vehicle_model FROM v2_loaner_assignments a JOIN v2_loaners l ON l.id=a.loaner_id AND l.shop_id=a.shop_id JOIN customers c ON c.id=a.customer_id AND c.shop_id=a.shop_id JOIN repair_orders r ON r.id=a.repair_order_id AND r.shop_id=a.shop_id AND r.customer_id=a.customer_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id WHERE a.shop_id=? AND a.returned_at IS NULL ORDER BY a.due_back_at,a.id LIMIT 250`).all(a.s);
      return res.json({vehicles,assignments});
    }catch(err){console.error('Garavex V2 loaners list error:',err);return res.status(500).json({error:'Unable to load loaner vehicles.'});}
  });

  app.post('/api/v2/loaners',requireLogin,requireLoaners,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const name=String(req.body?.name||'').trim().slice(0,150),vin=String(req.body?.vin||'').trim().toUpperCase().slice(0,30),plate=String(req.body?.plate||'').trim().toUpperCase().slice(0,30);
      if(!name)return res.status(400).json({error:'Loaner name is required.'});
      if(vin&&db.prepare(`SELECT id FROM v2_loaners WHERE shop_id=? AND UPPER(vin)=? AND active=1`).get(a.s,vin))return res.status(409).json({error:'That loaner VIN is already in the fleet.'});
      const info=db.prepare(`INSERT INTO v2_loaners(shop_id,name,year,make,model,plate,vin) VALUES(?,?,?,?,?,?,?)`).run(a.s,name,String(req.body?.year||'').trim().slice(0,10),String(req.body?.make||'').trim().slice(0,100),String(req.body?.model||'').trim().slice(0,100),plate,vin);
      return res.json({ok:true,id:info.lastInsertRowid});
    }catch(err){console.error('Garavex V2 loaner creation error:',err);return res.status(500).json({error:'Unable to add the loaner vehicle.'});}
  });

  app.post('/api/v2/loaners/:id/checkout',requireLogin,requireLoaners,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const loaner=Number(req.params.id),ro=Number(req.body?.repair_order_id);
      if(!validId(loaner)||!validId(ro))return res.status(400).json({error:'Valid loaner and repair order IDs are required.'});
      const r=db.prepare(`SELECT id,customer_id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(ro,a.s);
      if(!r)return res.status(404).json({error:'Repair order not found.'});
      if(r.status==='completed'||String(r.workflow_status||'').toLowerCase()==='delivered')return res.status(409).json({error:'Cannot assign a loaner to a completed or delivered repair order.'});
      const rawMileage=req.body?.out_mileage,mileage=rawMileage===undefined||rawMileage===null||rawMileage===''?null:Number(rawMileage);
      if(mileage!==null&&(!Number.isInteger(mileage)||mileage<0||mileage>10000000))return res.status(400).json({error:'Loaner mileage is invalid.'});
      const due=req.body?.due_back_at||null;if(due&&Number.isNaN(Date.parse(String(due))))return res.status(400).json({error:'Loaner due-back date is invalid.'});
      const tx=db.transaction(()=>{
        const l=db.prepare(`SELECT id FROM v2_loaners WHERE id=? AND shop_id=? AND active=1 AND status='available'`).get(loaner,a.s);if(!l)throw new Error('NOT_AVAILABLE');
        const changed=db.prepare(`UPDATE v2_loaners SET status='out' WHERE id=? AND shop_id=? AND active=1 AND status='available'`).run(loaner,a.s);if(changed.changes!==1)throw new Error('NOT_AVAILABLE');
        const info=db.prepare(`INSERT INTO v2_loaner_assignments(shop_id,loaner_id,repair_order_id,customer_id,due_back_at,out_mileage,out_fuel,note,employee_id) VALUES(?,?,?,?,?,?,?,?,?)`).run(a.s,loaner,ro,r.customer_id,due,mileage,String(req.body?.out_fuel||'').trim().slice(0,50),String(req.body?.note||'').trim().slice(0,1000),a.e);
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'loaner.checked_out','repair_order',ro,JSON.stringify({assignment_id:info.lastInsertRowid,loaner_id:loaner,due_back_at:due,out_mileage:mileage}));
      });
      try{tx();}catch(err){if(String(err.message).includes('NOT_AVAILABLE')||String(err.message).includes('UNIQUE'))return res.status(409).json({error:'Loaner is no longer available or this repair order already has an active loaner.'});throw err;}
      return res.json({ok:true});
    }catch(err){console.error('Garavex V2 loaner checkout error:',err);return res.status(500).json({error:'Unable to check out the loaner vehicle.'});}
  });

  app.patch('/api/v2/loaner-assignments/:id/return',requireLogin,requireLoaners,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid loaner assignment ID is required.'});
      const assignment=db.prepare(`SELECT a.*,l.status loaner_status FROM v2_loaner_assignments a JOIN v2_loaners l ON l.id=a.loaner_id AND l.shop_id=a.shop_id WHERE a.id=? AND a.shop_id=? AND a.returned_at IS NULL`).get(id,a.s);if(!assignment)return res.status(404).json({error:'Open loaner assignment not found.'});
      const tx=db.transaction(()=>{
        const returned=db.prepare(`UPDATE v2_loaner_assignments SET returned_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND returned_at IS NULL`).run(id,a.s);if(returned.changes!==1)throw new Error('ASSIGNMENT_CHANGED');
        const released=db.prepare(`UPDATE v2_loaners SET status='available' WHERE id=? AND shop_id=? AND status='out'`).run(assignment.loaner_id,a.s);if(released.changes!==1)throw new Error('LOANER_CHANGED');
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'loaner.returned','repair_order',assignment.repair_order_id,JSON.stringify({assignment_id:id,loaner_id:assignment.loaner_id}));
      });
      try{tx();}catch(err){return res.status(409).json({error:'Loaner assignment changed before the return could be saved.'});}
      return res.json({ok:true});
    }catch(err){console.error('Garavex V2 loaner return error:',err);return res.status(500).json({error:'Unable to return the loaner vehicle.'});}
  });
}
module.exports={installV2Loaners};
