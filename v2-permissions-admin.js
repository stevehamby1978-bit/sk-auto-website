const {parsePermissions,validSessionEmployee}=require('./v2-permissions');

function installV2PermissionsAdmin(app,db,{requireLogin,requireOwner}){
 if(!app||!db)throw new Error('V2 permissions admin requires app and db.');
 if(!requireLogin||!requireOwner)throw new Error('V2 permissions admin requires authentication middleware.');
 const sid=req=>Number(req.session?.employee?.shop_id||0),eid=req=>Number(req.session?.employee?.id||0),validId=x=>Number.isInteger(x)&&x>0;
 const scope=(req,res)=>{const employee=req.session?.employee;if(!validSessionEmployee(employee)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{shop:sid(req),employee:eid(req)};};
 const catalog={
  repair_orders:'Repair orders',dispatch:'Technician dispatch',dvi:'Digital inspections',time_clock:'Technician time',parts:'Parts requests',inventory:'Inventory & vendors',purchase_orders:'Purchase orders',customer_contact:'Customer contact & approvals',tasks:'Tasks',road_tests:'Road tests',keys:'Vehicle keys',loaners:'Loaner vehicles',delivery:'Final QC & delivery',reports:'Reports',settings:'Shop settings',employees:'Employee management',audit:'Audit log'
 };
 const valid=new Set(Object.keys(catalog));

 app.get('/api/v2/permissions/catalog',requireLogin,(req,res)=>{if(!scope(req,res))return;res.json({permissions:catalog});});

 app.get('/api/v2/employees/:id/permissions',requireLogin,requireOwner,(req,res)=>{const sc=scope(req,res);if(!sc)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid employee ID is required.'});const emp=db.prepare(`SELECT id,name,role,permissions_json FROM employees WHERE id=? AND shop_id=?`).get(id,sc.shop);if(!emp)return res.status(404).json({error:'Employee not found.'});res.json({id:emp.id,name:emp.name,role:emp.role,permissions:parsePermissions(emp)});});

 app.put('/api/v2/employees/:id/permissions',requireLogin,requireOwner,(req,res)=>{const sc=scope(req,res);if(!sc)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid employee ID is required.'});const emp=db.prepare(`SELECT id,name,role,permissions_json FROM employees WHERE id=? AND shop_id=?`).get(id,sc.shop);if(!emp)return res.status(404).json({error:'Employee not found.'});if(emp.role==='owner')return res.status(409).json({error:'Owner permissions cannot be restricted.'});const incoming=req.body?.permissions;if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({error:'Permissions object is required.'});const unknown=Object.keys(incoming).filter(key=>!valid.has(key));if(unknown.length)return res.status(400).json({error:'Unknown permission key.',permissions:unknown});const clean={};for(const key of valid)clean[key]=incoming[key]===true;const previous=parsePermissions(emp),json=JSON.stringify(clean);const tx=db.transaction(()=>{const info=db.prepare(`UPDATE employees SET permissions_json=? WHERE id=? AND shop_id=?`).run(json,id,sc.shop);if(info.changes!==1)throw new Error('Employee permission update did not modify exactly one record.');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)VALUES(?,?,?,?,?,?)`).run(sc.shop,sc.employee,'employee.permissions_updated','employee',id,JSON.stringify({employee_name:emp.name,previous,permissions:clean}));});try{tx();}catch(err){console.error('Garavex V2 permission update error:',err);return res.status(500).json({error:'Employee permissions could not be updated.'});}res.json({ok:true,employee_id:id,permissions:clean});});
}
module.exports={installV2PermissionsAdmin};
