const { permissionMiddleware } = require('./v2-permissions');

function installV2Keys(app, db, { requireLogin }) {
  if (!app || !db) throw new Error('V2 vehicle keys require app and db.');
  if (!requireLogin) throw new Error('V2 vehicle keys require login middleware.');

  const requireKeys = permissionMiddleware('keys');
  const validId = value => Number.isInteger(value) && value > 0;
  const sid = req => Number(req.session?.employee?.shop_id || 0);
  const eid = req => Number(req.session?.employee?.id || 0);
  const allowed = ['checked_in','technician','board','customer','missing'];
  const transitions = {
    checked_in:['technician','board','missing'],
    technician:['checked_in','board','missing'],
    board:['checked_in','technician','missing'],
    missing:['checked_in','technician','board'],
    customer:[]
  };

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

  /* Normalize the early V2 key_board state to the canonical board state used by delivery guards. */
  db.prepare(`UPDATE v2_vehicle_keys SET status='board' WHERE status='key_board'`).run();

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
        SELECT k.*,c.name customer_name,v.year,v.make,v.model,
               (SELECT e.name FROM v2_ro_assignments ra JOIN employees e ON e.id=ra.employee_id AND e.shop_id=ra.shop_id WHERE ra.repair_order_id=r.id AND ra.shop_id=r.shop_id ORDER BY ra.id DESC LIMIT 1) technician_name
        FROM v2_vehicle_keys k
        JOIN repair_orders r ON r.id=k.repair_order_id AND r.shop_id=k.shop_id
        JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
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
      if(delivered)return res.status(409).json({error:'Delivered vehicle key custody is final and cannot be edited.'});
      if(order.status==='completed'&&status==='missing')return res.status(409).json({error:'A completed repair order cannot be newly marked with a missing key.'});
      if(status==='customer')return res.status(409).json({error:'Keys are returned to the customer automatically when vehicle delivery is completed.'});

      const tag=String(req.body?.key_tag||'').trim().slice(0,100);
      const location=String(req.body?.location||'').trim().slice(0,300);
      const note=String(req.body?.note||'').trim().slice(0,1000);
      if(status==='missing'&&!note)return res.status(400).json({error:'Add a note describing the missing key situation.'});
      if(status==='technician'&&!location)return res.status(400).json({error:'Record who or where the technician key is with.'});
      if(status==='board'&&!location)return res.status(400).json({error:'Record the key board location.'});

      const previous=db.prepare(`SELECT * FROM v2_vehicle_keys WHERE shop_id=? AND repair_order_id=?`).get(a.s,ro);
      if(previous&&previous.status==='customer')return res.status(409).json({error:'Returned customer key custody is final.'});
      if(previous&&previous.status!==status&&!(transitions[previous.status]||[]).includes(status))return res.status(409).json({error:`Cannot change key custody from ${previous.status} to ${status}.`});
      if(previous&&previous.status===status&&String(previous.key_tag||'')===tag&&String(previous.location||'')===location&&String(previous.note||'')===note)return res.json({ok:true,status,unchanged:true});

      const tx=db.transaction(()=>{
        if(previous){
          const changed=db.prepare(`UPDATE v2_vehicle_keys SET key_tag=?,location=?,status=?,note=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status=?`).run(tag,location,status,note,a.e,previous.id,a.s,previous.status);
          if(changed.changes!==1)throw new Error('KEY_CHANGED');
        }else{
          if(status!=='checked_in')throw new Error('KEY_INITIAL_STATE');
          db.prepare(`INSERT INTO v2_vehicle_keys(shop_id,repair_order_id,key_tag,location,status,note,updated_by) VALUES(?,?,?,?,?,?,?)`).run(a.s,ro,tag,location,status,note,a.e);
        }
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'vehicle.key_updated','repair_order',ro,JSON.stringify({previous_status:previous?.status||null,status,key_tag:tag,location,note}));
      });
      try{tx();}catch(err){if(String(err.message).includes('KEY_INITIAL_STATE'))return res.status(409).json({error:'New key custody records must begin checked in.'});return res.status(409).json({error:'Vehicle key custody changed before this update could be saved.'});}
      return res.json({ok:true,status});
    }catch(err){
      console.error('Garavex V2 key update error:',err);
      return res.status(500).json({error:'Unable to update vehicle key custody.'});
    }
  });
}

module.exports={installV2Keys};
