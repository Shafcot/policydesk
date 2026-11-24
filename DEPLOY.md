# Deploying Bliss

Bliss is one Node.js app: the API, the background worker and the built web app run in a single process on one port. It needs:

| Requirement | Notes |
|---|---|
| Node.js 20+ (22 recommended) | cPanel: **Websites & Apps → Deploy a Node.js App** (Application Manager). |
| MySQL 8 or MariaDB 10.6+ | cPanel: **Databases → Create Database**, plus a database user with **ALL PRIVILEGES** on it. |
| HTTPS | Twilio, SendGrid, Facebook and Google only call webhooks over HTTPS. cPanel's AutoSSL covers the domain. |

## Environment variables

| Name | Value |
|---|---|
| `DATABASE_URL` | `mysql://USER:PASSWORD@localhost:3306/DATABASE` (URL-encode special characters in the password, e.g. `#` → `%23`) |
| `JWT_SECRET` | A long random string (keep it secret; changing it signs everyone out) |
| `CLIENT_ORIGIN` | The app's address, e.g. `https://bliss-erp.com` |
| `PUBLIC_API_URL` | Same address (used for webhook URLs) |
| `NODE_ENV` | `production` |

Optional: `SETUP_ADMIN_EMAIL` / `SETUP_ADMIN_PASSWORD` create the first Super Admin on first start (remove them afterwards). Provider keys (Twilio, SendGrid, OpenAI, Microsoft, Firebase) can be entered later in **Admin → Integrations**.

## cPanel (Application Manager)

1. Upload the release zip with **File Manager** into a folder outside `public_html` (e.g. `~/bliss`) and extract it.
2. **Deploy a Node.js App**: application path = that folder, startup file = `server.js`, domain = the site, Node.js 22, environment = production. Add the variables above.
3. Install dependencies (the app manager's *Install dependencies* / `npm ci --omit=dev`), then start the app.
4. On first start the app creates its tables automatically (migrations run on start).
5. Open the site. With no agency yet, it shows the first-time setup (or uses `SETUP_ADMIN_*`).

The prebuilt release already contains `server/dist` and `client/dist`, so nothing has to be compiled on the server.

## Docker (any VPS)

```bash
cp server/.env.example .env.production   # fill it in
export MYSQL_PASSWORD=$(openssl rand -hex 16) MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
docker compose -f docker-compose.prod.yml up -d --build
```

Put a TLS proxy (Caddy, nginx) in front of port 4000.

## Backups

Set `BACKUP_DIR` and the worker writes one `mysqldump` per day (needs the `mysqldump` tool on the server). On cPanel, the account's own backups also include the database.
