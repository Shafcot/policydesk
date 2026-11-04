// Call UI shared across pages: the floating call bar (stays on screen while browsing), the incoming-call banner,
// in-call controls, the transfer picker and the admin's live-calls list (listen in / whisper).
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCalls, useTick, type ActiveCall } from '../lib/calls';
import { fullName } from '../lib/domain';
import { dur } from '../lib/format';
import { Icon } from './Icon';
import { Keypad } from './DialPad';
import { Modal, Pill } from './ui';

export const pretty = (n: string) => n.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
export const callName = (a: Pick<ActiveCall, 'lead' | 'number'>) => (a.lead ? fullName(a.lead) : pretty(a.number));

export function stateText(a: ActiveCall) {
  if (a.handedOff) return 'Transferred. Log the result';
  if (a.transfer?.state === 'ringing') return `${a.transfer.mode === 'warm' ? 'Calling' : 'Transferring to'} ${a.transfer.label}…`;
  if (a.transfer?.state === 'joined') return `On a 3-way call with ${a.transfer.label}`;
  return { ringing: a.direction === 'in' ? 'Connecting…' : 'Ringing…', connected: 'Connected', ended: 'Call ended', manual: 'Dial from your phone' }[a.state];
}

/** Mute / keypad / transfer / hang up (and transfer complete/cancel). Used in the call bar and the dialer. */
export function CallControls({ compact }: { compact?: boolean }) {
  const c = useCalls();
  const a = c.active;
  const [keys, setKeys] = useState(false);
  const [xfer, setXfer] = useState(false);
  if (!a) return null;
  const live = a.live && a.state !== 'ended';
  return (
    <>
      <div className="row">
        {a.state === 'manual' && <button className="btn danger" onClick={c.endManual}><Icon name="hang" className="sm" />End call</button>}
        {live && <>
          <button className="btn danger" onClick={c.hangUp}><Icon name="hang" className="sm" />Hang up</button>
          <button className="btn" onClick={c.toggleMute} aria-pressed={c.muted}>{c.muted ? 'Unmute' : 'Mute'}</button>
          {a.state === 'connected' && <button className={`btn ${keys ? 'primary' : ''}`} onClick={() => setKeys(!keys)} aria-pressed={keys}><Icon name="grid" className="sm" />Keypad</button>}
          {a.state === 'connected' && !a.transfer && <button className="btn" onClick={() => setXfer(true)}><Icon name="users" className="sm" />Transfer</button>}
          {a.transfer?.state === 'joined' && a.transfer.mode === 'warm' && <button className="btn primary" onClick={c.completeTransfer}>Complete transfer</button>}
          {a.transfer && a.transfer.mode === 'warm' && <button className="btn ghost" onClick={c.cancelTransfer}>Cancel transfer</button>}
        </>}
        {a.state === 'ended' && !a.handedOff && <button className="btn" onClick={c.redial}><Icon name="phone" className="sm" />Call again</button>}
      </div>
      {keys && a.state === 'connected' && <Keypad compact={compact ?? true} onKey={c.sendDigits} />}
      {xfer && <TransferModal onClose={() => setXfer(false)} />}
    </>
  );
}

/** Pick an agent, a saved contact or a number, then warm (stay on) or blind (drop off). */
export function TransferModal({ onClose }: { onClose: () => void }) {
  const c = useCalls();
  const [mode, setMode] = useState<'warm' | 'blind'>('warm');
  const [number, setNumber] = useState('');
  const t = useQuery({ queryKey: ['transfer-targets'], queryFn: () => api<{ users: { id: string; name: string; role: string; status: string }[]; contacts: { id: string; name: string; phone: string }[] }>('/calls/transfer-targets') });
  const go = async (target: { userId?: string; number?: string }) => { await c.transfer(mode, target); onClose(); };
  const order = { available: 0, oncall: 1, offline: 2 } as Record<string, number>;
  return (
    <Modal title="Transfer call" onClose={onClose}>
      <div className="seg" role="radiogroup" aria-label="Transfer type">
        <button role="radio" aria-checked={mode === 'warm'} className={mode === 'warm' ? 'on' : ''} onClick={() => setMode('warm')}><b>Warm</b><small>You stay on the line and introduce them</small></button>
        <button role="radio" aria-checked={mode === 'blind'} className={mode === 'blind' ? 'on' : ''} onClick={() => setMode('blind')}><b>Blind</b><small>Transfer and drop off right away</small></button>
      </div>
      <div className="eyebrow">Team</div>
      <div className="list">{(t.data?.users ?? []).slice().sort((x, y) => (order[x.status] ?? 3) - (order[y.status] ?? 3)).map((u) => (
        <div className="li" key={u.id}><span className={`dot ${u.status}`} /><div className="grow"><b>{u.name}</b><small>{u.role === 'admin' ? 'Super Admin' : 'Agent'} · {{ available: 'Available', oncall: 'On a call', offline: 'Offline' }[u.status]}</small></div>
          <button className="btn sm" disabled={u.status === 'offline'} onClick={() => go({ userId: u.id })}>Transfer</button></div>
      ))}{t.data && !t.data.users.length && <p className="muted">No teammates yet.</p>}</div>
      {(t.data?.contacts.length ?? 0) > 0 && <><div className="eyebrow">Saved contacts</div><div className="list">{t.data!.contacts.map((x) => (
        <div className="li" key={x.id}><div className="grow"><b>{x.name}</b><small className="mono">{pretty(x.phone)}</small></div><button className="btn sm" onClick={() => go({ number: x.phone })}>Transfer</button></div>
      ))}</div></>}
      <div className="eyebrow">Any number</div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (number.replace(/\D/g, '').length >= 10) void go({ number }); }}>
        <input className="input mono" style={{ flex: 1 }} inputMode="tel" placeholder="(512) 555-0100" value={number} onChange={(e) => setNumber(e.target.value)} aria-label="Transfer to number" />
        <button className="btn" disabled={number.replace(/\D/g, '').length < 10}>Transfer</button>
      </form>
    </Modal>
  );
}

