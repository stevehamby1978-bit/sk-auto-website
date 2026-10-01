/* Garavex V2 pre-release startup/static validation.
 * Run: node v2-startup-validation.js
 * This script does not start the server or modify the database.
 */
'use strict';
const fs=require('fs');
const path=require('path');
const root=__dirname;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const exists=name=>fs.existsSync(path.join(root,name));
const fail=[];
const warn=[];
const ok=[];
function check(condition,message){(condition?ok:fail).push(message);return condition;}
function syntaxCheck(file){try{new Function(read(file));ok.push(`JavaScript syntax valid: ${file}`);return true;}catch(err){fail.push(`JavaScript syntax invalid: ${file}: ${err.message}`);return false;}}

const bootstrapName='v2-bootstrap.js';
check(exists(bootstrapName),`${bootstrapName} exists`);
if(!exists(bootstrapName)){console.error('Garavex V2 validation failed: v2-bootstrap.js is missing.');process.exit(1);}
const bootstrap=read(bootstrapName);
const importRe=/require\(['"]\.\/(v2-[^'"]+)['"]\)/g;
const imports=[];let m;
while((m=importRe.exec(bootstrap)))imports.push(`${m[1]}.js`);
for(const file of imports)check(exists(file),`Bootstrap dependency exists: ${file}`);
check(!/require\(['"]\.\/v2-api['"]\)/.test(bootstrap),'Retired v2-api.js is not imported');
check(/installV2Schema\(db\)/.test(bootstrap),'V2 schema installs from centralized bootstrap');
check(/installedApps\s*=\s*new WeakSet\(\)/.test(bootstrap)&&/installedApps\.has\(app\)/.test(bootstrap),'Bootstrap has duplicate-install guard');
check(/installingApps\s*=\s*new WeakSet\(\)/.test(bootstrap)&&/installingApps\.has\(app\)/.test(bootstrap)&&/installingApps\.delete\(app\)/.test(bootstrap),'Bootstrap has in-progress installation guard');

const jsFiles=fs.readdirSync(root).filter(f=>/^v2-.*\.js$/.test(f));
for(const file of jsFiles)syntaxCheck(file);
for(const file of ['garavex-start.js'])if(exists(file))syntaxCheck(file);

const routes=new Map();
const routeRe=/app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
for(const file of jsFiles.filter(f=>f!==path.basename(__filename))){const src=read(file);let r;while((r=routeRe.exec(src))){const key=`${r[1].toUpperCase()} ${r[2]}`;if(!routes.has(key))routes.set(key,[]);routes.get(key).push(file);}}
for(const [route,files] of routes){const unique=[...new Set(files)];if(unique.length>1)fail.push(`Duplicate V2 route ${route}: ${unique.join(', ')}`);}

const permissionMutation='PUT /api/v2/employees/:id/permissions';
const permissionOwners=[...new Set(routes.get(permissionMutation)||[])];
check(permissionOwners.length===1&&permissionOwners[0]==='v2-permissions-admin.js',`Employee permission mutation has one authoritative owner: v2-permissions-admin.js (found ${permissionOwners.join(', ')||'none'})`);
if(exists('v2-admin-api.js'))check(!/app\.(put|patch)\(\s*['"]\/api\/v2\/employees\/:id\/permissions['"]/.test(read('v2-admin-api.js')),'V2 admin API does not redefine employee permission mutation');

if(check(exists('v2-schema.js'),'v2-schema.js exists')){
 const schema=read('v2-schema.js');
 check(/assertBaseSchema\(db\)[\s\S]*BEGIN IMMEDIATE/.test(schema),'V2 validates base schema before opening migration transaction');
 check(/db\.exec\(['"]BEGIN IMMEDIATE['"]\)/.test(schema),'V2 schema migration starts an immediate transaction');
 check(/db\.exec\(['"]COMMIT['"]\)/.test(schema),'V2 schema migration commits explicitly');
 check(/db\.exec\(['"]ROLLBACK['"]\)/.test(schema),'V2 schema migration rolls back on failure');
 check(/applyV2Schema\(db\)/.test(schema),'V2 schema changes are grouped behind the transactional migration wrapper');
}

if(check(exists('v2-permissions.js'),'v2-permissions.js exists')){
 const permissions=read('v2-permissions.js');
 check(/WHERE\s+id\s*=\s*\?\s+AND\s+shop_id\s*=\s*\?\s+AND\s+active\s*=\s*1/i.test(permissions),'V2 live employee authorization rejects inactive employees');
 check(/loadCurrentEmployee\(db,\s*sessionEmployee\)/.test(permissions),'V2 permission middleware authorizes from the live employee row');
 check(/req\.v2ShopId\s*=\s*Number\(employee\.shop_id\)/.test(permissions),'V2 permission middleware derives request shop identity from the live employee row');
 check(/function normalizedRole\(employee\)/.test(permissions)&&/\.trim\(\)\.toLowerCase\(\)/.test(permissions),'V2 owner authorization uses normalized live roles');
 check(/Object\.create\(null\)/.test(permissions),'V2 parsed permissions use a prototype-free object');
 check(/granted\s*===\s*true/.test(permissions),'V2 permission parsing grants only explicit boolean true values');
 check(/Object\.prototype\.hasOwnProperty\.call\(permissions,\s*requiredPermission\)/.test(permissions),'V2 permission authorization requires an own permission property');
 check(/const requiredPermission\s*=\s*permission\.trim\(\)/.test(permissions),'V2 permission names are normalized before authorization');
}
if(check(exists('v2-permissions-admin.js'),'v2-permissions-admin.js exists')){
 const admin=read('v2-permissions-admin.js');
 check(/loadCurrentEmployee\(db,sessionEmployee\)/.test(admin),'V2 permissions admin reloads the live employee');
 check(/WHERE id=\? AND shop_id=\? AND active=1/.test(admin),'V2 permissions admin targets active employees in the current shop');
 check(/UPDATE employees SET permissions_json=\? WHERE id=\? AND shop_id=\? AND active=1/.test(admin),'V2 permission writes remain active-employee and shop scoped');
 check(/stillLiveOwner\(req,sc\)/.test(admin),'V2 permission writes revalidate the acting owner inside the transaction');
 check(/normalizedRole\(emp\)===['"]owner['"]/.test(admin),'V2 permission admin protects normalized owner roles');
 check(/LOWER\(TRIM\(COALESCE\(role,''\)\)\)!='owner'/.test(admin),'V2 permission SQL refuses to restrict owner accounts');
 check(/no-store, private, max-age=0/.test(admin),'V2 permission admin disables caching for sensitive responses');
 check(/employee\.permissions_updated/.test(admin),'V2 permission changes remain audit logged');
 const catalogMatch=admin.match(/const catalog=\{([\s\S]*?)\};/);
 if(check(Boolean(catalogMatch),'V2 permission catalog can be inspected by release validation')){
  const catalogKeys=new Set();
  const keyRe=/([A-Za-z_][A-Za-z0-9_]*)\s*:/g;let k;
  while((k=keyRe.exec(catalogMatch[1])))catalogKeys.add(k[1]);
  check(catalogKeys.has('dashboard'),'V2 permission catalog includes dashboard authorization');
  const usages=[];
  const usageRe=/permissionMiddleware\(\s*['"]([^'"]+)['"]/g;
  for(const file of jsFiles){const src=read(file);let u;while((u=usageRe.exec(src)))usages.push({file,key:u[1]});}
  const unknown=usages.filter(u=>!catalogKeys.has(u.key));
  check(unknown.length===0,`All permissionMiddleware keys exist in the V2 permission catalog${unknown.length?`: ${unknown.map(u=>`${u.file}:${u.key}`).join(', ')}`:''}`);
  check(usages.some(u=>u.file==='v2-time.js'&&u.key==='time_clock'),'V2 technician time uses canonical time_clock permission');
  check(usages.some(u=>u.file==='v2-dashboard-kpis.js'&&u.key==='dashboard'),'V2 dashboard KPIs use canonical dashboard permission');
 }
}

if(check(exists('v2-core-operations.js'),'v2-core-operations.js exists')){
 const core=read('v2-core-operations.js');
 check(/requireRO\s*=\s*permissionMiddleware\(['"]repair_orders['"],\s*db\)/.test(core),'V2 core operations define repair_orders authorization');
 check(/requireReports\s*=\s*permissionMiddleware\(['"]reports['"],\s*db\)/.test(core),'V2 core operations define reports authorization');
 check(/requireAudit\s*=\s*permissionMiddleware\(['"]audit['"],\s*db\)/.test(core),'V2 core operations define audit authorization');
 check(/app\.get\(['"]\/api\/v2\/overview['"],\s*requireLogin,\s*requireRO/.test(core),'V2 overview requires repair_orders permission');
 check(/app\.get\(['"]\/api\/v2\/technician-performance['"],\s*requireLogin,\s*requireOwner,\s*requireReports/.test(core),'Technician performance requires owner and reports authorization');
 check(/app\.get\(['"]\/api\/v2\/profitability['"],\s*requireLogin,\s*requireOwner,\s*requireReports/.test(core),'Profitability requires owner and reports authorization');
 check(/app\.get\(['"]\/api\/v2\/audit['"],\s*requireLogin,\s*requireOwner,\s*requireAudit/.test(core),'Audit log requires owner and audit authorization');
}

if(check(exists('v2-admin-api.js'),'v2-admin-api.js exists')){
 const adminApi=read('v2-admin-api.js');
 check(/requireSettings\s*=\s*permissionMiddleware\(['"]settings['"],\s*db\)/.test(adminApi),'V2 admin API defines settings authorization');
 check(/app\.get\(['"]\/api\/v2\/settings['"],\s*requireLogin,\s*requireOwner,\s*requireSettings/.test(adminApi),'V2 settings read requires owner and settings authorization');
 check(/app\.patch\(['"]\/api\/v2\/settings['"],\s*requireLogin,\s*requireOwner,\s*requireSettings/.test(adminApi),'V2 settings update requires owner and settings authorization');
 check(/app\.get\(['"]\/api\/v2\/canned-jobs['"],\s*requireLogin,\s*requireSettings/.test(adminApi),'V2 canned-job reads require settings authorization');
 check(/app\.post\(['"]\/api\/v2\/canned-jobs['"],\s*requireLogin,\s*requireOwner,\s*requireSettings/.test(adminApi),'V2 canned-job creation requires owner and settings authorization');
 check(/stillLive\(req,scope\)/.test(adminApi),'V2 admin writes revalidate the live employee inside transactions');
 check(/no-store, private, max-age=0/.test(adminApi),'V2 admin API disables caching for sensitive responses');
}

if(check(exists('v2-vin.js'),'v2-vin.js exists')){
 const vin=read('v2-vin.js');
 check(/permissionMiddleware\(['"]repair_orders['"],\s*db\)/.test(vin),'V2 VIN decoding defines repair_orders authorization');
 check(/app\.get\(['"]\/api\/v2\/vin\/:vin['"],\s*requireLogin,\s*requireRO/.test(vin),'V2 VIN decoding requires repair_orders permission');
 check(/loadCurrentEmployee\(db,req\.session\?\.employee\)/.test(vin),'V2 VIN decoding revalidates the live employee after the external request');
 check(/no-store, private, max-age=0/.test(vin),'V2 VIN responses disable caching');
}

if(check(exists('v2-warranty.js'),'v2-warranty.js exists')){
 const warranty=read('v2-warranty.js');
 check(/normalizedRole\}=require\(['"]\.\/v2-permissions['"]\)/.test(warranty),'V2 warranty imports canonical role normalization');
 check(/normalizedRole\(employee\)!==['"]owner['"]/.test(warranty),'V2 warranty owner middleware uses normalized roles');
 check(/normalizedRole\(current\)!==['"]owner['"]/.test(warranty),'V2 warranty transaction revalidates normalized owner role');
 check(/w\.shop_id=\?/.test(warranty)&&/r\.shop_id=w\.shop_id/.test(warranty),'V2 warranty records remain shop scoped to repair orders');
 check(/no-store, private, max-age=0/.test(warranty),'V2 warranty responses disable caching');
}

const customerFacingV2Pages=['v2-dashboard.html','v2-dvi.html','v2-inventory.html','v2-vin.html','v2-parts.html','v2-reports.html','v2-settings.html','dvi-review.html','customer-portal.html'];
for(const file of customerFacingV2Pages){
 if(exists(file)){
  const src=read(file);
  check(!/S&K\s+Auto|S&amp;K\s+Auto|S&K\s+AUTO|S&amp;K\s+AUTO/i.test(src),`V2 customer-facing page has no hard-coded S&K Auto branding: ${file}`);
 }
}
for(const file of ['v2-preflight.js','v2-health.js','v2-release-tests.js']){
 if(check(exists(file),`${file} exists`)){
  const src=read(file);
  check(/requireOwner/.test(src),`${file} requires owner authorization`);
  check(/no-store/.test(src),`${file} disables response caching`);
  check(/loadCurrentEmployee/.test(src),`${file} reloads the authenticated employee from the database`);
  check(/shop_id/.test(src),`${file} validates shop-scoped identity/data`);
 }
}
if(exists('v2-preflight.js')){
 const preflight=read('v2-preflight.js');
 check(/STRIPE_SECRET_KEY/.test(preflight)&&/STRIPE_WEBHOOK_SECRET/.test(preflight),'V2 preflight requires Stripe server and webhook configuration');
 check(/stripeAccountConfigured/.test(preflight)&&/stripeConnected/.test(preflight),'V2 preflight requires connected-shop Stripe readiness');
 check(/blockers/.test(preflight)&&/ready/.test(preflight),'V2 preflight exposes explicit readiness blockers');
}

const serverName='server.js',launcherName='garavex-start.js';
if(check(exists(serverName),'server.js exists')&&check(exists(launcherName),'garavex-start.js exists')){
 const server=read(serverName),launcher=read(launcherName);
 const directImports=(server.match(/require\(['"]\.\/v2-bootstrap['"]\)/g)||[]).length,directCalls=(server.match(/installGaravexV2\s*\(/g)||[]).length;
 check(directImports===0,`Legacy server.js remains V2-bootstrap free (found ${directImports} direct import(s))`);
 check(directCalls===0,`Legacy server.js remains V2-install free (found ${directCalls} direct call(s))`);
 check(/require\(['"]\.\/v2-bootstrap['"]\)/.test(launcher),'Launcher injects the centralized V2 bootstrap import');
 check(/installGaravexV2\(app, db/.test(launcher),'Launcher injects installGaravexV2');
 check(/listenerNeedle\s*=\s*['"]\\napp\.listen\(PORT/.test(launcher),'Launcher targets the HTTP listener insertion point');
 check(/source\.replace\(listenerNeedle/.test(launcher),'Launcher injects V2 immediately before app.listen');
 check(/source\.includes\(bootstrapMarker\)/.test(launcher),'Launcher rejects accidental direct bootstrap wiring');
 const webhook=server.indexOf("app.post('/api/stripe/webhook'"),json=server.indexOf('app.use(express.json())');
 check(webhook>=0&&json>=0&&webhook<json,'Stripe webhook remains before express.json');
 if(/quickbooks/i.test(bootstrap))fail.push('QuickBooks reference found in V2 bootstrap; V2 must remain Stripe-only.');
}

if(exists('package.json')){try{const pkg=JSON.parse(read('package.json'));check(pkg?.scripts?.start==='node garavex-start.js','Production start command uses the V2 launcher');check(pkg?.scripts?.['validate:v2']==='node v2-startup-validation.js','V2 validation command is registered');if(pkg?.scripts?.['start:legacy']!=='node server.js')warn.push('Legacy start command is not explicitly preserved as node server.js.');}catch(err){fail.push(`package.json could not be parsed: ${err.message}`);}}
if(check(exists('Dockerfile'),'Dockerfile exists')){const docker=read('Dockerfile');check(/CMD\s*\[\s*["']node["']\s*,\s*["']garavex-start\.js["']\s*\]/.test(docker),'Docker starts through garavex-start.js');if(/CMD\s*\[\s*["']node["']\s*,\s*["']server\.js["']\s*\]/.test(docker))fail.push('Dockerfile still contains a legacy-only server.js CMD.');}

const summary={ok:fail.length===0,passed:ok.length,failed:fail.length,warnings:warn.length,failures:fail,warningDetails:warn};
console.log(JSON.stringify(summary,null,2));
if(fail.length)process.exitCode=1;
