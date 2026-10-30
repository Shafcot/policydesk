import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { RESULTS, STG, fullName, type CallResult, type Lead, type Stage } from '../lib/domain';
import { ago, dur, ftime, pct } from '../lib/format';
import { usePublicSettings } from '../lib/hooks';
import { useOpenLead } from '../lib/leadLink';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Avatar, Bar, PageHead, StagePill } from '../components/ui';
import { SpeedDial } from '../components/SpeedDial';
import { useVoice } from '../lib/voice';
import type { Call } from '@twilio/voice-sdk';
import { WonModal } from '../components/WonModal';
import { DialPad, Keypad } from '../components/DialPad';
import { NewLeadModal } from '../components/NewLeadModal';
import { Modal } from '../components/ui';

type QueueItem = { bucket: 'new' | 'callback' | 'followup' | 'retry'; lead: Lead };
const BUCKETS: [QueueItem['bucket'], string][] = [['new', 'New leads'], ['callback', 'Requested call-backs'], ['followup', 'Follow-ups due today'], ['retry', 'No-answer retries']];
const LABEL = { new: 'New lead', callback: 'Call-back', followup: 'Follow-up', retry: 'Retry' };

/**
 * Power dialer. Until Twilio is connected (Milestone 3) the agent dials on their own phone:
 * the app picks the next lead in SOW order, locks it, times the call and logs the result.
 */
