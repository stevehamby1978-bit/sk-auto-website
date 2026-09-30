const crypto=require('crypto');
const {permissionMiddleware}=require('./v2-permissions');

function installV2CustomerPortal(app,db,{requireLogin}){
 if(!app||!db)throw new Error('V2 customer portal requires app and db.');
 if(!requireLogin)throw new Error('V2 customer portal requires login middleware.');
 const sid=req=>Number(req.session?.employee?.shop_id||0),eid=req=>Number(req.session?.employee?.id||0),requirePortal=permissionMiddleware('customers'),validId=x=>Number.isInteger(x)&&x>0,makeToken=()=>crypto.randomBytes(32).toString('hex');
 const audit=(s,e,a,id,d)=>db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)VALUES(?,?,?,?,?,?)`).run(s,e,a,'customer_portal_token',id,JSON.stringify(d||{}));
 const noStore=res=>{res.set('Cache-Control','no-store, private');res.set('Pragma','no-cache');res.set('Referrer-Policy','no-referrer');res.set('X-Content-Type-Options','nosniff');};

 app.post('/api/v2/customers/:id/portal-token',requireLogin,requirePortal,(req,res)=>{
  const s=sid(req),e=eid(req),cid=Number(req.params.id);noStore(res);
  if(!validId(s)||!validId(e))return res.status(401).json({error:'A valid employee shop session is required.'});
  if(!validId(cid))return res.status(400).json({error:'Valid customer ID is required.'});
  const customer=db.prepare(`SELECT id FROM customers WHERE id=? AND shop_id=?`).get(cid,s);if(!customer)return res.status(404).json({error:'Customer not found.'});
  const enabled=db.prepare(`SELECT customer_portal_enabled FROM shops WHERE id=?`).get(s);if(!enabled||Number(enabled.customer_portal_enabled)!==1)return res.status(403).json({error:'Customer portal is disabled for this shop.'});
  const value=makeToken();
  const tx=db.transaction(()=>{db.prepare(`UPDATE customer_portal_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE shop_id=? AND customer_id=? AND revoked_at IS NULL`).run(s,cid);const info=db.prepare(`INSERT INTO customer_portal_tokens(shop_id,customer_id,token,expires_at)VALUES(?,?,?,datetime('now','+30 days'))`).run(s,cid,value);audit(s,e,'portal.token_created',info.lastInsertRowid,{customer_id:cid,expires_in_days:30});return info.lastInsertRowid;});
  const id=tx();res.json({ok:true,id,url:`/customer-portal.html?token=${value}`,expires_in_days:30});
 });

 app.post('/api/v2/customers/:id/portal-revoke',requireLogin,requirePortal,(req,res)=>{
  const s=sid(req),e=eid(req),cid=Number(req.params.id);noStore(res);
  if(!validId(s)||!validId(e))return res.status(401).json({error:'A valid employee shop session is required.'});
  if(!validId(cid))return res.status(400).json({error:'Valid customer ID is required.'});
  if(!db.prepare(`SELECT id FROM customers WHERE id=? AND shop_id=?`).get(cid,s))return res.status(404).json({error:'Customer not found.'});
  const info=db.prepare(`UPDATE customer_portal_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE shop_id=? AND customer_id=? AND revoked_at IS NULL`).run(s,cid);audit(s,e,'portal.tokens_revoked',cid,{customer_id:cid,count:info.changes});res.json({ok:true,revoked:info.changes});
 });

 app.get('/api/v2/public/portal/:token',(req,res)=>{
  noStore(res);
  const value=String(req.params.token||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(value))return res.status(404).json({error:'Portal link is invalid or expired.'});
  const access=db.prepare(`SELECT t.id,t.shop_id,t.customer_id,t.expires_at FROM customer_portal_tokens t JOIN shops s ON s.id=t.shop_id AND s.customer_portal_enabled=1 JOIN customers c ON c.id=t.customer_id AND c.shop_id=t.shop_id WHERE t.token=? AND t.revoked_at IS NULL AND t.expires_at IS NOT NULL AND datetime(t.expires_at)>datetime('now')`).get(value);if(!access)return res.status(404).json({error:'Portal link is invalid or expired.'});
  const customer=db.prepare(`SELECT id,name FROM customers WHERE id=? AND shop_id=?`).get(access.customer_id,access.shop_id);if(!customer)return res.status(404).json({error:'Portal link is invalid or expired.'});
  const shop=db.prepare(`SELECT id,name FROM shops WHERE id=? AND customer_portal_enabled=1`).get(access.shop_id);if(!shop)return res.status(404).json({error:'Portal link is invalid or expired.'});
  const vehicles=db.prepare(`SELECT id,year,make,model,vin,engine,trim,license_plate,plate_state FROM vehicles WHERE customer_id=? AND shop_id=? ORDER BY year DESC,id DESC LIMIT 100`).all(access.customer_id,access.shop_id);
  const orders=db.prepare(`SELECT id,vehicle_id,status,workflow_status,payment_status,amount_paid,created_at,completed_at FROM repair_orders WHERE customer_id=? AND shop_id=? ORDER BY created_at DESC LIMIT 50`).all(access.customer_id,access.shop_id);
  const deferred=db.prepare(`SELECT id,vehicle_id,description,estimated_total,status,follow_up_date FROM deferred_services WHERE customer_id=? AND shop_id=? AND status IN('deferred','scheduled') ORDER BY created_at DESC LIMIT 100`).all(access.customer_id,access.shop_id);
  res.json({shop,customer,vehicles,orders,deferred,expires_at:access.expires_at});
 });
}
module.exports={installV2CustomerPortal};
