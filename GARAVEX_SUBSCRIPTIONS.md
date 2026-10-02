# Garavex V2 subscription tiers

This branch adds the safe foundation for subscription tiers without turning billing on automatically.

## Plans

- Starter: core customer, vehicle, appointment, estimate, repair-order, invoice/payment, and service-history workflow. Employee limit: 2.
- Professional: Starter plus DVI, inventory, technician workflow, recommendations/approvals, SMS, reporting, and deferred services. Employee limit: 8.
- Elite: Professional plus QuickBooks, loaners, advanced reporting/profitability, advanced workflow, warranty/comebacks, and automation. Employee limit: unlimited.

## Shop columns to add during server integration

- `subscription_plan TEXT NOT NULL DEFAULT 'starter'`
- `subscription_status TEXT NOT NULL DEFAULT 'active'`
- `stripe_customer_id TEXT`
- `stripe_subscription_id TEXT`
- `stripe_price_id TEXT`
- `subscription_current_period_end TEXT`
- `subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0`

Existing shops should remain active during migration. A Stripe-backed shop should fall back to Starter access if its Stripe subscription is no longer active/trialing.

## Required before paid launch

1. Add the columns above through the existing idempotent shops migration in `server.js`.
2. Configure three recurring Stripe Price IDs as Railway variables (do not hard-code secrets or price IDs).
3. Add subscription Checkout and Billing Portal endpoints.
4. Extend the existing Stripe webhook to process subscription lifecycle events in addition to connected-account repair-order payments.
5. Add `/api/subscription` so the UI can display the current plan, status, renewal date, features, and employee limit.
6. Apply `requireFeature(...)` to premium server endpoints. UI hiding alone is not sufficient security.
7. Enforce employee limits in the employee-create endpoint.
8. Add owner-facing Billing/Plan UI for upgrade, downgrade, cancellation, and portal access.
9. Test with at least two shops to confirm plan changes and billing events never cross `shop_id` boundaries.

## Environment variables planned

- `STRIPE_STARTER_PRICE_ID`
- `STRIPE_PROFESSIONAL_PRICE_ID`
- `STRIPE_ELITE_PRICE_ID`

The existing Stripe secret and webhook variables remain in use. Subscription billing must use the Garavex platform Stripe account; the existing Stripe Connect flow for a shop collecting repair invoices is a separate concern.
