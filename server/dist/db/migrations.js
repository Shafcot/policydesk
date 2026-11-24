import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { db, pool } from './client.js';
const CHARSET = 'utf8mb4', COLLATION = 'utf8mb4_unicode_ci';
/**
 * Some hosts (cPanel's MariaDB among them) create databases as latin1, which rejects arrows, emoji and most
 * non-Western letters. Make the database default utf8mb4 and convert any table that isn't yet.
 * Converting latin1 → utf8mb4 keeps existing text intact.
 */
export async function ensureUtf8mb4() {
    const conn = await pool.getConnection();
    try {
        const [[dbRow]] = await conn.query('SELECT DATABASE() AS name, @@character_set_database AS cs');
        if (!dbRow?.name)
            return;
        if (dbRow.cs !== CHARSET)
            await conn.query(`ALTER DATABASE \`${dbRow.name}\` CHARACTER SET ${CHARSET} COLLATE ${COLLATION}`);
        const [tables] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_collation NOT LIKE 'utf8mb4%'");
        if (!tables.length)
            return;
        // MariaDB refuses to change a column's charset while a foreign key uses it, so drop the keys,
        // convert, then put the same keys back.
        const [fkRows] = await conn.query(`
      SELECT k.table_name AS tbl, k.constraint_name AS name, k.column_name AS col, k.referenced_table_name AS rtbl,
             k.referenced_column_name AS rcol, k.ordinal_position AS pos, r.delete_rule AS del, r.update_rule AS upd
      FROM information_schema.key_column_usage k
      JOIN information_schema.referential_constraints r ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
      WHERE k.table_schema = DATABASE() AND k.referenced_table_name IS NOT NULL
      ORDER BY k.table_name, k.constraint_name, k.ordinal_position`);
        const fks = new Map();
        for (const r of fkRows) {
            const key = `${r.tbl}.${r.name}`;
            const fk = fks.get(key) ?? { tbl: r.tbl, name: r.name, cols: [], rtbl: r.rtbl, rcols: [], del: r.del, upd: r.upd };
            fk.cols.push(r.col);
            fk.rcols.push(r.rcol);
            fks.set(key, fk);
        }
        const q = (s) => `\`${s}\``;
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        try {
            for (const fk of fks.values())
                await conn.query(`ALTER TABLE ${q(fk.tbl)} DROP FOREIGN KEY ${q(fk.name)}`);
            for (const { t } of tables) {
                await conn.query(`ALTER TABLE ${q(t)} CONVERT TO CHARACTER SET ${CHARSET} COLLATE ${COLLATION}`);
                console.log(`Converted table ${t} to ${CHARSET}`);
            }
            for (const fk of fks.values()) {
                await conn.query(`ALTER TABLE ${q(fk.tbl)} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.cols.map(q).join(', ')}) REFERENCES ${q(fk.rtbl)} (${fk.rcols.map(q).join(', ')}) ON DELETE ${fk.del} ON UPDATE ${fk.upd}`);
            }
        }
        finally {
            await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
    finally {
        conn.release();
    }
}
/** Applies pending SQL migrations from server/drizzle (works from src/ and dist/). */
export async function runMigrations() {
    await ensureUtf8mb4();
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
    await ensureUtf8mb4();
}
//# sourceMappingURL=migrations.js.map