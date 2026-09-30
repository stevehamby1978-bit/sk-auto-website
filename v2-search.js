const {permissionMiddleware,validSessionEmployee}=require('./v2-permissions');
function installV2Search(app,db,{requireLogin}){
 if(!app||!db)throw new Error('V2 search requires app and db.');
 if(!requireLogin)throw new Error('V2 search requires authentication middleware.');
 const requireRepairOrders=permissionMiddleware('repair_orders');
 const empty=()=>({customers:[],vehicles:[],repair_orders:[]});
 app.get('/api/v2/search',requireLogin,requireRepairOrders,(req,res)=>{
  try{
   const employee=req.session?.employee;if(!validSessionEmployee(employee))return res.status(401).json({error:'A valid employee shop session is required.'});
   const s=Number(employee.shop_id),raw=String(req.query?.q||'').trim().slice(0,120);if(raw.length<2)return res.json(empty());
   const escaped=raw.replace(/[\\%_]/g,m=>'\\'+m),q=`%${escaped}%`;
   const numeric=/^\d{1,10}$/.test(raw)?Number(raw):null,id=Number.isSafeInteger(numeric)&&numeric>0?numeric:-1;
   const customers=db.prepare(`SELECT id,name,phone,email FROM customers WHERE shop_id=? AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY name LIMIT 20`).all(s,q,q,q);
   const vehicles=db.prepare(`SELECT v.id,v.customer_id,v.year,v.make,v.model,v.vin,c.name customer_name FROM vehicles v JOIN customers c ON c.id=v.customer_id AND c.shop_id=v.shop_id WHERE v.shop_id=? AND (v.make LIKE ? ESCAPE '\\' OR v.model LIKE ? ESCAPE '\\' OR v.vin LIKE ? ESCAPE '\\' OR CAST(v.year AS TEXT) LIKE ? ESCAPE '\\') ORDER BY v.id DESC LIMIT 20`).all(s,q,q,q,q);
   const ros=db.prepare(`SELECT r.id,r.status,r.workflow_status,r.created_at,c.id customer_id,c.name customer_name,v.year,v.make,v.model,v.vin FROM repair_orders r JOIN customers c ON c.id=r.customer_id AND c.shop_id=r.shop_id LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id WHERE r.shop_id=? AND (r.id=? OR c.name LIKE ? ESCAPE '\\' OR v.vin LIKE ? ESCAPE '\\' OR v.make LIKE ? ESCAPE '\\' OR v.model LIKE ? ESCAPE '\\') ORDER BY r.id DESC LIMIT 30`).all(s,id,q,q,q,q);
   return res.json({customers,vehicles,repair_orders:ros});
  }catch(err){console.error('Garavex V2 search error:',err);return res.status(500).json({error:'Search could not be completed.'});}
 });
}
module.exports={installV2Search};
