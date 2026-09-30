# GARAVEX V2

This branch is the isolated development baseline for Garavex V2.

## Production safety
- Branch: `garavex-v2`
- Base: current production `main`
- Do not deploy this branch to the production app until V2 testing is complete.
- Existing V1 behavior is the compatibility baseline.

## V2 scope
1. Digital Vehicle Inspections (green/yellow/red findings, photos, video-ready attachment model, customer review/approval)
2. Technician assignment and technician dashboard
3. Live shop workflow board
4. VIN decoding/scanning workflow
5. Parts cost, selling price, markup, gross profit
6. Technician time clock and actual-vs-billed labor
7. Deferred/declined service tracking and follow-up
8. Expanded automated customer SMS/status notifications
9. Customer portal for approvals, inspections, invoices, payments, service history
10. Inventory, vendors, purchase orders, parts status
11. Expanded KPI/profitability reporting
12. Global customer/vehicle/VIN/RO search
13. Canned jobs/services and configurable labor rates
14. Expanded employee permissions and audit history
15. Photos/documents/attachments throughout repair workflow
16. Mobile/tablet usability improvements
17. V2 onboarding and shop configuration

## Compatibility requirements
Preserve multi-shop `shop_id` isolation and existing authentication, appointments, estimates, repair orders, invoices/payments, Stripe Connect, QuickBooks, Twilio, customer/vehicle history, employee management, and shop settings.

## Delivery target
A tested `Garavex-V2.zip` built from this branch after V2 implementation and validation.
