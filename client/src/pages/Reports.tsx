import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useMe } from '../lib/auth';
import { fullName, type Lead } from '../lib/domain';
import { ago, kmoney, money, pct } from '../lib/format';
import { useOpenLead } from '../lib/leadLink';
import { Icon } from '../components/Icon';
import { Avatar, colorFor, Loading, PageHead, StagePill } from '../components/ui';
import { downloadCsv } from './Book';

type Report = {
  production: { month: string; premium: number }[];
  bySource: { name: string; premium: number; sold: number }[];
  byCarrier: { name: string; premium: number; sold: number }[];
  roi: { name: string; vendor: boolean; leads: number; costPerLead: number; cost: number; won: number; conversion: number; revenue: number; roi: number | null }[];
  agents: { id: string; name: string; premium: number; sold: number; personal: number; commercial: number; calls: number; contacts: number; quotes: number; leads: number; conversion: number }[];
};

const monthLabel = (m: string) => new Date(`${m}-01T12:00:00`).toLocaleDateString('en-US', { month: 'short' });

function HBars({ rows, onClick }: { rows: { name: string; value: number; color?: string; id?: string }[]; onClick?: (id: string) => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="muted">No sales in this period.</p>;
  return (
    <div className="hbars">{rows.map((r) => (
      <div key={r.name} className={`hbar ${onClick ? 'click' : ''}`} onClick={() => onClick && r.id && onClick(r.id)}>
        <span className="lbl">{r.name}</span><div className="track"><i style={{ width: `${pct(r.value, max)}%`, ['--c' as string]: `var(${r.color ?? '--brand'})` }} /></div><span className="num">{kmoney(r.value)}</span>
      </div>
    ))}</div>
  );
}

export function Reports() {
  const { isAdmin } = useMe();
  const [months, setMonths] = useState(6);
  const [drill, setDrill] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['reports', months], queryFn: () => api<Report>(`/reports?months=${months}`) });
  const canPrint = (() => { try { return window.self === window.top; } catch { return false; } })();

  const head = (
    <PageHead title="Reports" sub={isAdmin ? 'Click an agent to drill down: agency → agent → lead.' : 'Your performance.'}
      actions={<>
        <div className="seg">{[[1, 'This month'], [3, '3 months'], [6, '6 months'], [12, '12 months']].map(([v, n]) => <button key={v} className={months === v ? 'on' : ''} onClick={() => setMonths(v as number)}>{n}</button>)}</div>
        {canPrint && <button className="btn" onClick={() => window.print()}><Icon name="print" className="sm" />Print</button>}
      </>} />
  );
  if (!data) return <>{head}<Loading /></>;
  if (drill && isAdmin) return <>{head}<Drill agentId={drill} months={months} name={data.agents.find((a) => a.id === drill)?.name ?? ''} onBack={() => setDrill(null)} /></>;

  const pmax = Math.max(1, ...data.production.map((p) => p.premium));
  const csv = (name: string, rows: (string | number | null)[][]) => <button className="btn sm ghost no-print" onClick={() => downloadCsv(`report-${name}.csv`, rows)}><Icon name="download" className="sm" />CSV</button>;
  return (
    <>
      {head}
      <div className="grid g2">
        {isAdmin && <section className="panel"><div className="panel-h"><h2>Leaderboard · sales by agent</h2>{csv('leaderboard', [['Agent', 'Premium', 'Policies'], ...data.agents.map((a) => [a.name, a.premium, a.sold])])}</div>
          <div className="panel-b"><HBars rows={[...data.agents].sort((a, b) => b.premium - a.premium).map((a) => ({ name: a.name, value: a.premium, color: colorFor(a.id), id: a.id }))} onClick={setDrill} /></div></section>}
        <section className="panel"><div className="panel-h"><h2>Production by month</h2>{csv('production', [['Month', 'Premium'], ...data.production.map((p) => [p.month, p.premium])])}</div><div className="panel-b">
          <div className="colchart">{data.production.map((p, i) => <div className="c" key={p.month}><span>{kmoney(p.premium)}</span><i className={i === data.production.length - 1 ? 'cur' : ''} style={{ height: `${pct(p.premium, pmax)}%` }} /></div>)}</div>
          <div className="colchart-x">{data.production.map((p) => <span key={p.month}>{monthLabel(p.month)}</span>)}</div></div></section>
        <section className="panel"><div className="panel-h"><h2>Sales by lead source</h2>{csv('source', [['Source', 'Premium', 'Policies'], ...data.bySource.map((r) => [r.name, r.premium, r.sold])])}</div><div className="panel-b"><HBars rows={data.bySource.map((r) => ({ name: r.name, value: r.premium }))} /></div></section>
        <section className="panel"><div className="panel-h"><h2>Sales by carrier</h2>{csv('carrier', [['Carrier', 'Premium', 'Policies'], ...data.byCarrier.map((r) => [r.name, r.premium, r.sold])])}</div><div className="panel-b"><HBars rows={data.byCarrier.map((r) => ({ name: r.name, value: r.premium, color: '--s4' }))} /></div></section>
      </div>
      <section className="panel" style={{ marginTop: 16 }}><div className="panel-h"><h2>Lead cost vs revenue · ROI per source</h2>{csv('roi', [['Source', 'Leads', 'Cost per lead', 'Lead cost', 'Won', 'Conversion %', 'Revenue', 'ROI %'], ...data.roi.map((r) => [r.name, r.leads, r.costPerLead, r.cost, r.won, r.conversion, r.revenue, r.roi])])}</div>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Source / vendor</th><th className="r">Leads</th><th className="r">Cost per lead</th><th className="r">Lead cost</th><th className="r">Won</th><th className="r">Conversion</th><th className="r">Revenue</th><th className="r">ROI</th></tr></thead><tbody>
          {data.roi.map((r) => <tr key={r.name}><td>{r.name}{r.vendor && <small className="muted"> · vendor</small>}</td><td className="r num">{r.leads}</td><td className="r num">{money(r.costPerLead)}</td><td className="r num">{money(r.cost)}</td><td className="r num">{r.won}</td><td className="r num">{r.conversion}%</td><td className="r num">{money(r.revenue)}</td>
            <td className="r num" style={{ fontWeight: 600, color: r.roi == null ? 'var(--muted)' : r.roi >= 0 ? 'var(--ok)' : 'var(--bad)' }}>{r.roi == null ? 'Free' : `${r.roi}%`}</td></tr>)}
        </tbody></table></div></section>
      <section className="panel" style={{ marginTop: 16 }}><div className="panel-h"><h2>Agent performance</h2>{csv('performance', [['Agent', 'Calls', 'Contacts', 'Quotes', 'Wins', 'Lead conversion %', 'Premium', 'Personal', 'Commercial'], ...data.agents.map((a) => [a.name, a.calls, a.contacts, a.quotes, a.sold, a.conversion, a.premium, a.personal, a.commercial])])}</div>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Agent</th><th className="r">Calls</th><th className="r">Contacts</th><th className="r">Quotes</th><th className="r">Wins</th><th className="r">Lead conversion</th><th className="r">Premium</th><th style={{ minWidth: 200 }}>Personal vs commercial</th></tr></thead><tbody>
          {data.agents.map((a) => { const t = a.personal + a.commercial; return (
            <tr key={a.id} className={isAdmin ? 'click' : ''} onClick={() => isAdmin && setDrill(a.id)}>
              <td><div className="who"><Avatar name={a.name} color={colorFor(a.id)} /><b>{a.name}</b></div></td>
              <td className="r num">{a.calls}</td><td className="r num">{a.contacts}</td><td className="r num">{a.quotes}</td><td className="r num">{a.sold}</td><td className="r num">{a.conversion}%</td><td className="r num">{money(a.premium)}</td>
              <td><div className="split" title={`Personal ${money(a.personal)} · Commercial ${money(a.commercial)}`}><i style={{ width: `${pct(a.personal, t || 1)}%`, background: 'var(--s1)' }} /><i style={{ width: `${pct(a.commercial, t || 1)}%`, background: 'var(--s5)' }} /></div>
                <small className="muted">{t ? (a.personal >= a.commercial ? 'Stronger in personal' : 'Stronger in commercial') : 'No sales'}</small></td>
            </tr>
          ); })}
        </tbody></table></div>
        <div className="panel-b"><div className="legend"><span style={{ ['--c' as string]: 'var(--s1)' }}>Personal lines</span><span style={{ ['--c' as string]: 'var(--s5)' }}>Commercial lines</span></div></div></section>
    </>
  );
}

