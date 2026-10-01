'use strict';

/*
 * Garavex application launcher.
 *
 * server.js is the legacy production server and is intentionally left intact while
 * V2 is developed additively. This launcher installs V2 safety overrides before
 * compiling the legacy server, then injects the centralized V2 bootstrap immediately
 * before the HTTP listener starts.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Register tenant-safe replacements before server.js defines the legacy scheduling
// routes. The preload only intercepts the specific scheduling endpoints it owns.
require('./v2-scheduling-preload');

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

// V2 owns appointment reminders. Disable only the two legacy scheduler calls while
// leaving the legacy function definition intact for rollback/debugging.
source = source.replace(/\nsendAppointmentReminders\(\);\s*\n\s*setInterval\(sendAppointmentReminders,\s*15\s*\*\s*60\s*\*\s*1000\);/, '\n// Legacy appointment reminder scheduler disabled by Garavex V2.');

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
