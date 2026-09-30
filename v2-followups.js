function installV2Followups(app, db, { requireLogin, twilioClient }) {
  const sid = req => Number(req.session.employee.shop_id);
  const normalizePhone = value => { const d=String(value||'').replace(/\D/g,''); return d.length===10?`+1${d}`:d.length===11&&d.startsWith('1')?`+${d}`:null; };
  const sendSms = async (to, body) => {
    if (!twilioClient || !process.env.TWILIO_PHONE_NUMBER) throw new Error('SMS is not configured.');
    return twilioClient.messages.create({ to, from:process.env.TWILIO_PHONE_NUMBER, body });
  };

  app.get('/api/v2/followups/due', requireLogin, (req,res)=>{
    const rows=db.prepare(`SELECT d.id,d.description,d.estimated_total,d.follow_up_date,c.name customer_name,c.phone customer_phone,v.year,v.make,v.model FROM deferred_services d JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.shop_id=? AND d.status='deferred' AND d.follow_up_date IS NOT NULL AND date(d.follow_up_date)<=date('now') ORDER BY date(d.follow_up_date),d.id`).all(sid(req));
    res.json(rows);
  });

  app.post('/api/v2/deferred/:id/follow-up-text', requireLogin, async(req,res)=>{
    try {
      const shopId=sid(req),id=Number(req.params.id);
      const row=db.prepare(`SELECT d.*,c.name customer_name,c.phone customer_phone,v.year,v.make,v.model,s.name shop_name FROM deferred_services d JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id JOIN shops s ON s.id=d.shop_id WHERE d.id=? AND d.shop_id=?`).get(id,shopId);
      if(!row)return res.status(404).json({error:'Deferred service not found.'});
      const phone=normalizePhone(row.customer_phone); if(!phone)return res.status(400).json({error:'Customer phone number is invalid.'});
      const vehicle=[row.year,row.make,row.model].filter(Boolean).join(' ');
      const amount=Number(row.estimated_total||0).toFixed(2);
      const body=String(req.body.message||'').trim() || `${row.shop_name}: Hi ${row.customer_name||'there'}, just a reminder about the recommended ${row.description} for your ${vehicle||'vehicle'} (estimated $${amount}). Reply or call us when you’re ready to schedule.`;
      await sendSms(phone,body);
      db.prepare(`UPDATE deferred_services SET follow_up_date=date('now','+30 days') WHERE id=? AND shop_id=?`).run(id,shopId);
      db.prepare(`INSERT INTO audit_log(shop_id,employee_id,action,entity_type,entity_id,details) VALUES(?,?,?,?,?,?)`).run(shopId,Number(req.session.employee.id),'deferred.followup_text','deferred_service',id,JSON.stringify({phone,last_sent_at:new Date().toISOString()}));
      res.json({ok:true,next_follow_up_in_days:30});
    } catch(err) { console.error('V2 deferred follow-up SMS error:',err); res.status(500).json({error:'Unable to send follow-up text.'}); }
  });
}
module.exports={installV2Followups};
