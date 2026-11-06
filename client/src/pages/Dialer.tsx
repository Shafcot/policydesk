import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { useCalls, useTick } from '../lib/calls';
import { BAD_REASONS, MAIN_RESULTS, QUOTE_RESULTS, STG, fullName, isBlockingBad, type Lead } from '../lib/domain';
import { ago, dur, ftime, pct } from '../lib/format';
import { usePublicSettings, type CallScript } from '../lib/hooks';
import { useOpenLead } from '../lib/leadLink';
import { Icon } from '../components/Icon';
import { Avatar, Bar, Modal, PageHead, StagePill } from '../components/ui';
import { SpeedDial } from '../components/SpeedDial';
import { WonModal } from '../components/WonModal';
import { DialPad } from '../components/DialPad';
import { NewLeadModal } from '../components/NewLeadModal';
import { CallControls, LiveCalls, callName, pretty, stateText } from '../components/CallBar';

const BUCKETS = [['new', 'New leads'], ['callback', 'Requested call-backs'], ['followup', 'Follow-ups due today'], ['retry', 'No-answer retries']] as const;
const LABEL = { new: 'New lead', callback: 'Call-back', followup: 'Follow-up', retry: 'Retry' };

/**
 * Power dialer. Calls go through the browser when Twilio is connected; otherwise the agent dials on their own phone
 * and the app times the call. The call itself lives in the app-wide call manager (see lib/calls.tsx).
 */
