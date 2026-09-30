function installV2Quality(app, db, { requireLogin }) {
  const sid=req=>Number(req.session.employee.shop_id), eid=req=>Number(req.session.employee.id);
  const audit=(req,action,id,details)=>db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(sid(req),eid(req),action,'repair_order',id,JSON.stringify(details||{}));

  app.get('/api/v2/repair-orders/:id/quality',requireLogin,(req,res)=>{
    const shop=sid(req),id=Number(req.params.id);
    const ro=db.prepare(`SELECT r.id,r.status,r.workflow_status,r.customer_concern,r.technician_diagnosis,r.customer_id,r.vehicle_id,c.name customer_name,v.year,v.make,v.model,v.mileage FROM repair_orders r JOIN customers c ON c.id=r.customer_id LEFT JOIN vehicles v ON v.id=r.vehicle_id WHERE r.id=? AND r.shop_id=?`).get(id,shop);
    if(!ro)return res.status(404).json({error:'Repair order not found.'});
    const itemCount=db.prepare(`SELECT COUNT(*) n FROM repair_order_items WHERE repair_order_id=?`).get(id)?.n||0;
    const openTime=db.prepare(`SELECT COUNT(*) n FROM technician_time_entries WHERE shop_id=? AND repair_order_id=? AND clock_out IS NULL`).get(shop,id)?.n||0;
    const dvi=db.prepare(`SELECT id,status FROM dvi_inspections WHERE shop_id=? AND repair_order_id=? ORDER BY id DESC LIMIT 1`).get(shop,id);
    const checks=[
      {key:'customer_concern',label:'Customer concern documented',ok:Boolean(String(ro.customer_concern||'').trim())},
      {key:'mileage',label:'Vehicle mileage recorded',ok:Boolean(String(ro.mileage||'').trim())},
      {key:'line_items',label:'Repair order has line items',ok:itemCount>0},
      {key:'diagnosis',label:'Technician diagnosis documented',ok:Boolean(String(ro.technician_diagnosis||'').trim())},
      {key:'technician_time',label:'No technician clock still running',ok:openTime===0},
      {key:'inspection',label:'Digital inspection completed or intentionally skipped',ok:!dvi||['completed','sent','approved'].includes(String(dvi.status||''))}
    ];
    res.json({...ro,checks,ready:checks.every(x=>x.ok)});
  });

  app.post('/api/v2/repair-orders/:id/quality/approve',requireLogin,(req,res)=>{
    const shop=sid(req),id=Number(req.params.id),ro=db.prepare(`SELECT id FROM repair_orders WHERE id=? AND shop_id=?`).get(id,shop);if(!ro)return res.status(404).json({error:'Repair order not found.'});
    const note=String(req.body.note||'').trim();audit(req,'quality.approved',id,{note});
    db.prepare(`UPDATE repair_orders SET workflow_status='ready' WHERE id=? AND shop_id=?`).run(id,shop);
    res.json({ok:true,workflow_status:'ready'});
  });
}
module.exports={installV2Quality};
