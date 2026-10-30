// Phone number pieces shared by the Phone numbers page and the user form: the numbers query and the "buy a number" search.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

export type PhoneNumber = { id: string; number: string; label: string | null; userId: string | null; userName: string | null; twilioSid: string | null; createdAt: string };
export type NumbersResp = { numbers: PhoneNumber[]; twilio: boolean; defaultCallerId: string | null };
export const useNumbers = () => useQuery({ queryKey: ['numbers'], queryFn: () => api<NumbersResp>('/admin/numbers') });

/** +15125550123 → (512) 555-0123 */
export const prettyNumber = (n: string) => { const m = n.match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n; };

type Available = { number: string; friendly: string; locality: string | null; region: string | null };

/** Searches Twilio for numbers to buy and lets the admin pick one. */
export function BuySearch({ value, onPick }: { value: string; onPick: (n: string) => void }) {
  const [area, setArea] = useState('');
  const [contains, setContains] = useState('');
  const [q, setQ] = useState<{ areaCode?: string; contains?: string } | null>(null);
  const found = useQuery({
    queryKey: ['available-numbers', q],
    enabled: !!q,
    queryFn: () => api<Available[]>(`/admin/numbers/available?${new URLSearchParams(Object.entries(q ?? {}).filter(([, v]) => v) as [string, string][])}`),
  });
  return (
    <div className="buy-search">
      <div className="row">
        <input className="input num" style={{ width: 110 }} inputMode="numeric" maxLength={3} placeholder="Area code" value={area} onChange={(e) => setArea(e.target.value.replace(/\D/g, ''))} aria-label="Area code" />
        <input className="input num" style={{ width: 150 }} inputMode="numeric" placeholder="Contains (optional)" value={contains} onChange={(e) => setContains(e.target.value.replace(/[^0-9]/g, ''))} aria-label="Number contains" />
        <button type="button" className="btn" disabled={(area.length > 0 && area.length !== 3) || found.isFetching} onClick={() => setQ({ areaCode: area || undefined, contains: contains.length >= 2 ? contains : undefined })}>{found.isFetching ? 'Searching…' : 'Search'}</button>
      </div>
      {found.error && <p className="optout">{found.error instanceof ApiError ? found.error.message : 'Search failed'}</p>}
      {found.data && (found.data.length
        ? <div className="avail">{found.data.map((n) => (
          <label key={n.number} className={`avail-item ${value === n.number ? 'on' : ''}`}>
            <input type="radio" name="buy-number" checked={value === n.number} onChange={() => onPick(n.number)} />
            <span className="mono">{prettyNumber(n.number)}</span><small className="muted">{[n.locality, n.region].filter(Boolean).join(', ')}</small>
          </label>))}</div>
        : <p className="help">No numbers found. Try another area code.</p>)}
      <p className="help">Twilio bills each number monthly to the agency’s Twilio account. Calls and texts to it go straight to the CRM.</p>
    </div>
  );
}
