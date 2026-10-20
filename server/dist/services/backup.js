// Daily database backup (SOW 7 must-have). Writes a compressed pg_dump to BACKUP_DIR and keeps the newest BACKUP_KEEP files.
// Copy BACKUP_DIR off the server (or point it at mounted storage) once hosting is decided.
import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config.js';
const run = promisify(execFile);
export async function backupDatabase(dir = process.env.BACKUP_DIR, keep = Number(process.env.BACKUP_KEEP ?? 14)) {
    if (!dir)
        return null;
    await mkdir(dir, { recursive: true });
    const file = join(dir, `policydesk-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
    await run('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`, env.DATABASE_URL], { timeout: 30 * 60_000 });
    const files = (await readdir(dir)).filter((f) => f.startsWith('policydesk-') && f.endsWith('.dump')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep)))
        await unlink(join(dir, old));
    return { file, bytes: (await stat(file)).size };
}
//# sourceMappingURL=backup.js.map