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
const { execFileSync } = require('child_process');

// Safety preloads open the same SQLite file as server.js, so ensure the configured
// data directory exists before they are required.
fs.mkdirSync(process.env.DATA_DIR || path.join(__dirname, 'data'), { recursive: true });

// Railway pre-deploy commands run before the persistent volume is mounted. Run the
// narrowly-scoped owner repair here instead, after /app/data is mounted but before
// authentication routes are installed. The repair script refuses ambiguous changes.
if (process.env.V2_REPAIR_OWNER_EMAIL && process.env.V2_REPAIR_OWNER_PASSWORD) {
  execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'v2-login-repair.js')], {
    stdio: 'inherit',
    env: process.env
  });
}

// Register tenant-safe replacements before server.js defines the corresponding
// legacy routes. Each preload intercepts only the endpoints it owns.
require('./v2-auth-preload');
require('./v2-scheduling-preload');
require('./v2-recommendations-preload');
require('./v2-communications-preload');

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
const { installV2AuthDiagnostic } = require('./v2-auth-diagnostic');
installGaravexV2(app, db, {
  requireLogin,
  requireOwner,
  twilioClient,
  resend
});
installV2AuthDiagnostic(app, db, { requireOwner });
// ===== END GARAVEX V2 CENTRALIZED BOOTSTRAP =====
`;

source = source.replace(listenerNeedle, `${bootstrap}${listenerNeedle}`);

// Compile using server.js as the module filename so __dirname and all relative
// require() calls behave exactly as they do when server.js is launched directly.
const serverModule = new Module(serverFilename, module);
serverModule.filename = serverFilename;
serverModule.paths = Module._nodeModulePaths(__dirname);
serverModule._compile(source, serverFilename);
