// Book of business screens: customers & policies, sales ledger, targets.
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../lib/api';
import { useMe } from '../lib/auth';
import { LINES, type Policy } from '../lib/domain';
import { daysUntil, fdate, fdateY, kmoney, money, pct } from '../lib/format';
import { useLookups, useTeam } from '../lib/hooks';
import { useOpenLead } from '../lib/leadLink';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Avatar, Bar, colorFor, Empty, Loading, Modal, PageHead, Pill } from '../components/ui';
import { downloadCsv, parseCsv } from '../lib/csv';

type Customer = { id: string; name: string; company: string | null; phone: string | null; email: string | null; type: 'personal' | 'commercial'; agentName: string | null; source: string | null; imported: boolean; createdAt: string; policyCount: number; premium: number; leadId: string | null; dob: string | null };
type PolicyRow = Policy & { customerId: string; customerName: string; agentName: string | null };

const IMPORT_HEADERS = ['name', 'phone', 'email', 'type', 'carrier', 'line', 'premium', 'effective_date', 'policy_number', 'agent_email'];

export function Customers() {
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as 'customers' | 'policies' | 'renewals') || 'customers';
  const [q, setQ] = useState('');
  const [win, setWin] = useState(30);
  const [open, setOpen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const customers = useQuery({ queryKey: ['customers', q], queryFn: () => api<Customer[]>(`/customers${qs({ q })}`), enabled: tab === 'customers' });
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => api<PolicyRow[]>('/policies'), enabled: tab === 'policies' });
  const renewals = useQuery({ queryKey: ['policies', 'renew', win], queryFn: () => api<PolicyRow[]>(`/policies?renewWithinDays=${win}`), enabled: tab === 'renewals' });

  const imp = useMutation({
    mutationFn: (rows: Record<string, string>[]) => api<{ imported: number; skipped: { row: number; reason: string }[] }>('/customers/import', { method: 'POST', json: { rows } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['customers'] }); qc.invalidateQueries({ queryKey: ['policies'] }); toast(`Imported ${r.imported} customers${r.skipped.length ? ` · ${r.skipped.length} without a policy` : ''}`, 'upload'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Import failed', 'alert'),
  });
  const onFile = async (file: File) => {
    const rows = parseCsv(await file.text());
    const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    if (!head.includes('name')) { toast('The file needs a "name" column. Download the template to see the format.', 'alert'); return; }
    imp.mutate(rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()]))));
  };
  const setTab = (t: string) => setParams((p) => { p.set('tab', t); return p; });

  const pList = tab === 'policies' ? (policies.data ?? []).filter((p) => !q || p.customerName.toLowerCase().includes(q.toLowerCase()) || p.policyNumber.toLowerCase().includes(q.toLowerCase())) : [];
  const rList = renewals.data ?? [];
  return (
    <>
      <PageHead title="Customers & policies" sub="Your book of business. A won lead’s calls, texts and notes carry over to the customer."
        actions={isAdmin && <>
          <button className="btn" onClick={() => downloadCsv('customer-import-template.csv', [IMPORT_HEADERS, ['Jane Doe', '(512) 555-0101', 'jane@example.com', 'Personal', 'Progressive', 'Auto', '1840', '2026-03-01', 'PL-123456', 'maya@youragency.com']])}><Icon name="file" className="sm" />Import template</button>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={imp.isPending}><Icon name="upload" className="sm" />{imp.isPending ? 'Importing…' : 'Import spreadsheet'}</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        </>} />
      <div className="tabs" style={{ marginBottom: 14 }}>
        {(['customers', 'policies', 'renewals'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{{ customers: 'Customers', policies: 'Policies', renewals: 'Upcoming renewals' }[t]}</button>)}
      </div>
      {tab !== 'renewals' && <div className="filters" style={{ marginBottom: 12 }}><input className="input grow" placeholder={tab === 'customers' ? 'Search name, phone, company' : 'Search customer or policy #'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>}
      <section className="panel">
        {tab === 'customers' && (customers.isLoading ? <Loading /> : (
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Customer</th><th>Type</th><th className="r">Policies</th><th className="r">Premium</th><th>Agent</th><th>Since</th><th>Source</th></tr></thead><tbody>
            {(customers.data ?? []).map((c) => (
              <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
                <td><div className="who"><Avatar name={c.name} color="--s6" /><div><b>{c.name}</b><small>{c.company ? `${c.company} · ` : ''}{c.phone}</small></div></div></td>
                <td>{c.type === 'commercial' ? 'Commercial' : 'Personal'}</td><td className="r num">{c.policyCount}</td><td className="r num">{money(c.premium)}</td>
                <td>{c.agentName ?? '—'}</td><td>{fdateY(c.createdAt)}</td><td><span className="tag">{c.imported ? 'Imported' : c.source}</span></td>
              </tr>
            ))}
          </tbody></table>{customers.data && !customers.data.length && <Empty>No customers yet.</Empty>}</div>
        ))}
        {tab === 'policies' && (policies.isLoading ? <Loading /> : (
          <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Policy #</th><th>Customer</th><th>Carrier</th><th>Line</th><th className="r">Premium</th><th>Effective</th><th>Renewal</th><th>Agent</th></tr></thead><tbody>
            {pList.map((p) => <tr key={p.id} className="click" onClick={() => setOpen(p.customerId)}><td className="mono">{p.policyNumber}</td><td>{p.customerName}</td><td>{p.carrier}</td><td>{p.line}</td><td className="r num">{money(p.premium)}</td><td>{fdateY(p.effectiveDate)}</td><td>{fdateY(p.renewalDate)}</td><td>{p.agentName ?? '—'}</td></tr>)}
          </tbody></table></div>
        ))}
        {tab === 'renewals' && (
          <>
            <div className="panel-h"><div className="seg">{[30, 60, 90].map((d) => <button key={d} className={win === d ? 'on' : ''} onClick={() => setWin(d)}>{d} days</button>)}</div>
              <small className="muted">{rList.length} policies · {money(rList.reduce((a, p) => a + p.premium, 0))} up for renewal</small></div>
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Renews</th><th>Customer</th><th>Policy</th><th className="r">Premium</th><th>Agent</th><th>Reminders</th></tr></thead><tbody>
              {rList.map((p) => { const d = daysUntil(p.renewalDate); return (
                <tr key={p.id} className="click" onClick={() => setOpen(p.customerId)}><td><Pill color={d <= 30 ? '--s7' : d <= 60 ? '--s3' : '--s4'}>{d} days</Pill> <small className="muted">{fdate(p.renewalDate)}</small></td>
                  <td>{p.customerName}</td><td>{p.line} · {p.carrier}</td><td className="r num">{money(p.premium)}</td><td>{p.agentName ?? '—'}</td>
                  <td><small className="muted">{d <= 30 ? '60- and 30-day reminders due' : d <= 60 ? '60-day reminder due' : 'Starts at 60 days'}</small></td></tr>
              ); })}
            </tbody></table>{renewals.data && !rList.length && <Empty>No renewals in this window.</Empty>}</div>
            <div className="panel-b"><p className="help">Customer reminders and agent review tasks at 60 and 30 days send automatically once automations run (Milestone 2).</p></div>
          </>
        )}
      </section>
      {open && <CustomerModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function CustomerModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const openLead = useOpenLead();
  const lookups = useLookups();
  const { data: c } = useQuery({ queryKey: ['customer', id], queryFn: () => api<Customer & { policies: Policy[]; history: { calls: number; messages: number; notes: number } | null }>(`/customers/${id}`) });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ carrier: '', line: 'Auto', premium: '', policyNumber: `PL-${Math.floor(100000 + Math.random() * 899999)}`, effectiveDate: new Date().toISOString().slice(0, 10) });
  const add = useMutation({
    mutationFn: () => api(`/customers/${id}/policies`, { method: 'POST', json: { ...f, carrier: f.carrier || lookups.data?.carriers[0], premium: Number(f.premium) } }),
    onSuccess: () => { ['customer', 'customers', 'policies', 'sales'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setAdding(false); toast('Policy added and sale recorded', 'dollar'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not add policy', 'alert'),
  });
  if (!c) return <Modal title="Customer" onClose={onClose}><Loading /></Modal>;
  return (
    <Modal wide title={c.name} onClose={onClose} footer={adding
      ? <><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" disabled={!Number(f.premium) || add.isPending} onClick={() => add.mutate()}>Save policy</button></>
      : <><button className="btn" onClick={onClose}>Close</button><button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" className="sm" />Add policy</button></>}>
      <div className="kv"><div><span>Phone</span><b>{c.phone ?? '—'}</b></div><div><span>Email</span><b>{c.email ?? '—'}</b></div><div><span>Agent</span><b>{c.agentName ?? '—'}</b></div><div><span>Customer since</span><b>{fdateY(c.createdAt)}</b></div></div>
      {adding ? (
        <div className="form-grid">
          <div className="field"><label htmlFor="ap-carrier">Carrier</label><select id="ap-carrier" className="input" value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })}>{(lookups.data?.carriers ?? []).map((x) => <option key={x}>{x}</option>)}</select></div>
          <div className="field"><label htmlFor="ap-line">Line</label><select id="ap-line" className="input" value={f.line} onChange={(e) => setF({ ...f, line: e.target.value })}>{LINES.map((x) => <option key={x}>{x}</option>)}</select></div>
          <div className="field"><label htmlFor="ap-prem">Annual premium ($)</label><input id="ap-prem" className="input num" type="number" value={f.premium} onChange={(e) => setF({ ...f, premium: e.target.value })} /></div>
          <div className="field"><label htmlFor="ap-no">Policy number</label><input id="ap-no" className="input mono" value={f.policyNumber} onChange={(e) => setF({ ...f, policyNumber: e.target.value })} /></div>
          <div className="field"><label htmlFor="ap-eff">Effective date</label><input id="ap-eff" className="input" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></div>
        </div>
      ) : (
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Policy #</th><th>Carrier</th><th>Line</th><th className="r">Premium</th><th>Renewal</th></tr></thead><tbody>
          {c.policies.map((p) => <tr key={p.id}><td className="mono">{p.policyNumber}</td><td>{p.carrier}</td><td>{p.line}</td><td className="r num">{money(p.premium)}</td><td>{fdateY(p.renewalDate)}</td></tr>)}
        </tbody></table>{!c.policies.length && <Empty>No policies yet.</Empty>}</div>
      )}
      {c.history && c.leadId && <div className="owner-note"><Icon name="file" className="sm" /><span>History carried over from the lead: {c.history.calls} calls, {c.history.messages} messages, {c.history.notes} notes.</span><button className="btn sm" onClick={() => { onClose(); openLead(c.leadId!); }}>View</button></div>}
      {c.imported && <div className="owner-note"><Icon name="upload" className="sm" />Imported from a spreadsheet</div>}
    </Modal>
  );
}

type Sale = { id: string; soldAt: string; customerId: string; customerName: string; policyNumber: string; agentName: string | null; carrier: string; line: string; source: string | null; premium: number };

export function Sales() {
  const { isAdmin } = useMe();
  const team = useTeam();
  const [month, setMonth] = useState('');
  const [agent, setAgent] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['sales', month, agent], queryFn: () => api<Sale[]>(`/sales${qs({ month, agent })}`) });
  const rows = data ?? [];
  const total = rows.reduce((a, s) => a + s.premium, 0);
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); return [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })]; });
  return (
    <>
      <PageHead title="Sales ledger" sub={isAdmin ? 'Every sale. Added automatically when a lead is marked won.' : 'Your sales only.'}
        actions={<button className="btn" onClick={() => downloadCsv('sales-ledger.csv', [['Date', 'Customer', 'Policy', 'Agent', 'Carrier', 'Line', 'Lead source', 'Premium'], ...rows.map((s) => [s.soldAt.slice(0, 10), s.customerName, s.policyNumber, s.agentName, s.carrier, s.line, s.source, s.premium])])}><Icon name="download" className="sm" />Export</button>} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <select className="input" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month"><option value="">All months</option>{months.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
        {isAdmin && <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent"><option value="">All agents</option>{(team.data ?? []).filter((u) => u.role === 'agent').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
      </div>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3,minmax(0,1fr))' }}>
        <div className="kpi"><div className="eyebrow">Policies sold</div><b>{rows.length}</b></div>
        <div className="kpi"><div className="eyebrow">Written premium</div><b>{money(total)}</b></div>
        <div className="kpi"><div className="eyebrow">Avg premium</div><b>{money(rows.length ? total / rows.length : 0)}</b></div>
      </div>
      <section className="panel"><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Date</th><th>Customer</th><th>Policy #</th><th>Agent</th><th>Carrier</th><th>Line</th><th>Lead source</th><th className="r">Premium</th></tr></thead><tbody>
        {rows.map((s) => <tr key={s.id}><td>{fdateY(s.soldAt)}</td><td>{s.customerName}</td><td className="mono">{s.policyNumber}</td><td>{s.agentName ?? '—'}</td><td>{s.carrier}</td><td>{s.line}</td><td><span className="tag">{s.source ?? '—'}</span></td><td className="r num">{money(s.premium)}</td></tr>)}
      </tbody></table>{isLoading && <Loading />}{data && !rows.length && <Empty>No sales in this period.</Empty>}</div></section>
    </>
  );
}

