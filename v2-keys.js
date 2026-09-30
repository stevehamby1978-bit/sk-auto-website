const { permissionMiddleware } = require('./v2-permissions');

function installV2Keys(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 vehicle keys require app and db.');
  if (!requireLogin) throw new Error('V2 vehicle keys require login middleware.');

  const requireKeys = permissionMiddleware('keys');
  const validId = value => Number.isInteger(value) && value > 0;
  const sid = req => Number(req.session?.employee?.shop_id || 0);
  const eid = req => Number(req.session?.employee?.id || 0);
  const allowed = ['checked_in','technician','key_board','customer','missing'];

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_vehicle_keys(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL,
      repair_order_id INTEGER NOT NULL,
      key_tag TEXT,
      location TEXT,
      status TEXT NOT NULL DEFAULT 'checked_in',
      note TEXT,
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(shop_id,repair_order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_v2_vehicle_keys_shop_status ON v2_vehicle_keys(shop_id,status);
    CREATE INDEX IF NOT EXISTS idx_v2_vehicle_keys_ro ON v2_vehicle_keys(shop_id,repair_order_id);
  `);

  const auth = (req,res) => {
    const s=sid(req),e=eid(req);
    if(!validId(s)||!validId(e)){
      res.status(401).json({error:'A valid employee shop session is required.'});
      return null;
    }
    return {s,e};
  };

  app.get('/api/v2/keys',requireLogin,requireKeys,(req,res)=>{
    try{
      const a=auth(req,res); if(!a)return;
      const rows=db.prepare(`
        SELECT k.*,c.name customer_name,v.year,v.make,v.model,e.name technician_name
        FROM v2_vehicle_keys k
        JOIN repair_orders r ON r.id=k.repair_order_id AND r.shop_id=k.shop_id
        JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        LEFT JOIN v2_ro_assignments a ON a.repair_order_id=r.id AND a.shop_id=r.shop_id
        LEFT JOIN employees e ON e.id=a.employee_id AND e.shop_id=r.shop_id
        WHERE k.shop_id=? AND COALESCE(r.workflow_status,'')!='delivered'
        ORDER BY CASE k.status WHEN 'missing' THEN 0 WHEN 'technician' THEN 1 ELSE 2 END,k.updated_at DESC,k.id DESC
        LIMIT 500
      `).all(a.s);
      return res.json(rows);
    }catch(err){
      console.error('Garavex V2 key board error:',err);
      return res.status(500).json({error:'Unable to load vehicle key custody.'});
    }
  });

  app.put('/api/v2/repair-orders/:id/key',requireLogin,requireKeys,(req,res)=>{
    try{
      const a=auth(req,res); if(!a)return;
      const ro=Number(req.params.id);
      if(!validId(ro))return res.status(400).json({error:'Valid repair order ID is required.'});
      const status=String(req.body?.status||'checked_in').trim().toLowerCase();
      if(!allowed.includes(status))return res.status(400).json({error:'Invalid key status.'});

      const order=db.prepare(`SELECT id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(ro,a.s);
      if(!order)return res.status(404).json({error:'Repair order not found.'});
      const delivered=String(order.workflow_status||'').toLowerCase()==='delivered';
      if(delivered&&status!=='customer')return res.status(409).json({error:'Delivered vehicle keys must remain returned to the customer.'});
      if(order.status==='completed'&&!delivered&&status==='missing')return res.status(409).json({error:'A completed repair order cannot be newly marked with a missing key.'});

      const tag=String(req.body?.key_tag||'').trim().slice(0,100);
      const location=String(req.body?.location||'').trim().slice(0,300);
      const note=String(req.body?.note||'').trim().slice(0,1000);
      if(status==='missing'&&!note)return res.status(400).json({error:'Add a note describing the missing key situation.'});
      if(status==='technician'&&!location)return res.status(400).json({error:'Record who or where the technician key is with.'});
      if(status==='key_board'&&!location)return res.status(400).json({error:'Record the key board location.'});
      if(status==='customer'&&!delivered)return res.status(409).json({error:'Keys can only be marked returned to the customer as part of vehicle delivery.'});

      const previous=db.prepare(`SELECT * FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=?`).get(a.s,ro);
      if(previous&&previous.status===status&&String(previous.key_tag||'')===tag&&String(previous.location||'')===location&&String(previous.note||'')===note)return res.json({ok:true,status,unchanged:true});

      const tx=db.transaction(()=>{
        if(previous){
          const changed=db.prepare(`UPDATE v2_vehicle_keys SET key_tag=?,location=?,status=?,note=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status=?`).run(tag,location,status,note,a.e,previous.id,a.s,previous.status);
          if(changed.changes!==1)throw new Error('Key custody changed before update.');
        }else{
          db.prepare(`INSERT INTO v2_vehicle_keys(shop_id,repair_order_id,key_tag,location,status,note,updated_by) VALUES(?,?,?,?,?,?,?)`).run(a.s,ro,tag,location,status,note,a.e);
        }
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'vehicle.key_updated','repair_order',ro,JSON.stringify({previous_status:previous?.status||null,status,key_tag:tag,location,note}));
      });
      try{tx();}catch(err){return res.status(409).json({error:'Vehicle key custody changed before this update could be saved.'});}
      return res.json({ok:true,status});
    }catch(err){
      console.error('Garavex V2 key update error:',err);
      return res.status(500).json({error:'Unable to update vehicle key custody.'});
    }
  });
}

module.exports={installV2Keys};
