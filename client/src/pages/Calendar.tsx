import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { fullName, type Appointment, type Lead } from '../lib/domain';
import { fdt, ftime, isToday, toLocalInput } from '../lib/format';
import { bookingLink, usePublicSettings, useTeam } from '../lib/hooks';
import { useOpenLead } from '../lib/leadLink';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { colorFor, Modal, PageHead, Pill } from '../components/ui';

type Appt = Appointment & { leadId: string; leadName: string; line: string; agentName: string };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const H = 60;

const weekStart = (offset: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7); return d; };

export function Calendar() {
  const { isAdmin, me } = useMe();
  const team = useTeam();
  const [week, setWeek] = useState(0);
  const [agent, setAgent] = useState('');
  const [sel, setSel] = useState<Appt | null>(null);
  const [book, setBook] = useState(false);
  const from = weekStart(week);
  const to = new Date(from); to.setDate(to.getDate() + 7);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(from); d.setDate(d.getDate() + i); return d; });
  const { data = [] } = useQuery({ queryKey: ['appointments', from.toISOString(), agent], queryFn: () => api<Appt[]>(`/appointments${qs({ from: from.toISOString(), to: to.toISOString(), agent })}`) });

  const hrs = data.map((a) => new Date(a.startsAt).getHours());
  const h0 = Math.min(8, ...hrs), h1 = Math.max(18, ...hrs.map((h) => h + 1));
  const owner = isAdmin ? (team.data ?? []).find((u) => u.id === agent) : me;
  const offDays = owner?.daysOff ?? [];
  const nowTop = (new Date().getHours() + new Date().getMinutes() / 60 - h0) * H;
  const agents = (team.data ?? []).filter((u) => u.role === 'agent');

  return (
    <>
      <PageHead title="Calendar" sub={isAdmin ? 'All agents’ appointments and call-backs.' : 'Your appointments and call-backs. A reminder goes out before each one.'}
        actions={<>
          {isAdmin && <select className="input" style={{ width: 'auto' }} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent"><option value="">All agents</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
          <div className="seg"><button onClick={() => setWeek(week - 1)} aria-label="Previous week"><Icon name="left" className="sm" /></button><button className={week === 0 ? 'on' : ''} onClick={() => setWeek(0)}>This week</button><button onClick={() => setWeek(week + 1)} aria-label="Next week"><Icon name="right" className="sm" /></button></div>
          <button className="btn primary" onClick={() => setBook(true)}><Icon name="plus" className="sm" />Appointment</button>
        </>} />
      <div className="cal-layout">
        <section className="panel">
          <div className="panel-h"><h2>{days[0].toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – {days[6].toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</h2>
            {isAdmin && !agent && <div className="legend">{agents.map((a) => <span key={a.id} style={{ ['--c' as string]: `var(${colorFor(a.id)})` }}>{a.name.split(' ')[0]}</span>)}</div>}</div>
          <div className="cal-scroll"><div className="cal">
            <div />
            {days.map((d) => <div key={d.toISOString()} className={`cal-dh ${isToday(d.toISOString()) ? 'today' : ''}`}>{d.toLocaleDateString('en-US', { weekday: 'short' })}<small>{d.getDate()}</small></div>)}
            <div className="cal-hours">{Array.from({ length: h1 - h0 }, (_, i) => <div key={i}>{((h0 + i) % 12) || 12}{h0 + i < 12 ? 'a' : 'p'}</div>)}</div>
            {days.map((d) => {
              const dn = DAYS[(d.getDay() + 6) % 7];
              const today = isToday(d.toISOString());
              return (
                <div key={d.toISOString()} className={`cal-day ${offDays.includes(dn) ? 'off' : ''} ${today ? 'today' : ''}`} style={{ height: (h1 - h0) * H }}>
                  {today && nowTop > 0 && nowTop < (h1 - h0) * H && <div className="now-line" style={{ top: nowTop }} />}
                  {data.filter((a) => new Date(a.startsAt).toDateString() === d.toDateString()).map((a) => {
                    const t = new Date(a.startsAt);
                    return (
                      <div key={a.id} className={`ev ${a.status === 'noshow' ? 'noshow' : ''}`} style={{ top: (t.getHours() + t.getMinutes() / 60 - h0) * H, height: Math.max(28, (a.durationMin / 60) * H - 2), ['--c' as string]: `var(${colorFor(a.userId)})` }}
                        onClick={() => setSel(a)} title={`${a.type} · ${a.agentName}`}>
                        <b>{a.leadName}</b>{ftime(a.startsAt)} · {a.type}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div></div>
        </section>
        <div className="stack">{isAdmin ? <AdminSide /> : <AgentSide />}</div>
      </div>
      {sel && <ApptModal a={sel} onClose={() => setSel(null)} />}
      {book && <BookModal onClose={() => setBook(false)} />}
    </>
  );
}

function CopyLink({ url }: { url: string }) {
  const toast = useToast();
  const copy = () => navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast(url, 'copy'));
  return <div className="copybox"><input className="input" readOnly value={url} aria-label="Booking link" /><button className="icon-btn" onClick={copy} aria-label="Copy link"><Icon name="copy" className="sm" /></button></div>;
}

function AgentSide() {
  const { me } = useMe();
  const { setUser } = useAuth();
  const toast = useToast();
  const settings = usePublicSettings();
  const save = useMutation({
    mutationFn: (b: Partial<{ hoursStart: string; hoursEnd: string; daysOff: string[] }>) => api<{ hoursStart: string; hoursEnd: string; daysOff: string[] }>('/users/me/hours', { method: 'PATCH', json: b }),
    onSuccess: (r) => { setUser({ ...me, ...r }); toast('Working hours saved'); },
  });
  return (
    <>
      <section className="panel"><div className="panel-h"><h3>My booking link</h3></div><div className="panel-b"><p className="help" style={{ marginBottom: 8 }}>Leads pick a free slot inside your working hours.</p><CopyLink url={bookingLink(me.name)} /></div></section>
      <section className="panel"><div className="panel-h"><h3>Working hours</h3></div><div className="panel-b stack" style={{ gap: 12 }}>
        <div className="row"><input type="time" className="input" style={{ width: 'auto' }} defaultValue={me.hoursStart} onBlur={(e) => e.target.value !== me.hoursStart && save.mutate({ hoursStart: e.target.value })} aria-label="Start" /><span>to</span>
          <input type="time" className="input" style={{ width: 'auto' }} defaultValue={me.hoursEnd} onBlur={(e) => e.target.value !== me.hoursEnd && save.mutate({ hoursEnd: e.target.value })} aria-label="End" /></div>
        <div><div className="lbl-sm" style={{ marginBottom: 6 }}>Days off</div><div className="chips">{DAYS.map((d) => (
          <button key={d} className={`chip ${me.daysOff.includes(d) ? 'on' : ''}`} onClick={() => save.mutate({ daysOff: me.daysOff.includes(d) ? me.daysOff.filter((x) => x !== d) : [...me.daysOff, d] })}>{d}</button>
        ))}</div></div>
        <p className="help">Reminders go out {settings.data?.reminderMinutes ?? 10} minutes before each appointment.</p>
      </div></section>
    </>
  );
}

function AdminSide() {
  const team = useTeam();
  const agents = (team.data ?? []).filter((u) => u.role === 'agent');
  return (
    <>
      <section className="panel"><div className="panel-h"><h3>Team hours</h3></div><div className="panel-b"><div className="list">{agents.map((a) => (
        <div className="li" key={a.id}><span className="dot" style={{ background: `var(${colorFor(a.id)})` }} /><div className="grow"><b>{a.name}</b><small>{a.hoursStart}–{a.hoursEnd} · off {a.daysOff.join(', ') || 'none'}</small></div></div>
      ))}</div></div></section>
      <section className="panel"><div className="panel-h"><h3>Booking links</h3></div><div className="panel-b stack" style={{ gap: 8 }}>{agents.map((a) => <div key={a.id}><small className="muted">{a.name}</small><CopyLink url={bookingLink(a.name)} /></div>)}</div></section>
      <section className="panel"><div className="panel-h"><h3>No-shows</h3></div><div className="panel-b"><p className="help">Mark an appointment as a no-show and the lead gets a rebooking text while the agent and you get an alert.</p></div></section>
    </>
  );
}

function ApptModal({ a, onClose }: { a: Appt; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const openLead = useOpenLead();
  const set = useMutation({
    mutationFn: (status: Appt['status']) => api(`/appointments/${a.id}`, { method: 'PATCH', json: { status } }),
    onSuccess: (_r, s) => { qc.invalidateQueries({ queryKey: ['appointments'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); toast(s === 'noshow' ? 'No-show logged. Rebooking text queued; agent and admin alerted.' : 'Appointment updated'); onClose(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not update', 'alert'),
  });
  const status = { scheduled: <Pill color="--info">Upcoming</Pill>, done: <Pill color="--ok">Done</Pill>, noshow: <Pill color="--bad">No-show</Pill>, cancelled: <Pill color="--s9">Cancelled</Pill> }[a.status];
  return (
    <Modal title={a.type} onClose={onClose} footer={<>
      <button className="btn" onClick={() => { onClose(); openLead(a.leadId); }}>Open lead</button>
      <button className="btn danger" onClick={() => set.mutate('noshow')}>Mark no-show</button>
      <button className="btn primary" onClick={() => set.mutate('done')}>Mark done</button>
    </>}>
      <div className="kv"><div><span>Lead</span><b>{a.leadName}</b></div><div><span>When</span><b>{fdt(a.startsAt)}</b></div><div><span>Agent</span><b>{a.agentName}</b></div><div><span>Status</span><b>{status}</b></div></div>
    </Modal>
  );
}

export function BookModal({ onClose, leadId }: { onClose: () => void; leadId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const leads = useQuery({ queryKey: ['leads', 'bookable'], queryFn: () => api<Lead[]>('/leads?limit=500') });
  const options = useMemo(() => (leads.data ?? []).filter((l) => !['won', 'recycled'].includes(l.stage)), [leads.data]);
  const tomorrow10 = new Date(); tomorrow10.setDate(tomorrow10.getDate() + 1); tomorrow10.setHours(10, 0, 0, 0);
  const [f, setF] = useState({ leadId: leadId ?? '', when: toLocalInput(tomorrow10.toISOString()), type: 'Quote review' });
  const save = useMutation({
    mutationFn: () => api('/appointments', { method: 'POST', json: { leadId: f.leadId || options[0]?.id, startsAt: new Date(f.when).toISOString(), type: f.type } }),
    onSuccess: () => { ['appointments', 'lead', 'dashboard', 'notifications'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Appointment booked', 'calendar'); onClose(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not book', 'alert'),
  });
  return (
    <Modal title="New appointment" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={save.isPending || !options.length} onClick={() => save.mutate()}>Book appointment</button></>}>
      <div className="form-grid">
        <div className="field full"><label htmlFor="ap-lead">Lead</label><select id="ap-lead" className="input" value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })}>{options.map((l) => <option key={l.id} value={l.id}>{fullName(l)} · {l.phone}</option>)}</select></div>
        <div className="field"><label htmlFor="ap-when">Date & time</label><input id="ap-when" className="input" type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></div>
        <div className="field"><label htmlFor="ap-type">Type</label><select id="ap-type" className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['Quote review', 'Call-back', 'Policy review', 'Discovery call'].map((t) => <option key={t}>{t}</option>)}</select></div>
      </div>
      <p className="help">Booking stops any automation the lead is in.</p>
    </Modal>
  );
}