type Targets = { team: { target: number; achieved: number } | null; teamTargetVisible: boolean; agents: { id: string; name: string; target: number; achieved: number; sold: number }[] };

export function TargetsPage() {
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['targets'], queryFn: () => api<Targets>('/targets') });
  const save = useMutation({
    mutationFn: (b: { path: string; json: object }) => api(b.path, { method: 'PATCH', json: b.json }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['targets'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); toast('Target saved'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not save', 'alert'),
  });
  if (!data) return <Loading />;
  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const Figs = ({ t, a }: { t: number; a: number }) => <div className="target-figs"><div><small className="muted">Total</small><b>{money(t)}</b></div><div><small className="muted">Achieved</small><b>{money(a)}</b></div><div><small className="muted">Remaining</small><b>{money(Math.max(0, t - a))}</b></div><div><small className="muted">Progress</small><b>{pct(a, t)}%</b></div></div>;
  return (
    <>
      <PageHead title="Targets" sub={`Monthly written-premium targets · ${month}`}
        actions={isAdmin && <label className="check"><input type="checkbox" checked={data.teamTargetVisible} onChange={(e) => save.mutate({ path: '/admin/settings', json: { settings: { teamTargetVisible: e.target.checked } } })} />Agents can see the team target</label>} />
      <div className="stack">
        {data.team && <section className="panel"><div className="panel-h"><h2>Team target</h2>
          {isAdmin && <div className="row"><label className="lbl-sm" htmlFor="team-t">Monthly target $</label><input id="team-t" className="input num" type="number" style={{ width: 140 }} defaultValue={data.team.target} onBlur={(e) => Number(e.target.value) !== data.team!.target && save.mutate({ path: '/admin/settings', json: { settings: { teamTarget: Number(e.target.value) } } })} /></div>}</div>
          <div className="panel-b"><Bar value={pct(data.team.achieved, data.team.target)} thick /><Figs t={data.team.target} a={data.team.achieved} /></div></section>}
        <section className="panel"><div className="panel-h"><h2>{isAdmin ? 'Agent targets' : 'My target'}</h2></div><div className="tbl-wrap"><table className="tbl"><thead><tr><th>Agent</th><th>Target</th><th className="r">Achieved</th><th className="r">Remaining</th><th style={{ width: '30%' }}>Progress</th></tr></thead><tbody>
          {data.agents.map((a) => (
            <tr key={a.id}><td><div className="who"><Avatar name={a.name} color={colorFor(a.id)} /><b>{a.name}</b></div></td>
              <td>{isAdmin ? <input className="input num" type="number" style={{ width: 120 }} defaultValue={a.target} aria-label={`${a.name} target`} onBlur={(e) => Number(e.target.value) !== a.target && save.mutate({ path: `/admin/users/${a.id}`, json: { monthlyTarget: Number(e.target.value) } })} /> : <span className="num">{money(a.target)}</span>}</td>
              <td className="r num">{money(a.achieved)}</td><td className="r num">{money(Math.max(0, a.target - a.achieved))}</td>
              <td><div className="row" style={{ flexWrap: 'nowrap' }}><Bar value={pct(a.achieved, a.target)} /><span className="num" style={{ width: 42, textAlign: 'right' }}>{pct(a.achieved, a.target)}%</span></div></td></tr>
          ))}
        </tbody></table></div></section>
        {!isAdmin && !data.team && <p className="help">Your Super Admin has hidden the team target.</p>}
        <p className="help">Achieved = written premium from sales this month ({kmoney(data.agents.reduce((s, a) => s + a.achieved, 0))} across {isAdmin ? 'the team' : 'your sales'}).</p>
      </div>
    </>
  );
}
