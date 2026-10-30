// Super Admin: the agency's phone numbers. Add numbers you already have, import them from Twilio or buy new ones,
// and assign one to each user (their caller ID; calls to it ring them in the browser).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useTeam } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Empty, Loading, Modal, PageHead, Pill } from '../components/ui';
import { BuySearch, prettyNumber, useNumbers, type PhoneNumber } from '../components/NumberPicker';

const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

export function Numbers() {
  const qc = useQueryClient();
  const toast = useToast();
  const nums = useNumbers();
  const team = useTeam();
  const [modal, setModal] = useState<'add' | 'buy' | null>(null);
  const [removing, setRemoving] = useState<PhoneNumber | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['numbers'] }); qc.invalidateQueries({ queryKey: ['users'] }); };
  const patch = useMutation({ mutationFn: (b: { id: string; userId?: string | null; label?: string | null }) => api(`/admin/numbers/${b.id}`, { method: 'PATCH', json: { userId: b.userId, label: b.label } }), onSuccess: (_r, b) => { refresh(); toast(b.userId === undefined ? 'Label saved' : b.userId ? 'Number assigned' : 'Number unassigned'); }, onError: (e) => toast(err(e), 'alert') });
  const sync = useMutation({ mutationFn: () => api<{ added: number; total: number }>('/admin/numbers/sync', { method: 'POST' }), onSuccess: (r) => { refresh(); toast(r.added ? `Added ${r.added} number${r.added === 1 ? '' : 's'} from Twilio` : `All ${r.total} Twilio numbers are already listed`); }, onError: (e) => toast(err(e), 'alert') });
  if (!nums.data || !team.data) return <Loading />;
  const { numbers, twilio, defaultCallerId } = nums.data;
  const active = team.data.filter((u) => u.active !== false);
  return (
    <>
      <PageHead title="Phone numbers" sub="Each user calls from their own number, and calls to that number ring them in the browser. A user has one number at a time."
        actions={<>
          {twilio && <button className="btn" disabled={sync.isPending} onClick={() => sync.mutate()}><Icon name="download" className="sm" />{sync.isPending ? 'Importing…' : 'Import from Twilio'}</button>}
          <button className="btn" onClick={() => setModal('add')}><Icon name="plus" className="sm" />Add a number</button>
          <button className="btn primary" onClick={() => setModal('buy')}><Icon name="phone" className="sm" />Buy a number</button>
        </>} />
      {!twilio && <p className="note-box">Twilio isn’t connected yet. You can still list numbers and assign them; buying and importing turn on once the Twilio keys are saved in <a href="/settings">Settings → Integrations</a>.</p>}
      <section className="panel">
        {!numbers.length ? <Empty>No numbers yet. Add a number the agency already has, or buy a new one.</Empty> : (
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Number</th><th>Label</th><th>Assigned to</th><th>Twilio</th><th /></tr></thead><tbody>
            {numbers.map((n) => (
              <tr key={n.id}>
                <td className="mono"><b>{prettyNumber(n.number)}</b></td>
                <td><input className="input" style={{ minWidth: 140 }} defaultValue={n.label ?? ''} placeholder="e.g. Sales line" aria-label={`Label for ${n.number}`} onBlur={(e) => e.target.value.trim() !== (n.label ?? '') && patch.mutate({ id: n.id, label: e.target.value.trim() || null })} /></td>
                <td><select className="input" style={{ minWidth: 180 }} value={n.userId ?? ''} onChange={(e) => patch.mutate({ id: n.id, userId: e.target.value || null })} aria-label={`Assign ${n.number}`}>
                  <option value="">Not assigned</option>
                  {active.map((u) => <option key={u.id} value={u.id}>{u.name}{u.twilioNumber && u.twilioNumber !== n.number ? ` (replaces ${prettyNumber(u.twilioNumber)})` : ''}</option>)}
                </select></td>
                <td>{n.twilioSid ? <Pill color="--ok">In account</Pill> : <Pill color="--s9">Not in Twilio</Pill>}</td>
                <td className="r"><button className="btn sm danger" onClick={() => setRemoving(n)}><Icon name="trash" className="sm" />Remove</button></td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </section>
      <p className="help" style={{ marginTop: 8 }}>Users without a number call from the default caller ID{defaultCallerId ? ` (${prettyNumber(defaultCallerId)})` : ' (set in Settings → Integrations → Twilio)'}.</p>
      {modal && <NumberModal mode={modal} onClose={() => setModal(null)} />}
      {removing && <RemoveModal n={removing} onClose={() => setRemoving(null)} />}
    </>
  );
}

function NumberModal({ mode, onClose }: { mode: 'add' | 'buy'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const team = useTeam();
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [userId, setUserId] = useState('');
  const save = useMutation({
    mutationFn: () => api<{ warning?: string; number?: string }>(mode === 'buy' ? '/admin/numbers/buy' : '/admin/numbers', { method: 'POST', json: { number, label: label || undefined, userId: userId || null } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['numbers'] }); qc.invalidateQueries({ queryKey: ['users'] }); toast(r.warning ?? (mode === 'buy' ? `Bought ${prettyNumber(r.number ?? number)}` : 'Number added'), r.warning ? 'alert' : undefined); onClose(); },
    onError: (e) => toast(err(e), 'alert'),
  });
  return (
    <Modal title={mode === 'buy' ? 'Buy a new number' : 'Add a number the agency already has'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!number || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : mode === 'buy' ? 'Buy number' : 'Add number'}</button></>}>
      <div className="form-grid">
        {mode === 'add'
          ? <div className="field full"><label htmlFor="pn-num">Phone number</label><input id="pn-num" className="input mono" placeholder="(512) 555-0100 or +15125550100" value={number} onChange={(e) => setNumber(e.target.value)} autoFocus />
            <small className="help">If it’s in the connected Twilio account, its calls and texts are pointed at the CRM automatically. Numbers from another carrier (e.g. RingCentral) need porting to Twilio first.</small></div>
          : <div className="field full"><label>Find a number</label><BuySearch value={number} onPick={setNumber} /></div>}
        <div className="field"><label htmlFor="pn-label">Label (optional)</label><input id="pn-label" className="input" placeholder="e.g. Sales line" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
        <div className="field"><label htmlFor="pn-user">Assign to</label><select id="pn-user" className="input" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Nobody yet</option>{(team.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      </div>
    </Modal>
  );
}

function RemoveModal({ n, onClose }: { n: PhoneNumber; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [release, setRelease] = useState(false);
  const del = useMutation({
    mutationFn: () => api(`/admin/numbers/${n.id}${release ? '?release=true' : ''}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['numbers'] }); qc.invalidateQueries({ queryKey: ['users'] }); toast(release ? 'Number released from Twilio' : 'Number removed from the list'); onClose(); },
    onError: (e) => toast(err(e), 'alert'),
  });
  return (
    <Modal title={`Remove ${prettyNumber(n.number)}?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary danger-fill" disabled={del.isPending} onClick={() => del.mutate()}>{release ? 'Release number' : 'Remove from list'}</button></>}>
      <p>{n.userName ? `${n.userName} will call from the default caller ID until you give them another number.` : 'It’s not assigned to anyone.'}</p>
      {n.twilioSid && <label className="check"><input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />Also release it from Twilio (stops the monthly charge; the number can’t be recovered)</label>}
    </Modal>
  );
}
