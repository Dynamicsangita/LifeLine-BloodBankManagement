# LifeLine — Blood Bank & Donor Network

LifeLine is a responsive full-stack blood donor coordination website built with Node.js, Express, MongoDB, EJS, HTML, CSS and JavaScript.

## Pages and features

- Home, About Us, How It Works and Contact Us
- Blood-group and city-based donor search
- Advanced donor filters for age and gender, with server-side validation
- Donor registration and availability profile, including optional consent-based donor photo uploads
- Sign up, login, logout and a personal dashboard
- Account deactivation requests that stop sign-in and public donor visibility without deleting records
- Blood requests, request tracking and cancellation while pending
- Preliminary emergency donor matching
- Verified blood bank directory
- Personal donation history
- Admin dashboard for inventory, request status and contact enquiries
- Admin-only blood request CSV reports with spreadsheet-formula injection protection
- Dashboard notifications derived from donor profile and request status, without extra notification records
- Privacy and Terms & Conditions information pages
- Live admin analytics for donor blood groups, request status, recent registrations and recent activity, with blood-group links to filtered donor search
- Homepage with animated database-backed statistics and donation awareness content
- Responsive red, white and light-pink design

> **Medical disclaimer:** donor matching is only a preliminary educational aid. Clinical eligibility, blood typing, screening and crossmatching must be handled by qualified medical professionals. For emergencies, contact a hospital or local emergency service directly.

The homepage donation photo is stored locally in `static/images/donation-hero.jpg` and sourced from Unsplash. Distinct local Unsplash photos are also used for About (`about-care.jpg`), donor registration (`donor-registration.jpg`), login (`login-care.jpg`), signup (`signup-community.jpg`), donor search (`community-donation.jpg`), blood requests (`blood-request.jpg`), emergency matching (`emergency-care.jpg`), blood-bank stock (`bank-stock.jpg`), the donor dashboard (`donor-network.jpg`), admin operations (`admin-team.jpg`) and contact (`contact-support.jpg`). How It Works uses a step-by-step SVG illustration rather than repeating the donor-search photograph. Image loading failures fall back to the existing soft-pink visual treatment. The homepage perspective cards are explicitly illustrative, not testimonials from actual LifeLine users. Donor search lists available profiles immediately, with optional JPEG/PNG/WebP donor photos stored outside the static asset directory and served only while the profile is available and the donor has consented to public photo display. Photos are limited to 5 MB and are not tracked by Git.

The CSV report is available to administrators at `/admin/reports/requests.csv` and includes request coordination fields only. It exports up to 5,000 latest requests per download. Dashboard notifications are computed from current request/profile state and are not persisted as separate records. Approved requests may be fulfilled only when the manually recorded aggregate stock for the requested blood group is sufficient; fulfillment and the stock decrement are committed together.

The Privacy Policy and Terms & Conditions pages provide user-facing project notices; they are demonstration content, not jurisdiction-specific legal advice. Review them before handling real personal data. Donor consent is recorded with a policy version and timestamp. Existing donor records without verifiable consent are retained but marked unknown and made unavailable in public search until the donor consents again. Account deactivation preserves database records and requires a separate, approved retention decision before any permanent deletion.

Donor search shows every currently available registered donor on initial load. Donors can optionally upload a JPEG, PNG or WebP profile photo (maximum 5 MB) and must separately consent before it appears publicly. Uploaded photos are stored in the ignored `uploads/donors/` directory, not served as static files; the photo route returns them only while the profile remains available and photo consent is enabled. Existing donor records without photos continue to show initials.

## Requirements

- Node.js 20 or newer
- MongoDB running as a replica set (a single-node replica set is sufficient for local development), or a MongoDB Atlas replica-set connection string

## Setup on Windows

Open a terminal in this folder and install packages:

```powershell
npm install
```

Create a `.env` file based on `.env.example`. The application requires:

```env
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/lifeline?replicaSet=rs0
SESSION_SECRET=use-a-random-secret-at-least-32-characters-long
NODE_ENV=development
```

Make sure your MongoDB replica set is running. Multi-document transactions are required for request submission, request fulfillment, and account deactivation; a standalone MongoDB server will not support these operations. Then start LifeLine:

```powershell
npm start
```

Open `http://localhost:3000`.

For development with automatic restarts:

```powershell
npm run dev
```

## Admin and directory setup

New accounts always receive the regular `user` role. To grant administrator access, update the user's MongoDB document in `mongosh`:

```javascript
use lifeline
db.users.updateOne({ email: "admin@example.com" }, { $set: { role: "admin" } })
```

Log out and log back in. The Admin link then appears in navigation. The admin dashboard can edit stock, review requests and process contact enquiries.

Blood bank listings are shown only when marked verified. Add accurate, authorized directory entries to the `bloodbanks` collection; do not enter sample or unverified contact details.

## Tests

```powershell
npm test
```

## Existing Flask/MySQL files

The active application is now `server.js` and MongoDB. The original Flask/MySQL files and SQL schema are retained as a legacy reference; they are not used by the Node.js application. Existing MySQL data is not automatically copied to MongoDB.

If you run the retained Flask app directly, it requires a separate `SECRET_KEY` with at least 32 characters and will stop at startup if it is missing or too short. Use a unique, high-entropy value; `SESSION_SECRET` is used by the active Node.js app.

The Flask/MySQL version also supports a verified blood-bank directory. Apply `database/migrations/002_add_blood_banks.sql` to `bloodbank_db` before starting `app.py`. The public `/blood-banks` page and signed-in dashboard read verified entries from the `blood_banks` table. The migration creates the table but does not insert sample listings; add only accurate, authorized bank details and set `verified` to `1` after verification.

## Production notes

Use a private, currently supported MongoDB replica set and set `MONGODB_URI`, set a unique high-entropy `SESSION_SECRET`, set `NODE_ENV=production`, use HTTPS, maintain tested backups, and publish verified privacy/consent and retention policies before handling real donor information. Production startup fails if `MONGODB_URI`, a sufficiently long `SESSION_SECRET`, or transaction-capable replica-set topology is missing. Session cookies are HTTP-only, SameSite=Lax, and Secure in production. If TLS terminates at a trusted reverse proxy, set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops (commonly `1`) so secure session cookies work correctly. The built-in rate limiter uses in-process storage; configure shared storage before running multiple application instances.