function Drill({ agentId, name, months, onBack }: { agentId: string; name: string; months: number; onBack: () => void }) {
  const openLead = useOpenLead();
  const leads = useQuery({ queryKey: ['leads', 'drill', agentId], queryFn: () => api<Lead[]>(`/leads${qs({ agent: agentId, limit: 500 })}`) });
  const rep = useQuery({ queryKey: ['reports', months, agentId], queryFn: () => api<Report>(`/reports?months=${months}&agent=${agentId}`) });
  const a = rep.data?.agents[0];
  return (
    <>
      <div className="crumbs" style={{ marginBottom: 10 }}><a onClick={onBack}>Agency</a><Icon name="right" className="sm" /><span>{name}</span><Icon name="right" className="sm" /><span className="faint">select a lead</span></div>
      {a && <div className="kpis">{([['Premium', kmoney(a.premium)], ['Policies', a.sold], ['Calls', a.calls], ['Contacts', a.contacts], ['Quotes', a.quotes], ['Lead conversion', `${a.conversion}%`]] as const).map(([k, v]) => <div className="kpi" key={k}><div className="eyebrow">{k}</div><b>{v}</b></div>)}</div>}
      <section className="panel"><div className="panel-h"><h2>{name}’s leads</h2><button className="btn sm" onClick={onBack}><Icon name="left" className="sm" />Back to agency</button></div>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Lead</th><th>Stage</th><th>Line</th><th>Source</th><th className="r">Attempts</th><th>Last contact</th></tr></thead><tbody>
          {(leads.data ?? []).map((l) => <tr key={l.id} className="click" onClick={() => openLead(l.id)}><td><b>{fullName(l)}</b></td><td><StagePill stage={l.stage} /></td><td>{l.line}</td><td>{l.source}</td><td className="r num">{l.attempts}</td><td>{ago(l.lastContactAt)}</td></tr>)}
        </tbody></table>{leads.isLoading && <Loading />}</div></section>
    </>
  );
}
