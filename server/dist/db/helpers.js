// MySQL helpers for things PostgreSQL did in one statement.
import { inArray } from 'drizzle-orm';
/**
 * INSERT … RETURNING *: inserts rows (ids come from the column's $defaultFn) and reads them back in the same order.
 */
export async function insertReturning(x, table, values) {
    const list = Array.isArray(values) ? values : [values];
    if (!list.length)
        return [];
    const ids = (await x.insert(table).values(list).$returningId());
    const rows = (await x.select().from(table).where(inArray(table.id, ids.map((r) => r.id))));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((r) => byId.get(r.id)).filter(Boolean);
}
/** Count as a JS number (MySQL returns BIGINT counts; mysql2 gives numbers when they fit). */
export const num = (v) => Number(v ?? 0);
/** Raw query → rows (drizzle's mysql2 execute returns [rows, fields]). */
export async function rowsOf(x, q) {
    const r = (await x.execute(q));
    return r[0];
}
/** UPDATE … RETURNING *: updates, then reads the matching rows back (the WHERE must not depend on the changed columns). */
export async function updateReturning(x, table, set, where) {
    await x.update(table).set(set).where(where);
    return (await x.select().from(table).where(where));
}
//# sourceMappingURL=helpers.js.map