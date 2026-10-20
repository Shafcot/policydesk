import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fullName, type Lead } from '../lib/domain';
import { initials } from '../lib/format';
import { Icon } from './Icon';
import { Modal } from './ui';

type Contact = { id: string; firstName: string; lastName: string; phone: string; stage: Lead['stage']; calls: number; favorite: boolean };

/** Top 20 most-called contacts + favorites, searchable by name or initials (SOW 3). */
export function SpeedDial({ onClose, onCall }: { onClose: () => void; onCall?: (l: Lead) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['speed-dial'], queryFn: () => api<{ favorites: Contact[]; top: Contact[] }>('/speed-dial') });
  const search = useQuery({ queryKey: ['leads', 'speed-search', q], queryFn: () => api<Lead[]>(`/leads?q=${encodeURIComponent(q)}&limit=10`), enabled: q.trim().length > 1 });
  const fav = useMutation({
    mutationFn: (c: { id: string; favorite: boolean }) => api(`/favorites/${c.id}`, { method: c.favorite ? 'DELETE' : 'PUT' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['speed-dial'] }),
  });

  const s = q.trim().toLowerCase();
  const match = (c: { firstName: string; lastName: string; phone: string }) => !s || fullName(c).toLowerCase().includes(s) || initials(fullName(c)).toLowerCase().startsWith(s) || (s.replace(/\D/g, '') && c.phone.replace(/\D/g, '').includes(s.replace(/\D/g, '')));
  const favs = (data?.favorites ?? []).filter(match);
  const top = (data?.top ?? []).filter(match);
  const shown = new Set([...favs, ...top].map((c) => c.id));
  const more = (search.data ?? []).filter((l) => !shown.has(l.id));

  const call = async (id: string) => {
    if (!onCall) { onClose(); navigate(`/dialer?call=${id}`); return; }
    onCall(await api<Lead>(`/leads/${id}`));
  };
  const Row = ({ c, isFav }: { c: { id: string; firstName: string; lastName: string; phone: string; calls?: number }; isFav: boolean }) => (
    <div className="li">
      <button className="icon-btn sm" onClick={() => fav.mutate({ id: c.id, favorite: isFav })} aria-label={isFav ? 'Remove favorite' : 'Add favorite'} style={{ color: isFav ? 'var(--accent)' : 'var(--faint)' }}><Icon name="star" className={`sm ${isFav ? 'fill' : ''}`} /></button>
      <div className="grow"><b>{fullName(c)}</b><small>{c.phone}{c.calls !== undefined ? ` · called ${c.calls}×` : ''}</small></div>
      <button className="icon-btn call" onClick={() => call(c.id)} aria-label={`Call ${fullName(c)}`}><Icon name="phone" className="sm" /></button>
    </div>
  );
  return (
    <Modal title="Speed dial" onClose={onClose}>
      <input className="input" autoFocus placeholder="Type a name or initials (e.g. “MT”)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contacts" />
      {favs.length > 0 && <div><div className="eyebrow">Favorites</div><div className="list">{favs.map((c) => <Row key={c.id} c={c} isFav />)}</div></div>}
      <div><div className="eyebrow">Top 20 most called</div><div className="list">{top.map((c) => <Row key={c.id} c={c} isFav={false} />)}{!top.length && <p className="muted">No matches</p>}</div></div>
      {more.length > 0 && <div><div className="eyebrow">Other matches</div><div className="list">{more.map((l) => <Row key={l.id} c={l} isFav={false} />)}</div></div>}
    </Modal>
  );
}
