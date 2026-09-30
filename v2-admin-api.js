const {validSessionEmployee,loadCurrentEmployee}=require('./v2-permissions');

function installV2AdminApi(app, db, { requireLogin, requireOwner }) {
  if(!app||!db)throw new Error('V2 admin API requires app and db.');
  if(!requireLogin||!requireOwner)throw new Error('V2 admin API requires authentication middleware.');
  const validId=value=>Number.isInteger(value)&&value>0;
  const session=(req,res)=>{
    const sessionEmployee=req.session?.employee;
    if(!validSessionEmployee(sessionEmployee)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}
    const employee=loadCurrentEmployee(db,sessionEmployee);
    if(!employee){res.status(401).json({error:'Employee session is no longer valid for this shop.'});return null;}
    const shop=Number(employee.shop_id),employeeId=Number(employee.id);
    if(!validId(shop)||!validId(employeeId)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}
    req.v2Employee=employee;req.v2ShopId=shop;
    return{shop,employee:employeeId};
  };
  const finiteNonNegative=(value,label,{nullable=false}={})=>{if(nullable&&(value===''||value==null))return{ok:true,value:null};const n=Number(value);if(!Number.isFinite(n)||n<0)return{ok:false,error:`${label} must be a non-negative number.`};return{ok:true,value:n};};
  const audit=(scope,action,type,id,details)=>db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details)VALUES(?,?,?,?,?,?)`).run(scope.shop,scope.employee,action,type,id||null,details?JSON.stringify(details):null);

  app.get('/api/v2/settings',requireLogin,requireOwner,(req,res)=>{const scope=session(req,res);if(!scope)return;const s=db.prepare(`SELECT id,name,default_labor_rate,parts_markup_percent,dvi_enabled,customer_portal_enabled FROM shops WHERE id=?`).get(scope.shop);if(!s)return res.status(404).json({error:'Shop not found.'});res.json(s);});

  app.patch('/api/v2/settings',requireLogin,requireOwner,(req,res)=>{const scope=session(req,res);if(!scope)return;const labor=finiteNonNegative(req.body?.default_labor_rate,'Default labor rate'),markup=finiteNonNegative(req.body?.parts_markup_percent,'Parts markup percent');if(!labor.ok)return res.status(400).json({error:labor.error});if(!markup.ok)return res.status(400).json({error:markup.error});const info=db.prepare(`UPDATE shops SET default_labor_rate=?,parts_markup_percent=? WHERE id=?`).run(labor.value,markup.value,scope.shop);if(info.changes!==1)return res.status(404).json({error:'Shop not found.'});audit(scope,'settings.update','shop',scope.shop,{default_labor_rate:labor.value,parts_markup_percent:markup.value});res.json({ok:true});});

  app.get('/api/v2/canned-jobs',requireLogin,(req,res)=>{const scope=session(req,res);if(!scope)return;res.json(db.prepare(`SELECT * FROM canned_jobs WHERE shop_id=? AND active=1 ORDER BY category,name`).all(scope.shop));});

  app.post('/api/v2/canned-jobs',requireLogin,requireOwner,(req,res)=>{const scope=session(req,res);if(!scope)return;const name=String(req.body?.name||'').trim();if(!name)return res.status(400).json({error:'Job name required.'});if(name.length>150)return res.status(400).json({error:'Job name is too long.'});const hours=finiteNonNegative(req.body?.labor_hours??0,'Labor hours'),rate=finiteNonNegative(req.body?.labor_rate,'Labor rate',{nullable:true}),parts=finiteNonNegative(req.body?.parts_price??0,'Parts price');if(!hours.ok)return res.status(400).json({error:hours.error});if(!rate.ok)return res.status(400).json({error:rate.error});if(!parts.ok)return res.status(400).json({error:parts.error});const category=String(req.body?.category||'').trim().slice(0,100),description=String(req.body?.description||'').trim().slice(0,2000);const tx=db.transaction(()=>{const info=db.prepare(`INSERT INTO canned_jobs(shop_id,name,category,description,labor_hours,labor_rate,parts_price)VALUES(?,?,?,?,?,?,?)`).run(scope.shop,name,category,description,hours.value,rate.value,parts.value);audit(scope,'canned_job.create','canned_job',info.lastInsertRowid,{name});return info.lastInsertRowid;});try{const id=tx();return res.json({ok:true,id});}catch(err){console.error('Garavex V2 canned job create error:',err);return res.status(500).json({error:'Canned job could not be created.'});}});

  // Employee permission reads/writes are intentionally owned by
  // v2-permissions-admin.js. Keeping one authoritative route prevents Express
  // route-order conflicts and keeps the permission catalog/audit behavior in sync.
}
module.exports={installV2AdminApi};
