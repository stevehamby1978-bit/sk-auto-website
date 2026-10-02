'use strict';

/* Garavex application launcher. */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || process.env.DATA_Dir || path.join(__dirname, 'data');
process.env.DATA_DIR = dataDir;
process.env.DATA_Dir = dataDir;
fs.mkdirSync(dataDir, { recursive: true });
console.log(`[V2 STARTUP] database=${path.join(dataDir, 'bookings.db')}`);

if (process.env.V2_REPAIR_OWNER_EMAIL && process.env.V2_REPAIR_OWNER_PASSWORD) {
  console.log('[V2 STARTUP] verifying S&K owner');
  execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'v2-login-repair.js')], {
    stdio: 'inherit',
    env: process.env
  });
  console.log('[V2 STARTUP] S&K owner verification finished');
}

require('./v2-auth-preload');
require('./v2-scheduling-preload');
require('./v2-recommendations-preload');
require('./v2-communications-preload');

const serverFilename = path.join(__dirname, 'server.js');
const listenerNeedle = '\napp.listen(PORT, () => {';
const bootstrapMarker = 'installGaravexV2(app, db';
let source = fs.readFileSync(serverFilename, 'utf8');

if (!source.includes(listenerNeedle)) throw new Error('Garavex startup aborted: server.js listener insertion point was not found.');
if (source.includes(bootstrapMarker)) throw new Error('Garavex startup aborted: V2 bootstrap is already wired directly into server.js.');

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

const serverModule = new Module(serverFilename, module);
serverModule.filename = serverFilename;
serverModule.paths = Module._nodeModulePaths(__dirname);
serverModule._compile(source, serverFilename);
