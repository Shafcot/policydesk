// Applies an uploaded update without any cPanel steps beyond the upload itself.
// Upload `bliss-erp-update.zip` (containing bliss-erp-update/client/dist and bliss-erp-update/server/dist)
// to the hosting account's home folder; within a minute the app unpacks it over its own dist folders,
// deletes the zip, writes a line to ~/bliss-deploy.log and restarts itself.
import { appendFile, cp, mkdir, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

// zlib.crc32 exists from Node 22.2; older versions skip the checksum (size is still checked).
const crc32 = (zlib as { crc32?: (b: Buffer) => number }).crc32;

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PREFIX = 'bliss-erp-update/';
const PARTS = ['client/dist/', 'server/dist/'];

/** Reads every file entry of a zip (stored or deflated). Throws if the archive is incomplete or corrupt. */
export function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a complete zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported zip compression in ${name}`);
    if (data.length !== usize || (crc32 && crc32(data) !== crc)) throw new Error(`corrupt file in zip: ${name}`);
    out.push({ name, data });
  }
  return out;
}

/** Unpacks the update into the app. Returns the number of files written. */
export async function applyUpdate(zipPath: string, appRoot = APP_ROOT) {
  const entries = readZip(await readFile(zipPath)).filter((e) => e.name.startsWith(PREFIX) && PARTS.some((p) => e.name.slice(PREFIX.length).startsWith(p)));
  if (!entries.some((e) => e.name === `${PREFIX}server/dist/index.js`) || !entries.some((e) => e.name === `${PREFIX}client/dist/index.html`)) throw new Error('the zip is missing client/dist or server/dist');
  const staging = join(dirname(zipPath), '.bliss-update-staging');
  await rm(staging, { recursive: true, force: true });
  for (const e of entries) {
    const rel = normalize(e.name.slice(PREFIX.length));
    if (rel.startsWith('..') || rel.includes(`${sep}..${sep}`)) throw new Error(`unsafe path in zip: ${e.name}`);
    const to = join(staging, rel);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, e.data);
  }
  for (const part of ['client/dist', 'server/dist']) await cp(join(staging, part), join(appRoot, part), { recursive: true, force: true });
  await rm(staging, { recursive: true, force: true });
  return entries.length;
}

/** Checks the home folder for an uploaded update every 30 s (production only). */
export function startSelfUpdate(zipPath = process.env.UPDATE_ZIP || join(homedir(), 'bliss-erp-update.zip')) {
  let last = '';
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = await stat(zipPath).catch(() => null);
      if (!s) { last = ''; return; }
      // Wait until the upload has finished: same size and time on two checks in a row.
      const sig = `${s.size}:${s.mtimeMs}`;
      if (sig !== last) { last = sig; return; }
      const log = join(dirname(zipPath), 'bliss-deploy.log');
      // Several app processes may run; only the one that creates the lock file applies the update.
      const lockPath = `${zipPath}.lock`;
      const lock = await open(lockPath, 'wx').catch(async () => {
        const l = await stat(lockPath).catch(() => null);
        if (l && Date.now() - l.mtimeMs > 10 * 60_000) await rm(lockPath, { force: true }); // stale lock
        return null;
      });
      if (!lock) return;
      await lock.close();
      try {
        const files = await applyUpdate(zipPath);
        await rm(zipPath, { force: true });
        await appendFile(log, `${new Date().toISOString()} deployed ${files} files\n`);
        console.log(`Update applied (${files} files). Restarting.`);
        const restart = join(APP_ROOT, 'tmp', 'restart.txt');
        await mkdir(dirname(restart), { recursive: true });
        await writeFile(restart, '').then(() => utimes(restart, new Date(), new Date()));
        setTimeout(() => process.exit(0), 1500); // Passenger starts the new version on the next request
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'not a complete zip file') return; // still uploading
        console.error('Update failed:', msg);
        await appendFile(log, `${new Date().toISOString()} update failed: ${msg}\n`).catch(() => undefined);
        await rm(zipPath, { force: true }); // don't retry a broken upload forever; upload it again
      } finally {
        await rm(lockPath, { force: true });
      }
    } finally { busy = false; }
  };
  setTimeout(check, 3000);
  return setInterval(check, 30_000);
}
