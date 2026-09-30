/* Garavex V1 tenant-aware employee password reset protection. */
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(process.env.DATA_DIR || path.join(__dirname,'data'),'bookings.db'));

function shopId(req){
  const id = Number(req.session?.employee?.shop_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function resetPassword(req,res){
  try {
    const sid = shopId(req);
    if(!sid) return res.status(401).json({error:'Not authorized.'});

    const employeeId = Number(req.params.id);
    if(!Number.isInteger(employeeId) || employeeId <= 0){
      return res.status(400).json({error:'Invalid employee.'});
    }

    const employee = db.prepare(
      'SELECT id FROM employees WHERE id = ? AND shop_id = ?'
    ).get(employeeId,sid);

    if(!employee) return res.status(404).json({error:'Employee not found.'});

    const password = String(req.body?.password || '').trim();
    if(password.length < 6){
      return res.status(400).json({error:'Password must be at least 6 characters.'});
    }

    const hash = await bcrypt.hash(password,10);
    db.prepare(`
      UPDATE employees
      SET password_hash = ?, must_change_password = 1
      WHERE id = ? AND shop_id = ?
    `).run(hash, employeeId, sid);

    return res.json({success:true});
  } catch(err){
    console.error('V1 employee reset failed:',err);
    return res.status(500).json({error:'Unable to reset password.'});
  }
}

const post = express.application.post;
express.application.post = function(route,...handlers){
  if(route === '/api/employees/:id/reset-password'){
    return post.call(this,route,resetPassword);
  }
  return post.call(this,route,...handlers);
};
