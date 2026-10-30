import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { LINES, type Lead } from '../lib/domain';
import { useLookups } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Modal } from './ui';

type Initial = Partial<{ firstName: string; lastName: string; phone: string; email: string; company: string; line: string; source: string }>;
/** `assignToMe` keeps the lead with the person creating it (dial pad), instead of auto-assignment. */
export function NewLeadModal({ onClose, initial, assignToMe, onCreated, note }: { onClose: () => void; initial?: Initial; assignToMe?: boolean; onCreated?: (l: Lead) => void; note?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', email: '', company: '', line: 'Auto', source: '', ...initial });
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => api<Lead>('/leads', { method: 'POST', json: { ...f, source: f.source || lookups.data?.sources[0]?.name || 'Manual', ...(assignToMe ? { assignToMe: true } : {}) } }),
    onSuccess: (l) => {
      qc.invalidateQueries({ queryKey: ['leads'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); qc.invalidateQueries({ queryKey: ['notifications'] });
      toast(assignToMe ? `${l.firstName} ${l.lastName} added to your leads.` : `${l.firstName} ${l.lastName} added${l.agentId ? ' and assigned' : '. No agent matched, so it is waiting in intake'}.`, 'users');
      if (onCreated) onCreated(l); else onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not create the lead'),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setErr(''); save.mutate(); };
  return (
    <Modal title="New lead" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="new-lead" disabled={save.isPending}>{save.isPending ? 'Creating…' : 'Create lead'}</button></>}>
      <form id="new-lead" onSubmit={submit} className="form-grid">
        <div className="field"><label htmlFor="nl-first">First name</label><input id="nl-first" className="input" required value={f.firstName} onChange={set('firstName')} autoFocus /></div>
        <div className="field"><label htmlFor="nl-last">Last name</label><input id="nl-last" className="input" required value={f.lastName} onChange={set('lastName')} /></div>
        <div className="field"><label htmlFor="nl-phone">Phone</label><input id="nl-phone" className="input" required minLength={7} value={f.phone} onChange={set('phone')} placeholder="(512) 555-0123" /></div>
        <div className="field"><label htmlFor="nl-email">Email</label><input id="nl-email" className="input" type="email" value={f.email} onChange={set('email')} /></div>
        <div className="field"><label htmlFor="nl-line">Line of insurance</label><select id="nl-line" className="input" value={f.line} onChange={set('line')}>{LINES.map((l) => <option key={l}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="nl-source">Source</label><select id="nl-source" className="input" value={f.source} onChange={set('source')}>{(lookups.data?.sources ?? []).map((s) => <option key={s.id}>{s.name}</option>)}</select></div>
        <div className="field full"><label htmlFor="nl-company">Company (commercial)</label><input id="nl-company" className="input" value={f.company} onChange={set('company')} /></div>
      </form>
      <p className="help">{note ?? 'The lead lands in intake and auto-assigns by the agency’s rule.'}</p>
      {err && <p className="optout">{err}</p>}
    </Modal>
  );
}
