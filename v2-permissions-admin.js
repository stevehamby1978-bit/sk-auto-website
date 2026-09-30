const {parsePermissions}=require('./v2-permissions');

function installV2PermissionsAdmin(app,db,{requireLogin,requireOwner}){
 const sid=req=>Number(req.session.employee.shop_id),eid=req=>Number(req.session.employee.id);
 const catalog={
  repair_orders:'Repair orders',dispatch:'Technician dispatch',dvi:'Digital inspections',time_clock:'Technician time',parts:'Parts requests',inventory:'Inventory & vendors',purchase_orders:'Purchase orders',customer_contact:'Customer contact & approvals',tasks:'Tasks',road_tests:'Road tests',keys:'Vehicle keys',loaners:'Loaner vehicles',delivery:'Final QC & delivery',reports:'Reports',settings:'Shop settings',employees:'Employee management',audit:'Audit log'
 };
 const valid=new Set(Object.keys(catalog));
 app.get('/api/v2/permissions/catalog',requireLogin,(req,res)=>res.json({permissions:catalog}));
 app.get('/api/v2/employees/:id/permissions',requireLogin,requireOwner,(req,res)=>{const s=sid(req),id=Number(req.params.id),emp=db.prepare(`SELECT id,name,role,permissions_json FROM employees WHERE id=? AND shop_id=?`).get(id,s);if(!emp)return res.status(404).json({error:'Employee not found.'});res.json({id:emp.id,name:emp.name,role:emp.role,permissions:parsePermissions(emp)});});
 app.put('/api/v2/employees/:id/permissions',requireLogin,requireOwner,(req,res)=>{const s=sid(req),id=Number(req.params.id),emp=db.prepare(`SELECT id,name,role,permissions_json FROM employees WHERE id=? AND shop_id=?`).get(id,s);if(!emp)return res.status(404).json({error:'Employee not found.'});if(emp.role==='owner')return res.status(409).json({error:'Owner permissions cannot be restricted.'});const incoming=req.body&&req.body.permissions;if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({error:'Permissions object is required.'});const clean={};for(const key of valid)clean[key]=incoming[key]===true;const previous=parsePermissions(emp),json=JSON.stringify(clean);const tx=db.transaction(()=>{db.prepare(`UPDATE employees SET permissions_json=? WHERE id=? AND shop_id=?`).run(json,id,s);db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)VALUES(?,?,?,?,?,?)`).run(s,eid(req),'employee.permissions_updated','employee',id,JSON.stringify({employee_name:emp.name,previous,permissions:clean}));});tx();res.json({ok:true,employee_id:id,permissions:clean});});
}
module.exports={installV2PermissionsAdmin};
