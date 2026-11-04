import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fullName, type Lead } from '../lib/domain';
import { initials } from '../lib/format';
import { Icon } from './Icon';
import { Modal } from './ui';
import { useMe } from '../lib/auth';
import { useToast } from '../lib/toast';
import { ApiError } from '../lib/api';

type SavedContact = { id: string; name: string; phone: string; note: string | null; shared: boolean; userId: string | null };
const pretty = (n: string) => n.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');

type Contact = { id: string; firstName: string; lastName: string; phone: string; stage: Lead['stage']; calls: number; favorite: boolean };

/** Top 20 most-called contacts + favorites, searchable by name or initials (SOW 3). */
/** `onDial` calls a saved contact's number (carrier service lines etc.). */
export function SpeedDial({ onClose, onCall, onDial }: { onClose: () => void; onCall?: (l: Lead) => void; onDial?: (number: string) => void }) {
  const { me, isAdmin } = useMe();
  const toast = useToast();
  const saved = useQuery({ queryKey: ['speed-dial-contacts'], queryFn: () => api<SavedContact[]>('/speed-dial/contacts') });
  const [adding, setAdding] = useState(false);
  const [nc, setNc] = useState({ name: '', phone: '', shared: false });
  const addC = useMutation({ mutationFn: () => api('/speed-dial/contacts', { method: 'POST', json: nc }), onSuccess: () => { setNc({ name: '', phone: '', shared: false }); setAdding(false); qc.invalidateQueries({ queryKey: ['speed-dial-contacts'] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save', 'alert') });
  const delC = useMutation({ mutationFn: (id: string) => api(`/speed-dial/contacts/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['speed-dial-contacts'] }) });
  const dialNumber = (n: string) => { if (onDial) onDial(n); else { onClose(); navigate(`/dialer?dial=${encodeURIComponent(n)}`); } };
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
  const contacts = (saved.data ?? []).filter((c) => !s || c.name.toLowerCase().includes(s) || c.phone.includes(s.replace(/\D/g, '') || '~'));
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
      <div><div className="row between"><div className="eyebrow">Saved numbers</div><button className="btn sm ghost" onClick={() => setAdding(!adding)}><Icon name="plus" className="sm" />Add number</button></div>
        {adding && <form className="row" style={{ margin: '6px 0' }} onSubmit={(e) => { e.preventDefault(); addC.mutate(); }}>
          <input className="input" style={{ flex: 2, minWidth: 140 }} placeholder="Name, e.g. Progressive service line" value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} aria-label="Contact name" required />
          <input className="input mono" style={{ flex: 1, minWidth: 130 }} placeholder="(800) 555-0100" value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} aria-label="Contact number" required />
          {isAdmin && <label className="check"><input type="checkbox" checked={nc.shared} onChange={(e) => setNc({ ...nc, shared: e.target.checked })} />Share with team</label>}
          <button className="btn sm primary" disabled={addC.isPending}>Save</button>
        </form>}
        <div className="list">{contacts.map((c) => (
          <div className="li" key={c.id}><span style={{ color: 'var(--accent)', display: 'inline-flex' }}><Icon name="star" className="sm fill" /></span>
            <div className="grow"><b>{c.name}</b><small className="mono">{pretty(c.phone)}{c.shared ? ' · team' : ''}</small></div>
            {(c.userId === me.id || isAdmin) && <button className="icon-btn sm" onClick={() => delC.mutate(c.id)} aria-label={`Remove ${c.name}`}><Icon name="trash" className="sm" /></button>}
            <button className="icon-btn call" onClick={() => dialNumber(c.phone)} aria-label={`Call ${c.name}`}><Icon name="phone" className="sm" /></button>
          </div>))}
          {!contacts.length && !adding && <p className="muted">Add carrier service lines and other numbers you call often.</p>}</div></div>
      {favs.length > 0 && <div><div className="eyebrow">Favorite leads</div><div className="list">{favs.map((c) => <Row key={c.id} c={c} isFav />)}</div></div>}
      <div><div className="eyebrow">Top 20 most called</div><div className="list">{top.map((c) => <Row key={c.id} c={c} isFav={false} />)}{!top.length && <p className="muted">No matches</p>}</div></div>
      {more.length > 0 && <div><div className="eyebrow">Other matches</div><div className="list">{more.map((l) => <Row key={l.id} c={l} isFav={false} />)}</div></div>}
    </Modal>
  );
}
