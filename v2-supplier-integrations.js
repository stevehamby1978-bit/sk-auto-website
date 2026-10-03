/* GARAVEX supplier integration foundation.
 * Live ordering stays disabled until an authorized supplier connector is configured.
 */
const PROVIDERS={
  oreilly:{name:"O'Reilly Pro",modes:['api','punchout']},
  autozone:{name:'AutoZone Pro',modes:['api','punchout']}
};
function validId(v){return Number.isInteger(Number(v))&&Number(v)>0}
function installV2SupplierIntegrations(app,db,{requireLogin,requireOwner}){
 const noCache=(req,res,next)=>{res.set('Cache-Control','no-store, private, max-age=0');next()};
 const shop=req=>Number(req.session?.employee?.shop_id||0);
 app.get('/api/v2/supplier-integrations',requireLogin,noCache,(req,res)=>{
  const sid=shop(req);if(!sid)return res.status(401).json({error:'Login required.'});
  const rows=db.prepare('SELECT id,provider,display_name,connection_mode,status,account_label,live_ordering_enabled,last_verified_at,created_at,updated_at FROM supplier_integrations WHERE shop_id=? ORDER BY provider').all(sid);
  const by=new Map(rows.map(r=>[r.provider,r]));
  res.json(Object.entries(PROVIDERS).map(([provider,p])=>({...p,provider,connection:by.get(provider)||null})));
 });
 app.put('/api/v2/supplier-integrations/:provider',requireLogin,requireOwner,noCache,(req,res)=>{
  const sid=shop(req),provider=String(req.params.provider||'').toLowerCase(),def=PROVIDERS[provider];
  if(!sid)return res.status(401).json({error:'Login required.'});if(!def)return res.status(400).json({error:'Unsupported supplier.'});
  const mode=String(req.body?.connection_mode||'punchout').toLowerCase();if(!def.modes.includes(mode))return res.status(400).json({error:'Unsupported connection mode.'});
  const label=String(req.body?.account_label||'').trim().slice(0,120);
  db.prepare(`INSERT INTO supplier_integrations(shop_id,provider,display_name,connection_mode,status,account_label,live_ordering_enabled,updated_at)
   VALUES(?,?,?,?,?,?,0,CURRENT_TIMESTAMP)
   ON CONFLICT(shop_id,provider) DO UPDATE SET display_name=excluded.display_name,connection_mode=excluded.connection_mode,account_label=excluded.account_label,updated_at=CURRENT_TIMESTAMP`)
   .run(sid,provider,def.name,mode,'awaiting_partner_credentials',label);
  const row=db.prepare('SELECT id,provider,display_name,connection_mode,status,account_label,live_ordering_enabled,last_verified_at FROM supplier_integrations WHERE shop_id=? AND provider=?').get(sid,provider);
  res.json({success:true,connection:row,message:'Supplier staged. Live ordering remains disabled until authorized partner credentials are installed.'});
 });
 app.post('/api/v2/supplier-integrations/:provider/order',requireLogin,noCache,(req,res)=>{
  const sid=shop(req),provider=String(req.params.provider||'').toLowerCase();
  if(!sid)return res.status(401).json({error:'Login required.'});if(!PROVIDERS[provider])return res.status(400).json({error:'Unsupported supplier.'});
  const connection=db.prepare('SELECT * FROM supplier_integrations WHERE shop_id=? AND provider=?').get(sid,provider);
  if(!connection||!connection.live_ordering_enabled)return res.status(409).json({error:'Live supplier ordering is not enabled yet. GARAVEX needs authorized integration credentials from this supplier.',code:'SUPPLIER_NOT_LIVE'});
  return res.status(501).json({error:'Supplier connector is staged but its live adapter has not been installed.',code:'SUPPLIER_ADAPTER_REQUIRED'});
 });
 app.post('/api/v2/supplier-order-drafts',requireLogin,noCache,(req,res)=>{
  const sid=shop(req),provider=String(req.body?.provider||'').toLowerCase(),ro=Number(req.body?.repair_order_id);
  if(!sid)return res.status(401).json({error:'Login required.'});if(!PROVIDERS[provider])return res.status(400).json({error:'Unsupported supplier.'});if(!validId(ro))return res.status(400).json({error:'Valid repair order is required.'});
  const order=db.prepare('SELECT id FROM repair_orders WHERE id=? AND shop_id=?').get(ro,sid);if(!order)return res.status(404).json({error:'Repair order not found.'});
  const result=db.prepare("INSERT INTO supplier_order_drafts(shop_id,provider,repair_order_id,status,created_by) VALUES(?,?,?,'draft',?)").run(sid,provider,ro,Number(req.session.employee.id)||null);
  res.status(201).json({success:true,id:Number(result.lastInsertRowid),status:'draft'});
 });
 app.get('/api/v2/supplier-order-drafts/:id',requireLogin,noCache,(req,res)=>{
  const sid=shop(req),id=Number(req.params.id),draft=db.prepare('SELECT * FROM supplier_order_drafts WHERE id=? AND shop_id=?').get(id,sid);
  if(!draft)return res.status(404).json({error:'Supplier order draft not found.'});
  const items=db.prepare('SELECT * FROM supplier_order_draft_items WHERE draft_id=? AND shop_id=? ORDER BY id').all(id,sid);
  const connection=db.prepare('SELECT provider,display_name,status,live_ordering_enabled FROM supplier_integrations WHERE shop_id=? AND provider=?').get(sid,draft.provider);
  res.json({...draft,items,connection:connection||null});
 });
 app.post('/api/v2/supplier-order-drafts/:id/create-po',requireLogin,noCache,(req,res)=>{
  const sid=shop(req),id=Number(req.params.id),draft=db.prepare("SELECT * FROM supplier_order_drafts WHERE id=? AND shop_id=? AND status='draft'").get(id,sid);
  if(!draft)return res.status(404).json({error:'Supplier order draft not found.'});
  const items=db.prepare('SELECT * FROM supplier_order_draft_items WHERE draft_id=? AND shop_id=? ORDER BY id').all(id,sid);if(!items.length)return res.status(400).json({error:'Add at least one part before creating a purchase order.'});
  const providerName=PROVIDERS[draft.provider]?.name||draft.provider;
  const result=db.transaction(()=>{let vendor=db.prepare('SELECT id FROM vendors WHERE shop_id=? AND LOWER(name)=LOWER(?) LIMIT 1').get(sid,providerName);let vendorId=vendor?.id;if(!vendorId)vendorId=Number(db.prepare('INSERT INTO vendors(shop_id,name,active) VALUES(?,?,1)').run(sid,providerName).lastInsertRowid);
    const po=db.prepare("INSERT INTO purchase_orders(shop_id,vendor_id,repair_order_id,status,notes) VALUES(?,?,?,'draft',?)").run(sid,vendorId,draft.repair_order_id,'Created from GARAVEX supplier order draft #'+id);
    const poId=Number(po.lastInsertRowid),poNumber='PO-'+sid+'-'+String(poId).padStart(6,'0');db.prepare('UPDATE purchase_orders SET po_number=? WHERE id=? AND shop_id=?').run(poNumber,poId,sid);
    const ins=db.prepare('INSERT INTO purchase_order_items(shop_id,purchase_order_id,part_number,description,quantity,unit_cost) VALUES(?,?,?,?,?,?)');for(const x of items)ins.run(sid,poId,x.part_number,x.description,x.quantity,x.unit_cost);
    db.prepare("UPDATE supplier_order_drafts SET purchase_order_id=?,status='po_created',updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=?").run(poId,id,sid);return {poId,poNumber};})();
  res.status(201).json({success:true,id:result.poId,po_number:result.poNumber});
 });
 app.post('/api/v2/supplier-order-drafts/:id/items',requireLogin,noCache,(req,res)=>{
  const sid=shop(req),id=Number(req.params.id),d=db.prepare("SELECT * FROM supplier_order_drafts WHERE id=? AND shop_id=? AND status='draft'").get(id,sid);
  if(!d)return res.status(404).json({error:'Supplier order draft not found.'});
  const part=String(req.body?.part_number||'').trim().slice(0,120),desc=String(req.body?.description||'').trim().slice(0,250),qty=Number(req.body?.quantity||1),cost=Number(req.body?.unit_cost||0),sell=Number(req.body?.sell_price||0);
  if(!desc||!Number.isFinite(qty)||qty<=0||!Number.isFinite(cost)||cost<0||!Number.isFinite(sell)||sell<0)return res.status(400).json({error:'Valid description, quantity, cost and selling price are required.'});
  const r=db.prepare('INSERT INTO supplier_order_draft_items(shop_id,draft_id,part_number,description,quantity,unit_cost,sell_price) VALUES(?,?,?,?,?,?,?)').run(sid,id,part,desc,qty,cost,sell);
  res.status(201).json({success:true,id:Number(r.lastInsertRowid)});
 });
}
module.exports={installV2SupplierIntegrations,PROVIDERS};
