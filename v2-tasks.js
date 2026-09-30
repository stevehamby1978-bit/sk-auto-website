const { permissionMiddleware } = require('./v2-permissions');

function installV2Tasks(app,db,{requireLogin}){
  if(!app||!db)throw new Error('V2 tasks require app and db.');
  if(!requireLogin)throw new Error('V2 tasks require login middleware.');
  const requireTasks=permissionMiddleware('tasks');
  const validId=v=>Number.isInteger(v)&&v>0;
  const sid=req=>Number(req.session?.employee?.shop_id||0);
  const eid=req=>Number(req.session?.employee?.id||0);

  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,shop_id INTEGER NOT NULL,repair_order_id INTEGER,assigned_to INTEGER,
      title TEXT NOT NULL,details TEXT,priority TEXT NOT NULL DEFAULT 'normal',due_at DATETIME,status TEXT NOT NULL DEFAULT 'open',
      created_by INTEGER,completed_by INTEGER,completed_at DATETIME,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_v2_tasks_shop_status ON v2_tasks(shop_id,status,due_at);
    CREATE INDEX IF NOT EXISTS idx_v2_tasks_ro ON v2_tasks(shop_id,repair_order_id,status);
    CREATE INDEX IF NOT EXISTS idx_v2_tasks_assignee ON v2_tasks(shop_id,assigned_to,status,due_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_tasks_open_identity ON v2_tasks(shop_id,COALESCE(repair_order_id,0),COALESCE(assigned_to,0),title) WHERE status='open';
  `);

  const auth=(req,res)=>{const s=sid(req),e=eid(req);if(!validId(s)||!validId(e)){res.status(401).json({error:'A valid employee shop session is required.'});return null;}return{s,e};};

  app.get('/api/v2/tasks',requireLogin,requireTasks,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const status=String(req.query.status||'open').toLowerCase();
      if(!['open','completed','all'].includes(status))return res.status(400).json({error:'Invalid task status filter.'});
      const assignedRaw=req.query.assigned_to;
      const assigned=assignedRaw===undefined||assignedRaw===''?null:Number(assignedRaw);
      if(assigned!==null&&!validId(assigned))return res.status(400).json({error:'Invalid assigned employee filter.'});
      if(assigned&&!db.prepare(`SELECT id FROM employees WHERE id=? AND shop_id=?`).get(assigned,a.s))return res.status(400).json({error:'Assigned employee is not in this shop.'});
      const rows=db.prepare(`
        SELECT t.*,a.name assigned_name,c.name created_name,r.workflow_status,cu.name customer_name,v.year,v.make,v.model,
               CASE WHEN t.status='open' AND t.due_at IS NOT NULL AND datetime(t.due_at)<datetime('now') THEN 1 ELSE 0 END overdue
        FROM v2_tasks t
        LEFT JOIN employees a ON a.id=t.assigned_to AND a.shop_id=t.shop_id
        LEFT JOIN employees c ON c.id=t.created_by AND c.shop_id=t.shop_id
        LEFT JOIN repair_orders r ON r.id=t.repair_order_id AND r.shop_id=t.shop_id
        LEFT JOIN customers cu ON cu.id=r.customer_id AND cu.shop_id=r.shop_id
        LEFT JOIN vehicles v ON v.id=r.vehicle_id AND v.shop_id=r.shop_id
        WHERE t.shop_id=? AND (?='all' OR t.status=?) AND (? IS NULL OR t.assigned_to=?)
        ORDER BY overdue DESC,CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,t.due_at IS NULL,t.due_at,t.id DESC
        LIMIT 300
      `).all(a.s,status,status,assigned,assigned);
      return res.json(rows);
    }catch(err){console.error('Garavex V2 task list error:',err);return res.status(500).json({error:'Unable to load tasks.'});}
  });

  app.post('/api/v2/tasks',requireLogin,requireTasks,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;
      const title=String(req.body?.title||'').trim().slice(0,160),details=String(req.body?.details||'').trim().slice(0,2000);
      if(!title)return res.status(400).json({error:'Task title is required.'});
      const requestedPriority=String(req.body?.priority||'normal').toLowerCase();
      if(!['normal','high','urgent'].includes(requestedPriority))return res.status(400).json({error:'Task priority must be normal, high, or urgent.'});
      const priority=requestedPriority;
      const assignedRaw=req.body?.assigned_to,assigned=assignedRaw===undefined||assignedRaw===null||assignedRaw===''?null:Number(assignedRaw);
      if(assigned!==null&&!validId(assigned))return res.status(400).json({error:'Assigned employee is invalid.'});
      const roRaw=req.body?.repair_order_id,ro=roRaw===undefined||roRaw===null||roRaw===''?null:Number(roRaw);
      if(ro!==null&&!validId(ro))return res.status(400).json({error:'Repair order ID is invalid.'});
      const due=req.body?.due_at===undefined||req.body?.due_at===null||req.body?.due_at===''?null:String(req.body.due_at).trim();if(due&&Number.isNaN(Date.parse(due)))return res.status(400).json({error:'Task due date is invalid.'});
      const tx=db.transaction(()=>{
        if(assigned&&!db.prepare(`SELECT id FROM employees WHERE id=? AND shop_id=?`).get(assigned,a.s))throw new Error('ASSIGNEE_INVALID');
        if(ro){const order=db.prepare(`SELECT id,status,workflow_status FROM repair_orders WHERE id=? AND shop_id=?`).get(ro,a.s);if(!order)throw new Error('RO_NOT_FOUND');if(order.status==='completed'||String(order.workflow_status||'').toLowerCase()==='delivered')throw new Error('RO_CLOSED');}
        const duplicate=db.prepare(`SELECT id FROM v2_tasks WHERE shop_id=? AND status='open' AND COALESCE(repair_order_id,0)=COALESCE(?,0) AND COALESCE(assigned_to,0)=COALESCE(?,0) AND title=? LIMIT 1`).get(a.s,ro,assigned,title);if(duplicate){const err=new Error('TASK_DUPLICATE');err.taskId=duplicate.id;throw err;}
        const info=db.prepare(`INSERT INTO v2_tasks(shop_id,repair_order_id,assigned_to,title,details,priority,due_at,created_by) VALUES(?,?,?,?,?,?,?,?)`).run(a.s,ro,assigned,title,details,priority,due,a.e);db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'task.created',ro?'repair_order':'task',ro||info.lastInsertRowid,JSON.stringify({task_id:info.lastInsertRowid,title,assigned_to:assigned,priority,due_at:due}));return info.lastInsertRowid;
      });
      try{return res.json({ok:true,id:tx()});}catch(err){const code=String(err.message||'');if(code==='ASSIGNEE_INVALID')return res.status(400).json({error:'Assigned employee is not in this shop.'});if(code==='RO_NOT_FOUND')return res.status(400).json({error:'Repair order not found.'});if(code==='RO_CLOSED')return res.status(409).json({error:'Cannot create a task for a completed or delivered repair order.'});if(code==='TASK_DUPLICATE'||code.includes('UNIQUE constraint failed')){const existing=db.prepare(`SELECT id FROM v2_tasks WHERE shop_id=? AND status='open' AND COALESCE(repair_order_id,0)=COALESCE(?,0) AND COALESCE(assigned_to,0)=COALESCE(?,0) AND title=? LIMIT 1`).get(a.s,ro,assigned,title);return res.status(409).json({error:'An identical open task already exists.',id:err.taskId||existing?.id||null});}throw err;}
    }catch(err){console.error('Garavex V2 task creation error:',err);return res.status(500).json({error:'Unable to create the task.'});}
  });

  app.patch('/api/v2/tasks/:id/complete',requireLogin,requireTasks,(req,res)=>{
    try{
      const a=auth(req,res);if(!a)return;const id=Number(req.params.id);if(!validId(id))return res.status(400).json({error:'Valid task ID is required.'});
      const tx=db.transaction(()=>{const task=db.prepare(`SELECT t.*,r.status repair_order_status,r.workflow_status FROM v2_tasks t LEFT JOIN repair_orders r ON r.id=t.repair_order_id AND r.shop_id=t.shop_id WHERE t.id=? AND t.shop_id=? AND t.status='open'`).get(id,a.s);if(!task)throw new Error('TASK_NOT_FOUND');if(task.repair_order_id&&(task.repair_order_status==='completed'||String(task.workflow_status||'').toLowerCase()==='delivered'))throw new Error('RO_CLOSED');const changed=db.prepare(`UPDATE v2_tasks SET status='completed',completed_by=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND shop_id=? AND status='open'`).run(a.e,id,a.s);if(changed.changes!==1)throw new Error('TASK_CHANGED');db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(a.s,a.e,'task.completed',task.repair_order_id?'repair_order':'task',task.repair_order_id||id,JSON.stringify({task_id:id,title:task.title,assigned_to:task.assigned_to}));});
      try{tx();}catch(err){const code=String(err.message||'');if(code==='TASK_NOT_FOUND')return res.status(404).json({error:'Open task not found.'});if(code==='RO_CLOSED')return res.status(409).json({error:'Repair-order tasks cannot be changed after completion or delivery.'});return res.status(409).json({error:'Task changed before completion could be saved.'});}
      return res.json({ok:true});
    }catch(err){console.error('Garavex V2 task completion error:',err);return res.status(500).json({error:'Unable to complete the task.'});}
  });
}
module.exports={installV2Tasks};
