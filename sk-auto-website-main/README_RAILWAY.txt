S&K AUTO — RAILWAY-READY WEBSITE

Business
S&K Auto
3107 Homestead
Hutchinson, KS 67502
(620) 899-0425
Monday-Friday, 8:00 AM-5:00 PM

WHAT THIS VERSION INCLUDES
- S&K Auto logo and responsive business website
- Customer reviews section
- Embedded Google Map
- Google Maps directions buttons
- Live appointment scheduler
- Server-side SQLite booking database
- Double-booking prevention
- Monday-Friday scheduling
- Confirmation numbers
- Railway health check
- Railway configuration file
- Persistent-data directory support

RAILWAY DEPLOYMENT

1. Create a new GitHub repository, for example:
   sk-auto-website

2. Upload ALL files from this folder to the ROOT of that repository.
   package.json, server.js, index.html and railway.toml should all be at the repository root.

3. In Railway:
   New Project > Deploy from GitHub Repo
   Select the sk-auto-website repository.

4. Open the deployed service and add this VARIABLE:
   DATA_DIR=/app/data

5. Add a persistent Railway Volume to the same service.
   Set its mount path to:
   /app/data

   This step is critical. The appointment database is stored there.

6. Under Networking, generate a Railway public domain.

7. Open the generated URL and test:
   - Website loads
   - Map loads
   - Directions button works
   - Scheduler displays availability
   - Make a test appointment
   - Reload and confirm the booked time is no longer available

8. Later, connect your custom domain in Railway's Networking settings.

LOCAL TESTING

Install Node.js 20+, then:

npm install
npm start

Open:
http://localhost:3000

VIEW BOOKINGS

npm run view-bookings

EXPORT BOOKINGS TO CSV

npm run export-bookings

IMPORTANT
For Railway, set DATA_DIR=/app/data AND attach a Railway Volume mounted at /app/data.
Without the volume, booking data will not be safely persistent across deployments.

NEXT UPGRADES
- Customer email confirmations
- SMS confirmations
- Google Calendar sync
- Password-protected admin dashboard
- Appointment cancellation/rescheduling
- Real Google/Facebook review links
