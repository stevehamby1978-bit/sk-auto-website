'use strict';

const { shopPlan, shopAccessActive } = require('./garavex-subscription-tiers');

function installV2SubscriptionEnforcement(app, db, { requireLogin, requireOwner }) {
  if (!app || !db) throw new Error('Subscription enforcement requires app and db.');
  const shopFor = req => Number(req.session?.employee?.shop_id || 0);
  const subscriptionForShop = shopId => db.prepare(`SELECT id,subscription_plan,subscription_status,stripe_subscription_id,subscription_current_period_end,trial_ends_at FROM shops WHERE id=? LIMIT 1`).get(shopId);

  function requireActiveSubscription(req,res,next){
    const shopId=shopFor(req); if(!shopId)return res.status(401).json({error:'Login required.'});
    const shop=subscriptionForShop(shopId); if(!shop)return res.status(404).json({error:'Shop not found.'});
    if(!shopAccessActive(shop))return res.status(402).json({error:'Your Garavex trial has ended or the subscription is inactive. Choose a plan to continue.',code:'SUBSCRIPTION_REQUIRED'});
    req.garavexPlan=shopPlan(shop); next();
  }

  // Billing endpoints remain reachable so an expired shop can subscribe.
  // Protect all V2 operational APIs registered after this middleware.
  app.use('/api/v2', (req,res,next)=>{
    if(req.path==='/plans'||req.path.startsWith('/subscription'))return next();
    return requireActiveSubscription(req,res,next);
  });

  function requireEmployeeCapacity(req,res,next){
    const shopId=shopFor(req); if(!shopId)return res.status(401).json({error:'Login required.'});
    const shop=subscriptionForShop(shopId); if(!shop)return res.status(404).json({error:'Shop not found.'});
    const plan=shopPlan(shop); if(plan.employeeLimit==null)return next();
    const count=Number(db.prepare('SELECT COUNT(*) AS count FROM employees WHERE shop_id=? AND active=1').get(shopId)?.count||0);
    if(count>=plan.employeeLimit)return res.status(403).json({error:`${plan.name} allows up to ${plan.employeeLimit} active employees. Upgrade the shop plan to add another employee.`,code:'EMPLOYEE_LIMIT_REACHED',plan:plan.key,employeeLimit:plan.employeeLimit,employeeCount:count});
    next();
  }

  app.get('/api/v2/employees',requireLogin,requireOwner,(req,res)=>{
    const shopId=shopFor(req);
    const rows=db.prepare(`SELECT id,name,email,role,active,must_change_password,created_at FROM employees WHERE shop_id=? ORDER BY active DESC,name COLLATE NOCASE ASC`).all(shopId);
    res.json(rows);
  });

  app.post('/api/v2/employees',requireLogin,requireOwner,requireEmployeeCapacity,async(req,res)=>{
    try{
      const bcrypt=require('bcryptjs'),shopId=shopFor(req),name=String(req.body?.name||'').trim(),email=String(req.body?.email||'').trim().toLowerCase(),password=String(req.body?.password||'');
      const allowedRoles=new Set(['owner','manager','service_writer','technician']); const role=allowedRoles.has(req.body?.role)?req.body.role:'technician';
      if(!name)return res.status(400).json({error:'Employee name is required.'}); if(!email)return res.status(400).json({error:'Employee email is required.'}); if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters.'});
      if(db.prepare('SELECT id FROM employees WHERE LOWER(email)=? LIMIT 1').get(email))return res.status(409).json({error:'An employee with this email already exists.'});
      const passwordHash=await bcrypt.hash(password,12); const result=db.prepare(`INSERT INTO employees(name,email,password_hash,role,active,must_change_password,shop_id) VALUES(?,?,?,?,1,1,?)`).run(name,email,passwordHash,role,shopId);
      res.status(201).json({success:true,employee:{id:Number(result.lastInsertRowid),name,email,role,active:1,shop_id:shopId}});
    }catch(err){console.error('[V2 SUBSCRIPTIONS] employee create error:',err);res.status(500).json({error:'Unable to add employee.'});}
  });

  app.post('/api/v2/employees/:id/reset-password',requireLogin,requireOwner,async(req,res)=>{
    try{
      const bcrypt=require('bcryptjs'),shopId=shopFor(req),employeeId=Number(req.params.id),temporaryPassword=String(req.body?.temporaryPassword||'');
      if(!Number.isInteger(employeeId)||employeeId<=0)return res.status(400).json({error:'Invalid employee.'});
      if(temporaryPassword.length<8)return res.status(400).json({error:'Temporary password must be at least 8 characters.'});
      const employee=db.prepare('SELECT id FROM employees WHERE id=? AND shop_id=? LIMIT 1').get(employeeId,shopId); if(!employee)return res.status(404).json({error:'Employee not found for this shop.'});
      const passwordHash=await bcrypt.hash(temporaryPassword,12); db.prepare('UPDATE employees SET password_hash=?,must_change_password=1 WHERE id=? AND shop_id=?').run(passwordHash,employeeId,shopId);
      res.json({success:true});
    }catch(err){console.error('[V2 SUBSCRIPTIONS] employee reset error:',err);res.status(500).json({error:'Unable to reset employee password.'});}
  });

  app.patch('/api/v2/employees/:id/active',requireLogin,requireOwner,(req,res)=>{
    const shopId=shopFor(req),employeeId=Number(req.params.id),active=req.body?.active===true||req.body?.active===1?1:0;
    if(!Number.isInteger(employeeId)||employeeId<=0)return res.status(400).json({error:'Invalid employee.'});
    const current=db.prepare('SELECT id,role,active FROM employees WHERE id=? AND shop_id=? LIMIT 1').get(employeeId,shopId); if(!current)return res.status(404).json({error:'Employee not found for this shop.'});
    if(!active&&current.active&&String(current.role||'').trim().toLowerCase()==='owner'){
      const activeOwners=Number(db.prepare("SELECT COUNT(*) AS count FROM employees WHERE shop_id=? AND active=1 AND LOWER(TRIM(COALESCE(role,'')))='owner'").get(shopId)?.count||0);
      if(activeOwners<=1)return res.status(409).json({error:'A shop must keep at least one active owner account.',code:'LAST_OWNER_REQUIRED'});
    }
    if(active&&!current.active){const shop=subscriptionForShop(shopId),plan=shopPlan(shop),count=Number(db.prepare('SELECT COUNT(*) AS count FROM employees WHERE shop_id=? AND active=1').get(shopId)?.count||0);if(plan.employeeLimit!=null&&count>=plan.employeeLimit)return res.status(403).json({error:`${plan.name} active employee limit has been reached.`,code:'EMPLOYEE_LIMIT_REACHED'});}
    db.prepare('UPDATE employees SET active=? WHERE id=? AND shop_id=?').run(active,employeeId,shopId); res.json({success:true,active:Boolean(active)});
  });

  app.get('/api/v2/subscription/employee-capacity',requireLogin,(req,res)=>{
    const shopId=shopFor(req),shop=subscriptionForShop(shopId); if(!shop)return res.status(404).json({error:'Shop not found.'}); const plan=shopPlan(shop),count=Number(db.prepare('SELECT COUNT(*) AS count FROM employees WHERE shop_id=? AND active=1').get(shopId)?.count||0);
    res.json({plan:plan.key,employeeCount:count,employeeLimit:plan.employeeLimit,canAddEmployee:plan.employeeLimit==null||count<plan.employeeLimit});
  });
  console.log('[V2 SUBSCRIPTIONS] shop-scoped employee management and limits installed.');
}
module.exports={installV2SubscriptionEnforcement};
