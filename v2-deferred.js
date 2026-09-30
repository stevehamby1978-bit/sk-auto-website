const { permissionMiddleware } = require('./v2-permissions');

function installV2Deferred(app,db,{requireLogin}){
  if(!app||!db)throw new Error('V2 deferred services require app and db.');
  if(!requireLogin)throw new Error('V2 deferred services require login middleware.');
  const requireDeferred=permissionMiddleware('repair_orders');
  const validId=v=>Number.isInteger(v)&&v>0;
  const sid=req=>Number(req.session?.employee?.shop_id||0);
  const eid=req=>Number(req.session?.employee?.id||0);
  const auth=(req,res)=>{const s=sid(req),e=eid(req);if(!validId(s)||!validId(e)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{s,e};};

  try{
    const cols=db.prepare(`PRAGMA table_info(deferred_services)`).all().map(x=>x.name);
    if(cols.length){
      if(!cols.includes('resolved_by'))db.exec(`ALTER TABLE deferred_services ADD COLUMN resolved_by INTEGER`);
      if(!cols.includes('updated_at'))db.exec(`ALTER TABLE deferred_services ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deferred_shop_status_followup ON deferred_services(shop_id,status,follow_up_date);CREATE INDEX IF NOT EXISTS idx_deferred_ro ON deferred_services(shop_id,repair_order_id,status);`);
    }
  }catch(err){console.error('Garavex V2 deferred migration error:',err);}

  app.get('/api/v2/deferred',requireLogin,requireDeferred,(req,res)=>{
    try{const a=auth(req,res);if(!a)return;const rows=db.prepare(`SELECT d.*,c.name customer_name,v.year,v.make,v.model,CASE WHEN d.status='deferred' AND d.follow_up_date IS NOT NULL AND date(d.follow_up_date)<date('now') THEN 1 ELSE 0 END overdue FROM deferred_services d JOIN customers c ON c.id=d.customer_id AND c.shop_id=d.shop_id LEFT JOIN vehicles v ON v.id=d.vehicle_id AND v.shop_id=d.shop_id WHERE d.shop_id=? ORDER BY overdue DESC,CASE WHEN d.status='deferred' THEN 0 WHEN d.status='scheduled' THEN 1 ELSE 2 END,d.follow_up_date,d.created_at DESC,d.id DESC LIMIT 300`).all(a.s);return res.json(rows);}catch(err){console.error('Garavex V2 deferred list error:',err);return res.status(500).json({error:'Unable to load deferred services.'});}
  });

  app.post('/api/v2/deferred',requireLogin,requireDeferred,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const customer=Number(req.body?.customer_id),vehicleRaw=req.body?.vehicle_id,roRaw=req.body?.repair_order_id;
      const vehicle=vehicleRaw===undefined||vehicleRaw===null||vehicleRaw===''?null:Number(vehicleRaw),ro=roRaw===undefined||roRaw===null||roRaw===''?null:Number(roRaw);
      const description=String(req.body?.description||'').trim().slice(0,2000),total=Number(req.body?.estimated_total||0),follow=String(req.body?.follow_up_date||'').trim()||null;
      if(!validId(customer))return res.status(400).json({error:'Valid customer ID is required.'});if(vehicle!==null&&!validId(vehicle))return res.status(400).json({error:'Valid vehicle ID is required.'});if(ro!==null&&!validId(ro))return res.status(400).json({error:'Valid repair order ID is required.'});
      if(!db.prepare(`SELECT id FROM customers WHERE id=? AND shop_id=?`).get(customer,a.s))return res.status(404).json({error:'Customer not found.'});
      if(vehicle&&!db.prepare(`SELECT id FROM vehicles WHERE id=? AND customer_id=? AND shop_id=?`).get(vehicle,customer,a.s))return res.status(404).json({error:'Vehicle not found for this customer.'});
      if(ro){const order=db.prepare(`SELECT id,customer_id,vehicle_id FROM repair_orders WHERE id=? AND shop_id=?`).get(ro,a.s);if(!order)return res.status(404).json({error:'Repair order not found.'});if(order.customer_id!==customer||(vehicle&&order.vehicle_id!==vehicle))return res.status(400).json({error:'Repair order does not match the selected customer/vehicle.'});}
      if(!description)return res.status(400).json({error:'Deferred service description is required.'});if(!Number.isFinite(total)||total<0||total>10000000)return res.status(400).json({error:'Estimated total is invalid.'});if(follow&&Number.isNaN(Date.parse(follow)))return res.status(400).json({error:'Follow-up date is invalid.'});
      const duplicate=db.prepare(`SELECT id FROM deferred_services WHERE shop_id=? AND customer_id=? AND COALESCE(vehicle_id,0)=COALESCE(?,0) AND description=? AND status IN('deferred','scheduled') LIMIT 1`).get(a.s,customer,vehicle,description);if(duplicate)return res.status(409).json({error:'An identical active deferred service already exists.',id:duplicate.id});
      const tx=db.transaction(()=>{const info=db.prepare(`INSERT INTO deferred_services(shop_id,customer_id,vehicle_id,repair_order_id,description,estimated_total,follow_up_date) VALUES(?,?,?,?,?,?,?)`).run(a.s,customer,vehicle,ro,description,total,follow);db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'deferred.created','deferred_service',info.lastInsertRowid,JSON.stringify({customer_id:customer,vehicle_id:vehicle,repair_order_id:ro,description,estimated_total:total,follow_up_date:follow}));return info.lastInsertRowid;});return res.json({ok:true,id:tx()});
    }catch(err){console.error('Garavex V2 deferred creation error:',err);return res.status(500).json({error:'Unable to create the deferred service.'});}
  });

  app.patch('/api/v2/deferred/:id',requireLogin,requireDeferred,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const recordId=Number(req.params.id);if(!validId(recordId))return res.status(400).json({error:'Valid deferred service ID is required.'});
      const row=db.prepare(`SELECT * FROM deferred_services WHERE id=? AND shop_id=?`).get(recordId,a.s);if(!row)return res.status(404).json({error:'Deferred service not found.'});if(['completed','dismissed'].includes(row.status))return res.status(409).json({error:'Resolved deferred services cannot be changed.'});
      const status=String(req.body?.status||row.status).trim().toLowerCase(),follow=req.body?.follow_up_date===undefined?row.follow_up_date:(String(req.body.follow_up_date||'').trim()||null);if(!['deferred','scheduled','completed','dismissed'].includes(status))return res.status(400).json({error:'Invalid status.'});if(row.status==='scheduled'&&status==='deferred')return res.status(409).json({error:'Deferred service status cannot move backward from scheduled to deferred.'});if(follow&&Number.isNaN(Date.parse(follow)))return res.status(400).json({error:'Follow-up date is invalid.'});if(status==='scheduled'&&!follow)return res.status(400).json({error:'A follow-up date is required when scheduling deferred work.'});if(status===row.status&&String(follow||'')===String(row.follow_up_date||''))return res.json({ok:true,unchanged:true});
      const closing=['completed','dismissed'].includes(status);
      const tx=db.transaction(()=>{const changed=db.prepare(`UPDATE deferred_services SET status=?,follow_up_date=?,resolved_by=CASE WHEN ? THEN ? ELSE resolved_by END,resolved_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE resolved_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status=?`).run(status,follow,closing?1:0,a.e,closing?1:0,recordId,a.s,row.status);if(changed.changes!==1)throw new Error('DEFERRED_CHANGED');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'deferred.updated','deferred_service',recordId,JSON.stringify({previous_status:row.status,status,previous_follow_up_date:row.follow_up_date,follow_up_date:follow,resolved_by:closing?a.e:null}));});
      try{tx();}catch(err){return res.status(409).json({error:'Deferred service changed before this update could be saved.'});}return res.json({ok:true,status});
    }catch(err){console.error('Garavex V2 deferred update error:',err);return res.status(500).json({error:'Unable to update the deferred service.'});}
  });
}
module.exports={installV2Deferred};
