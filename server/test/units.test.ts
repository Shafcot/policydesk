import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/domain.js';
import { isBusinessTime, nextBusinessTime } from '../src/services/hours.js';
import { last10, toE164 } from '../src/integrations/phone.js';
import { readUnsubToken, signPath, unsubToken, verifyPath } from '../src/integrations/signed.js';

describe('phone numbers', () => {
  it('normalises US numbers to E.164', () => {
    expect(toE164('(512) 555-0123')).toBe('+15125550123');
    expect(toE164('1-512-555-0123')).toBe('+15125550123');
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('123')).toBeNull();
    expect(last10('+1 (512) 555-0123')).toBe('5125550123');
  });
});

describe('business hours', () => {
  const st = { ...DEFAULT_SETTINGS, timezone: 'America/Chicago', businessDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], businessOpen: '09:00', businessClose: '17:00' };
  it('knows when the agency is open', () => {
    expect(isBusinessTime(new Date('2026-10-20T15:00:00Z'), st)).toBe(true); // Tue 10:00 CDT
    expect(isBusinessTime(new Date('2026-10-20T23:30:00Z'), st)).toBe(false); // Tue 18:30 CDT
  });
  it('holds weekend messages until Monday opening', () => {
    const sat = new Date('2026-10-24T17:00:00Z'); // Sat noon CDT
    expect(nextBusinessTime(sat, st).toISOString()).toBe('2026-10-26T14:00:00.000Z'); // Mon 09:00 CDT
  });
  it('handles the daylight-saving change', () => {
    const sat = new Date('2026-11-07T17:00:00Z'); // Sat before DST ends
    expect(nextBusinessTime(sat, st).toISOString()).toBe('2026-11-09T15:00:00.000Z'); // Mon 09:00 CST
  });
});

describe('signed links', () => {
  it('verifies recording links and rejects tampering or expiry', () => {
    const u = new URL(`https://x${signPath('/media/recordings/abc', 60)}`);
    const exp = u.searchParams.get('exp')!, sig = u.searchParams.get('sig')!;
    expect(verifyPath('/media/recordings/abc', exp, sig)).toBe(true);
    expect(verifyPath('/media/recordings/abd', exp, sig)).toBe(false);
    expect(verifyPath('/media/recordings/abc', String(Number(exp) + 100), sig)).toBe(false);
    const old = new URL(`https://x${signPath('/media/recordings/abc', -10)}`); // correctly signed but expired
    expect(verifyPath('/media/recordings/abc', old.searchParams.get('exp')!, old.searchParams.get('sig')!)).toBe(false);
  });
  it('round-trips unsubscribe tokens', () => {
    const id = '0b6f4c9e-1d2a-4f5b-9c8d-7e6f5a4b3c2d';
    expect(readUnsubToken(unsubToken('lead', id))).toEqual({ kind: 'lead', id });
    expect(readUnsubToken(`c.${id}.forged`)).toBeNull();
  });
});
