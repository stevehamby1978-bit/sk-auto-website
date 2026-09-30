/*
 * Garavex V2 bootstrap
 *
 * Centralizes V2 installation so server.js only needs one integration point.
 * The bootstrap is intentionally additive and leaves the V1 production routes intact.
 */
const { installV2Schema } = require('./v2-schema');
const { installV2Api } = require('./v2-api');
const { installV2AdminApi } = require('./v2-admin-api');
const { installVinApi } = require('./v2-vin');
const { installV2Communications } = require('./v2-communications');
const { installV2Followups } = require('./v2-followups');
const { installV2Checkin } = require('./v2-checkin');

function installGaravexV2(app, db, deps) {
  if (!app || !db) throw new Error('Garavex V2 requires app and db.');
  if (!deps?.requireLogin || !deps?.requireOwner) {
    throw new Error('Garavex V2 requires authentication middleware.');
  }

  installV2Schema(db);
  installV2Api(app, db, { requireLogin:deps.requireLogin, requireOwner:deps.requireOwner });
  installV2AdminApi(app, db, { requireLogin:deps.requireLogin, requireOwner:deps.requireOwner });
  installVinApi(app, { requireLogin:deps.requireLogin });
  installV2Communications(app, db, { requireLogin:deps.requireLogin, twilioClient:deps.twilioClient, resend:deps.resend });
  installV2Followups(app, db, { requireLogin:deps.requireLogin, twilioClient:deps.twilioClient });
  installV2Checkin(app, db, { requireLogin:deps.requireLogin });

  console.log('Garavex V2 modules installed.');
}
module.exports = { installGaravexV2 };
