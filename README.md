# Bliss ERP

All-in-one CRM for insurance agencies: leads, pipeline, power dialer, inbox, automations, policies, sales and reports. It replaces GoHighLevel, AgencyZoom, Ricochet and RingCentral.

- **Frontend:** React 18 + TypeScript (Vite), React Router, TanStack Query
- **Backend:** Node.js + TypeScript, Express, Drizzle ORM
- **Database:** MySQL 8 / MariaDB 10.6+ · **Queue/cache:** Redis 7 (used from Milestone 2)

```
client/   React app (screens, components, API client)
server/   API, business rules, database schema + migrations, seed data
```

## Run it locally

Requirements: Node.js 20+ and Docker (for MySQL and Redis).

```bash
npm install                     # installs client + server
docker compose up -d            # starts MySQL and Redis
cp server/.env.example server/.env
npm run db:migrate              # creates the tables
npm run db:seed                 # demo agency, users, leads, policies
npm run dev                     # API on :4000, app on http://localhost:5173
```

Demo sign-ins (password `BlissErp123!`, or whatever you set as `SEED_PASSWORD`):

| Role | Email |
| --- | --- |
| Super Admin | admin@bliss-erp.test |
| Agent | maya@bliss-erp.test (also daniel, priya, marcus, elena) |

`npm run db:seed` wipes the database. It refuses to run when `NODE_ENV=production`.

## How permissions work

Every API route except login requires a signed-in user, and every check happens on the server:

- **Agents** only see their own leads. Another agent's lead returns 404, so agents can't even learn it exists.
- **Only the owner** (or the Super Admin) can log calls on a lead, and a lead on a live call is locked for everyone else.
- **Admin-only actions** (reassigning leads, bulk actions, auto-moves, user settings) return 403 for agents.

Until Twilio/SendGrid are connected (Milestone 3), the dialer has agents dial from their own phone while the app picks, locks and times each call, and outgoing texts/emails are saved as **queued**.

Business rules live in `server/src/services/rules.ts`: lead auto-assignment (round robin / availability / line of insurance, skipping offline or at-limit agents), call result → stage, retries, call-backs, recycling and the 5-month re-quote.

## Automations and the background worker

The worker runs inside the API process every 15 seconds (set `RUN_WORKER=false` and run `npm run worker -w server` to split it out). It:

- advances automation runs whose wait has passed (`server/src/services/automation.ts`)
- sends appointment reminders and scheduled broadcasts
- once a day per agency, after opening time in the agency's time zone: auto-moves, renewal triggers (60/30 days), birthday and holiday messages

Flows stop when the lead replies, books or is won/lost (per flow), and always when the lead opts out. Messages only go out during business hours when the flow says so. Until Twilio and SendGrid are connected, outgoing messages are stored as **queued**.

To test replies before the webhooks exist, admins can call `POST /api/dev/inbound` with `{ "leadId": "...", "body": "STOP" }` (disabled in production).

## Backups

Set `BACKUP_DIR` (and optionally `BACKUP_KEEP`, default 14) and the worker writes one `mysqldump` a day, keeping the newest files. Run one by hand with `npm run backup -w server`. Restore with `mysql <database> < <file>`. On cPanel, its own backups also cover the database.

## Tests

```bash
npm test     # API tests: auth, permissions, lead intake + vendor webhooks, messaging/opt-out, booking, restore, helpers
```

Tests use a separate database (`bliss_test`, or `TEST_DATABASE_URL`) that is migrated and re-seeded on every run. No provider keys are set, so nothing is ever sent. CI runs typecheck, build and tests on every pull request.

## Deploying

One Node.js process serves the API, worker and React app. See [DEPLOY.md](DEPLOY.md) for cPanel and Docker hosting, environment variables, first-admin setup and backups, [INTEGRATIONS.md](INTEGRATIONS.md) to connect provider accounts, and [HANDOVER.md](HANDOVER.md) for the live installation.

## Database changes

Edit `server/src/db/schema.ts`, then:

```bash
npm run db:generate -w server   # writes a new SQL migration in server/drizzle/
npm run db:migrate
```

## Status

| Milestone | Scope | Status |
| --- | --- | --- |
| 1 · Frontend | All screens, including the automation builder and campaigns | Done |
| 2 · Backend | Automation engine, worker, campaigns, tasks, live updates, lead import, booking pages, team emails, password reset, login rate limit, daily backups | Done |
| 3 · Integrations & testing | Twilio calling/recording/SMS, SendGrid, OpenAI, Firebase push, Facebook/Google/vendor lead webhooks; automated tests, CI, deploy guide | Done. Live on bliss-erp.com; provider accounts are connected in Admin → Integrations |
| 4 · Data migration | AgencyZoom leads, history and staff; move to MySQL on the agency's own hosting | Done |

Nothing in the code is tied to one host: it runs on cPanel (Passenger), any VPS with Docker, or other Node.js hosting, and file storage goes through a local-disk driver that can be swapped for S3-compatible storage later.
