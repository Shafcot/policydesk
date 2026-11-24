// Recreates the test database, applies migrations and loads the demo data.
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'mysql://bliss:bliss@127.0.0.1:3306/bliss_test';
  const u = new URL(url);
  const name = u.pathname.slice(1).replace(/`/g, '');
  u.pathname = '/';
  const admin = await mysql.createConnection(u.toString());
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url };
  for (const script of ['src/db/migrate.ts', 'src/db/seed.ts']) {
    const r = spawnSync('npx', ['tsx', script], { env, stdio: 'pipe', encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} failed:\n${r.stdout}\n${r.stderr}`);
  }
}
