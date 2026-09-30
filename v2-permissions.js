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

function permissionMiddleware(permission) {
  if (typeof permission !== 'string' || !permission.trim()) {
    throw new Error('Garavex V2 permission middleware requires a permission name.');
  }
  return function requireV2Permission(req, res, next) {
    const employee = req.session?.employee;
    const apiRequest = req.path.startsWith('/api/');
    if (!validSessionEmployee(employee)) {
      if (apiRequest) return res.status(401).json({ error: 'A valid employee shop session is required.' });
      return res.redirect('/login.html');
    }
    if (employee.role === 'owner') return next();
    const permissions = parsePermissions(employee);
    if (permissions[permission] === true) return next();
    if (apiRequest) return res.status(403).json({ error: `Permission required: ${permission}` });
    return res.status(403).send('Access denied.');
  };
}

module.exports = { parsePermissions, permissionMiddleware, validSessionEmployee };
