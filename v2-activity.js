function installV2Activity(app,db,{requireLogin}){
 const sid=req=>Number(req.session.employee.shop_id);
 app.get('/api/v2/activity',requireLogin,(req,res)=>{const shop=sid(req),limit=Math.min(100,Math.max(10,Number(req.query.limit)||40));const rows=db.prepare(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.created_at,e.name employee_name FROM audit_log a LEFT JOIN employees e ON e.id=a.employee_id AND e.shop_id=a.shop_id WHERE a.shop_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT ?`).all(shop,limit);res.json(rows.map(x=>{let details={};try{details=JSON.parse(x.details||'{}')}catch{details={text:x.details||''}}return {...x,details}}));});
}
module.exports={installV2Activity};
