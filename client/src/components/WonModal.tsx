import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { LINES, fullName, type Lead } from '../lib/domain';
import { useLookups } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Modal } from './ui';

export function WonModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const [f, setF] = useState({
    carrier: '', line: lead.line, premium: String(lead.quotePremium ?? ''),
    policyNumber: `${lead.type === 'commercial' ? 'CP' : 'PL'}-${Math.floor(100000 + Math.random() * 899999)}`,
    effectiveDate: new Date().toISOString().slice(0, 10),
  });
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/leads/${lead.id}/won`, { method: 'POST', json: { ...f, carrier: f.carrier || lookups.data?.carriers[0], premium: Number(f.premium) } }),
    onSuccess: () => {
      ['leads', 'lead', 'dashboard', 'notifications'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast(`${fullName(lead)} is now a customer. Sale recorded and review request queued.`, 'dollar');
      onClose();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Could not save'),
  });
  return (
    <Modal title="Won · create customer & policy" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending || !Number(f.premium)} onClick={() => save.mutate()}>Create customer & policy</button></>}>
      <p className="muted">{fullName(lead)} becomes a customer with their full history. The sale is added to the ledger and a review request goes out.</p>
      <div className="form-grid">
        <div className="field"><label htmlFor="w-carrier">Carrier</label><select id="w-carrier" className="input" value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })}>{(lookups.data?.carriers ?? []).map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field"><label htmlFor="w-line">Line</label><select id="w-line" className="input" value={f.line} onChange={(e) => setF({ ...f, line: e.target.value })}>{LINES.map((l) => <option key={l}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="w-prem">Annual premium ($)</label><input id="w-prem" className="input num" type="number" min="1" value={f.premium} onChange={(e) => setF({ ...f, premium: e.target.value })} /></div>
        <div className="field"><label htmlFor="w-no">Policy number</label><input id="w-no" className="input mono" value={f.policyNumber} onChange={(e) => setF({ ...f, policyNumber: e.target.value })} /></div>
        <div className="field"><label htmlFor="w-eff">Effective date</label><input id="w-eff" className="input" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></div>
      </div>
      {err && <p className="optout">{err}</p>}
    </Modal>
  );
}