export function Dialer() {
  const { me, isAdmin } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const openLead = useOpenLead();
  const settings = usePublicSettings();
  const queue = useQuery({ queryKey: ['queue'], queryFn: () => api<QueueItem[]>('/leads/queue/mine'), refetchInterval: 30_000 });
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ callsToday: number }>('/dashboard') });
  const [current, setCurrent] = useState<Lead | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState('');
  const [auto, setAuto] = useState(false);
  const [speed, setSpeed] = useState(false);
  const [won, setWon] = useState<Lead | null>(null);
  const autoRef = useRef(auto); autoRef.current = auto;
  const voice = useVoice();
  const callRef = useRef<Call | null>(null);
  const [callState, setCallState] = useState<'ringing' | 'connected' | 'ended' | null>(null);
  const [muted, setMuted] = useState(false);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  // Dial pad: a typed number that isn't one of the agent's leads.
  const [pad, setPad] = useState(false);
  const [padErr, setPadErr] = useState('');
  const [manual, setManual] = useState<{ number: string } | null>(null);
  const [saveLead, setSaveLead] = useState(false);
  const [tones, setTones] = useState(false);

  useEffect(() => { if (!startedAt || endedAt) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [startedAt, endedAt]);
  const elapsed = startedAt ? ((endedAt ?? now) - startedAt) / 1000 : 0;
  const busyCall = !!current || !!manual;

  const items = (queue.data ?? []).filter((x) => x.lead.id !== current?.id);
  const onErr = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Something went wrong', 'alert');

  /** Follows a Twilio call: the timer starts when answered and stops when it ends. */
  const track = (call: Call) => {
    callRef.current = call;
    call.on('accept', () => { setCallState('connected'); setStartedAt(Date.now()); setNow(Date.now()); });
    const end = () => { setCallState('ended'); setTones(false); setEndedAt((x) => x ?? Date.now()); };
    call.on('disconnect', end); call.on('cancel', end); call.on('reject', end);
    call.on('error', (e: { message?: string }) => { end(); toast(`Call error: ${e.message ?? 'unknown'}`, 'alert'); });
  };
  const resetCall = () => { setCurrent(null); setManual(null); setStartedAt(null); setEndedAt(null); setCallState(null); setTones(false); callRef.current = null; };

  const begin = useMutation({
    mutationFn: (l: Lead) => api(`/leads/${l.id}/lock`, { method: 'POST' }).then(() => l),
    onSuccess: async (l) => {
      setCurrent(l); setNote(''); setMuted(false); setEndedAt(null);
      if (!voice.ready) { setStartedAt(Date.now()); setNow(Date.now()); setCallState(null); return; }
      // Live call through Twilio: the timer starts when the lead answers.
      setStartedAt(null); setCallState('ringing');
      try { track(await voice.connect(l.id)); } catch (e) { setCallState('ended'); onErr(e); }
    },
    onError: onErr,
  });
  const hangUp = () => { callRef.current?.disconnect(); setCallState('ended'); setEndedAt((x) => x ?? Date.now()); };

  // Dial pad → the agent's own lead (normal lead call), someone else's lead (blocked), or a new number.
  const dialNumber = useMutation({
    mutationFn: (typed: string) => api<{ valid: boolean; number?: string; lead: Lead | null; blocked?: string }>(`/dialpad/lookup?phone=${encodeURIComponent(typed)}`),
    onSuccess: async (r) => {
      if (!r.valid || !r.number) return setPadErr('That phone number isn’t valid.');
      if (r.blocked) return setPadErr(r.blocked);
      setPad(false); setPadErr('');
      if (r.lead) { toast(`That’s ${fullName(r.lead)}, one of your leads`); begin.mutate(r.lead); return; }
      setManual({ number: r.number }); setNote(''); setMuted(false); setEndedAt(null);
      if (!voice.ready) { setStartedAt(Date.now()); setNow(Date.now()); setCallState(null); return; }
      setStartedAt(null); setCallState('ringing');
      try { track(await voice.connectNumber(r.number)); } catch (e) { setCallState('ended'); onErr(e); }
    },
    onError: (e) => setPadErr(e instanceof ApiError ? e.message : 'Could not check that number'),
  });
  const finish = useMutation({
    mutationFn: (result: CallResult) => {
      const callSid = callRef.current?.parameters?.CallSid;
      if (callRef.current && callState !== 'ended') callRef.current.disconnect();
      return api<Lead & { stage: Stage }>(`/leads/${current!.id}/calls`, { method: 'POST', json: { result, durationSec: Math.round(elapsed), notes: note.trim() || undefined, ...(callSid ? { callSid } : {}) } });
    },
    onSuccess: (l, result) => {
      ['queue', 'dashboard', 'leads', 'lead'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (result === 'sold') { setWon(l); setAuto(false); } else toast(`${fullName(l)} → ${STG[l.stage].n}`);
      resetCall();
    },
    onError: onErr,
  });

  // Power mode: when the previous call is logged, load and start the next lead automatically.
  useEffect(() => {
    if (!auto || current || manual || begin.isPending || finish.isPending || !queue.data) return;
    const next = (queue.data ?? [])[0];
    if (!next) { setAuto(false); toast('Queue is empty. Unreached numbers return next shift.'); return; }
    const t = setTimeout(() => { if (autoRef.current) begin.mutate(next.lead); }, 900);
    return () => clearTimeout(t);
  }, [auto, current, manual, queue.data, begin, finish.isPending, toast]);

  // Speed dial from the top bar lands here with ?call=<leadId>.
  const [params, setParams] = useSearchParams();
  const callId = params.get('call');
  useEffect(() => {
    if (!callId || current) return;
    setParams((p) => { p.delete('call'); return p; }, { replace: true });
    api<Lead>(`/leads/${callId}`).then((l) => begin.mutate(l)).catch(onErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  const st = settings.data;
  const calls = dash.data?.callsToday ?? 0;
  return (
    <>
      <PageHead title="Dialer" sub="Queue order: new leads → requested call-backs → follow-ups due today → no-answer retries."
        actions={<>
          <button className="btn" disabled={busyCall} onClick={() => { setPadErr(''); setPad(true); }}><Icon name="phone" className="sm" />Dial pad</button>
          <button className="btn" onClick={() => setSpeed(true)}><Icon name="grid" className="sm" />Speed dial</button>
        </>} />
      <div className="dialer">
        <div className="stack">
          <section className="panel dial-stage">
            {manual && !current ? (
              <ManualCall number={manual.number} state={callState} elapsed={elapsed} muted={muted} tones={tones} live={voice.ready}
                onHangUp={hangUp} onMute={() => { callRef.current?.mute(!muted); setMuted(!muted); }} onTones={() => setTones(!tones)} onDigit={(d) => callRef.current?.sendDigits(d)}
                onEndManual={() => { setCallState('ended'); setEndedAt(Date.now()); }} onSave={() => setSaveLead(true)} onDone={resetCall} />
            ) : !current ? (
              <div className="dial-idle">
                <div className="ring"><Icon name="phone" /></div>
                <h2>{auto ? 'Loading next lead…' : 'Power dialer'}</h2>
                <p className="muted" style={{ maxWidth: 440 }}>Loads the next lead, locks it so no one else calls it, and times the call. Pick a result and the next lead loads automatically. Use the dial pad to call any number.</p>
                {auto
                  ? <button className="btn lg" onClick={() => setAuto(false)}><Icon name="pause" className="sm" />Pause dialing</button>
                  : <button className="btn accent lg" disabled={!items.length} onClick={() => setAuto(true)}><Icon name="play" className="sm fill" />Start dialing · {items.length} in queue</button>}
                {!isAdmin && <div style={{ width: 'min(360px,100%)' }}><div className="row between"><small className="muted">Calls today</small><small className="num">{calls} · min {me.minCallsPerDay} · max {me.maxCallsPerDay}</small></div><Bar value={pct(calls, me.maxCallsPerDay)} /></div>}
              </div>
            ) : (
              <>
                <div className="row between">
                  <div className="live-lead"><Avatar name={fullName(current)} color={STG[current.stage].c} size="lg" /><div><h2>{fullName(current)}</h2><span className="muted">{current.line} · {current.type === 'commercial' ? 'Commercial' : 'Personal'}{current.company ? ` · ${current.company}` : ''}</span></div></div>
                  <StagePill stage={current.stage} />
                </div>
                <div className="row between">
                  {callState
                    ? <div className={`call-state ${callState === 'connected' ? 'connected' : ''}`}><span className="pulse" />{{ ringing: 'Ringing…', connected: 'Connected', ended: 'Call ended — pick a result' }[callState]} <span className="mono muted">{current.phone}</span></div>
                    : <div className="call-state connected"><span className="pulse" />Dial <span className="mono" style={{ fontSize: 20 }}>{current.phone}</span></div>}
                  <div className="row">{callState === 'connected' && <span className="rec">RECORDING</span>}<span className="call-timer">{dur(elapsed)}</span></div>
                </div>
                {callState && callState !== 'ended' && <div className="row">
                  <button className="btn danger" onClick={hangUp}><Icon name="hang" className="sm" />Hang up</button>
                  <button className="btn" onClick={() => { callRef.current?.mute(!muted); setMuted(!muted); }}>{muted ? 'Unmute' : 'Mute'}</button>
                  {callState === 'connected' && <button className={`btn ${tones ? 'primary' : ''}`} onClick={() => setTones(!tones)}><Icon name="grid" className="sm" />Keypad</button>}
                </div>}
                {tones && callState === 'connected' && <Keypad compact onKey={(d) => callRef.current?.sendDigits(d)} />}
                {!callState && <p className="help">Browser calling turns on when Twilio is connected. Until then, dial from your phone and log the result here.</p>}
                <div className="kv">
                  <div><span>Source</span><b>{current.source}</b></div>
                  <div><span>Attempt</span><b className="num">{current.attempts + 1} of {st?.maxAttempts ?? '—'}</b></div>
                  <div><span>Current carrier</span><b>{current.custom.carrier || '—'}</b></div>
                  <div><span>Last call</span><b>{current.lastAttemptAt ? ago(current.lastAttemptAt) : 'First call'}</b></div>
                </div>
                <div className="field"><label htmlFor="call-note">Call notes</label><textarea id="call-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Saved to the lead with the call" /></div>
                <div>
                  <div className="lbl-sm" style={{ marginBottom: 6 }}>Call result → updates the stage{auto ? ' and loads the next lead' : ''}</div>
                  <div className="result-grid">{RESULTS.map((r) => <button key={r.k} className="result-btn" style={{ ['--c' as string]: `var(${r.c})` }} disabled={finish.isPending} onClick={() => finish.mutate(r.k)}>{r.n}</button>)}</div>
                </div>
                <div className="row">
                  <button className="btn ghost" onClick={() => openLead(current.id)}>Open lead page</button>
                  {auto && <button className="btn ghost" onClick={() => setAuto(false)}><Icon name="pause" className="sm" />Pause after this call</button>}
                </div>
              </>
            )}
          </section>
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
                    <button className="icon-btn call sm" disabled={!!current} onClick={() => begin.mutate(x.lead)} aria-label={`Call ${fullName(x.lead)}`}><Icon name="phone" className="sm" /></button>
                  </div>
                ))}
                {list.length > 8 && <div className="q-item"><small className="muted">+{list.length - 8} more</small></div>}
              </div>
            );
          })}
        </section>
      </div>
      {pad && <Modal title="Dial pad" onClose={() => setPad(false)}>
        <DialPad busy={dialNumber.isPending} error={padErr} onCall={(n) => { setPadErr(''); dialNumber.mutate(n); }} callingFrom={voice.ready ? me.twilioNumber ?? null : undefined} />
        {!voice.ready && <p className="help" style={{ textAlign: 'center', marginTop: 8 }}>Browser calling isn’t connected yet. You’ll dial from your own phone and the call is timed here.</p>}
      </Modal>}
      {saveLead && manual && <NewLeadModal initial={{ phone: manual.number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') }} assignToMe note="The lead is added to your leads. Then pick the call result to log this call."
        onClose={() => setSaveLead(false)}
        onCreated={(l) => { setSaveLead(false); setManual(null); setCurrent(l); setCallState((s) => s ?? 'ended'); qc.invalidateQueries({ queryKey: ['queue'] }); }} />}
      {speed && <SpeedDial onClose={() => setSpeed(false)} onCall={(l) => { setSpeed(false); if (!busyCall) begin.mutate(l); }} />}
      {won && <WonModal lead={won} onClose={() => setWon(null)} />}
    </>
  );
}

