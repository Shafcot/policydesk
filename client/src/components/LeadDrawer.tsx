import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { RESULTS, STAGES, STG, fullName, type CallResult, type LeadDetail, type Stage } from '../lib/domain';
import { ago, dur, fdate, fdateY, fdt, ftime, money, toLocalInput } from '../lib/format';
import { usePublicSettings, useTeam } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';
import { Avatar, Pill, ResultPill } from './ui';
import { WonModal } from './WonModal';
import { Composer } from './Composer';
import { BookModal } from '../pages/Calendar';


/** The lead page. Opens over any screen when the URL has ?lead=<id>, so a lead link can be shared. */
export function LeadDrawer() {
  const [params, setParams] = useSearchParams();
  const id = params.get('lead');
  const close = () => setParams((p) => { p.delete('lead'); return p; });
  useEffect(() => {
    if (!id) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });
  if (!id) return null;
  return (
    <>
      <div className="overlay" onClick={close} />
      <aside className="drawer" role="dialog" aria-label="Lead"><DrawerBody id={id} onClose={close} /></aside>
    </>
  );
}

function DrawerBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { me, isAdmin } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const team = useTeam();
  const [tab, setTab] = useState<'calls' | 'sms' | 'email' | 'notes'>('calls');
  const [won, setWon] = useState(false);
  const [book, setBook] = useState(false);
  const settings = usePublicSettings();
  const { data: l, error, isLoading } = useQuery({ queryKey: ['lead', id], queryFn: () => api<LeadDetail>(`/leads/${id}`) });

  const refresh = () => { ['lead', 'leads', 'dashboard', 'queue'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const onErr = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Something went wrong', 'alert');
  const patch = useMutation({ mutationFn: (body: object) => api(`/leads/${id}`, { method: 'PATCH', json: body }), onSuccess: refresh, onError: onErr });
  const logCall = useMutation({
    mutationFn: (result: CallResult) => api<{ stage: Stage }>(`/leads/${id}/calls`, { method: 'POST', json: { result } }),
    onSuccess: (r, result) => { refresh(); if (result === 'sold') setWon(true); else toast(`Logged “${RESULTS.find((x) => x.k === result)!.n}” → ${STG[r.stage].n}`); },
    onError: onErr,
  });

  if (isLoading) return <div className="drawer-b"><p className="muted">Loading lead…</p></div>;
  if (error || !l) return <div className="drawer-b"><p>{error instanceof ApiError ? error.message : 'Could not load this lead.'}</p><button className="btn" onClick={onClose}>Close</button></div>;

  const canCall = isAdmin || l.agentId === me.id;
  const flags = [!l.email && 'Missing email'].filter(Boolean) as string[];
  const sms = l.messages.filter((m) => m.channel === 'sms');
  const emails = l.messages.filter((m) => m.channel === 'email');

  return (
    <>
      <div className="drawer-h">
        <div className="row between" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <div className="who"><Avatar name={fullName(l)} color={STG[l.stage].c} size="lg" />
            <div><h2>{fullName(l)}</h2><small className="muted">{l.company ? `${l.company} · ` : ''}{l.type === 'commercial' ? 'Commercial' : 'Personal'} · {l.line}</small></div></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className={`owner-note ${l.lockedByName ? 'lock' : ''}`}>
          <Icon name={l.lockedByName ? 'lock' : 'users'} className="sm" />
          {l.lockedByName
            ? <span><b>{l.lockedByName}</b> is on a call with this lead right now. Calling is locked.</span>
            : <span>Owned by <b>{l.agentName ?? 'nobody yet'}</b> · last contact {ago(l.lastContactAt)}{l.lastCallByName ? ` by ${l.lastCallByName}` : ''}. Only the owner can call this lead.</span>}
        </div>
        <div className="row">
          <button className="btn primary" disabled={!canCall || !!l.lockedByName} onClick={() => toast('Live calling connects in Milestone 3 (Twilio). Log the result below for now.', 'phone')}><Icon name="phone" className="sm" />Call {l.phone}</button>
          <button className="btn" onClick={() => setTab('sms')}><Icon name="msg" className="sm" />SMS</button>
          <button className="btn" onClick={() => setTab('email')}><Icon name="mail" className="sm" />Email</button>
          <button className="btn" onClick={() => setBook(true)}><Icon name="calendar" className="sm" />Book</button>
          {l.stage !== 'won' && <button className="btn" onClick={() => setWon(true)}><Icon name="shield" className="sm" />Mark won</button>}
        </div>
      </div>
      <div className="drawer-b">
        {l.optOut && <div className="optout"><Icon name="alert" className="sm" />Opted out (replied STOP). Removed from all SMS, email and automations.</div>}
        {flags.length > 0 && <div className="owner-note" style={{ color: 'var(--warn)' }}><Icon name="flag" className="sm" /><span>{flags.join(' · ')}</span></div>}

        <section className="panel"><div className="panel-h"><h3>Log call result</h3><small className="muted">Updates the stage automatically</small></div>
          <div className="panel-b"><div className="result-grid">
            {RESULTS.map((r) => (
              <button key={r.k} className="result-btn" style={{ ['--c' as string]: `var(${r.c})` }} disabled={!canCall || logCall.isPending} onClick={() => logCall.mutate(r.k)}>{r.n}</button>
            ))}
          </div></div></section>

        <section className="panel"><div className="panel-h"><h3>Details</h3></div><div className="panel-b"><div className="kv">
          <div><span>Stage</span>
            <select className="input" value={l.stage} onChange={(e) => { const v = e.target.value as Stage; if (v === 'won') setWon(true); else patch.mutate({ stage: v }); }}>
              {STAGES.map((s) => <option key={s.k} value={s.k}>{s.n}</option>)}
            </select></div>
          <div><span>Agent</span>
            {isAdmin
              ? <select className="input" value={l.agentId ?? ''} onChange={(e) => patch.mutate({ agentId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {(team.data ?? []).filter((u) => u.role === 'agent').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              : <b>{l.agentName}</b>}</div>
          <div><span>Phone</span><b>{l.phone}</b></div>
          <div><span>Email</span><b>{l.email || <span style={{ color: 'var(--warn)' }}>Missing</span>}</b></div>
          <div><span>Source</span><b>{l.source}</b></div>
          <div><span>Line · type</span><b>{l.line} · {l.type === 'commercial' ? 'Commercial' : 'Personal'}</b></div>
          <div><span>Received</span><b>{fdateY(l.createdAt)} {ftime(l.createdAt)}</b></div>
          <div><span>Call attempts</span><b className="num">{l.attempts}</b></div>
          <div><span>Follow-up</span>
            <input type="datetime-local" className="input" defaultValue={toLocalInput(l.followUpAt)} key={l.followUpAt ?? 'none'}
              onBlur={(e) => { const v = e.target.value; if (v !== toLocalInput(l.followUpAt)) patch.mutate({ followUpAt: v ? new Date(v).toISOString() : null }); }} /></div>
          <div><span>Quoted premium</span><b className="num">{l.quotePremium ? `${money(l.quotePremium)}/yr` : '—'}</b></div>
        </div></div></section>

        <section className="panel"><div className="panel-h"><h3>Custom fields</h3></div><div className="panel-b"><div className="kv">
          {(settings.data?.customFields ?? []).map((cf) => (
            <div key={cf.key}><span>{cf.label}</span>
              <input className="input" type={cf.type} defaultValue={l.custom[cf.key] ?? ''} onBlur={(e) => { if (e.target.value !== (l.custom[cf.key] ?? '')) patch.mutate({ custom: { [cf.key]: e.target.value } }); }} /></div>
          ))}
        </div></div></section>

        <section className="panel"><div className="panel-h"><h3>Automation</h3></div><div className="panel-b row between">
          {l.automation
            ? <><span><Icon name="zap" className="sm" /> In <b>{l.automation}</b>. Stops when the lead replies, books, or is won/lost.</span><button className="btn sm" onClick={() => patch.mutate({ automation: null })}>Remove</button></>
            : <span className="muted">Not in an automation.</span>}
        </div></section>

        <div className="grid g2">
          <section className="panel"><div className="panel-h"><h3>Appointments</h3></div><div className="panel-b"><div className="list">
            {l.appointments.slice(0, 4).map((a) => <div className="li" key={a.id}><div className="grow"><b>{a.type}</b><small>{fdt(a.startsAt)}</small></div>
              <Pill color={a.status === 'noshow' ? '--bad' : a.status === 'done' ? '--ok' : '--info'}>{{ scheduled: 'Upcoming', done: 'Done', noshow: 'No-show', cancelled: 'Cancelled' }[a.status]}</Pill></div>)}
            {!l.appointments.length && <p className="muted">None</p>}
          </div></div></section>
          <section className="panel"><div className="panel-h"><h3>Policies</h3></div><div className="panel-b"><div className="list">
            {l.policies.map((p) => <div className="li" key={p.id}><div className="grow"><b>{p.line} · {p.carrier}</b><small className="num">{p.policyNumber} · renews {fdate(p.renewalDate)}</small></div><b className="num">{money(p.premium)}</b></div>)}
            {!l.policies.length && <p className="muted">No policies yet</p>}
          </div></div></section>
        </div>

        <section className="panel">
          <div className="tabs" style={{ padding: '0 8px' }}>
            {([['calls', 'Calls', l.calls.length], ['sms', 'SMS', sms.length], ['email', 'Email', emails.length], ['notes', 'Notes', l.notes.length]] as const).map(([k, n, c]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n} <span className="muted">{c}</span></button>
            ))}
          </div>
          <div className="panel-b" style={{ paddingTop: 14 }}>
            {tab === 'calls' && (
              <div className="stack" style={{ gap: 10 }}>
                {l.calls.map((c) => (
                  <div className="call-item" key={c.id}>
                    <div className="row between"><div className="row"><ResultPill result={c.result} /><small className="muted">{fdt(c.startedAt)} · {dur(c.durationSec)} · {c.userName ?? 'Unknown'}</small></div></div>
                    {c.recordingUrl ? <audio controls src={c.recordingUrl} style={{ width: '100%' }} /> : <small className="faint">Recording appears here once calling is connected (Milestone 3).</small>}
                    {c.summary && <div className="summary"><b><Icon name="bot" className="sm" /> Summary</b><p>{c.summary}</p></div>}
                    {c.notes && <p><small className="muted">Notes:</small> {c.notes}</p>}
                  </div>
                ))}
                {!l.calls.length && <p className="muted">No calls yet.</p>}
              </div>
            )}
            {(tab === 'sms' || tab === 'email') && (
              <>
                <div className="thread">
                  {(tab === 'sms' ? sms : emails).map((m) => (
                    <div key={m.id} className={`bubble ${m.direction} ${tab === 'email' ? 'email' : ''}`}>
                      {m.subject && <span className="subj">{m.subject}</span>}{m.body}<small>{fdt(m.createdAt)}{m.automated ? ' · automation' : ''}{m.status === 'queued' ? ' · queued' : ''}</small>
                    </div>
                  ))}
                  {!(tab === 'sms' ? sms : emails).length && <p className="muted">No messages yet.</p>}
                </div>
                <div style={{ marginTop: 12 }}><Composer lead={l} channel={tab} /></div>
              </>
            )}
            {tab === 'notes' && <Notes lead={l} />}
          </div>
        </section>
      </div>
      {won && <WonModal lead={l} onClose={() => setWon(false)} />}
      {book && <BookModal leadId={l.id} onClose={() => setBook(false)} />}
    </>
  );
}

function Notes({ lead }: { lead: LeadDetail }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => api(`/leads/${lead.id}/notes`, { method: 'POST', json: { body: text } }),
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['lead', lead.id] }); },
  });
  return (
    <>
      <div className="composer">
        <textarea className="input" placeholder="Add a note…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Note" />
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary sm" disabled={!text.trim() || add.isPending} onClick={() => add.mutate()}>Add note</button></div>
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        {lead.notes.map((n) => <div className="li" key={n.id} style={{ alignItems: 'flex-start' }}><div className="grow"><small>{n.userName ?? 'System'} · {fdt(n.createdAt)}</small><p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p></div></div>)}
      </div>
    </>
  );
}
