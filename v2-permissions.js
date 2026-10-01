/* Garavex V2 role/permission helpers. */
function normalizedRole(employee) {
  return String(employee?.role || '').trim().toLowerCase();
}

function parsePermissions(employee) {
  if (!employee) return {};
  if (normalizedRole(employee) === 'owner') return { owner: true, all: true };
  try {
    const value = typeof employee.permissions_json === 'string'
      ? JSON.parse(employee.permissions_json || '{}')
      : (employee.permissions_json || {});
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    // Only an explicit boolean true grants a permission. Ignore prototype keys
    // and non-boolean truthy values from malformed or legacy permission JSON.
    const permissions = Object.create(null);
    for (const [key, granted] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && granted === true) permissions[key] = true;
    }
    return permissions;
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
      SELECT id, shop_id, name, email, role, permissions_json, active
      FROM employees
      WHERE id = ? AND shop_id = ? AND active = 1
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
  const requiredPermission = permission.trim();
  return function requireV2Permission(req, res, next) {
    const sessionEmployee = req.session?.employee;
    if (!validSessionEmployee(sessionEmployee)) {
      return deny(req, res, 401, 'A valid employee shop session is required.');
    }

    // When a database handle is supplied, authorization is based on the live,
    // active employee row rather than a potentially stale role/permissions
    // snapshot stored in the session. Permission changes, deactivation and
    // account removal therefore take effect immediately without allowing a
    // shop id to change mid-session.
    const employee = db ? loadCurrentEmployee(db, sessionEmployee) : sessionEmployee;
    if (!employee) return deny(req, res, 401, 'Employee session is no longer valid for this shop.');

    if (db) {
      req.v2Employee = employee;
      req.v2ShopId = Number(employee.shop_id);
    }

    if (normalizedRole(employee) === 'owner') return next();
    const permissions = parsePermissions(employee);
    if (Object.prototype.hasOwnProperty.call(permissions, requiredPermission) && permissions[requiredPermission] === true) return next();
    return deny(req, res, 403, `Permission required: ${requiredPermission}`);
  };
}

module.exports = { parsePermissions, permissionMiddleware, validSessionEmployee, loadCurrentEmployee, normalizedRole };
