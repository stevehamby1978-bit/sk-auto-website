const {parsePermissions,validSessionEmployee,loadCurrentEmployee,normalizedRole}=require('./v2-permissions');

function installV2PermissionsAdmin(app,db,{requireLogin,requireOwner}){
 if(!app||!db)throw new Error('V2 permissions admin requires app and db.');
 if(!requireLogin||!requireOwner)throw new Error('V2 permissions admin requires authentication middleware.');
 const validId=x=>Number.isInteger(x)&&x>0;
 const noStore=res=>{res.set('Cache-Control','no-store, private, max-age=0');res.set('Pragma','no-cache');res.set('Expires','0');res.set('X-Content-Type-Options','nosniff');};
 const scope=(req,res)=>{
  const sessionEmployee=req.session?.employee;
  if(!validSessionEmployee(sessionEmployee)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}
  const employee=loadCurrentEmployee(db,sessionEmployee);
  if(!employee){res.status(401).json({error:'Employee session is no longer valid for this shop.'});return null;}
  const shop=Number(employee.shop_id),employeeId=Number(employee.id);
  if(!validId(shop)||!validId(employeeId)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}
  req.v2Employee=employee;req.v2ShopId=shop;noStore(res);
  return{shop,employee:employeeId};
 };
 const stillLiveOwner=(req,sc)=>{const live=loadCurrentEmployee(db,req.session?.employee);return Boolean(live&&Number(live.id)===sc.employee&&Number(live.shop_id)===sc.shop&&normalizedRole(live)==='owner');};
 const catalog={
  dashboard:'Dashboard & KPIs',customers:'Customers & customer portal',repair_orders:'Repair orders',dispatch:'Technician dispatch',dvi:'Digital inspections',time_clock:'Technician time',parts:'Parts requests',inventory:'Inventory & vendors',purchase_orders:'Purchase orders',customer_contact:'Customer contact & approvals',tasks:'Tasks',road_tests:'Road tests',keys:'Vehicle keys',loaners:'Loaner vehicles',delivery:'Final QC & delivery',reports:'Reports',settings:'Shop settings',employees:'Employee management',audit:'Audit log'
 };
 const valid=new Set(Object.keys(catalog));

 app.get('/api/v2/permissions/catalog',requireLogin,(req,res)=>{if(!scope(req,res))return;res.json({permissions:catalog});});

 app.get('/api/v2/employees/:id/permissions',requireLogin,requireOwner,(req,res)=>{const sc=scope(req,res);if(!sc)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid employee ID is required.'});const emp=db.prepare(`SELECT id,name,role,permissions_json FROM employees WHERE id=? AND shop_id=? AND active=1`).get(id,sc.shop);if(!emp)return res.status(404).json({error:'Active employee not found.'});res.json({id:emp.id,name:emp.name,role:emp.role,permissions:parsePermissions(emp)});});

 app.put('/api/v2/employees/:id/permissions',requireLogin,requireOwner,(req,res)=>{const sc=scope(req,res);if(!sc)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid employee ID is required.'});const incoming=req.body?.permissions;if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({error:'Permissions object is required.'});const unknown=Object.keys(incoming).filter(key=>!valid.has(key));if(unknown.length)return res.status(400).json({error:'Unknown permission key.',permissions:unknown});const clean={};for(const key of valid)clean[key]=incoming[key]===true;let result;const tx=db.transaction(()=>{if(!stillLiveOwner(req,sc))throw new Error('SESSION_INVALID');const emp=db.prepare(`SELECT id,name,role,permissions_json FROM employees WHERE id=? AND shop_id=? AND active=1`).get(id,sc.shop);if(!emp)throw new Error('EMPLOYEE_NOT_FOUND');if(normalizedRole(emp)==='owner')throw new Error('OWNER_RESTRICTED');const previous=parsePermissions(emp),json=JSON.stringify(clean);const info=db.prepare(`UPDATE employees SET permissions_json=? WHERE id=? AND shop_id=? AND active=1 AND LOWER(TRIM(COALESCE(role,'')))!='owner'`).run(json,id,sc.shop);if(info.changes!==1)throw new Error('CHANGED');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)VALUES(?,?,?,?,?,?)`).run(sc.shop,sc.employee,'employee.permissions_updated','employee',id,JSON.stringify({employee_name:emp.name,previous,permissions:clean}));result={ok:true,employee_id:id,permissions:clean};});try{tx();}catch(err){const code=String(err.message||'');if(code==='SESSION_INVALID')return res.status(401).json({error:'Owner session is no longer valid for this shop.'});if(code==='EMPLOYEE_NOT_FOUND')return res.status(404).json({error:'Active employee not found.'});if(code==='OWNER_RESTRICTED')return res.status(409).json({error:'Owner permissions cannot be restricted.'});if(code==='CHANGED')return res.status(409).json({error:'Employee changed before permissions could be saved.'});console.error('Garavex V2 permission update error:',err);return res.status(500).json({error:'Employee permissions could not be updated.'});}res.json(result);});
}
module.exports={installV2PermissionsAdmin};
