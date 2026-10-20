const DAY = 864e5;
const d = (v: string | number | Date) => new Date(v);
export const money = (n: number | null | undefined) => '$' + Math.round(n ?? 0).toLocaleString('en-US');
export const kmoney = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : money(n));
export const isToday = (v: string | null | undefined) => !!v && d(v).toDateString() === new Date().toDateString();
export const fdate = (v: string | null | undefined) => (v ? d(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
export const fdateY = (v: string | null | undefined) => (v ? d(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const ftime = (v: string | number | Date) => d(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
export const fdt = (v: string | null | undefined) => (v ? `${isToday(v) ? 'Today' : fdate(v)}, ${ftime(v)}` : '—');
export const ago = (v: string | null | undefined) => {
  if (!v) return 'Never';
  const s = (Date.now() - +d(v)) / 1e3;
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const days = Math.floor(s / 86400);
  return days < 30 ? `${days}d ago` : fdate(v);
};
export const dur = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
export const daysUntil = (v: string) => Math.ceil((+d(v) - Date.now()) / DAY);
export const initials = (n: string) => n.split(' ').filter(Boolean).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
/** ISO string → value for <input type="datetime-local">. */
export const toLocalInput = (v: string | null) => {
  if (!v) return '';
  const x = d(v); x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
};
