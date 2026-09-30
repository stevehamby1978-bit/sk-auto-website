# Garavex V1 Tenant Isolation Audit

## Critical: appointment system

The current appointment stack is not safe for multi-shop beta use yet.

### Confirmed findings

1. `GET /api/availability` reads `bookings` and `blocked_times` without `shop_id`, so one shop's schedule can affect another shop's availability.
2. `POST /api/book` inserts a booking without `shop_id` and still sends S&K Auto-specific notifications/branding.
3. Employee appointment update/delete/status routes must validate both the appointment ID and the logged-in employee's `shop_id` before reading or mutating a booking.
4. Appointment blocked dates/times need tenant scoping as well; global date/time blocks are not acceptable for Garavex SaaS.
5. Automatic balance reminders must use each repair order's shop profile for business name/contact details instead of S&K Auto hard-coded branding.

## Required V1 fix

- Add/verify `shop_id` on `bookings`, `blocked_dates`, and `blocked_times`.
- Backfill legacy S&K Auto records to the primary S&K Auto shop.
- Scope every employee appointment query by `req.session.employee.shop_id`.
- Provide a tenant-aware employee appointment-create endpoint.
- Keep the S&K Auto public booking flow explicitly tied to the S&K Auto shop rather than treating it as a generic Garavex endpoint.
- Scope availability and blocked-time checks to the resolved shop.
- Load shop name, phone, email, and address for customer notifications.
- Add regression tests proving Shop A cannot list, edit, delete, block, or collide with Shop B's appointments.

## Release gate

Do not consider Garavex V1 tenant-safe until these checks pass for two separate test shops.