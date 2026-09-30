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

function installGaravexV2(app, db, deps) {
  if (!app || !db) throw new Error('Garavex V2 requires app and db.');
  if (!deps?.requireLogin || !deps?.requireOwner) {
    throw new Error('Garavex V2 requires authentication middleware.');
  }

  // Additive schema migrations run before V2 routes are registered.
  installV2Schema(db);

  installV2Api(app, db, {
    requireLogin: deps.requireLogin,
    requireOwner: deps.requireOwner
  });

  installV2AdminApi(app, db, {
    requireLogin: deps.requireLogin,
    requireOwner: deps.requireOwner
  });

  installVinApi(app, {
    requireLogin: deps.requireLogin
  });

  installV2Communications(app, db, {
    requireLogin: deps.requireLogin,
    twilioClient: deps.twilioClient,
    resend: deps.resend
  });

  console.log('Garavex V2 modules installed.');
}

module.exports = { installGaravexV2 };
