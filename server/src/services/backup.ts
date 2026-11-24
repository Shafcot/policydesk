// Daily database backup (SOW 7 must-have). Writes a mysqldump to BACKUP_DIR and keeps the newest BACKUP_KEEP files.
// Copy BACKUP_DIR off the server (or point it at mounted storage) once hosting is decided.
import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config.js';

const run = promisify(execFile);

export async function backupDatabase(dir = process.env.BACKUP_DIR, keep = Number(process.env.BACKUP_KEEP ?? 14)) {
  if (!dir) return null;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `bliss-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
  const u = new URL(env.DATABASE_URL);
  // Password goes through the environment, not the command line (so it doesn't show in the process list).
  await run('mysqldump', ['--single-transaction', '--routines', '--no-tablespaces', `--host=${u.hostname}`, `--port=${u.port || '3306'}`, `--user=${decodeURIComponent(u.username)}`, `--result-file=${file}`, decodeURIComponent(u.pathname.slice(1))],
    { timeout: 30 * 60_000, env: { ...process.env, MYSQL_PWD: decodeURIComponent(u.password) } });
  const files = (await readdir(dir)).filter((f) => f.startsWith('bliss-') && f.endsWith('.sql')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) await unlink(join(dir, old));
  return { file, bytes: (await stat(file)).size };
}
