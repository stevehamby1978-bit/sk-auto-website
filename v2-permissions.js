/* Garavex V2 role/permission helpers. */
function parsePermissions(employee) {
  if (!employee) return {};
  if (employee.role === 'owner') return { owner: true, all: true };
  try {
    const value = typeof employee.permissions_json === 'string'
      ? JSON.parse(employee.permissions_json || '{}')
      : (employee.permissions_json || {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function validSessionEmployee(employee) {
  const employeeId = Number(employee?.id || 0);
  const shopId = Number(employee?.shop_id || 0);
  return Number.isInteger(employeeId) && employeeId > 0 && Number.isInteger(shopId) && shopId > 0;
}

function loadCurrentEmployee(db, employee) {
  if (!db || typeof db.prepare !== 'function' || !validSessionEmployee(employee)) return null;
  try {
    return db.prepare(`
      SELECT id, shop_id, name, email, role, permissions_json
      FROM employees
      WHERE id = ? AND shop_id = ?
      LIMIT 1
    `).get(Number(employee.id), Number(employee.shop_id)) || null;
  } catch (_) {
    return null;
  }
}

function deny(req, res, status, message) {
  const apiRequest = String(req.path || '').startsWith('/api/');
  if (apiRequest) return res.status(status).json({ error: message });
  if (status === 401) return res.redirect('/login.html');
  return res.status(status).send('Access denied.');
}

function permissionMiddleware(permission, db) {
  if (typeof permission !== 'string' || !permission.trim()) {
    throw new Error('Garavex V2 permission middleware requires a permission name.');
  }
  return function requireV2Permission(req, res, next) {
    const sessionEmployee = req.session?.employee;
    if (!validSessionEmployee(sessionEmployee)) {
      return deny(req, res, 401, 'A valid employee shop session is required.');
    }

    // When a database handle is supplied, authorization is based on the live
    // employee row rather than a potentially stale role/permissions snapshot
    // stored in the session. This makes permission changes and account removal
    // effective immediately without allowing a shop id to change mid-session.
    const employee = db ? loadCurrentEmployee(db, sessionEmployee) : sessionEmployee;
    if (!employee) return deny(req, res, 401, 'Employee session is no longer valid for this shop.');

    if (db) {
      req.v2Employee = employee;
      req.v2ShopId = Number(employee.shop_id);
    }

    if (employee.role === 'owner') return next();
    const permissions = parsePermissions(employee);
    if (permissions[permission] === true) return next();
    return deny(req, res, 403, `Permission required: ${permission}`);
  };
}

module.exports = { parsePermissions, permissionMiddleware, validSessionEmployee, loadCurrentEmployee };
