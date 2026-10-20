// Creates the test database if needed, applies migrations and loads the demo data.
import { spawnSync } from 'node:child_process';
import pg from 'pg';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://policydesk:policydesk@127.0.0.1:5432/policydesk_test';
  const name = new URL(url).pathname.slice(1);
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
  if (!rowCount) await admin.query(`create database "${name.replace(/"/g, '')}"`);
  await admin.end();
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url };
  for (const script of ['src/db/migrate.ts', 'src/db/seed.ts']) {
    const r = spawnSync('npx', ['tsx', script], { env, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} failed:\n${r.stdout}\n${r.stderr}`);
  }
}
