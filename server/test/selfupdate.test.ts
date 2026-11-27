// Deploying by uploading bliss-erp-update.zip: the app unpacks it over its own dist folders.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyUpdate, readZip } from '../src/services/selfupdate.js';

function makeZip(dir: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), body); }
  execFileSync('zip', ['-qr', 'u.zip', 'bliss-erp-update'], { cwd: dir });
  return join(dir, 'u.zip');
}

describe('self-update', () => {
  it('unpacks client/dist and server/dist over the app and leaves other files alone', async () => {
    const work = mkdtempSync(join(tmpdir(), 'upd-'));
    const app = join(work, 'app');
    mkdirSync(join(app, 'server/dist'), { recursive: true });
    mkdirSync(join(app, 'client/dist'), { recursive: true });
    writeFileSync(join(app, 'server/dist/index.js'), 'old');
    writeFileSync(join(app, 'server/dist/keep.js'), 'keep');
    writeFileSync(join(app, 'app.js'), 'entry');
    const zip = makeZip(work, {
      'bliss-erp-update/server/dist/index.js': 'new server',
      'bliss-erp-update/server/dist/routes/leads.js': 'routes',
      'bliss-erp-update/client/dist/index.html': '<html>new</html>',
      'bliss-erp-update/client/dist/assets/a.js': 'x'.repeat(5000),
      'bliss-erp-update/app.js': 'should not be copied',
    });
    expect(await applyUpdate(zip, app)).toBe(4);
    expect(readFileSync(join(app, 'server/dist/index.js'), 'utf8')).toBe('new server');
    expect(readFileSync(join(app, 'server/dist/routes/leads.js'), 'utf8')).toBe('routes');
    expect(readFileSync(join(app, 'client/dist/assets/a.js'), 'utf8')).toHaveLength(5000);
    expect(readFileSync(join(app, 'server/dist/keep.js'), 'utf8')).toBe('keep');
    expect(readFileSync(join(app, 'app.js'), 'utf8')).toBe('entry');
    expect(existsSync(join(work, '.bliss-update-staging'))).toBe(false);
  });

  it('refuses incomplete or incomplete-looking uploads', async () => {
    const work = mkdtempSync(join(tmpdir(), 'upd-'));
    const zip = makeZip(work, { 'bliss-erp-update/client/dist/index.html': 'x' });
    const buf = readFileSync(zip);
    expect(() => readZip(buf.subarray(0, buf.length - 30))).toThrow('not a complete zip file');
    await expect(applyUpdate(zip, join(work, 'app'))).rejects.toThrow('missing client/dist or server/dist');
  });
});
