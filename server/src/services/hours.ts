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

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The agency's target month, which can start on any day (e.g. the 20th → Sept 20 – Oct 19), in the agency's time zone.
 * `offset` moves back/forward whole periods (-1 = the previous target month).
 */
export function targetPeriod(st: Pick<AgencySettings, 'timezone' | 'targetStartDay'>, now = new Date(), offset = 0) {
  const day = Math.min(28, Math.max(1, Math.round(st.targetStartDay || 1)));
  const p = localParts(now, st.timezone);
  let y = p.y, m = p.m - 1; // 0-based month whose `day` starts the current period
  if (p.d < day) m -= 1;
  m += offset;
  const norm = (yy: number, mm: number) => ({ y: yy + Math.floor(mm / 12), m: ((mm % 12) + 12) % 12 });
  const s = norm(y, m), e = norm(y, m + 1);
  y = s.y;
  const start = zonedToUtc(s.y, s.m + 1, day, 0, 0, st.timezone);
  const end = zonedToUtc(e.y, e.m + 1, day, 0, 0, st.timezone);
  const last = new Date(end.getTime() - 864e5);
  const lp = localParts(last, st.timezone);
  const label = day === 1 ? `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][s.m]} ${s.y}` : `${MON[s.m]} ${day} – ${MON[lp.m - 1]} ${lp.d}`;
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 864e5));
  return { start, end, label, daysLeft, key: `${s.y}-${String(s.m + 1).padStart(2, '0')}` };
}

/** Start of today and of this week (Monday) in the agency's time zone. */
export function dayAndWeekStart(tz: string, now = new Date()) {
  const p = localParts(now, tz);
  const today = zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  const wk = new Date(Date.UTC(p.y, p.m - 1, p.d - dow, 12));
  const week = zonedToUtc(wk.getUTCFullYear(), wk.getUTCMonth() + 1, wk.getUTCDate(), 0, 0, tz);
  return { today, week };
}
