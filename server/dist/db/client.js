import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { env } from '../config.js';
import * as schema from './schema.js';
// MySQL 8 / MariaDB 10.6+. The connection works in UTC so stored datetimes are UTC.
// DATABASE_SSL=require for hosted MySQL that needs TLS; cPanel's local MySQL doesn't.
const ssl = process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : process.env.DATABASE_SSL === 'no-verify' ? { rejectUnauthorized: false } : undefined;
export const pool = mysql.createPool({
    uri: env.DATABASE_URL,
    connectionLimit: Number(process.env.DATABASE_POOL_MAX ?? 10),
    maxIdle: 2,
    idleTimeout: 10_000,
    enableKeepAlive: true,
    timezone: 'Z',
    dateStrings: false,
    decimalNumbers: false, // decimal(12,2) arrives as a string; the money column converts it
    supportBigNumbers: true,
    bigNumberStrings: false,
    charset: 'utf8mb4',
    ...(ssl ? { ssl } : {}),
});
// Every new connection: UTC session time zone, strict mode.
pool.on('connection', (c) => {
    // `pool.on('connection')` hands out the callback-style connection.
    c.query("SET time_zone = '+00:00', sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES')");
});
export const db = drizzle(pool, { schema, mode: 'default' });
//# sourceMappingURL=client.js.map