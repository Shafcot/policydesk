import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { STAGES, type Appointment, type Lead, type Policy, type Stage } from '../lib/domain';
import { ago, daysUntil, ftime, kmoney, money, pct } from '../lib/format';
import { Icon } from '../components/Icon';
import { Avatar, Bar, colorFor, Loading, PageHead, Pill } from '../components/ui';
import { TasksPanel } from '../components/Tasks';

type Dash = {
  kpis: { newLeads: number; contacted: number; quoted: number; won: number; revenue: number; conversion: number };
  byStage: Record<Stage, number>;
  target: { team: number; achieved: number } | null;
  myTarget: { target: number; achieved: number; sold: number } | null;
  leaderboard: { id: string; name: string; premium: number; sold: number; status: string; callsToday: number; maxCalls: number }[] | null;
  today: (Appointment & { leadName: string; line: string; phone: string; agentName: string; leadId: string })[];
  renewals: (Policy & { customerName: string })[];
  unassigned: { id: string; firstName: string; lastName: string; source: string; line: string; createdAt: string }[];
  callsToday: number;
};
type QueueItem = { bucket: 'new' | 'callback' | 'followup' | 'retry'; lead: Lead };

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };
const monthName = () => new Date().toLocaleDateString('en-US', { month: 'long' });
const daysLeft = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate(); };

function useOpenLead() {
  const [, setParams] = useSearchParams();
  return (id: string) => setParams((p) => { p.set('lead', id); return p; });
}

export function Dashboard() {
  const { isAdmin } = useMe();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dash>('/dashboard'), refetchInterval: 60_000 });
  if (!q.data) return <Loading />;
  return isAdmin ? <AdminDash d={q.data} /> : <AgentDash d={q.data} />;
}

function TodayRow({ a, showAgent }: { a: Dash['today'][number]; showAgent?: boolean }) {
  const open = useOpenLead();
  const status = a.status === 'noshow' ? <Pill color="--bad">No-show</Pill> : a.status === 'done' ? <Pill color="--ok">Done</Pill> : <Pill color="--info">Upcoming</Pill>;
  return (
    <tr className="click" onClick={() => open(a.leadId)}>
      <td className="num">{ftime(a.startsAt)}</td>
      {showAgent && <td><div className="who"><Avatar name={a.agentName} color={colorFor(a.userId)} size="sm" /><span>{a.agentName}</span></div></td>}
      <td>{a.leadName}</td><td>{a.type}</td><td>{status}</td>
    </tr>
  );
}

function Renewals({ list }: { list: Dash['renewals'] }) {
  if (!list.length) return <p className="muted">No renewals coming up.</p>;
  return (
    <div className="list">
      {list.map((p) => { const d = daysUntil(p.renewalDate); return (
        <div className="li" key={p.id}><div className="grow"><b>{p.customerName}</b><small>{p.line} · {p.carrier} · {money(p.premium)}</small></div>
          <Pill color={d <= 30 ? '--s7' : d <= 60 ? '--s3' : '--s4'}>{d}d</Pill></div>
      ); })}
    </div>
  );
}

