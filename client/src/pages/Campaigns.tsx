import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { LINES, STAGES } from '../lib/domain';
import { fdateY, fdt, toLocalInput } from '../lib/format';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Loading, Modal, PageHead, Pill } from '../components/ui';

type Campaign = { id: string; kind: 'broadcast' | 'birthday' | 'holiday'; name: string; channel: 'sms' | 'email'; subject: string | null; body: string; active: boolean; holidayDate: string | null; scheduledFor: string | null; sentAt: string | null; recipients: number; excluded: number; createdAt: string };
type Resp = { campaigns: Campaign[]; birthdaysToday: { id: string; name: string }[] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (s: string) => `${MONTHS[Number(s.slice(0, 2)) - 1]} ${Number(s.slice(3))}`;

export function Campaigns() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['campaigns'], queryFn: () => api<Resp>('/campaigns') });
  const [editing, setEditing] = useState<Campaign | 'new-holiday' | null>(null);
  const patch = useMutation({
    mutationFn: (b: { id: string } & Partial<Campaign>) => api(`/campaigns/${b.id}`, { method: 'PATCH', json: { active: b.active, body: b.body, name: b.name, holidayDate: b.holidayDate ?? undefined, channel: b.channel } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); toast('Saved'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save', 'alert'),
  });
  if (!data) return <Loading />;
  const birthday = data.campaigns.find((c) => c.kind === 'birthday');
  const holidays = data.campaigns.filter((c) => c.kind === 'holiday').sort((a, b) => (a.holidayDate ?? '').localeCompare(b.holidayDate ?? ''));
  const broadcasts = data.campaigns.filter((c) => c.kind === 'broadcast');
  return (
    <>
      <PageHead title="Campaigns" sub="Birthday and holiday messages go out automatically; broadcasts reach a filtered list. Opted-out contacts are never messaged." />
      <div className="grid g2">
        <div className="stack">
          {birthday && <section className="panel"><div className="panel-h"><h2><Icon name="gift" /> Birthday messages</h2>
            <label className="switch"><input type="checkbox" checked={birthday.active} onChange={(e) => patch.mutate({ id: birthday.id, active: e.target.checked })} aria-label="Birthday messages on" /><span /></label></div>
            <div className="panel-b stack" style={{ gap: 10 }}>
              <p className="muted">Sends every day after opening time to customers whose birthday is today.</p>
              <div className="composer"><small className="muted">Message</small><p>{birthday.body}</p><div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn sm" onClick={() => setEditing(birthday)}><Icon name="edit" className="sm" />Edit</button></div></div>
              <div><div className="lbl-sm">Birthdays today ({data.birthdaysToday.length})</div><div className="chips" style={{ marginTop: 6 }}>{data.birthdaysToday.map((b) => <span key={b.id} className="tag">{b.name}</span>)}{!data.birthdaysToday.length && <span className="muted">None today</span>}</div></div>
            </div></section>}
          <section className="panel"><div className="panel-h"><h2>Holiday messages</h2><button className="btn sm" onClick={() => setEditing('new-holiday')}><Icon name="plus" className="sm" />Add holiday</button></div>
            <div className="panel-b"><div className="list">{holidays.map((h) => (
              <div className="li" key={h.id}><div className="grow click" style={{ cursor: 'pointer' }} onClick={() => setEditing(h)}><b>{h.name} <small className="muted">· {h.holidayDate ? md(h.holidayDate) : ''}</small></b><small>{h.body}</small></div>
                <label className="switch"><input type="checkbox" checked={h.active} onChange={(e) => patch.mutate({ id: h.id, active: e.target.checked })} aria-label={h.name} /><span /></label></div>
            ))}</div><p className="help" style={{ marginTop: 8 }}>Holiday messages go to all leads and customers on the day, during business hours.</p></div></section>
        </div>
        <div className="stack">
          <Broadcast />
          <section className="panel"><div className="panel-h"><h2>Broadcasts</h2></div><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Campaign</th><th>Channel</th><th>Status</th><th className="r">Sent</th><th className="r">Excluded</th></tr></thead><tbody>
            {broadcasts.map((b) => <tr key={b.id}><td>{b.name}<small className="muted" style={{ display: 'block' }}>{fdateY(b.createdAt)}</small></td><td>{b.channel.toUpperCase()}</td>
              <td>{b.sentAt ? <Pill color="--ok">Sent {fdt(b.sentAt)}</Pill> : <Pill color="--info">Scheduled {fdt(b.scheduledFor)}</Pill>}</td><td className="r num">{b.sentAt ? b.recipients : '—'}</td><td className="r num">{b.sentAt ? b.excluded : '—'}</td></tr>)}
          </tbody></table>{!broadcasts.length && <div className="empty">No broadcasts yet.</div>}</div></section>
        </div>
      </div>
      {editing && <EditModal c={editing === 'new-holiday' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EditModal({ c, onClose }: { c: Campaign | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ name: c?.name ?? '', body: c?.body ?? '', date: c?.holidayDate ? `2026-${c.holidayDate}` : '' });
  const save = useMutation({
    mutationFn: () => c
      ? api(`/campaigns/${c.id}`, { method: 'PATCH', json: { name: f.name, body: f.body, ...(c.kind === 'holiday' && f.date ? { holidayDate: f.date.slice(5) } : {}) } })
      : api('/campaigns/holiday', { method: 'POST', json: { name: f.name, body: f.body, holidayDate: f.date.slice(5) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); toast('Saved'); onClose(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save', 'alert'),
  });
  const del = useMutation({ mutationFn: () => api(`/campaigns/${c!.id}`, { method: 'DELETE' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['campaigns'] }); onClose(); } });
  const isHoliday = !c || c.kind === 'holiday';
  return (
    <Modal title={c ? `Edit ${c.name}` : 'New holiday message'} onClose={onClose}
      footer={<>{c?.kind === 'holiday' && <button className="btn danger" onClick={() => del.mutate()}>Delete</button>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name || !f.body || (isHoliday && !f.date)} onClick={() => save.mutate()}>Save</button></>}>
      <div className="form-grid">
        <div className="field"><label htmlFor="c-name">Name</label><input id="c-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        {isHoliday && <div className="field"><label htmlFor="c-date">Date (every year)</label><input id="c-date" className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>}
        <div className="field full"><label htmlFor="c-body">Message</label><textarea id="c-body" className="input" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
      </div>
      <p className="help">Variables: {'{first} {agent} {agency}'}</p>
    </Modal>
  );
}

function Broadcast() {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ name: '', channel: 'sms' as 'sms' | 'email', subject: '', body: '', stage: '', line: '', type: '', includeCustomers: true, when: '' });
  const [count, setCount] = useState<{ recipients: number; excluded: number } | null>(null);
  const audience = { stage: f.stage || undefined, line: f.line || undefined, type: f.type || undefined, includeCustomers: f.includeCustomers };
  useEffect(() => {
    const t = setTimeout(() => api<{ recipients: number; excluded: number }>('/campaigns/audience', { method: 'POST', json: audience }).then(setCount).catch(() => setCount(null)), 250);
    return () => clearTimeout(t); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.stage, f.line, f.type, f.includeCustomers]);
  const send = useMutation({
    mutationFn: () => api<Campaign>('/campaigns/broadcast', { method: 'POST', json: { name: f.name, channel: f.channel, subject: f.subject || undefined, body: f.body, audience, sendAt: f.when ? new Date(f.when).toISOString() : undefined } }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['campaigns'] }); toast(c.sentAt ? `Broadcast queued to ${c.recipients} recipients` : `Broadcast scheduled for ${fdt(c.scheduledFor)} (business hours)`, 'megaphone'); setF({ ...f, name: '', body: '', subject: '', when: '' }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not send', 'alert'),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="panel"><div className="panel-h"><h2>New broadcast</h2></div><div className="panel-b stack" style={{ gap: 12 }}>
      <div className="form-grid">
        <div className="field full"><label htmlFor="bc-name">Campaign name</label><input id="bc-name" className="input" value={f.name} onChange={set('name')} placeholder="e.g. Winter driving safety" /></div>
        <div className="field"><label htmlFor="bc-stage">Stage</label><select id="bc-stage" className="input" value={f.stage} onChange={set('stage')}><option value="">Any stage</option>{STAGES.map((s) => <option key={s.k} value={s.k}>{s.n}</option>)}</select></div>
        <div className="field"><label htmlFor="bc-line">Line</label><select id="bc-line" className="input" value={f.line} onChange={set('line')}><option value="">Any line</option>{LINES.map((l) => <option key={l}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="bc-type">Type</label><select id="bc-type" className="input" value={f.type} onChange={set('type')}><option value="">Personal & commercial</option><option value="personal">Personal</option><option value="commercial">Commercial</option></select></div>
        <div className="field"><label htmlFor="bc-ch">Channel</label><select id="bc-ch" className="input" value={f.channel} onChange={set('channel')}><option value="sms">SMS</option><option value="email">Email</option></select></div>
        <label className="check full"><input type="checkbox" checked={f.includeCustomers} onChange={(e) => setF({ ...f, includeCustomers: e.target.checked })} />Include imported customers</label>
        {f.channel === 'email' && <div className="field full"><label htmlFor="bc-subj">Subject</label><input id="bc-subj" className="input" value={f.subject} onChange={set('subject')} /></div>}
        <div className="field full"><label htmlFor="bc-body">Message</label><textarea id="bc-body" className="input" value={f.body} onChange={set('body')} placeholder="Hi {first}, …" /></div>
        <div className="field full"><label htmlFor="bc-when">Send at (optional)</label><input id="bc-when" className="input" type="datetime-local" min={toLocalInput(new Date().toISOString())} value={f.when} onChange={set('when')} /></div>
      </div>
      <div className="row between">
        <span>{count ? <><b className="num">{count.recipients}</b> recipients <small className="muted">· {count.excluded} opted out excluded</small></> : <small className="muted">Counting…</small>}</span>
        <button className="btn primary" disabled={!f.name || !f.body || send.isPending} onClick={() => send.mutate()}><Icon name="megaphone" className="sm" />{f.when ? 'Schedule' : 'Send now'}</button>
      </div>
      <p className="help">Outside business hours, sending waits for the next opening time.</p>
    </div></section>
  );
}
