'use strict';

// Garavex V2 multi-shop login compatibility preload.
// Owners may sign in with either their employee email or their shop account email.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bookings.db'));
const originalPost = express.application.post;
const originalSendFile = express.response.sendFile;

// Inject the shared V2 navigation/workflow controls into every HTML page served by Express.
// The client script itself skips public/customer-facing pages.
express.response.sendFile = function(filePath, options, callback) {
  const target = String(filePath || '');
  if (!target.toLowerCase().endsWith('.html')) {
    return originalSendFile.call(this, filePath, options, callback);
  }

  try {
    let html = fs.readFileSync(filePath, 'utf8');
    if (!html.includes('/v2-global-navigation.js')) {
      html = html.replace(/<\/body>/i, '<script src="/v2-global-navigation.js" defer></script>\n</body>');
    }
    return this.type('html').send(html);
  } catch (err) {
    return originalSendFile.call(this, filePath, options, callback);
  }
};

async function multiShopLogin(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (email.length > 320 || password.length > 1024) return res.status(400).json({ error: 'Invalid login request.' });

    const candidates = db.prepare(`
      SELECT e.id,e.name,e.email,e.password_hash,e.role,e.must_change_password,
             e.shop_id,e.active,s.active AS shop_active,s.name AS shop_name
      FROM employees e
      JOIN shops s ON s.id=e.shop_id
      WHERE LOWER(e.email)=?
         OR (e.role='owner' AND LOWER(COALESCE(s.email,''))=?)
      ORDER BY e.id
      LIMIT 25
    `).all(email, email);

    const matches = [];
    for (const employee of candidates) {
      if (!employee.active || !employee.shop_active || !employee.password_hash) continue;
      if (await bcrypt.compare(password, employee.password_hash)) matches.push(employee);
    }

    if (matches.length !== 1) {
      console.log('[V2 AUTH DIAG]', JSON.stringify({
        candidateCount: candidates.length,
        candidates: candidates.map(e => ({
          id: e.id,
          shop_id: e.shop_id,
          role: e.role,
          employee_active: e.active,
          shop_active: e.shop_active,
          has_password_hash: !!e.password_hash,
          shop_name: e.shop_name
        })),
        matchedPasswordCount: matches.length
      }));
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const employee = matches[0];
    req.session.regenerate(err => {
      if (err) {
        console.error('V2 login session regenerate error:', err);
        return res.status(500).json({ error: 'Unable to complete login.' });
      }
      req.session.employee = {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        role: employee.role,
        shop_id: employee.shop_id,
        must_change_password: employee.must_change_password
      };
      req.session.save(saveErr => {
        if (saveErr) {
          console.error('V2 login session save error:', saveErr);
          return res.status(500).json({ error: 'Unable to complete login.' });
        }
        res.set('Cache-Control', 'no-store, private, max-age=0');
        return res.json({
          success: true,
          employee: {
            id: employee.id,
            name: employee.name,
            email: employee.email,
            role: employee.role,
            shop_id: employee.shop_id,
            must_change_password: employee.must_change_password,
            shop_name: employee.shop_name
          }
        });
      });
    });
  } catch (err) {
    console.error('Garavex V2 multi-shop login error:', err);
    return res.status(500).json({ error: 'Unable to complete login.' });
  }
}

express.application.post = function(route, ...handlers) {
  if (route === '/api/login') return originalPost.call(this, route, multiShopLogin);
  return originalPost.call(this, route, ...handlers);
};
