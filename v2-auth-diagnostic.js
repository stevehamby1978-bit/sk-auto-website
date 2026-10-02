'use strict';

// Read-only Garavex V2 authentication diagnostic.
// Never returns password hashes or other credential material.
function installV2AuthDiagnostic(app, db, { requireOwner } = {}) {
  const ownerGuard = typeof requireOwner === 'function'
    ? requireOwner
    : (req, res, next) => {
        if (!req.session?.employee || req.session.employee.role !== 'owner') {
          return res.status(403).json({ error: 'Owner access required.' });
        }
        next();
      };

  app.get('/api/v2/diagnostics/auth', ownerGuard, (req, res) => {
    try {
      const shops = db.prepare(`
        SELECT
          s.id AS shop_id,
          s.name AS shop_name,
          s.email AS shop_email,
          s.active AS shop_active,
          COUNT(e.id) AS employee_count,
          SUM(CASE WHEN e.role = 'owner' THEN 1 ELSE 0 END) AS owner_count,
          SUM(CASE WHEN e.role = 'owner' AND e.active = 1 THEN 1 ELSE 0 END) AS active_owner_count,
          SUM(CASE WHEN e.role = 'owner' AND e.active = 1 AND e.password_hash IS NOT NULL AND LENGTH(e.password_hash) > 0 THEN 1 ELSE 0 END) AS active_owner_with_password_count
        FROM shops s
        LEFT JOIN employees e ON e.shop_id = s.id
        WHERE s.id = ?
        GROUP BY s.id, s.name, s.email, s.active
        ORDER BY s.id
      `).all(Number(req.session?.employee?.shop_id || 0));

      const owners = db.prepare(`
        SELECT
          e.id AS employee_id,
          e.shop_id,
          s.name AS shop_name,
          e.name AS owner_name,
          e.email AS employee_email,
          s.email AS shop_email,
          e.active AS employee_active,
          s.active AS shop_active,
          e.must_change_password,
          CASE WHEN e.password_hash IS NOT NULL AND LENGTH(e.password_hash) > 0 THEN 1 ELSE 0 END AS has_password_hash
        FROM employees e
        JOIN shops s ON s.id = e.shop_id
        WHERE e.role = 'owner' AND e.shop_id = ?
        ORDER BY e.shop_id, e.id
      `).all(Number(req.session?.employee?.shop_id || 0));

      res.set('Cache-Control', 'no-store, private, max-age=0');
      return res.json({
        database: 'configured bookings.db',
        authenticated_shop_id: req.session?.employee?.shop_id || null,
        authenticated_employee_id: req.session?.employee?.id || null,
        shops,
        owners
      });
    } catch (err) {
      console.error('V2 auth diagnostic error:', err);
      return res.status(500).json({ error: 'Unable to run authentication diagnostic.' });
    }
  });
}

module.exports = { installV2AuthDiagnostic };
