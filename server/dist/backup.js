// Manual backup: `npm run backup -w server` (uses BACKUP_DIR, default ./backups). Restore with: pg_restore --clean -d "$DATABASE_URL" <file>
import { backupDatabase } from './services/backup.js';
const r = await backupDatabase(process.env.BACKUP_DIR ?? './backups');
console.log(r ? `Backup written: ${r.file} (${Math.round(r.bytes / 1024)} KB)` : 'BACKUP_DIR is not set');
process.exit(0);
//# sourceMappingURL=backup.js.map