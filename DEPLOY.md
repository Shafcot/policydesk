# Deploying Policy-desk CRM

The app ships as **one Docker image**: the API, the background worker and the built React app on a single port (4000). It needs **PostgreSQL 16** and an **HTTPS** address, because Twilio, SendGrid, Facebook and Google only call webhooks over HTTPS. It is not tied to any one hosting provider.

## What you need

| Item | Notes |
|---|---|
| A Docker host | Any of: Render, Railway, Fly.io, DigitalOcean App Platform / Droplet, a VPS, AWS ECS/Lightsail, Azure Container Apps. |
| PostgreSQL 16 | Managed (recommended: daily snapshots + point-in-time restore) or the `db` service in `docker-compose.prod.yml`. |
| A domain | e.g. `crm.agency.com`, with HTTPS (most hosts do this automatically; on a VPS use Caddy or nginx + Let's Encrypt). |
| Persistent disk (optional) | Mounted at `/data`, for local uploads and the built-in nightly `pg_dump` backups. Not needed if the managed database has its own backups. |

## Environment variables

Start from `server/.env.example`. The ones that must be set in production:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/dbname` |
| `JWT_SECRET` | a long random string (`openssl rand -hex 32`). The server refuses to start without it. |
| `CLIENT_ORIGIN` | the app's public address, e.g. `https://crm.agency.com` |
| `PUBLIC_API_URL` | the same address (the app and API share one origin) |

All integration keys are optional. Each provider switches on when its keys are present; see [INTEGRATIONS.md](INTEGRATIONS.md).

The Firebase **web** config (`VITE_FIREBASE_*`) is compiled into the browser bundle, so pass it as **build arguments**, not runtime variables.

Other optional variables:
- `RUN_WORKER=false`: run the worker as its own service (`node dist/worker.js`) instead of inside the web process. Use this if you run more than one web instance. The worker is safe to run more than once (database locks), but one is enough.
- `BACKUP_DIR` / `BACKUP_KEEP`: nightly `pg_dump` to a folder, keeping the newest N files (default 14).

## Option A: single server with Docker Compose

```bash
git clone git@github.com:Shafcot/policydesk.git && cd policydesk
cp server/.env.example .env.production   # fill in JWT_SECRET, CLIENT_ORIGIN, PUBLIC_API_URL, integration keys
export POSTGRES_PASSWORD=$(openssl rand -hex 16)   # keep this somewhere safe
docker compose -f docker-compose.prod.yml up -d --build
```

Then point HTTPS at port 4000. With Caddy, for example:

```
crm.agency.com {
  reverse_proxy localhost:4000
}
```

## Option B: a container platform (Render, Railway, Fly.io, …)

1. Create a managed PostgreSQL 16 database.
2. Create a web service from this repository using the `Dockerfile`. Port **4000**, health check `/api/health`.
3. Set the environment variables above, plus the `VITE_FIREBASE_*` build arguments if push is used.
4. Add the custom domain. Set `CLIENT_ORIGIN` and `PUBLIC_API_URL` to it.

Database migrations run automatically every time the container starts.

## First sign-in

The production database starts empty, and the demo seed refuses to run against production. Create the agency and first admin once:

```bash
docker compose -f docker-compose.prod.yml exec app node dist/db/bootstrap.js "Agency Name" "Owner Name" owner@agency.com
```

On a platform, run the same command in the service's shell. The command prints a one-time link to set the password. Invite everyone else from **Users** in the app.

## After deploying

1. Open **Settings → Integrations** and follow [INTEGRATIONS.md](INTEGRATIONS.md) to connect each account. Copy the webhook URLs from that page.
2. In **Settings**, set business hours and the time zone, lead routing, and the review links.
3. Import existing leads and customers (Leads → Import; Customers & policies → Import).

## Updating

Pull the new code and rebuild (`docker compose -f docker-compose.prod.yml up -d --build`), or redeploy on the platform. Migrations apply on start.

## Backups and restore

- Managed Postgres: turn on the provider's automatic backups.
- Built-in: set `BACKUP_DIR=/data/backups`. A compressed dump is written every night.
- Restore: `pg_restore --clean --no-owner -d "$DATABASE_URL" policydesk-YYYY-MM-DD.dump`

## Development and tests

```bash
docker compose up -d          # local Postgres
npm install
npm run db:migrate && npm run db:seed
npm run dev                   # API :4000, web :5173
npm test                      # API tests against a separate policydesk_test database
```

CI (`.github/workflows/ci.yml`) runs the typecheck, build and tests on every pull request.
