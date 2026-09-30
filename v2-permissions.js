/* Garavex V2 role/permission helpers. */
function parsePermissions(employee) {
  if (!employee) return {};
  if (employee.role === 'owner') return { owner: true, all: true };
  try {
    const value = typeof employee.permissions_json === 'string'
      ? JSON.parse(employee.permissions_json || '{}')
      : (employee.permissions_json || {});
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

function permissionMiddleware(permission) {
  return function requireV2Permission(req, res, next) {
    const employee = req.session?.employee;
    if (!employee) return res.redirect('/login.html');
    if (employee.role === 'owner') return next();
    const permissions = parsePermissions(employee);
    if (permissions[permission] === true) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: `Permission required: ${permission}` });
    }
    return res.status(403).send('Access denied.');
  };
}

module.exports = { parsePermissions, permissionMiddleware };