/** A dial-pad call to a number that isn't a lead yet. */
function ManualCall({ number, state, elapsed, muted, tones, live, onHangUp, onMute, onTones, onDigit, onEndManual, onSave, onDone }: {
  number: string; state: 'ringing' | 'connected' | 'ended' | null; elapsed: number; muted: boolean; tones: boolean; live: boolean;
  onHangUp: () => void; onMute: () => void; onTones: () => void; onDigit: (d: string) => void; onEndManual: () => void; onSave: () => void; onDone: () => void;
}) {
  const pretty = number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
  const ended = state === 'ended';
  return (
    <>
      <div className="row between">
        <div className="live-lead"><div className="ring sm"><Icon name="phone" /></div><div><h2 className="mono">{pretty}</h2><span className="muted">Dial pad · not a lead yet</span></div></div>
      </div>
      <div className="row between">
        {live || ended
          ? <div className={`call-state ${state === 'connected' ? 'connected' : ''}`}><span className="pulse" />{{ ringing: 'Ringing…', connected: 'Connected', ended: 'Call ended' }[state ?? 'ended']}</div>
          : <div className="call-state connected"><span className="pulse" />Dial <a className="mono" style={{ fontSize: 20 }} href={`tel:${number}`}>{pretty}</a> from your phone</div>}
        <div className="row">{state === 'connected' && <span className="rec">RECORDING</span>}<span className="call-timer">{dur(elapsed)}</span></div>
      </div>
      {!ended && <div className="row">
        {live ? <>
          <button className="btn danger" onClick={onHangUp}><Icon name="hang" className="sm" />Hang up</button>
          <button className="btn" onClick={onMute}>{muted ? 'Unmute' : 'Mute'}</button>
          {state === 'connected' && <button className={`btn ${tones ? 'primary' : ''}`} onClick={onTones}><Icon name="grid" className="sm" />Keypad</button>}
        </> : <button className="btn danger" onClick={onEndManual}><Icon name="hang" className="sm" />End call</button>}
      </div>}
      {tones && state === 'connected' && <Keypad compact onKey={onDigit} />}
      {ended && <>
        <p className="help">Save this number as a lead to log the call (and its recording) and follow up. Otherwise the call isn’t saved.</p>
        <div className="row">
          <button className="btn primary" onClick={onSave}><Icon name="userplus" className="sm" />Save as new lead</button>
          <button className="btn ghost" onClick={onDone}>Done, don’t save</button>
        </div>
      </>}
    </>
  );
}
