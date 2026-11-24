# Bliss ERP — handover

Bliss ERP is live at **https://bliss-erp.com** for Kriener Insurance. This page describes the live installation and what is left for the agency to do. Passwords and keys are not written here; they live only in the hosting panel and in the app.

## The live installation

| What | Where |
| --- | --- |
| Web app | https://bliss-erp.com (sign in with your Bliss ERP account) |
| Hosting | cPanel account `blisserp` on the agency's VPS (https://bliss-erp.com:2083) |
| App files | `/home/blisserp/bliss` (outside `public_html`) |
| App process | cPanel → **Websites & Apps → Application Manager**, app `bliss`, Node.js 22, production |
| Database | MariaDB 10.11 on the same server: database `blisserp_bliss`, user `blisserp_app` |
| App settings | Environment variables on the `bliss` app in Application Manager: `DATABASE_URL` (holds the database password), `JWT_SECRET`, `CLIENT_ORIGIN`, `PUBLIC_API_URL`, `NODE_ENV` |

To restart the app: Application Manager → `bliss` → disable, then enable (or edit and save it). Database tables are created and upgraded automatically on start.

## Data moved in

All data from AgencyZoom and from the trial installation was moved into this database and checked table by table, including:

- 46,000+ leads with their AgencyZoom notes and history, and the leads received in AgencyZoom up to the switchover
- users (staff), lead sources, customers, policies, sales, calls, messages, notifications, templates, automations and tasks

## Lead vendors

Each vendor has its own receiving address in **Settings → Integrations → Lead vendors** (Media Alpha, QuoteWizard, Zip Quote, Next Call Club, EverQuote, Smart Financial, HBW, AllWeb, Lead Force 360). The file *Bliss ERP - Vendor emails.pdf* has a ready-to-send email for each vendor with its address filled in.

Leads keep arriving in AgencyZoom until each vendor confirms the switch, so keep AgencyZoom running until then. If an address is ever shared by mistake, click **New address** for that vendor and send them the new one.

## Still to do

1. **Change the cPanel password**, since it was shared during setup.
2. **Add Duane Kriener's user** in Bliss ERP (Settings → Users) and assign him the leads that were his in AgencyZoom.
3. **Correct Darren Ostern's email** in Settings → Users (it reads `farmersagncy.com`).
4. **Connect the provider accounts** in Settings → Integrations: Twilio (calls and texts), SendGrid (email), OpenAI (call transcripts and AI replies), Microsoft 365 (Outlook calendar), Firebase (push notifications), Facebook and Google lead forms. Until then, calls are dialled from agents' own phones and outgoing texts and emails wait as *queued*. See [INTEGRATIONS.md](INTEGRATIONS.md).
5. **Send the vendor emails** and, once every vendor has switched, stop using AgencyZoom.

## Backups

cPanel's own account backups include the database. For an extra daily copy, set `BACKUP_DIR` on the app (for example `/home/blisserp/backups`); the app then writes one `mysqldump` a day and keeps the newest 14.

## Source code

This repository holds the complete source. [README.md](README.md) covers running it locally and the architecture, and [DEPLOY.md](DEPLOY.md) covers installing it on another server.
