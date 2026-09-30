const { permissionMiddleware } = require('./v2-permissions');

function installV2ShopHandoff(app,db,{requireLogin}){
  if(!app||!db)throw new Error('V2 shop handoff requires app and db.');
  if(!requireLogin)throw new Error('V2 shop handoff requires login middleware.');
  const requireTasks=permissionMiddleware('tasks');
  const validId=v=>Number.isInteger(v)&&v>0;
  const sid=req=>Number(req.session?.employee?.shop_id||0);
  const eid=req=>Number(req.session?.employee?.id||0);
  const validDate=value=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const [y,m,d]=value.split('-').map(Number),dt=new Date(Date.UTC(y,m-1,d));
    return dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d;
  };

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_shop_handoffs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,shop_id INTEGER NOT NULL,employee_id INTEGER NOT NULL,shift_date TEXT NOT NULL,
      summary TEXT NOT NULL,urgent_items TEXT,parts_items TEXT,customer_items TEXT,completed INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,completed_at DATETIME,completed_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_v2_handoff_shop ON v2_shop_handoffs(shop_id,completed,shift_date,created_at);
    CREATE INDEX IF NOT EXISTS idx_v2_handoff_employee ON v2_shop_handoffs(shop_id,employee_id,completed,shift_date);
  `);
  const cols=db.prepare(`PRAGMA table_info(v2_shop_handoffs)`).all().map(x=>x.name);
  if(!cols.includes('completed_by'))db.exec(`ALTER TABLE v2_shop_handoffs ADD COLUMN completed_by INTEGER`);

  const auth=(req,res)=>{const s=sid(req),e=eid(req);if(!validId(s)||!validId(e)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{s,e};};

  app.get('/api/v2/handoffs',requireLogin,requireTasks,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const rows=db.prepare(`
        SELECT h.*,e.name employee_name,CASE WHEN date(h.shift_date)<date('now') THEN 1 ELSE 0 END overdue
        FROM v2_shop_handoffs h
        LEFT JOIN employees e ON e.id=h.employee_id AND e.shop_id=h.shop_id
        WHERE h.shop_id=? AND h.completed=0
        ORDER BY overdue DESC,h.shift_date,h.created_at DESC,h.id DESC LIMIT 200
      `).all(a.s);
      return res.json(rows);
    }catch(err){console.error('Garavex V2 handoff list error:',err);return res.status(500).json({error:'Unable to load shop handoffs.'});}
  });

  app.post('/api/v2/handoffs',requireLogin,requireTasks,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const summary=String(req.body?.summary||'').trim(),rawDate=String(req.body?.shift_date||new Date().toISOString().slice(0,10)).trim();
      if(!summary)return res.status(400).json({error:'Handoff summary is required.'});
      if(summary.length>3000)return res.status(400).json({error:'Handoff summary cannot exceed 3000 characters.'});
      if(!validDate(rawDate))return res.status(400).json({error:'Valid shift date is required.'});
      const shiftMs=Date.parse(rawDate+'T00:00:00Z'),today=new Date();today.setUTCHours(0,0,0,0);
      if(shiftMs>today.getTime()+1000*60*60*24*31)return res.status(400).json({error:'Shift date is too far in the future.'});
      if(shiftMs<today.getTime()-1000*60*60*24*31)return res.status(400).json({error:'Shift date is too far in the past.'});
      const urgent=String(req.body?.urgent_items||'').trim(),parts=String(req.body?.parts_items||'').trim(),customer=String(req.body?.customer_items||'').trim();
      if(urgent.length>2000||parts.length>2000||customer.length>2000)return res.status(400).json({error:'Each handoff detail section cannot exceed 2000 characters.'});
      const duplicate=db.prepare(`SELECT id FROM v2_shop_handoffs WHERE shop_id=? AND employee_id=? AND shift_date=? AND completed=0 AND summary=? LIMIT 1`).get(a.s,a.e,rawDate,summary);
      if(duplicate)return res.status(409).json({error:'An identical open handoff already exists.',id:duplicate.id});
      const tx=db.transaction(()=>{const info=db.prepare(`INSERT INTO v2_shop_handoffs(shop_id,employee_id,shift_date,summary,urgent_items,parts_items,customer_items) VALUES(?,?,?,?,?,?,?)`).run(a.s,a.e,rawDate,summary,urgent,parts,customer);db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'handoff.created','handoff',info.lastInsertRowid,JSON.stringify({shift_date:rawDate,summary:summary.slice(0,500),has_urgent:Boolean(urgent),has_parts:Boolean(parts),has_customer:Boolean(customer)}));return info.lastInsertRowid;});
      return res.json({ok:true,id:tx()});
    }catch(err){console.error('Garavex V2 handoff creation error:',err);return res.status(500).json({error:'Unable to create the shop handoff.'});}
  });

  app.patch('/api/v2/handoffs/:id/complete',requireLogin,requireTasks,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid handoff ID is required.'});
      const row=db.prepare(`SELECT * FROM v2_shop_handoffs WHERE id=? AND shop_id=? AND completed=0`).get(id,a.s);if(!row)return res.status(404).json({error:'Open handoff not found.'});
      const tx=db.transaction(()=>{const changed=db.prepare(`UPDATE v2_shop_handoffs SET completed=1,completed_at=CURRENT_TIMESTAMP,completed_by=? WHERE id=? AND shop_id=? AND completed=0`).run(a.e,id,a.s);if(changed.changes!==1)throw new Error('HANDOFF_CHANGED');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'handoff.completed','handoff',id,JSON.stringify({shift_date:row.shift_date,created_by:row.employee_id,completed_by:a.e}));});
      try{tx();}catch(err){return res.status(409).json({error:'Handoff changed before completion could be saved.'});}
      return res.json({ok:true});
    }catch(err){console.error('Garavex V2 handoff completion error:',err);return res.status(500).json({error:'Unable to complete the shop handoff.'});}
  });
}
module.exports={installV2ShopHandoff};
