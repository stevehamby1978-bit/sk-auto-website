'use strict';

/*
 * Garavex application launcher.
 *
 * server.js is the legacy production server and is intentionally left intact while
 * V2 is developed additively. This launcher injects the centralized V2 bootstrap
 * immediately before the HTTP listener starts, after the legacy schema/routes have
 * been defined. That guarantees every V2 schema migration and route is installed
 * exactly once without duplicating dozens of require/install calls in server.js.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const serverFilename = path.join(__dirname, 'server.js');
const listenerNeedle = '\napp.listen(PORT, () => {';
const bootstrapMarker = 'installGaravexV2(app, db';

let source = fs.readFileSync(serverFilename, 'utf8');

if (!source.includes(listenerNeedle)) {
  throw new Error('Garavex startup aborted: server.js listener insertion point was not found.');
}
if (source.includes(bootstrapMarker)) {
  throw new Error('Garavex startup aborted: V2 bootstrap is already wired directly into server.js. Remove garavex-start.js from the start command before deploying.');
}

const bootstrap = `
// ===== GARAVEX V2 CENTRALIZED BOOTSTRAP =====
const { installGaravexV2 } = require('./v2-bootstrap');
installGaravexV2(app, db, {
  requireLogin,
  requireOwner,
  twilioClient,
  resend
});
// ===== END GARAVEX V2 CENTRALIZED BOOTSTRAP =====
`;

source = source.replace(listenerNeedle, `${bootstrap}${listenerNeedle}`);

// Compile using server.js as the module filename so __dirname and all relative
// require() calls behave exactly as they do when server.js is launched directly.
const serverModule = new Module(serverFilename, module);
serverModule.filename = serverFilename;
serverModule.paths = Module._nodeModulePaths(__dirname);
serverModule._compile(source, serverFilename);