/** Floating bar while a call is going and the agent is on another page (or the admin is listening in). */
export function CallBar() {
  const c = useCalls();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const a = c.active;
  useTick(!!a && !a.endedAt && !!a.startedAt);
  if (c.monitor) return (
    <div id="callbar"><div className="cb"><div className="row between">
      <div><b>{c.monitor.mode === 'whisper' ? 'Whispering to' : 'Listening to'} {c.monitor.label}</b><small style={{ display: 'block', opacity: 0.75 }}>{c.monitor.connected ? (c.monitor.mode === 'whisper' ? 'Only the agent can hear you' : 'You’re muted. Nobody can hear you') : 'Joining…'}</small></div>
      <button className="btn danger" onClick={c.stopListening}>Stop</button>
    </div></div></div>
  );
  if (!a || pathname === '/dialer') return null;
  return (
    <div id="callbar" role="region" aria-label="Call in progress"><div className="cb">
      <div className="row between">
        <div className="call-state connected" style={{ minWidth: 0 }}>{a.state !== 'ended' && <span className="pulse" />}
          <div style={{ minWidth: 0 }}><b>{callName(a)}</b><small style={{ display: 'block', opacity: 0.75 }}>{stateText(a)}</small></div></div>
        <div className="row">{a.state === 'connected' && a.live && <span className="rec">REC</span>}<span className="call-timer">{dur(c.elapsed())}</span></div>
      </div>
      <div className="row between">
        <CallControls />
        <button className="btn" onClick={() => navigate('/dialer')}>{a.state === 'ended' ? 'Log result' : 'Open dialer'}</button>
      </div>
    </div></div>
  );
}

/** Banner for a call ringing in the browser (inbound or transferred). */
export function IncomingCall() {
  const c = useCalls();
  if (!c.incoming) return null;
  const i = c.incoming.info;
  return (
    <div className="reminder" role="alertdialog" aria-label="Incoming call">
      <span className="eyebrow" style={{ color: 'var(--accent)' }}><Icon name="phone" className="sm" /> {i?.transferFrom ? `Transfer from ${i.transferFrom}` : `Incoming call${i?.label && i.label !== 'direct line' ? ` · ${i.label}` : ''}`}</span>
      <h3>{i?.leadName ?? pretty(i?.number ?? c.incoming.from)}</h3>
      {i?.leadName && <small className="muted mono">{pretty(i.number)}</small>}
      <div className="row"><button className="btn primary" onClick={() => void c.answer()}><Icon name="phone" className="sm" />Answer</button><button className="btn danger" onClick={c.decline}>Decline</button></div>
    </div>
  );
}

type LiveRow = { id: string; direction: 'in' | 'out'; status: string; agentName: string | null; leadName: string | null; number: string; answeredAt: string | null; createdAt: string; transfer: { mode: string; label: string; state: string } | null };

/** Super Admin: calls in progress, with listen-in and whisper. */
export function LiveCalls() {
  const c = useCalls();
  const q = useQuery({ queryKey: ['live-calls'], queryFn: () => api<{ voice: boolean; calls: LiveRow[] }>('/calls/live'), refetchInterval: 15_000 });
  useTick(true);
  const rows = q.data?.calls ?? [];
  return (
    <section className="panel">
      <div className="panel-h"><h2>Live calls</h2><Pill color={rows.length ? '--ok' : '--s9'}>{rows.length} now</Pill></div>
      {!q.data?.voice ? <div className="empty">Listen-in turns on when Twilio calling is connected.</div> : !rows.length ? <div className="empty">Nobody is on a call right now.</div> : (
        <div className="list">{rows.map((r) => {
          const label = `${r.agentName ?? 'agent'}’s call`;
          const secs = r.answeredAt ? (Date.now() - new Date(r.answeredAt).getTime()) / 1000 : 0;
          const on = c.monitor?.liveCallId === r.id;
          return (
            <div className="li" key={r.id}>
              <span className={`dot ${r.status === 'active' ? 'oncall' : 'available'}`} />
              <div className="grow"><b>{r.agentName ?? 'Unassigned'} {r.direction === 'in' ? '←' : '→'} {r.leadName ?? pretty(r.number)}</b>
                <small>{r.status === 'active' ? `Talking ${dur(secs)}` : 'Ringing'}{r.transfer ? ` · transferring to ${r.transfer.label}` : ''}</small></div>
              {r.status === 'active' && (on
                ? <button className="btn sm danger" onClick={c.stopListening}>Stop</button>
                : <>
                  <button className="btn sm" onClick={() => void c.listen(r.id, 'listen', label)}>Listen</button>
                  <button className="btn sm ghost" onClick={() => void c.listen(r.id, 'whisper', label)} title="Talk to the agent only; the customer can’t hear you">Whisper</button>
                </>)}
            </div>
          );
        })}</div>
      )}
    </section>
  );
}