function AdminDash({ d }: { d: Dash }) {
  const { me } = useMe();
  const open = useOpenLead();
  const maxStage = Math.max(1, ...Object.values(d.byStage));
  const lb = d.leaderboard ?? [];
  const maxLb = Math.max(1, ...lb.map((b) => b.premium));
  const t = d.target!;
  return (
    <>
      <PageHead title={`Good ${greeting()}, ${me.name.split(' ')[0]}`} sub="Agency overview · last 30 days"
        actions={<><Link className="btn" to="/reports"><Icon name="chart" className="sm" />Reports</Link><Link className="btn primary" to="/leads?tab=intake"><Icon name="inbox" className="sm" />Lead intake</Link></>} />
      <div className="kpis">
        {([['New leads', d.kpis.newLeads, 'last 30 days'], ['Contacted', d.kpis.contacted, 'reached by phone'], ['Quoted', d.kpis.quoted, 'quotes issued'], ['Won', d.kpis.won, 'policies this month'], ['Revenue', kmoney(d.kpis.revenue), 'written premium MTD'], ['Conversion', `${d.kpis.conversion}%`, 'lead → won']] as const)
          .map(([label, v, s]) => <div className="kpi" key={label}><div className="eyebrow">{label}</div><b>{v}</b><small>{s}</small></div>)}
      </div>
      <div className="grid g-dash">
        <div className="stack">
          <section className="panel"><div className="panel-h"><h2>Agency target · {monthName()}</h2><Pill color="--s6">{pct(t.achieved, t.team)}% achieved</Pill></div>
            <div className="panel-b"><Bar value={pct(t.achieved, t.team)} thick />
              <div className="target-figs"><div><small className="muted">Target</small><b>{money(t.team)}</b></div><div><small className="muted">Achieved</small><b>{money(t.achieved)}</b></div><div><small className="muted">Remaining</small><b>{money(Math.max(0, t.team - t.achieved))}</b></div><div><small className="muted">Days left</small><b>{daysLeft()}</b></div></div></div></section>
          <div className="grid g2">
            <section className="panel"><div className="panel-h"><h2>Leads by stage</h2><Link className="btn sm ghost" to="/pipeline">Pipeline <Icon name="right" className="sm" /></Link></div>
              <div className="panel-b"><div className="hbars">{STAGES.map((s) => (
                <div className="hbar" key={s.k}><span className="lbl">{s.n}</span><div className="track"><i style={{ width: `${pct(d.byStage[s.k], maxStage)}%`, ['--c' as string]: `var(${s.c})` }} /></div><span className="num">{d.byStage[s.k]}</span></div>
              ))}</div></div></section>
            <section className="panel"><div className="panel-h"><h2>Leaderboard</h2><small className="muted">premium MTD</small></div>
              <div className="panel-b"><div className="list">{lb.map((b, i) => (
                <div className="li" key={b.id}><span className={`rank ${i === 0 ? 'top' : ''}`}>{i + 1}</span><Avatar name={b.name} color={colorFor(b.id)} />
                  <div className="grow"><b>{b.name}</b><Bar value={pct(b.premium, maxLb)} accent={i === 0} /></div>
                  <div style={{ textAlign: 'right' }}><b className="num">{kmoney(b.premium)}</b><small className="muted" style={{ display: 'block' }}>{b.sold} sold</small></div></div>
              ))}</div></div></section>
          </div>
          <section className="panel"><div className="panel-h"><h2>Today’s calls & appointments · all agents</h2></div>
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Time</th><th>Agent</th><th>Lead</th><th>Type</th><th>Status</th></tr></thead>
              <tbody>{d.today.map((a) => <TodayRow key={a.id} a={a} showAgent />)}{!d.today.length && <tr><td colSpan={5} className="empty">Nothing scheduled today</td></tr>}</tbody></table></div></section>
        </div>
        <div className="stack">
          <section className="panel"><div className="panel-h"><h2>Unassigned leads</h2><span className="badge">{d.unassigned.length}</span></div>
            <div className="panel-b"><p className="muted" style={{ marginBottom: 10 }}>Leads that matched no agent (offline, at limit, or no line match).</p>
              <div className="list">{d.unassigned.slice(0, 5).map((l) => (
                <div className="li click" key={l.id} onClick={() => open(l.id)}><div className="grow"><b>{l.firstName} {l.lastName}</b><small>{l.source} · {l.line}</small></div><small className="muted">{ago(l.createdAt)}</small></div>
              ))}{!d.unassigned.length && <p className="muted">All leads are assigned.</p>}</div>
              <Link className="btn sm" style={{ marginTop: 10 }} to="/leads?tab=intake">Open intake</Link></div></section>
          <TasksPanel />
          <section className="panel"><div className="panel-h"><h2>Agent status</h2></div><div className="panel-b"><div className="list">{lb.map((a) => (
            <div className="li" key={a.id}><Avatar name={a.name} color={colorFor(a.id)} /><div className="grow"><b>{a.name}</b><small>{a.callsToday} / {a.maxCalls} calls today</small></div>
              <span className="row" style={{ gap: 6 }}><span className={`dot ${a.status}`} /><small>{{ available: 'Available', oncall: 'On call', offline: 'Offline' }[a.status]}</small></span></div>
          ))}</div></div></section>
          <section className="panel"><div className="panel-h"><h2>Upcoming renewals</h2><small className="muted">next 30 days</small></div><div className="panel-b"><Renewals list={d.renewals} /></div></section>
        </div>
      </div>
    </>
  );
}

