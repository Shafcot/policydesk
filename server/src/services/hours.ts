// Time-zone aware business hours. The agency's time zone (Settings → Business hours) decides when messages may go out.
import type { AgencySettings } from '../domain.js';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock parts of `d` in time zone `tz`. */
export function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, weekday: p.weekday as string, date: `${p.year}-${p.month}-${p.day}`, md: `${p.month}-${p.day}` };
}

/** UTC instant for a wall-clock time in `tz`. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = localParts(new Date(guess), tz);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess;
  return new Date(guess - offset);
}

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function isBusinessTime(d: Date, st: AgencySettings) {
  const p = localParts(d, st.timezone);
  const now = p.h * 60 + p.min;
  return st.businessDays.includes(p.weekday) && now >= toMin(st.businessOpen) && now < toMin(st.businessClose);
}

/** `d` if it is inside business hours, otherwise the next opening time. */
export function nextBusinessTime(d: Date, st: AgencySettings): Date {
  if (!st.businessDays.length) return d;
  if (isBusinessTime(d, st)) return d;
  const [oh, om] = st.businessOpen.split(':').map(Number);
  const p = localParts(d, st.timezone);
  for (let i = 0; i < 8; i++) {
    const base = new Date(Date.UTC(p.y, p.m - 1, p.d + i, 12));
    const day = DAY[base.getUTCDay()];
    if (!st.businessDays.includes(day)) continue;
    const open = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), oh, om, st.timezone);
    if (open > d) return open;
  }
  return d;
}
