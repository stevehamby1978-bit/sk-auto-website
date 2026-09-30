function installV2Checkin(app, db, { requireLogin }) {
  const sid=req=>Number(req.session.employee.shop_id);
  const eid=req=>Number(req.session.employee.id);
  const owns=(table,id,shop)=>db.prepare(`SELECT * FROM ${table} WHERE id=? AND shop_id=?`).get(id,shop);
  const audit=(req,action,type,id,details)=>db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)VALUES(?,?,?,?,?,?)`).run(sid(req),eid(req),action,type,id,JSON.stringify(details||{}));

  app.get('/api/v2/checkin/customers',requireLogin,(req,res)=>{
    const q=`%${String(req.query.q||'').trim()}%`;
    if(q==='%%')return res.json([]);
    res.json(db.prepare(`SELECT c.id,c.name,c.phone,c.email,v.id vehicle_id,v.year,v.make,v.model,v.vin,v.mileage FROM customers c LEFT JOIN vehicles v ON v.customer_id=c.id AND v.shop_id=c.shop_id WHERE c.shop_id=? AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR v.vin LIKE ?) ORDER BY c.name LIMIT 25`).all(sid(req),q,q,q,q));
  });

  app.post('/api/v2/checkin',requireLogin,(req,res)=>{
    const shop=sid(req),customerId=Number(req.body.customer_id),vehicleId=Number(req.body.vehicle_id);
    if(!owns('customers',customerId,shop))return res.status(404).json({error:'Customer not found.'});
    const vehicle=owns('vehicles',vehicleId,shop); if(!vehicle||Number(vehicle.customer_id)!==customerId)return res.status(400).json({error:'Vehicle does not belong to this customer.'});
    const concern=String(req.body.customer_concern||'').trim(); if(!concern)return res.status(400).json({error:'Customer concern is required.'});
    const mileage=String(req.body.mileage||'').trim();
    if(mileage)db.prepare(`UPDATE vehicles SET mileage=? WHERE id=? AND shop_id=?`).run(mileage,vehicleId,shop);
    const existing=db.prepare(`SELECT id FROM repair_orders WHERE shop_id=? AND customer_id=? AND vehicle_id=? AND status!='completed' ORDER BY id DESC LIMIT 1`).get(shop,customerId,vehicleId);
    let roId=existing?.id;
    if(roId){db.prepare(`UPDATE repair_orders SET customer_concern=?,workflow_status=COALESCE(NULLIF(workflow_status,''),'waiting') WHERE id=? AND shop_id=?`).run(concern,roId,shop);}else{
      const info=db.prepare(`INSERT INTO repair_orders(customer_id,vehicle_id,status,shop_id,customer_concern,workflow_status) VALUES(?,?,'waiting',?,?,'waiting')`).run(customerId,vehicleId,shop,concern);roId=info.lastInsertRowid;
    }
    audit(req,'vehicle.checkin','repair_order',roId,{customer_id:customerId,vehicle_id:vehicleId,mileage,concern});
    res.json({ok:true,repair_order_id:roId,reused_existing:Boolean(existing)});
  });
}
module.exports={installV2Checkin};