function AgentDash({ d }: { d: Dash }) {
  const { me } = useMe();
  const open = useOpenLead();
  const queue = useQuery({ queryKey: ['queue'], queryFn: () => api<QueueItem[]>('/leads/queue/mine') });
  const q = queue.data ?? [];
  const cnt = (b: QueueItem['bucket']) => q.filter((x) => x.bucket === b).length;
  const label = { new: 'New lead', callback: 'Call-back', followup: 'Follow-up', retry: 'Retry' };
  const t = d.myTarget!;
  return (
    <>
      <div className="hero-dial">
        <div><h1>Ready to dial, {me.name.split(' ')[0]}?</h1><p>{q.length} leads in your queue · {d.callsToday} of {me.minCallsPerDay}–{me.maxCallsPerDay} calls made today</p>
          <div className="qcounts"><div><b>{cnt('new')}</b><small>New leads</small></div><div><b>{cnt('callback')}</b><small>Call-backs due</small></div><div><b>{cnt('followup')}</b><small>Follow-ups today</small></div><div><b>{cnt('retry')}</b><small>No-answer retries</small></div></div></div>
        <Link className="btn accent lg" to="/dialer"><Icon name="phone" />Start dialing</Link>
      </div>
      <div className="grid g-dash">
        <div className="stack">
          <section className="panel"><div className="panel-h"><h2>Next in my queue</h2></div><div className="panel-b"><div className="list">
            {q.slice(0, 6).map((x) => (
              <div className="li click" key={x.lead.id} onClick={() => open(x.lead.id)}><div className="grow"><b>{x.lead.firstName} {x.lead.lastName}</b><small>{x.lead.line} · {x.lead.phone} · attempt {x.lead.attempts + 1}</small></div><span className="tag">{label[x.bucket]}</span></div>
            ))}{!q.length && <p className="muted">Queue is clear.</p>}
          </div></div></section>
          <section className="panel"><div className="panel-h"><h2>Today</h2><small className="muted">appointments & call-backs</small></div>
            <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Time</th><th>Lead</th><th>Type</th><th>Status</th></tr></thead>
              <tbody>{d.today.map((a) => <TodayRow key={a.id} a={a} />)}{!d.today.length && <tr><td colSpan={4} className="empty">Nothing scheduled today</td></tr>}</tbody></table></div></section>
        </div>
        <div className="stack">
          <TasksPanel />
          <section className="panel"><div className="panel-h"><h2>My target</h2><Pill color="--s6">{pct(t.achieved, t.target)}%</Pill></div>
            <div className="panel-b"><Bar value={pct(t.achieved, t.target)} thick />
              <div className="target-figs"><div><small className="muted">Target</small><b>{kmoney(t.target)}</b></div><div><small className="muted">Achieved</small><b>{kmoney(t.achieved)}</b></div><div><small className="muted">Remaining</small><b>{kmoney(Math.max(0, t.target - t.achieved))}</b></div><div><small className="muted">Sold</small><b>{t.sold}</b></div></div>
              {d.target && <><div className="sep" /><div className="row between"><small className="muted">Team target</small><small className="num">{kmoney(d.target.achieved)} / {kmoney(d.target.team)}</small></div><Bar value={pct(d.target.achieved, d.target.team)} accent /></>}
            </div></section>
          <section className="panel"><div className="panel-h"><h2>My renewals</h2><small className="muted">next 60 days</small></div><div className="panel-b"><Renewals list={d.renewals} /></div></section>
        </div>
      </div>
    </>
  );
}
