GARAVEX CLEAN STRIPE BUILD
==========================

This build uses Stripe Connect as its integrated online payment system.

Payments:
- Each shop connects its own Stripe account from Shop Settings.
- Customer invoice Pay button creates a Stripe Checkout Session on that shop's connected account.
- After Stripe returns, Garavex verifies the Checkout Session with Stripe before recording payment.
- Stripe Checkout session IDs are stored on payment records to prevent duplicate payment recording.

Core features retained:
- Multi-shop shop_id isolation
- Owner/employee login
- Customers and vehicles
- Estimates
- Repair orders and recommended repairs
- Customer authorization
- Invoices and receipts
- Local payment recording
- Stripe Connect and online card payments
- Appointments, blocked dates/times, reminders
- SMS/email communication
- Service history
- Shop profile/branding settings

Railway environment variables:
- SESSION_SECRET
- STRIPE_SECRET_KEY
- Existing Twilio/Resend/email variables if those features are used
- DATA_DIR should continue to point at the Railway persistent volume when preserving data

IMPORTANT DEPLOYMENT SAFETY:
Deploy this as a separate Railway service/project first. Do not delete the existing production service or database until this build has passed end-to-end testing.
