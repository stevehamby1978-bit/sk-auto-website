const { permissionMiddleware } = require('./v2-permissions');

function installV2Promises(app,db,{requireLogin}){
  if(!app||!db)throw new Error('V2 promises require app and db.');
  if(!requireLogin)throw new Error('V2 promises require login middleware.');
  const requireRepairOrders=permissionMiddleware('repair_orders');
  const validId=v=>Number.isInteger(v)&&v>0;
  const sid=req=>Number(req.session?.employee?.shop_id||0);
  const eid=req=>Number(req.session?.employee?.id||0);
  const tableExists=name=>Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_ro_promises(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      repair_order_id INTEGER NOT NULL,
      promised_at DATETIME NOT NULL,
      note TEXT,
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id,repair_order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_promises_due ON v2_ro_promises(shop_id,promised_at);
    CREATE INDEX IF NOT EXISTS idx_v2_promises_ro ON v2_ro_promises(shop_id,repair_order_id);
  `);

  const auth=(req,res)=>{const s=sid(req),e=eid(req);if(!validId(s)||!validId(e)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{s,e};};
  const normalizeDate=value=>{const raw=String(value||'').trim();if(!raw)return null;const ms=Date.parse(raw);if(Number.isNaN(ms))return null;return{ms,iso:new Date(ms).toISOString()};};

  app.get('/api/v2/promises',requireLogin,requireRepairOrders,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const assignmentJoin=tableExists('v2_ro_assignments')?`LEFT JOIN v2_ro_assignments a ON a.id=(SELECT a2.id FROM v2_ro_assignments a2 WHERE a2.repair_order_id=r.id AND a2.shop_id=r.shop_id ORDER BY a2.id DESC LIMIT 1) LEFT JOIN employees e ON e.id=a.employee_id AND e.shop_id=r.shop_id`:`LEFT JOIN employees e ON 1=0`;
      const rows=db.prepare(`
        SELECT p.*,c.name customer_name,v.year,v.make,v.model,r.workflow_status,e.name technician_name,
               CASE WHEN datetime(p.promised_at)<datetime('now') THEN 1 ELSE 0 END overdue
        FROM v2_ro_promises p
        JOIN repair_orders r ON r.id=p.repair_order_id AND r.shop_id=p.shop_id
        JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        ${assignmentJoin}
        WHERE p.shop_id=? AND COALESCE(r.workflow_status,'')!='delivered'
        ORDER BY overdue DESC,p.promised_at,p.id
        LIMIT 500
      `).all(a.s);
      return res.json(rows);
    }catch(err){console.error('Garavex V2 promises list error:',err);return res.status(500).json({error:'Unable to load promised completion times.'});}
  });

  app.put('/api/v2/repair-orders/:id/promise',requireLogin,requireRepairOrders,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid repair order ID is required.'});
      const parsed=normalizeDate(req.body?.promised_at),note=String(req.body?.note||'').trim().slice(0,1000);
      if(!parsed)return res.status(400).json({error:'Valid promised completion time is required.'});
      if(parsed.ms>Date.now()+1000*60*60*24*365*5)return res.status(400).json({error:'Promised completion time is too far in the future.'});
      if(parsed.ms<Date.now()-1000*60*60*24*30)return res.status(400).json({error:'Promised completion time is too far in the past.'});
      const promised=parsed.iso;

      const ro=db.prepare(`SELECT id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(id,a.s);
      if(!ro)return res.status(404).json({error:'Repair order not found.'});
      if(ro.status==='completed'||String(ro.workflow_status||'').toLowerCase()==='delivered')return res.status(409).json({error:'Cannot change a completion promise after repair-order completion or vehicle delivery.'});
      const previous=db.prepare(`SELECT promised_at,note,updated_at FROM v2_ro_promises WHERE shop_id=? AND repair_order_id=?`).get(a.s,id);
      const previousParsed=previous?.promised_at?normalizeDate(previous.promised_at):null;
      if(previousParsed?.iso===promised&&String(previous?.note||'')===note)return res.json({ok:true,promised_at:promised,unchanged:true});

      const tx=db.transaction(()=>{
        if(previous){
          const changed=db.prepare(`UPDATE v2_ro_promises SET promised_at=?,note=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE shop_id=? AND repair_order_id=? AND updated_at=?`).run(promised,note,a.e,a.s,id,previous.updated_at);
          if(changed.changes!==1)throw new Error('PROMISE_CHANGED');
        }else{
          try{db.prepare(`INSERT INTO v2_ro_promises(shop_id,repair_order_id,promised_at,note,updated_by) VALUES(?,?,?,?,?)`).run(a.s,id,promised,note,a.e);}catch(err){if(String(err.message).includes('UNIQUE'))throw new Error('PROMISE_CHANGED');throw err;}
        }
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'repair_order.promise_updated','repair_order',id,JSON.stringify({previous_promised_at:previous?.promised_at||null,previous_note:previous?.note||null,promised_at:promised,note}));
      });
      try{tx();}catch(err){if(String(err.message).includes('PROMISE_CHANGED'))return res.status(409).json({error:'Promised completion time changed before this update could be saved.'});throw err;}
      return res.json({ok:true,promised_at:promised});
    }catch(err){console.error('Garavex V2 promise update error:',err);return res.status(500).json({error:'Unable to update the promised completion time.'});}
  });
}
module.exports={installV2Promises};
