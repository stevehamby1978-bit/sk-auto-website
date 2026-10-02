# Garavex V2 tenant communications reconciliation

This branch is the isolated reconciliation workspace for bringing the production multi-shop communication protections into Garavex V2 without replacing V2's newer authorization and workflow guards.

## Confirmed current V2 protections

- Repair-order and payment ownership checks are scoped by the authenticated employee `shop_id`.
- Public estimate approval preserves the estimate `shop_id` when creating the repair order.
- Non-S&K tenants cannot fall through to legacy S&K-branded Twilio handlers.
- Non-S&K repair-order completion is tenant scoped and does not send S&K's legacy vehicle-ready message.
- Stripe Connect remains shop scoped in the main application.

## Production behavior to reconcile

Production `v1-final-safety-preload.js` contains generalized, shop-branded implementations for:

- invoice email
- payment receipt email
- payment receipt text
- invoice token generation scoped by `repair_orders.id + shop_id`
- customer and vehicle joins constrained to the repair order's shop
- voided-payment receipt rejection
- shop-specific name, address, phone and email branding

## Release rule

Do **not** relax V2's `requireSk` guard and allow non-S&K shops to fall through to legacy handlers. Those handlers contain S&K-specific branding and behavior.

Instead, the V2 communication layer must replace the guarded legacy invoice/receipt routes with tenant-generic handlers before this branch is promoted.

## Required verification before promotion

1. S&K invoice email is branded S&K and can only access an S&K repair order.
2. Zwickl invoice email is branded Zwickl and can only access a Zwickl repair order.
3. Cross-shop repair-order IDs return not found/forbidden without revealing customer data.
4. Payment receipt email/text validates both the repair order and payment ownership.
5. Voided payments cannot produce a receipt.
6. Invoice links use a token generated only on the authenticated shop's repair order.
7. Stripe Connect remains tied to the authenticated shop and is not changed by this reconciliation.
8. Existing V2 startup validation still passes.

No production deployment should occur from this branch until these gates pass.