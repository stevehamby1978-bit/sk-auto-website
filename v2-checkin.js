function installV2Checkin(app, db, { requireLogin }) {
  if(!app||!db)throw new Error('V2 check-in requires app and db.');
  if(!requireLogin)throw new Error('V2 check-in requires login middleware.');
  const validId=v=>Number.isInteger(v)&&v>0;
  const sid=req=>Number(req.session?.employee?.shop_id||0);
  const eid=req=>Number(req.session?.employee?.id||0);
  const auth=(req,res)=>{const shop=sid(req),employee=eid(req);if(!validId(shop)||!validId(employee)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{shop,employee};};

  app.get('/api/v2/checkin/customers',requireLogin,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const raw=String(req.query.q||'').trim();
      if(!raw)return res.json([]);
      if(raw.length>120)return res.status(400).json({error:'Search query is too long.'});
      const q=`%${raw}%`;
      return res.json(db.prepare(`SELECT c.id,c.name,c.phone,c.email,v.id vehicle_id,v.year,v.make,v.model,v.vin,v.mileage FROM customers c LEFT JOIN vehicles v ON v.customer_id=c.id AND v.shop_id=c.shop_id WHERE c.shop_id=? AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR v.vin LIKE ?) ORDER BY c.name LIMIT 25`).all(a.shop,q,q,q,q));
    }catch(err){console.error('Garavex V2 check-in search error:',err);return res.status(500).json({error:'Unable to search check-in customers.'});}
  });

  app.post('/api/v2/checkin',requireLogin,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const customerId=Number(req.body?.customer_id),vehicleId=Number(req.body?.vehicle_id);
      if(!validId(customerId)||!validId(vehicleId))return res.status(400).json({error:'Valid customer and vehicle IDs are required.'});
      const concern=String(req.body?.customer_concern||'').trim();
      if(!concern)return res.status(400).json({error:'Customer concern is required.'});
      if(concern.length>4000)return res.status(400).json({error:'Customer concern cannot exceed 4000 characters.'});
      const mileageRaw=req.body?.mileage;
      const mileage=mileageRaw===undefined||mileageRaw===null||String(mileageRaw).trim()===''?null:Number(mileageRaw);
      if(mileage!==null&&(!Number.isInteger(mileage)||mileage<0||mileage>10000000))return res.status(400).json({error:'Vehicle mileage is invalid.'});
      let roId=null,reused=false;
      const tx=db.transaction(()=>{
        const customer=db.prepare(`SELECT id FROM customers WHERE id=? AND shop_id=?`).get(customerId,a.shop);if(!customer)throw new Error('CUSTOMER_NOT_FOUND');
        const vehicle=db.prepare(`SELECT id,customer_id,mileage FROM vehicles WHERE id=? AND shop_id=?`).get(vehicleId,a.shop);if(!vehicle||Number(vehicle.customer_id)!==customerId)throw new Error('VEHICLE_MISMATCH');
        if(mileage!==null){const current=Number(vehicle.mileage);if(Number.isFinite(current)&&current>mileage)throw new Error('MILEAGE_DECREASED');const changed=db.prepare(`UPDATE vehicles SET mileage=? WHERE id=? AND shop_id=? AND customer_id=?`).run(String(mileage),vehicleId,a.shop,customerId);if(changed.changes!==1)throw new Error('VEHICLE_CHANGED');}
        const existing=db.prepare(`SELECT id,status,workflow_status FROM repair_orders WHERE shop_id=? AND customer_id=? AND vehicle_id=? AND status!='completed' AND LOWER(COALESCE(workflow_status,''))!='delivered' ORDER BY id DESC LIMIT 1`).get(a.shop,customerId,vehicleId);
        if(existing){const changed=db.prepare(`UPDATE repair_orders SET customer_concern=?,workflow_status=COALESCE(NULLIF(workflow_status,''),'waiting') WHERE id=? AND shop_id=? AND customer_id=? AND vehicle_id=? AND status!='completed' AND LOWER(COALESCE(workflow_status,''))!='delivered'`).run(concern,existing.id,a.shop,customerId,vehicleId);if(changed.changes!==1)throw new Error('RO_CHANGED');roId=existing.id;reused=true;}else{const info=db.prepare(`INSERT INTO repair_orders(customer_id,vehicle_id,status,shop_id,customer_concern,workflow_status) VALUES(?,?,'waiting',?,?,'waiting')`).run(customerId,vehicleId,a.shop,concern);roId=info.lastInsertRowid;}
        db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)VALUES(?,?,?,?,?,?)`).run(a.shop,a.employee,'vehicle.checkin','repair_order',roId,JSON.stringify({customer_id:customerId,vehicle_id:vehicleId,mileage,concern,reused_existing:reused}));
      });
      try{tx();}catch(err){const code=String(err.message||'');if(code==='CUSTOMER_NOT_FOUND')return res.status(404).json({error:'Customer not found.'});if(code==='VEHICLE_MISMATCH')return res.status(400).json({error:'Vehicle does not belong to this customer.'});if(code==='MILEAGE_DECREASED')return res.status(409).json({error:'Check-in mileage cannot be lower than the vehicle mileage already on file.'});if(code==='VEHICLE_CHANGED'||code==='RO_CHANGED')return res.status(409).json({error:'Check-in data changed before it could be saved. Refresh and try again.'});throw err;}
      return res.json({ok:true,repair_order_id:roId,reused_existing:reused});
    }catch(err){console.error('Garavex V2 check-in error:',err);return res.status(500).json({error:'Unable to check in the vehicle.'});}
  });
}
module.exports={installV2Checkin};
