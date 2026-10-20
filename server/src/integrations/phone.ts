/** US/Canada numbers to E.164 (+15125550123). Numbers already starting with + are kept. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.startsWith('+')) return '+' + s.slice(1).replace(/\D/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d.length >= 8 ? `+${d}` : null;
}
/** Last 10 digits, for matching numbers stored in different formats. */
export const last10 = (raw: string | null | undefined) => (raw ?? '').replace(/\D/g, '').slice(-10);
