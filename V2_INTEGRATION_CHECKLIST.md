# Garavex V2 Integration & Release Checklist

## Server integration
V2 is installed through the centralized `v2-bootstrap.js` entry point after the existing database, schema migrations, session middleware, `requireLogin`, and `requireOwner` helpers are initialized.

Current launch architecture:
- Production `npm start` runs `garavex-start.js`.
- `garavex-start.js` loads legacy `server.js`, injects the centralized V2 bootstrap immediately before `app.listen(...)`, and compiles it using `server.js` as the module filename.
- `server.js` intentionally remains free of direct V2 bootstrap wiring so the legacy startup path can still be used for V1 regression comparison.
- `npm run start:legacy` runs `server.js` directly without V2.
- `npm run validate:v2` performs static release/startup validation without starting the server or modifying the database.

Required integration:
- `v2-bootstrap.js` → `installGaravexV2(app, db, { requireLogin, requireOwner, twilioClient, resend })`
- `v2-bootstrap.js` installs `v2-schema.js` before all V2 route modules.
- Do not restore or import the retired `v2-api.js`; its responsibilities were split into hardened dedicated modules.
- Keep the Stripe webhook route before `express.json()` so signature verification receives the raw request body.
- Install V2 before `app.listen(...)` and only after all V1 schema migrations needed by V2 have completed.
- Keep `garavex-start.js` and `v2-startup-validation.js` synchronized if the launch architecture changes.

## Protected V2 pages
Require employee login:
- `/v2-dashboard.html`
- `/v2-dvi.html`
- `/v2-inventory.html`
- `/v2-vin.html`

Require owner login:
- `/v2-parts.html`
- `/v2-reports.html`
- `/v2-settings.html`

Public token-protected customer pages:
- `/dvi-review.html`
- `/customer-portal.html`

## Stripe-only rule
- Stripe Connect is the only integrated payment processor in V2.
- Do not expose QuickBooks setup or QuickBooks sync in V2 navigation or V2 workflows.
- Verify Stripe checkout, webhook signature verification, connected-account matching, duplicate payment protection, partial payment, paid status, and receipt flow.

## Multi-shop isolation tests
Create two test shops and verify that Shop A cannot read or mutate Shop B data through every V2 route:
- shop board / RO assignment / workflow
- DVI and DVI items
- technician time
- deferred services
- inventory
- vendors / purchase orders
- canned jobs
- profitability / reports
- audit log
- portal-token creation

Public DVI and customer portal endpoints must expose only the customer data linked to the opaque token and never accept a shop id from the browser.

## Functional acceptance tests
1. VIN decode returns vehicle data for a valid VIN and rejects malformed VINs.
2. Technician can clock in and clock out; duplicate open time entry is blocked.
3. Owner assigns technician and moves RO through V2 workflow.
4. DVI can be created from an RO and populated with green/yellow/red items.
5. Customer DVI token opens only that inspection.
6. Approving/declining DVI item persists decision.
7. Declined recommendation creates one deferred-service record without duplicates.
8. Customer portal token shows only that customer's vehicles, ROs and deferred services.
9. Inventory and vendor records are scoped to the current shop.
10. PO can be created and moved through ordered/partial/received states.
11. Profitability totals use parts/labor sales and costs.
12. Global search finds customer, vehicle, VIN, plate and RO only in current shop.
13. Owner can set labor rate/parts markup and create canned jobs.
14. Employee permissions persist and audit events are created.
15. DVI/status/portal SMS uses the current shop name, not hard-coded S&K Auto branding.
16. Existing appointments, estimates, ROs, invoices and Stripe payment flow still pass regression testing.

## Startup validation
- Confirm `package.json` production start command is `node garavex-start.js`.
- Confirm legacy `server.js` contains no direct `v2-bootstrap` import or `installGaravexV2(...)` call.
- Confirm `garavex-start.js` injects exactly one V2 bootstrap immediately before `app.listen(...)`.
- Confirm every module imported by `v2-bootstrap.js` exists on the release branch.
- Confirm no duplicate `/api/v2/...` route definitions remain outside their authoritative modules.
- Confirm the retired `v2-api.js` is not imported.
- Confirm Stripe webhook remains before `express.json()`.
- Confirm a fresh database and a copy of the production schema both complete `installV2Schema(db)` without errors.
- Confirm startup succeeds when optional Twilio/Resend credentials are absent where those features are not exercised.
- Run `npm run validate:v2` before every V2 release candidate.

## Runtime readiness
Owner-only diagnostics are available after V2 startup:
- `/api/v2/preflight` checks the authenticated shop, critical schema presence, shop scoping and Stripe connection state.
- `/api/v2/health` performs deeper database integrity, foreign-key, schema/index, environment and session/shop checks.
- Diagnostics must remain `no-store` and must not expose secrets or cross-shop records.

## Legacy branding cleanup before release
The inherited V1 `server.js` still contains hard-coded S&K Auto receipt/invoice messaging and URLs. V2 release must replace customer-facing hard-coded shop identity with `shops` table values and Garavex/app URLs while leaving the S&K Auto public website behavior isolated to its own domain.

## Release gate
Do not merge/deploy V2 to production until:
- V2 launcher/bootstrap validation passes
- syntax checks pass
- migration is tested on a copy of the production schema
- multi-shop isolation tests pass
- Stripe sandbox end-to-end payment test passes
- customer token security tests pass
- V1 regression tests pass
- legacy customer-facing hard-coded S&K Auto branding is isolated or replaced for Garavex workflows
- `/api/v2/preflight` reports ready for the release test shop
- `/api/v2/health` reports `release_ready: true` for the release test shop
- a complete source ZIP is produced and saved before production deployment
