// MySQL helpers for things PostgreSQL did in one statement.
import { inArray, type SQL } from 'drizzle-orm';
import type { MySqlColumn, MySqlTable } from 'drizzle-orm/mysql-core';
import type { db } from './client.js';

type Exec = Pick<typeof db, 'insert' | 'select'>;
type WithId = MySqlTable & { id: MySqlColumn };

/**
 * INSERT … RETURNING *: inserts rows (ids come from the column's $defaultFn) and reads them back in the same order.
 */
export async function insertReturning<T extends WithId>(x: Exec, table: T, values: T['$inferInsert'] | T['$inferInsert'][]): Promise<T['$inferSelect'][]> {
  const list = Array.isArray(values) ? values : [values];
  if (!list.length) return [];
  const ids = (await x.insert(table).values(list as never).$returningId()) as unknown as { id: string }[];
  const rows = (await x.select().from(table as never).where(inArray(table.id, ids.map((r) => r.id)))) as unknown as (T['$inferSelect'] & { id: string })[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((r) => byId.get(r.id)!).filter(Boolean);
}

/** Count as a JS number (MySQL returns BIGINT counts; mysql2 gives numbers when they fit). */
export const num = (v: unknown) => Number(v ?? 0);

/** `sql` fragment helper for conditional counts: sum(case when … then 1 else 0 end). */
export type Cond = SQL;

/** Raw query → rows (drizzle's mysql2 execute returns [rows, fields]). */
export async function rowsOf<T>(x: { execute: (q: SQL) => Promise<unknown> }, q: SQL): Promise<T[]> {
  const r = (await x.execute(q)) as unknown as [T[], unknown];
  return r[0];
}

/** UPDATE … RETURNING *: updates, then reads the matching rows back (the WHERE must not depend on the changed columns). */
export async function updateReturning<T extends WithId>(x: Pick<typeof db, 'update' | 'select'>, table: T, set: Partial<T['$inferInsert']>, where: SQL | undefined): Promise<T['$inferSelect'][]> {
  await x.update(table).set(set as never).where(where);
  return (await x.select().from(table as never).where(where)) as unknown as T['$inferSelect'][];
}
