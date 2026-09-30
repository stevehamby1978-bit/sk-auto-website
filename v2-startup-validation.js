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

const bootstrapName='v2-bootstrap.js';
check(exists(bootstrapName),`${bootstrapName} exists`);
if(!exists(bootstrapName)){
 console.error('Garavex V2 validation failed: v2-bootstrap.js is missing.');
 process.exit(1);
}
const bootstrap=read(bootstrapName);
const importRe=/require\(['"]\.\/(v2-[^'"]+)['"]\)/g;
const imports=[];let m;
while((m=importRe.exec(bootstrap)))imports.push(`${m[1]}.js`);
for(const file of imports)check(exists(file),`Bootstrap dependency exists: ${file}`);
check(!/require\(['"]\.\/v2-api['"]\)/.test(bootstrap),'Retired v2-api.js is not imported');
check(/installV2Schema\(db\)/.test(bootstrap),'V2 schema installs from centralized bootstrap');
check(/installedApps\s*=\s*new WeakSet\(\)/.test(bootstrap)&&/installedApps\.has\(app\)/.test(bootstrap),'Bootstrap has duplicate-install guard');

const jsFiles=fs.readdirSync(root).filter(f=>/^v2-.*\.js$/.test(f)&&f!==path.basename(__filename));
const routes=new Map();
const routeRe=/app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
for(const file of jsFiles){
 const src=read(file);let r;
 while((r=routeRe.exec(src))){
  const key=`${r[1].toUpperCase()} ${r[2]}`;
  if(!routes.has(key))routes.set(key,[]);
  routes.get(key).push(file);
 }
}
for(const [route,files] of routes){
 const unique=[...new Set(files)];
 if(unique.length>1)fail.push(`Duplicate V2 route ${route}: ${unique.join(', ')}`);
}

const serverName='server.js';
const launcherName='garavex-start.js';
if(check(exists(serverName),'server.js exists')&&check(exists(launcherName),'garavex-start.js exists')){
 const server=read(serverName),launcher=read(launcherName);
 const directImports=(server.match(/require\(['"]\.\/v2-bootstrap['"]\)/g)||[]).length;
 const directCalls=(server.match(/installGaravexV2\s*\(/g)||[]).length;
 check(directImports===0,`Legacy server.js remains V2-bootstrap free (found ${directImports} direct import(s))`);
 check(directCalls===0,`Legacy server.js remains V2-install free (found ${directCalls} direct call(s))`);
 check(/require\(['"]\.\/v2-bootstrap['"]\)/.test(launcher),'Launcher injects the centralized V2 bootstrap import');
 check(/installGaravexV2\(app, db/.test(launcher),'Launcher injects installGaravexV2');
 check(/listenerNeedle\s*=\s*['"]\\napp\.listen\(PORT/.test(launcher),'Launcher targets the HTTP listener insertion point');
 check(/source\.replace\(listenerNeedle/.test(launcher),'Launcher injects V2 immediately before app.listen');
 check(/source\.includes\(bootstrapMarker\)/.test(launcher),'Launcher rejects accidental direct bootstrap wiring');
 const webhook=server.indexOf("app.post('/api/stripe/webhook'");
 const json=server.indexOf('app.use(express.json())');
 check(webhook>=0&&json>=0&&webhook<json,'Stripe webhook remains before express.json');
 if(/quickbooks/i.test(bootstrap))fail.push('QuickBooks reference found in V2 bootstrap; V2 must remain Stripe-only.');
}

if(exists('package.json')){
 try{
  const pkg=JSON.parse(read('package.json'));
  check(pkg?.scripts?.start==='node garavex-start.js','Production start command uses the V2 launcher');
  if(pkg?.scripts?.['start:legacy']!=='node server.js')warn.push('Legacy start command is not explicitly preserved as node server.js.');
 }catch(err){fail.push(`package.json could not be parsed: ${err.message}`);}
}

const summary={ok:fail.length===0,passed:ok.length,failed:fail.length,warnings:warn.length,failures:fail,warningDetails:warn};
console.log(JSON.stringify(summary,null,2));
if(fail.length)process.exitCode=1;
