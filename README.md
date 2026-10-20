# Policy-desk CRM

All-in-one CRM for insurance agencies: leads, pipeline, power dialer, inbox, automations, policies, sales and reports. It replaces GoHighLevel, AgencyZoom, Ricochet and RingCentral.

- **Frontend:** React 18 + TypeScript (Vite), React Router, TanStack Query
- **Backend:** Node.js + TypeScript, Express, Drizzle ORM
- **Database:** PostgreSQL 16 · **Queue/cache:** Redis 7 (used from Milestone 2)
- Design reference: the approved HTML prototype at https://htmlcssdemo1.netlify.app

```
client/   React app (screens, components, API client)
server/   API, business rules, database schema + migrations, seed data
```

## Run it locally

Requirements: Node.js 20+ and Docker (for Postgres and Redis).

```bash
npm install                     # installs client + server
docker compose up -d            # starts Postgres and Redis
cp server/.env.example server/.env
npm run db:migrate              # creates the tables
npm run db:seed                 # demo agency, users, leads, policies
npm run dev                     # API on :4000, app on http://localhost:5173
```

Demo sign-ins (password `Policydesk123!`, or whatever you set as `SEED_PASSWORD`):

| Role | Email |
| --- | --- |
| Super Admin | admin@policydesk.test |
| Agent | maya@policydesk.test (also daniel, priya, marcus, elena) |

`npm run db:seed` wipes the database. It refuses to run when `NODE_ENV=production`.

## How permissions work

Every API route except login requires a signed-in user, and every check happens on the server:

- **Agents** only see their own leads. Another agent's lead returns 404, so agents can't even learn it exists.
- **Only the owner** (or the Super Admin) can log calls on a lead, and a lead on a live call is locked for everyone else.
- **Admin-only actions** (reassigning leads, bulk actions, auto-moves, user settings) return 403 for agents.

Business rules live in `server/src/services/rules.ts`: lead auto-assignment (round robin / availability / line of insurance, skipping offline or at-limit agents), call result → stage, retries, call-backs, recycling and the 5-month re-quote.

## Database changes

Edit `server/src/db/schema.ts`, then:

```bash
npm run db:generate -w server   # writes a new SQL migration in server/drizzle/
npm run db:migrate
```

## Status

| Milestone | Scope | Status |
| --- | --- | --- |
| 1 · Frontend | Login, roles, dashboards, leads, lead page, pipeline | In progress — dialer, calendar, inbox, customers, sales, targets, reports, users, settings next |
| 2 · Backend | Automations, scheduled jobs, live updates (Socket.IO), reports, imports | Not started |
| 3 · Integrations & testing | Twilio, SendGrid, OpenAI, Firebase, lead sources, data migration | Not started |

Hosting is not decided yet. Nothing in the code is tied to a provider; file storage goes through a local-disk driver that can be swapped for S3-compatible storage later.
