/* Garavex V1 tenant-isolation + tenant-branding hotfix.
 * Loaded before server.js. Keeps legacy V1 safe while the routes/pages are
 * progressively rewritten with native multi-shop behavior.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const express = require('express');

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

  // Legacy GET still selects broadly. Nothing leaves the API unless it belongs
  // to the logged-in shop, even if the underlying legacy query is broad.
  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (Array.isArray(payload)) payload = payload.filter(row => Number(row?.shop_id) === sid);
    return originalJson(payload);
  };
  next();
}

const originalGet = express.application.get;
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
      const shop = db.prepare('SELECT id, name FROM shops WHERE id = ? LIMIT 1').get(sid);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });
      res.set('Cache-Control', 'no-store, private, max-age=0');
      return res.json({ id: shop.id, name: shop.name || 'Garavex Shop' });
    } catch (err) {
      console.error('Current shop branding error:', err);
      return res.status(500).json({ error: 'Unable to load shop.' });
    }
  });
}

express.application.get = function(pathname, ...handlers) {
  // protectedPages is registered after session/auth middleware and before static.
  // Install the shop identity endpoint at that safe point in the middleware stack.
  if (Array.isArray(pathname) && pathname.some(p => p === '/estimates-admin.html' || p === '/appointments.html')) {
    const result = originalGet.call(this, pathname, ...handlers);
    installCurrentShopRoute(this);
    return result;
  }
  if (pathname === '/api/appointments') handlers.unshift(appointmentGuard);
  return originalGet.call(this, pathname, ...handlers);
};
express.application.delete = function(pathname, ...handlers) {
  if (pathname === '/api/appointments/:id') handlers.unshift(appointmentGuard);
  return originalDelete.call(this, pathname, ...handlers);
};
express.application.patch = function(pathname, ...handlers) {
  if (pathname === '/api/appointments/:id' || pathname === '/api/appointments/:id/status') handlers.unshift(appointmentGuard);
  return originalPatch.call(this, pathname, ...handlers);
};

// V1 was originally built for S&K Auto, so several authenticated admin pages
// contain literal S&K Auto text. Serve those pages with a tiny tenant-branding
// bootstrap that replaces legacy branding with the logged-in shop name.
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
