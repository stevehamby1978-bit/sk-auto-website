/* Garavex V1 tenant-isolation + tenant-branding + login compatibility hotfix.
 * Loaded before server.js. Keeps legacy V1 safe while the routes/pages are
 * progressively rewritten with native multi-shop behavior.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const express = require('express');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'bookings.db'));

function shopId(req) {
  const id = Number(req.session?.employee?.shop_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function appointmentGuard(req, res, next) {
  const sid = shopId(req);
  if (!sid) return res.status(401).json({ error: 'Not authorized.' });

  const id = Number(req.params?.id);
  if (req.method !== 'GET') {
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid appointment ID.' });
    const owned = db.prepare('SELECT id FROM bookings WHERE id = ? AND shop_id = ? LIMIT 1').get(id, sid);
    if (!owned) return res.status(404).json({ error: 'Appointment not found.' });
    return next();
  }

  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (Array.isArray(payload)) payload = payload.filter(row => Number(row?.shop_id) === sid);
    return originalJson(payload);
  };
  next();
}

const originalGet = express.application.get;
const originalPost = express.application.post;
const originalDelete = express.application.delete;
const originalPatch = express.application.patch;
let currentShopRouteInstalled = false;

function installCurrentShopRoute(app) {
  if (currentShopRouteInstalled) return;
  currentShopRouteInstalled = true;
  originalGet.call(app, '/api/current-shop', (req, res) => {
    try {
      const sid = shopId(req);
      if (!sid) return res.status(401).json({ error: 'Not authorized.' });
      const shop = db.prepare('SELECT id, name FROM shops WHERE id = ? AND active = 1 LIMIT 1').get(sid);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });
      res.set('Cache-Control', 'no-store, private, max-age=0');
      return res.json({ id: shop.id, name: shop.name || 'Garavex Shop' });
    } catch (err) {
      console.error('Current shop branding error:', err);
      return res.status(500).json({ error: 'Unable to load shop.' });
    }
  });
}

/*
 * Legacy V1 login looked up only the first employee row for an email. That is
 * unsafe for a multi-shop product and also prevents an owner from using the
 * shop contact email when it differs from the owner employee email. Resolve
 * every eligible candidate, verify the password against each hash, and only
 * establish a session when exactly one active shop account matches.
 */
async function v1MultiShopLogin(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (email.length > 320 || password.length > 1024) return res.status(400).json({ error: 'Invalid login request.' });

    const candidates = db.prepare(`
      SELECT e.id,e.name,e.email,e.password_hash,e.role,e.must_change_password,e.shop_id,e.active,
             s.active shop_active,s.name shop_name
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
      // Keep the response intentionally generic so login cannot enumerate users,
      // shops, inactive accounts, or duplicate credentials.
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const employee = matches[0];
    req.session.regenerate(err => {
      if (err) {
        console.error('V1 login session regenerate error:', err);
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
          console.error('V1 login session save error:', saveErr);
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
    console.error('Garavex V1 multi-shop login error:', err);
    return res.status(500).json({ error: 'Unable to complete login.' });
  }
}

express.application.get = function(pathname, ...handlers) {
  if (Array.isArray(pathname) && pathname.some(p => p === '/estimates-admin.html' || p === '/appointments.html')) {
    const result = originalGet.call(this, pathname, ...handlers);
    installCurrentShopRoute(this);
    return result;
  }
  if (pathname === '/api/appointments') handlers.unshift(appointmentGuard);
  return originalGet.call(this, pathname, ...handlers);
};

express.application.post = function(pathname, ...handlers) {
  // Replace only the legacy V1 login handler. Session middleware is already in
  // the stack by the time server.js registers this route.
  if (pathname === '/api/login') return originalPost.call(this, pathname, v1MultiShopLogin);
  return originalPost.call(this, pathname, ...handlers);
};

express.application.delete = function(pathname, ...handlers) {
  if (pathname === '/api/appointments/:id') handlers.unshift(appointmentGuard);
  return originalDelete.call(this, pathname, ...handlers);
};
express.application.patch = function(pathname, ...handlers) {
  if (pathname === '/api/appointments/:id' || pathname === '/api/appointments/:id/status') handlers.unshift(appointmentGuard);
  return originalPatch.call(this, pathname, ...handlers);
};

const originalStatic = express.static;
const tenantPages = new Set([
  '/dashboard.html','/appointments.html','/estimates-admin.html','/customers.html','/customer.html',
  '/repair-orders.html','/repair-order.html','/employees.html','/admin.html','/service-history.html',
  '/invoice.html','/invoice-stripe.html'
]);
const brandBootstrap = `<script data-garavex-tenant-branding>(async()=>{try{const r=await fetch('/api/current-shop',{credentials:'same-origin',cache:'no-store'});if(!r.ok)return;const s=await r.json();const n=String(s.name||'Garavex Shop');document.title=document.title.replace(/S&K Auto/gi,n);const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const nodes=[];while(w.nextNode()){const p=w.currentNode.parentElement;if(p&&!['SCRIPT','STYLE','TEXTAREA'].includes(p.tagName)&&/S&K Auto/i.test(w.currentNode.nodeValue||''))nodes.push(w.currentNode);}for(const x of nodes)x.nodeValue=x.nodeValue.replace(/S&K Auto/gi,n);for(const el of document.querySelectorAll('.brand')){if(/S&K|Auto/i.test(el.textContent||''))el.textContent=n;}}catch(e){console.error('Garavex shop branding:',e);}})();</script>`;

express.static = function(root, options) {
  const normal = originalStatic.call(express, root, options);
  return function garavexTenantStatic(req, res, next) {
    try {
      const pathname = String(req.path || '').replace(/\\/g, '/');
      if (req.method === 'GET' && tenantPages.has(pathname)) {
        const file = path.join(root, pathname.replace(/^\//, ''));
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          let html = fs.readFileSync(file, 'utf8');
          html = html.includes('</body>') ? html.replace('</body>', brandBootstrap + '</body>') : html + brandBootstrap;
          res.type('html');
          res.set('Cache-Control', 'no-store, private, max-age=0');
          return res.send(html);
        }
      }
    } catch (err) {
      console.error('Garavex tenant page branding error:', err);
    }
    return normal(req, res, next);
  };
};