export function Dialer() {
  const { me, isAdmin } = useMe();
  const c = useCalls();
  const openLead = useOpenLead();
  const settings = usePublicSettings();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ callsToday: number }>('/dashboard') });
  const [speed, setSpeed] = useState(false);
  const [pad, setPad] = useState(false);
  const [padErr, setPadErr] = useState('');
  const [padBusy, setPadBusy] = useState(false);
  const [saveLead, setSaveLead] = useState(false);
  const a = c.active;
  useTick(!!a && !a.endedAt && !!a.startedAt);

  // Speed dial from the top bar lands here with ?call=<leadId>.
  const [params, setParams] = useSearchParams();
  const callId = params.get('call');
  const dialParam = params.get('dial');
  useEffect(() => {
    if (!dialParam || a) return;
    setParams((p) => { p.delete('dial'); return p; }, { replace: true });
    void c.callNumber(dialParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialParam]);
  useEffect(() => {
    if (!callId || a) return;
    setParams((p) => { p.delete('call'); return p; }, { replace: true });
    api<Lead>(`/leads/${callId}`).then((l) => c.callLead(l)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  const st = settings.data;
  const calls = dash.data?.callsToday ?? 0;
  const items = c.queue;
  const dial = async (n: string) => { setPadBusy(true); setPadErr(''); const e = await c.callNumber(n); setPadBusy(false); if (e) setPadErr(e); else setPad(false); };
  const lead = a?.lead ?? null;
  return (
    <>
      <PageHead title="Dialer" sub="Queue order: new leads → requested call-backs → follow-ups due today → no-answer retries."
        actions={<>
          <button className="btn" disabled={!!a} onClick={() => { setPadErr(''); setPad(true); }}><Icon name="phone" className="sm" />Dial pad</button>
          <button className="btn" onClick={() => setSpeed(true)}><Icon name="grid" className="sm" />Speed dial</button>
        </>} />
      <div className="dialer">
        <div className="stack">
          <section className="panel dial-stage">
            {!a ? (
              <div className="dial-idle">
                <div className="ring"><Icon name="phone" /></div>
                <h2>{c.auto ? 'Loading next lead…' : 'Power dialer'}</h2>
                <p className="muted" style={{ maxWidth: 440 }}>Loads the next lead, locks it so no one else calls it, and times the call. Pick a result and the next lead loads automatically. Use the dial pad to call any number.</p>
                {c.auto
                  ? <button className="btn lg" onClick={() => c.setAuto(false)}><Icon name="pause" className="sm" />Pause dialing</button>
                  : <button className="btn accent lg" disabled={!items.length} onClick={() => c.setAuto(true)}><Icon name="play" className="sm fill" />Start dialing · {items.length} in queue</button>}
                {!isAdmin && <div style={{ width: 'min(360px,100%)' }}><div className="row between"><small className="muted">Calls today</small><small className="num">{calls} · min {me.minCallsPerDay} · max {me.maxCallsPerDay}</small></div><Bar value={pct(calls, me.maxCallsPerDay)} /></div>}
                {c.voiceReady && <small className="help">Calling from {me.twilioNumber ? pretty(me.twilioNumber) : 'the agency’s default number'}</small>}
              </div>
            ) : (
              <>
                <div className="row between">
                  <div className="live-lead">{lead ? <Avatar name={fullName(lead)} color={STG[lead.stage].c} size="lg" /> : <div className="ring sm"><Icon name="phone" /></div>}
                    <div><h2 className={lead ? '' : 'mono'}>{callName(a)}</h2><span className="muted">{lead ? `${lead.line} · ${lead.type === 'commercial' ? 'Commercial' : 'Personal'}${lead.company ? ` · ${lead.company}` : ''}` : a.direction === 'in' ? 'Incoming call · not a lead yet' : 'Dial pad · not a lead yet'}{a.transferFrom ? ` · transferred by ${a.transferFrom}` : ''}</span></div></div>
                  {lead && <StagePill stage={lead.stage} />}
                </div>
                <div className="row between">
                  {a.state === 'manual'
                    ? <div className="call-state connected"><span className="pulse" />Dial <a className="mono" style={{ fontSize: 20 }} href={`tel:${a.number}`}>{pretty(a.number)}</a></div>
                    : <div className={`call-state ${a.state === 'connected' ? 'connected' : ''}`}>{a.state !== 'ended' && <span className="pulse" />}{stateText(a)}{a.state !== 'ended' && <span className="mono muted">{pretty(a.number)}</span>}</div>}
                  <div className="row">{a.state === 'connected' && a.live && <span className="rec">RECORDING</span>}<span className="call-timer">{dur(c.elapsed())}</span></div>
                </div>
                <CallControls compact />
                {a.state === 'manual' && <p className="help">Browser calling turns on when Twilio is connected. Until then, dial from your phone and log the result here.</p>}
                {lead ? <>
                  <ScriptPanel lead={lead} first={lead.attempts === 0} scripts={st?.callScripts} />
                  <div className="kv">
                    <div><span>Source</span><b>{lead.source}</b></div>
                    <div><span>Attempt</span><b className="num">{lead.attempts + 1} of {st?.maxAttempts ?? '—'}</b></div>
                    <div><span>Current carrier</span><b>{lead.custom.carrier || '—'}</b></div>
                    <div><span>Last call</span><b>{lead.lastAttemptAt ? ago(lead.lastAttemptAt) : 'First call'}</b></div>
                  </div>
                  <div className="field"><label htmlFor="call-note">Call notes</label><textarea id="call-note" className="input" value={c.note} onChange={(e) => c.setNote(e.target.value)} placeholder="Saved to the lead with the call" /></div>
                  <div>
                    <div className="lbl-sm" style={{ marginBottom: 6 }}>Call result → updates the stage{c.auto ? ' and loads the next lead' : ''}</div>
                    <div className="result-grid six">{MAIN_RESULTS.map((r) => <button key={r.k} className="result-btn" style={{ ['--c' as string]: `var(${r.c})` }} onClick={() => void c.logResult(r.k)}>{r.n}</button>)}</div>
                    <div className="row" style={{ marginTop: 6, gap: 6 }}><small className="muted">Quote stage:</small>{QUOTE_RESULTS.map((r) => <button key={r.k} className="btn sm ghost" onClick={() => void c.logResult(r.k)}>{r.n}</button>)}</div>
                    <div className="row bad-row" style={{ marginTop: 6, gap: 6 }}><small className="muted">Bad lead:</small>{BAD_REASONS.map((r) => (
                      <button key={r.k} className="btn sm ghost" title={r.hint}
                        onClick={() => { if (!isBlockingBad(r.k) || window.confirm(`Mark ${fullName(lead)} as ${r.n}? Calls, texts and emails to this lead will be blocked.`)) void c.logResult(isBlockingBad(r.k) ? 'lost' : 'no_answer', r.k); }}>{r.n}</button>
                    ))}</div>
                  </div>
                  <div className="row">
                    <button className="btn ghost" onClick={() => openLead(lead.id)}>Open lead page</button>
                    {c.auto && <button className="btn ghost" onClick={() => c.setAuto(false)}><Icon name="pause" className="sm" />Pause after this call</button>}
                  </div>
                </> : a.state === 'ended' || a.state === 'manual' ? <>
                  <p className="help">Save this number as a lead to log the call (and its recording) and follow up. Otherwise the call isn’t saved.</p>
                  <div className="row">
                    <button className="btn primary" onClick={() => setSaveLead(true)}><Icon name="userplus" className="sm" />Save as new lead</button>
                    {a.state === 'ended' && <button className="btn ghost" onClick={c.dismiss}>Done, don’t save</button>}
                  </div>
                </> : <ScriptPanel lead={null} first scripts={st?.callScripts} />}
              </>
            )}
          </section>
          {isAdmin && <LiveCalls />}
          <Voicemails onCall={(n) => void dial(n)} />
          <section className="panel"><div className="panel-h"><h3>Call schedule</h3></div><div className="panel-b">
            <div className="kv"><div><span>Day 1 attempts</span><b className="num">{st?.attemptsDay1 ?? '—'}</b></div><div><span>Then per day</span><b className="num">{st?.attemptsPerDay ?? '—'}</b></div><div><span>Max attempts before Recycled</span><b className="num">{st?.maxAttempts ?? '—'}</b></div><div><span>Retry gap</span><b className="num">{st ? `${st.retryHours}h` : '—'}</b></div></div>
            <p className="help" style={{ marginTop: 10 }}>Unreached numbers go back in the queue next shift. New leads jump to the front of the queue.</p>
          </div></section>
        </div>
        <section className="panel">
          <div className="panel-h"><h2>Queue</h2><small className="muted">{items.length} leads</small></div>
          {BUCKETS.map(([k, n]) => {
            const list = items.filter((x) => x.bucket === k);
            return (
              <div key={k}>
                <div className="q-bucket"><span>{n}</span><span>{list.length}</span></div>
                {list.slice(0, 8).map((x) => (
                  <div key={x.lead.id} className={`q-item ${items[0] === x ? 'next' : ''}`}>
                    <div className="grow" style={{ cursor: 'pointer' }} onClick={() => openLead(x.lead.id)}><b>{fullName(x.lead)}</b><small>{LABEL[x.bucket]}{x.bucket === 'callback' && x.lead.followUpAt ? ` ${ftime(x.lead.followUpAt)}` : ''} · {x.lead.line}</small></div>
                    {items[0] === x && <span className="tag">Next</span>}
                    <button className="icon-btn call sm" disabled={!!a || c.busy} onClick={() => void c.callLead(x.lead)} aria-label={`Call ${fullName(x.lead)}`}><Icon name="phone" className="sm" /></button>
                  </div>
                ))}
                {list.length > 8 && <div className="q-item"><small className="muted">+{list.length - 8} more</small></div>}
              </div>
            );
          })}
        </section>
      </div>
      {speed && <SpeedDial onClose={() => setSpeed(false)} onCall={(l) => { setSpeed(false); if (!a) void c.callLead(l); }} onDial={(n) => { setSpeed(false); if (!a) void dial(n); }} />}
      {pad && <Modal title="Dial pad" onClose={() => setPad(false)}>
        <DialPad busy={padBusy} error={padErr} onCall={(n) => void dial(n)} callingFrom={c.voiceReady ? me.twilioNumber ?? null : undefined} />
        {!c.voiceReady && <p className="help" style={{ textAlign: 'center', marginTop: 8 }}>Browser calling isn’t connected yet. You’ll dial from your own phone and the call is timed here.</p>}
      </Modal>}
      {saveLead && a && <NewLeadModal initial={{ phone: pretty(a.number) }} assignToMe note="The lead is added to your leads. Then pick the call result to log this call."
        onClose={() => setSaveLead(false)} onCreated={(l) => { setSaveLead(false); c.attachLead(l); }} />}
      {c.won && <WonModal lead={c.won} onClose={c.clearWon} />}
    </>
  );
}

const fillScript = (t: string, lead: Lead | null, agent: string, agency: string) =>
  t.replaceAll('{first}', lead?.firstName ?? 'there').replaceAll('{agent}', agent.split(' ')[0]).replaceAll('{agency}', agency).replaceAll('{line}', lead?.line ?? 'insurance');

/** Opening script + objection answers for the lead's policy type. Open on the first call, collapsed after. */
function ScriptPanel({ lead, first, scripts }: { lead: Lead | null; first: boolean; scripts?: Record<string, CallScript> }) {
  const { me } = useMe();
  const { agency } = useAuth();
  const [open, setOpen] = useState(first);
  const [obj, setObj] = useState<number | null>(null);
  useEffect(() => { setOpen(first); setObj(null); }, [lead?.id, first]);
  const s = (lead && scripts?.[lead.line]) || scripts?.['*'];
  if (!s || (!s.opening && !s.objections.length)) return null;
  const agencyName = agency?.name ?? 'our agency';
  return (
    <div className={`script ${open ? 'open' : ''}`}>
      <button className="script-h" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="file" className="sm" /><b>Call script{lead && scripts?.[lead.line] ? ` · ${lead.line}` : ''}</b>{first && <span className="tag">First call</span>}<Icon name="left" className="sm chev" />
      </button>
      {open && <div className="script-b">
        {s.opening && <p className="script-open">{fillScript(s.opening, lead, me.name, agencyName)}</p>}
        {s.objections.length > 0 && <>
          <div className="lbl-sm">If they say…</div>
          <div className="chips">{s.objections.map((o, i) => <button key={i} type="button" className={`chip ${obj === i ? 'on' : ''}`} onClick={() => setObj(obj === i ? null : i)}>{o.q}</button>)}</div>
          {obj !== null && s.objections[obj] && <p className="script-answer">{fillScript(s.objections[obj].a, lead, me.name, agencyName)}</p>}
        </>}
      </div>}
    </div>
  );
}

type Voicemail = { id: string; fromNumber: string; leadId: string | null; leadName: string | null; userName: string | null; durationSec: number; heardAt: string | null; createdAt: string; audio: string };

function Voicemails({ onCall }: { onCall: (n: string) => void }) {
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const q = useQuery({ queryKey: ['voicemails'], queryFn: () => api<Voicemail[]>('/voicemails') });
  const heard = useMutation({ mutationFn: (id: string) => api(`/voicemails/${id}`, { method: 'PATCH' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['voicemails'] }) });
  const list = q.data ?? [];
  if (!list.length) return null;
  const fresh = list.filter((v) => !v.heardAt).length;
  return (
    <section className="panel">
      <div className="panel-h"><h3>Voicemails</h3>{fresh > 0 && <span className="tag">{fresh} new</span>}</div>
      <div className="list">{list.slice(0, 6).map((v) => (
        <div className={`li ${v.heardAt ? '' : 'unread'}`} key={v.id}>
          <div className="grow"><b>{v.leadName ?? pretty(v.fromNumber)}</b><small>{ago(v.createdAt)} · {dur(v.durationSec)}{isAdmin ? ` · for ${v.userName ?? 'the agency'}` : ''}</small>
            <audio controls preload="none" src={v.audio} style={{ width: '100%', marginTop: 6 }} onPlay={() => !v.heardAt && heard.mutate(v.id)} /></div>
          <button className="icon-btn call sm" onClick={() => onCall(v.fromNumber)} aria-label={`Call back ${v.leadName ?? v.fromNumber}`}><Icon name="phone" className="sm" /></button>
        </div>
      ))}</div>
    </section>
  );
}
