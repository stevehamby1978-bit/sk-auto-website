S&K AUTO WEBSITE — LIVE SCHEDULING VERSION

Business:
S&K Auto
3107 Homestead
Hutchinson, KS 67502
Phone: (620) 899-0425
Hours: Monday-Friday, 8:00 AM-5:00 PM

WHAT'S NEW
- Embedded interactive Google Map.
- "Get Directions" buttons open Google Maps with the shop destination prefilled.
- Real server-backed appointment scheduling.
- Live availability lookup.
- Prevents two customers from booking the same date/time.
- Monday-Friday booking rules.
- One-hour appointment/drop-off windows from 8:00 AM through 4:00 PM.
- Booking confirmation number.
- SQLite database stores appointments on the server.

HOW TO RUN LOCALLY
1. Install Node.js 20+.
2. Open a terminal in this folder.
3. Run:
   npm install
   npm start
4. Open:
   http://localhost:3000

HOW TO VIEW BOOKINGS
Run:
   node view-bookings.js

IMPORTANT DEPLOYMENT NOTE
This scheduler is now a real backend application, not a browser-only demo. It must be hosted on a server that:
- runs Node.js,
- allows persistent disk storage for bookings.db.

A normal static-only web host will NOT keep the live booking database.

Good deployment choices include a small VPS or a Node host with persistent storage.
If you use a serverless host with temporary/ephemeral files, replace SQLite with a hosted database such as PostgreSQL.

NEXT OPTIONAL UPGRADES
- Email confirmation to customer.
- Text/SMS confirmation to customer and S&K Auto.
- Admin dashboard to reschedule/cancel appointments.
- Google Calendar synchronization.
- Different appointment lengths/capacity by service.
- Automatic review-request text after completed repairs.
