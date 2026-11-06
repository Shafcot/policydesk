// Admin report: bad leads (bad number, unreachable, Do Not Solicit, Do Not Call) by reason, vendor and agent.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { BAD, BAD_REASONS, STG, type BadReason, type Stage } from '../lib/domain';
import { fdateY, pct } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import { useLookups } from '../lib/hooks';
import { useOpenLead } from '../lib/leadLink';
import { Icon } from '../components/Icon';
import { Empty, Loading, PageHead, Pill, StagePill } from '../components/ui';

type Counts = Partial<Record<BadReason, number>>;
type Report = {
  counts: Record<BadReason, number>; total: number;
  bySource: { source: string; counts: Counts; bad: number; leads: number }[];
  byAgent: { agentId: string | null; agentName: string; counts: Counts; bad: number }[];
  leads: { id: string; firstName: string; lastName: string; phone: string; email: string | null; source: string; stage: Stage; attempts: number; badReason: BadReason; badAt: string | null; createdAt: string; agentName: string | null; markedBy: string | null }[];
};

const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All time']] as const;

export function BadLeads() {
  const [days, setDays] = useState<number>(30);
  const [reason, setReason] = useState<BadReason | ''>('');
  const [source, setSource] = useState('');
  const lookups = useLookups();
  const openLead = useOpenLead();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['bad-leads', days, reason, source],
    queryFn: () => api<Report>(`/admin/bad-leads${qs({ days: days || undefined, reason: reason || undefined, source: source || undefined })}`),
    placeholderData: (p) => p,
  });

  const head = (
    <PageHead title="Bad leads" sub="Leads marked as bad number, unreachable, Do Not Solicit or Do Not Call. They stay out of the dialer queue and automations."
      actions={<div className="seg">{PERIODS.map(([v, n]) => <button key={v} className={days === v ? 'on' : ''} onClick={() => setDays(v)}>{n}</button>)}</div>} />
  );
  if (!data) return <>{head}<Loading /></>;

  const rcols = BAD_REASONS.map((r) => r.k);
  const cell = (c: Counts, k: BadReason) => c[k] ? <span className="num">{c[k]}</span> : <span className="faint">0</span>;
  const csvRows = (): (string | number | null)[][] => [
    ['Name', 'Phone', 'Email', 'Bad reason', 'Marked on', 'Marked by', 'Source / vendor', 'Agent', 'Stage', 'Call attempts', 'Received'],
    ...data.leads.map((l) => [`${l.firstName} ${l.lastName}`, l.phone, l.email, BAD[l.badReason].n, l.badAt?.slice(0, 10) ?? '', l.markedBy ?? 'System', l.source, l.agentName ?? 'Unassigned', STG[l.stage].n, l.attempts, l.createdAt.slice(0, 10)]),
  ];

  return (
    <>
      {head}
      <div className="kpis bad-kpis">
        <button className={`kpi click ${reason === '' ? 'on' : ''}`} onClick={() => setReason('')}><div className="eyebrow">All bad leads</div><b className="num">{data.total}</b></button>
        {BAD_REASONS.map((r) => (
          <button key={r.k} className={`kpi click ${reason === r.k ? 'on' : ''}`} style={{ ['--c' as string]: `var(${r.c})` }} onClick={() => setReason(reason === r.k ? '' : r.k)} title={r.hint}>
            <div className="eyebrow"><i className="dot" />{r.n}</div><b className="num">{data.counts[r.k]}</b>
          </button>
        ))}
      </div>

      <div className="grid g2">
        <section className="panel"><div className="panel-h"><h2>By lead source / vendor</h2>
          <button className="btn sm ghost" onClick={() => downloadCsv('bad-leads-by-source.csv', [['Source', 'Leads received', 'Bad leads', 'Bad %', ...BAD_REASONS.map((r) => r.n)], ...data.bySource.map((s) => [s.source, s.leads, s.bad, pct(s.bad, s.leads), ...rcols.map((k) => s.counts[k] ?? 0)])])}><Icon name="download" className="sm" />CSV</button></div>
          <div className="tbl-wrap"><table className="tbl bad-tbl"><thead><tr><th>Source</th><th className="r">Bad / received</th>{BAD_REASONS.map((r) => <th key={r.k} className="r" title={r.n}>{r.short}</th>)}</tr></thead><tbody>
            {data.bySource.map((s) => (
              <tr key={s.source} className={`click ${source === s.source ? 'sel' : ''}`} onClick={() => setSource(source === s.source ? '' : s.source)} title="Show only this source">
                <td><span className="tag">{s.source}</span></td>
                <td className="r"><span className="num">{s.bad} / {s.leads}</span> <small className={pct(s.bad, s.leads) >= 25 ? 'bad-pct hi' : 'bad-pct'}>{pct(s.bad, s.leads)}%</small></td>
                {rcols.map((k) => <td key={k} className="r">{cell(s.counts, k)}</td>)}
              </tr>
            ))}
            {!data.bySource.length && <tr><td colSpan={6} className="muted">No bad leads in this period.</td></tr>}
          </tbody></table></div></section>

        <section className="panel"><div className="panel-h"><h2>By agent</h2>
          <button className="btn sm ghost" onClick={() => downloadCsv('bad-leads-by-agent.csv', [['Agent', 'Bad leads', ...BAD_REASONS.map((r) => r.n)], ...data.byAgent.map((a) => [a.agentName, a.bad, ...rcols.map((k) => a.counts[k] ?? 0)])])}><Icon name="download" className="sm" />CSV</button></div>
          <div className="tbl-wrap"><table className="tbl bad-tbl"><thead><tr><th>Agent</th><th className="r">Total</th>{BAD_REASONS.map((r) => <th key={r.k} className="r" title={r.n}>{r.short}</th>)}</tr></thead><tbody>
            {data.byAgent.map((a) => (
              <tr key={a.agentId ?? 'none'}><td><b>{a.agentName}</b></td><td className="r num">{a.bad}</td>{rcols.map((k) => <td key={k} className="r">{cell(a.counts, k)}</td>)}</tr>
            ))}
            {!data.byAgent.length && <tr><td colSpan={6} className="muted">No bad leads in this period.</td></tr>}
          </tbody></table></div></section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-h"><h2>{reason ? BAD[reason].n : 'All bad leads'}{source ? ` · ${source}` : ''} <small className="muted">{data.leads.length}</small></h2>
          <div className="row" style={{ gap: 6 }}>
            <select className="input" style={{ width: 'auto' }} value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source"><option value="">All sources</option>{(lookups.data?.sources ?? []).map((s) => <option key={s.id}>{s.name}</option>)}</select>
            <button className="btn sm" onClick={() => navigate(`/leads?bad=${reason || 'any'}${source ? `&source=${encodeURIComponent(source)}` : ''}`)}><Icon name="users" className="sm" />Open in Leads</button>
            <button className="btn sm primary" disabled={!data.leads.length} onClick={() => downloadCsv(`bad-leads-${new Date().toISOString().slice(0, 10)}.csv`, csvRows())}><Icon name="download" className="sm" />Export CSV</button>
          </div></div>
        {data.leads.length ? <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Lead</th><th>Reason</th><th>Marked</th><th>Source</th><th>Agent</th><th>Stage</th><th className="r">Attempts</th></tr></thead><tbody>
          {data.leads.map((l) => (
            <tr key={l.id} className="click" onClick={() => openLead(l.id)}>
              <td><b>{l.firstName} {l.lastName}</b><small className="muted" style={{ display: 'block' }}>{l.phone}</small></td>
              <td><Pill color={BAD[l.badReason].c}>{BAD[l.badReason].n}</Pill></td>
              <td>{l.badAt ? fdateY(l.badAt) : '—'}<small className="muted" style={{ display: 'block' }}>{l.markedBy ?? 'Automatic'}</small></td>
              <td><span className="tag">{l.source}</span></td>
              <td>{l.agentName ?? <span className="muted">Unassigned</span>}</td>
              <td><StagePill stage={l.stage} /></td>
              <td className="r num">{l.attempts}</td>
            </tr>
          ))}
        </tbody></table></div> : <Empty>No bad leads match.</Empty>}
      </section>
      <p className="help" style={{ marginTop: 10 }}>Bad # = bad number · Unreach. = unreachable · DNS = Do Not Solicit · DNC = Do Not Call. Bad number is set automatically when the carrier reports the number doesn’t exist; Unreachable when a lead reaches the maximum call attempts without ever being reached. Agents mark leads from the dialer or the lead page; only the Super Admin can clear a flag.</p>
    </>
  );
}
