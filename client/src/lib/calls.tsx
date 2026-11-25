// One call manager for the whole app: the browser phone, the call in progress, incoming calls,
// transfers, admin listen-in, and the power-dialer queue. It lives above the pages, so a call keeps going
// (and the call bar stays on screen) when the agent moves to another page.
//
// The browser phone is Twilio by default. When the agent's own number is a RingCentral number and they have
// connected their RingCentral line, it is the RingCentral WebPhone instead (calls go straight from the browser
// to RingCentral; the CRM logs them and later attaches the recording from the RingCentral call history).
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Call, Device } from '@twilio/voice-sdk';
import type WebPhone from 'ringcentral-web-phone';
import type CallSession from 'ringcentral-web-phone/call-session/index';
import type InboundCallSession from 'ringcentral-web-phone/call-session/inbound';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { BAD, fullName, type BadReason, type CallResult, type Lead, type Stage } from './domain';
import { useLiveEvent } from './live';
import { useToast } from './toast';

export type CallState = 'ringing' | 'connected' | 'ended' | 'manual';
export type Transfer = { mode: 'warm' | 'blind'; label: string; state: 'ringing' | 'joined' | 'handoff' | 'failed' } | null;
export type ActiveCall = {
  lead: Lead | null;
  /** E.164 for typed / inbound numbers; the lead's phone otherwise. */
  number: string;
  direction: 'out' | 'in';
  /** Through Twilio (browser) or dialled by hand on the agent's phone. */
  live: boolean;
  state: CallState;
  liveCallId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  transfer: Transfer;
  /** The call was handed to someone else (transfer); the agent can still log a result. */
  handedOff?: boolean;
  label?: string | null;
  transferFrom?: string | null;
};
type IncomingInfo = { id: string; callSid: string | null; number: string; leadId: string | null; leadName: string | null; label: string; transferFrom: string | null };
export type Incoming = { from: string; info: IncomingInfo | null };
export type Monitor = { liveCallId: string; mode: 'listen' | 'whisper'; label: string; connected: boolean };
export type QueueItem = { bucket: 'new' | 'callback' | 'followup' | 'retry'; lead: Lead };

type Ctx = {
  voiceReady: boolean;
  /** Which browser phone is running: Twilio, RingCentral, or none (calls are dialled by hand). */
  phone: 'twilio' | 'ringcentral' | null;
  /** Starts the browser phone again (after connecting or disconnecting RingCentral). */
  reloadPhone: () => void;
  active: ActiveCall | null;
  muted: boolean;
  note: string; setNote: (v: string) => void;
  auto: boolean; setAuto: (v: boolean) => void;
  queue: QueueItem[];
  incoming: Incoming | null;
  monitor: Monitor | null;
  won: Lead | null; clearWon: () => void;
  busy: boolean;
  elapsed: () => number;
  callLead: (l: Lead) => Promise<void>;
  /** Dial pad: returns an error message when the number can't be called. */
  callNumber: (typed: string) => Promise<string | null>;
  redial: () => void;
  answer: () => Promise<void>;
  decline: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  sendDigits: (d: string) => void;
  /** Logs the call; `bad` also marks the lead as a bad lead (bad number, unreachable, DNS, DNC). */
  logResult: (r: CallResult, bad?: BadReason) => Promise<void>;
  attachLead: (l: Lead) => void;
  dismiss: () => void;
  endManual: () => void;
  transfer: (mode: 'warm' | 'blind', target: { userId?: string; number?: string }) => Promise<void>;
  completeTransfer: () => Promise<void>;
  cancelTransfer: () => Promise<void>;
  listen: (liveCallId: string, mode: 'listen' | 'whisper', label: string) => Promise<void>;
  stopListening: () => void;
};
const C = createContext<Ctx | null>(null);
export const useCalls = () => { const c = useContext(C); if (!c) throw new Error('useCalls outside CallProvider'); return c; };

const err = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');
const digitsOf = (n: string) => n.replace(/[^0-9]/g, '');
/** Full international form; 10-digit numbers are US/Canada. */
const asE164 = (n: string) => { const d = digitsOf(n); return d.length === 10 ? `+1${d}` : d ? `+${d}` : n; };
/** RingCentral dials numbers as digits with the country code and no '+' (e.g. 15125550100). */
const rcDigits = (n: string) => digitsOf(asE164(n));
type RcStatus = { enabled: boolean; connected: boolean; useRingCentral: boolean; line: { number: string; provider: 'twilio' | 'ringcentral' } | null };
/** A stable id per browser, so the same computer re-registers as the same RingCentral device (RingCentral allows 5). */
function rcInstanceId() {
  try {
    let id = localStorage.getItem('bliss-erp.rc-device');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('bliss-erp.rc-device', id); }
    return id;
  } catch { return undefined; }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, setUser } = useAuth();
  const device = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const monitorRef = useRef<Call | null>(null);
  const incomingCall = useRef<Call | null>(null);
  const incomingInfo = useRef(new Map<string, IncomingInfo>());
  const rcPhone = useRef<WebPhone | null>(null);
  const rcCall = useRef<CallSession | null>(null);
  const rcIncoming = useRef<InboundCallSession | null>(null);
  const rcFrom = useRef<string | undefined>(undefined);
  const rcWarm = useRef<{ complete: () => Promise<void>; cancel: () => Promise<void> } | null>(null);
  const [phone, setPhone] = useState<'twilio' | 'ringcentral' | null>(null);
  const [phoneGen, setPhoneGen] = useState(0);
  const reloadPhone = useCallback(() => setPhoneGen((g) => g + 1), []);
  const [voiceReady, setVoiceReady] = useState(false);
  const [active, setActiveState] = useState<ActiveCall | null>(null);
  const activeRef = useRef<ActiveCall | null>(null);
  const setActive = useCallback((v: ActiveCall | null | ((a: ActiveCall | null) => ActiveCall | null)) => {
    setActiveState((prev) => { const next = typeof v === 'function' ? v(prev) : v; activeRef.current = next; return next; });
  }, []);
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState('');
  const [auto, setAuto] = useState(false);
  const autoRef = useRef(auto); autoRef.current = auto;
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [monitor, setMonitor] = useState<Monitor | null>(null);
  const [won, setWon] = useState<Lead | null>(null);
  const [busy, setBusy] = useState(false);

  const queueQ = useQuery({ queryKey: ['queue'], queryFn: () => api<QueueItem[]>('/leads/queue/mine'), refetchInterval: 30_000, enabled: !!user });
  const queue = (queueQ.data ?? []).filter((x) => x.lead.id !== active?.lead?.id);

  const setStatus = useCallback(async (status: 'available' | 'oncall') => {
    if (!user || user.status === status || (status === 'available' && user.status !== 'oncall')) return;
    const u = await api<typeof user>('/users/me/status', { method: 'PATCH', json: { status } }).catch(() => null);
    if (u) setUser(u);
  }, [user, setUser]);

  /* ---- browser phone: RingCentral WebPhone when the agent's line is RingCentral, else Twilio Device ---- */
  useEffect(() => {
    let cancelled = false;
    setVoiceReady(false); setPhone(null);
    (async () => {
      const rc = await api<RcStatus>('/ringcentral/status').catch(() => null);
      if (rc?.useRingCentral && rc.line) {
        const { sipInfo } = await api<{ sipInfo: ConstructorParameters<typeof WebPhone>[0]['sipInfo'] }>('/ringcentral/sip', { method: 'POST' });
        const { default: WebPhoneClass } = await import('ringcentral-web-phone');
        if (cancelled) return;
        const wp = new WebPhoneClass({ sipInfo, instanceId: rcInstanceId() });
        wp.on('inboundCall', (s: InboundCallSession) => { void onRcIncoming(s); });
        // Registration can hang when RingCentral can't be reached (firewall, VPN): give up after 20 seconds.
        await Promise.race([wp.start(), new Promise((_, rej) => setTimeout(() => rej(new Error('RingCentral didn’t answer. Check your internet connection, then reload the page.')), 20_000))])
          .catch((e) => { void wp.dispose().catch(() => undefined); throw e; }); // don't wait: disposing a dead connection can hang
        if (cancelled) { void wp.dispose().catch(() => undefined); return; }
        rcPhone.current = wp; rcFrom.current = rcDigits(rc.line.number);
        setPhone('ringcentral'); setVoiceReady(true);
        return;
      }
      const st = await api<{ voice: boolean }>('/integrations/status').catch(() => ({ voice: false }));
      if (!st.voice || cancelled) return;
      const { token } = await api<{ token: string }>('/voice/token');
      const d = new Device(token, { codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU], closeProtection: 'A call is in progress. Leave anyway?' });
      d.on('error', (e: { code?: number; message?: string }) => console.warn(`Calling error ${e.code ?? ''}: ${e.message ?? ''}`));
      d.on('tokenWillExpire', async () => { const r = await api<{ token: string }>('/voice/token'); d.updateToken(r.token); });
      d.on('incoming', (call: Call) => {
        if (activeRef.current && activeRef.current.state !== 'ended') { call.reject(); return; } // already on a call
        incomingCall.current = call;
        const sid = call.parameters.CallSid;
        setIncoming({ from: call.parameters.From ?? 'Unknown caller', info: (sid && incomingInfo.current.get(sid)) || null });
        const clear = () => { if (incomingCall.current === call) { incomingCall.current = null; setIncoming(null); } };
        call.on('cancel', clear); call.on('reject', clear);
        call.on('disconnect', () => { clear(); if (callRef.current === call) ended(); });
      });
      await d.register();
      if (cancelled) { d.destroy(); return; }
      device.current = d; setPhone('twilio'); setVoiceReady(true);
    })().catch((e) => { console.warn('Calling unavailable:', e); if (!cancelled) toast(`Browser calling isn’t available: ${e instanceof Error ? e.message : 'the phone service couldn’t be reached. Check your internet connection, then reload the page.'}`, 'alert'); });
    return () => {
      cancelled = true;
      device.current?.destroy(); device.current = null;
      const wp = rcPhone.current; rcPhone.current = null;
      if (wp) void wp.dispose().catch(() => undefined);
    };
  }, [phoneGen]); // eslint-disable-line react-hooks/exhaustive-deps

  // RingCentral calls aren't protected by the Twilio SDK's close prompt: ask before leaving mid-call.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (rcCall.current && activeRef.current && activeRef.current.state !== 'ended') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const ended = useCallback(() => {
    setActive((a) => (a && a.state !== 'ended' ? { ...a, state: 'ended', endedAt: Date.now() } : a));
  }, [setActive]);

  const track = useCallback((call: Call) => {
    callRef.current = call;
    call.on('disconnect', () => { if (callRef.current === call) ended(); });
    call.on('cancel', () => { if (callRef.current === call) ended(); });
    call.on('error', (e: { message?: string }) => { if (callRef.current === call) { ended(); toast(`Call error: ${e.message ?? 'unknown'}`, 'alert'); } });
  }, [ended, toast]);

  /** Follows a RingCentral call: connected when answered (and recorded), ended when it's over. */
  const trackRc = useCallback((s: CallSession) => {
    rcCall.current = s;
    s.on('answered', () => {
      if (rcCall.current !== s) return;
      setActive((a) => (a && a.state === 'ringing' ? { ...a, state: 'connected', startedAt: Date.now() } : a));
      s.startRecording().catch(() => undefined); // follows the RingCentral account's recording permissions
    });
    s.on('disposed', () => { if (rcCall.current === s) ended(); });
    s.on('failed', (reason: string) => { if (rcCall.current === s) { ended(); toast(`Call failed${reason ? `: ${reason}` : ''}`, 'alert'); } });
  }, [ended, setActive, toast]);

  /** A call to the agent's RingCentral number while Bliss ERP is open. */
  const onRcIncoming = useCallback(async (s: InboundCallSession) => {
    if (activeRef.current && activeRef.current.state !== 'ended') return; // already on a call: let RingCentral's own rules handle it
    rcIncoming.current = s;
    const number = asE164(s.remoteNumber);
    setIncoming({ from: number, info: null });
    s.on('disposed', () => { if (rcIncoming.current === s) { rcIncoming.current = null; setIncoming(null); } });
    const r = await api<{ lead: Lead | null; blocked?: string }>(`/dialpad/lookup?phone=${encodeURIComponent(number)}`).catch(() => null);
    if (rcIncoming.current !== s) return;
    const info: IncomingInfo = { id: '', callSid: null, number, leadId: r?.lead?.id ?? null, leadName: r?.lead ? fullName(r.lead) : null, label: 'RingCentral line', transferFrom: null };
    setIncoming((x) => (x ? { ...x, info } : x));
  }, []);

  /* ---- server events ---- */
  useLiveEvent<{ id: string; state?: 'ringing' | 'connected' | 'ended'; agentCallSid?: string | null; transfer?: Transfer; endReason?: string | null; handedOff?: boolean; transferEnded?: boolean; transferFailed?: string }>('call:state', (p) => {
    const a = activeRef.current;
    if (!a?.live) return;
    const mySid = callRef.current?.parameters?.CallSid;
    if (a.liveCallId && a.liveCallId !== p.id) return;
    if (!a.liveCallId && p.agentCallSid && mySid && p.agentCallSid !== mySid) return;
    if (p.handedOff) { setActive({ ...a, liveCallId: p.id, state: 'ended', endedAt: Date.now(), handedOff: true, transfer: null }); toast('Call transferred'); return; }
    const next: ActiveCall = { ...a, liveCallId: p.id, transfer: p.transfer !== undefined ? p.transfer ?? null : a.transfer };
    if (p.state === 'connected' && a.state !== 'connected') { next.state = 'connected'; next.startedAt = Date.now(); }
    if (p.state === 'ended' && a.state !== 'ended') {
      next.state = 'ended'; next.endedAt = Date.now();
      const why: Record<string, string> = { busy: 'Line busy', 'no-answer': 'No answer', failed: 'Call failed', transfer_failed: 'Transfer wasn’t answered' };
      if (p.endReason && why[p.endReason]) toast(why[p.endReason], 'alert');
    }
    if (p.transferFailed) toast('The transfer wasn’t answered. You’re still on the call.', 'alert');
    setActive(next);
  });
  useLiveEvent<IncomingInfo>('call:incoming', (p) => {
    if (p.callSid) incomingInfo.current.set(p.callSid, p);
    setIncoming((x) => (x && !x.info ? { ...x, info: p } : x));
  });
  useLiveEvent<{ status: 'available' | 'oncall' | 'offline' }>('me:status', (p) => { if (user && user.status !== p.status) setUser({ ...user, status: p.status }); });

  /* ---- placing calls ---- */
  const startLive = useCallback(async (base: Omit<ActiveCall, 'live' | 'state' | 'liveCallId' | 'startedAt' | 'endedAt' | 'transfer'>, params: Record<string, string>) => {
    setMuted(false);
    if (rcPhone.current) {
      setActive({ ...base, live: true, state: 'ringing', liveCallId: null, startedAt: null, endedAt: null, transfer: null });
      void setStatus('oncall');
      try { trackRc(await rcPhone.current.call(rcDigits(base.number), rcFrom.current)); }
      catch (e) { ended(); toast(err(e), 'alert'); }
      return;
    }
    if (!device.current) {
      setActive({ ...base, live: false, state: 'manual', liveCallId: null, startedAt: Date.now(), endedAt: null, transfer: null });
      void setStatus('oncall');
      return;
    }
    setActive({ ...base, live: true, state: 'ringing', liveCallId: null, startedAt: null, endedAt: null, transfer: null });
    try { track(await device.current.connect({ params })); }
    catch (e) { ended(); toast(err(e), 'alert'); }
  }, [setActive, setStatus, track, trackRc, ended, toast]);

  const callLead = useCallback(async (l: Lead) => {
    if (activeRef.current && activeRef.current.state !== 'ended') { toast('Finish the current call first', 'alert'); return; }
    try {
      setBusy(true);
      await api(`/leads/${l.id}/lock`, { method: 'POST' });
      setNote('');
      await startLive({ lead: l, number: l.phone, direction: 'out' }, { leadId: l.id });
    } catch (e) { toast(err(e), 'alert'); }
    finally { setBusy(false); }
  }, [startLive, toast]);

  const dialTyped = useCallback(async (number: string) => {
    setNote('');
    await startLive({ lead: null, number, direction: 'out' }, { to: number });
  }, [startLive]);

  const callNumber = useCallback(async (typed: string) => {
    if (activeRef.current && activeRef.current.state !== 'ended') return 'Finish the current call first';
    const r = await api<{ valid: boolean; number?: string; lead: Lead | null; blocked?: string }>(`/dialpad/lookup?phone=${encodeURIComponent(typed)}`).catch((e) => ({ valid: false, error: err(e) } as const));
    if ('error' in r) return r.error;
    if (!r.valid || !r.number) return 'That phone number isn’t valid.';
    if (r.blocked) return r.blocked;
    if (r.lead) { toast(`That’s ${fullName(r.lead)}, one of your leads`); await callLead(r.lead); return null; }
    await dialTyped(r.number);
    return null;
  }, [callLead, dialTyped, toast]);

  const redial = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.state !== 'ended') return;
    setActive(null); callRef.current = null;
    if (a.lead) void callLead(a.lead); else void dialTyped(a.number);
  }, [callLead, dialTyped, setActive]);

  const answer = useCallback(async () => {
    const rs = rcIncoming.current;
    if (rs) {
      const info = incoming?.info ?? null;
      rcIncoming.current = null; setIncoming(null);
      try { await rs.answer(); } catch (e) { toast(err(e), 'alert'); return; }
      trackRc(rs);
      setMuted(false); setNote('');
      void setStatus('oncall');
      const lead = info?.leadId ? await api<Lead>(`/leads/${info.leadId}`).catch(() => null) : null;
      setActive({ lead, number: info?.number ?? asE164(rs.remoteNumber), direction: 'in', live: true, state: 'connected', liveCallId: null, startedAt: Date.now(), endedAt: null, transfer: null, label: 'RingCentral line', transferFrom: null });
      rs.startRecording().catch(() => undefined);
      return;
    }
    const call = incomingCall.current;
    if (!call) return;
    const sid = call.parameters.CallSid;
    const info = (sid && incomingInfo.current.get(sid)) || incoming?.info || null;
    call.accept();
    incomingCall.current = null; setIncoming(null);
    track(call);
    setMuted(false); setNote('');
    const lead = info?.leadId ? await api<Lead>(`/leads/${info.leadId}`).catch(() => null) : null;
    setActive({ lead, number: info?.number ?? call.parameters.From ?? '', direction: 'in', live: true, state: 'connected', liveCallId: info?.id ?? null, startedAt: Date.now(), endedAt: null, transfer: null, label: info?.label ?? null, transferFrom: info?.transferFrom ?? null });
  }, [incoming, track, trackRc, setActive, setStatus, toast]);

  const decline = useCallback(() => {
    if (rcIncoming.current) { void rcIncoming.current.decline().catch(() => undefined); rcIncoming.current = null; setIncoming(null); return; }
    incomingCall.current?.reject(); incomingCall.current = null; setIncoming(null);
  }, []);

  const hangUp = useCallback(() => { callRef.current?.disconnect(); void rcCall.current?.hangup().catch(() => undefined); ended(); }, [ended]);
  const endManual = useCallback(() => ended(), [ended]);
  const toggleMute = useCallback(() => {
    callRef.current?.mute(!muted);
    if (rcCall.current) { if (muted) rcCall.current.unmute(); else rcCall.current.mute(); }
    setMuted(!muted);
  }, [muted]);
  const sendDigits = useCallback((d: string) => { callRef.current?.sendDigits(d); rcCall.current?.sendDtmf(d); }, []);

  const reset = useCallback(() => {
    // Manual and RingCentral calls set "on a call" from the browser, so the browser sets it back too.
    const wasLocal = activeRef.current && (!activeRef.current.live || !!rcCall.current);
    setActive(null); callRef.current = null; rcCall.current = null; rcWarm.current = null; setMuted(false); setNote('');
    if (wasLocal) void setStatus('available');
  }, [setActive, setStatus]);

  const elapsed = useCallback(() => {
    const a = activeRef.current;
    return a?.startedAt ? ((a.endedAt ?? Date.now()) - a.startedAt) / 1000 : 0;
  }, []);

  const logResult = useCallback(async (result: CallResult, bad?: BadReason) => {
    const a = activeRef.current;
    if (!a?.lead) return;
    if (a.state !== 'ended' && !a.handedOff) { callRef.current?.disconnect(); void rcCall.current?.hangup().catch(() => undefined); }
    const callSid = callRef.current?.parameters?.CallSid;
    const rcSessionId = rcCall.current?.sessionId;
    try {
      const l = await api<Lead & { stage: Stage }>(`/leads/${a.lead.id}/calls`, { method: 'POST', json: {
        result, durationSec: Math.round(elapsed()), notes: note.trim() || undefined,
        ...(a.liveCallId ? { liveCallId: a.liveCallId } : callSid ? { callSid } : rcSessionId ? { rcSessionId } : {}),
      } });
      if (bad) await api(`/leads/${a.lead.id}`, { method: 'PATCH', json: { badReason: bad } });
      ['queue', 'dashboard', 'leads', 'lead'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (result === 'sold') { setWon(l); setAuto(false); } else toast(bad ? `${fullName(l)} marked as ${BAD[bad].n}` : `${fullName(l)} → ${l.stage.replace('_', ' ')}`);
      reset();
    } catch (e) { toast(err(e), 'alert'); }
  }, [elapsed, note, qc, reset, toast]);

  const attachLead = useCallback((l: Lead) => { setActive((a) => (a ? { ...a, lead: l, state: a.state === 'manual' ? 'ended' : a.state, endedAt: a.endedAt ?? Date.now() } : a)); qc.invalidateQueries({ queryKey: ['queue'] }); }, [setActive, qc]);
  const dismiss = useCallback(() => reset(), [reset]);

  /* ---- transfers ---- */
  const transfer = useCallback(async (mode: 'warm' | 'blind', target: { userId?: string; number?: string }) => {
    const a = activeRef.current;
    const s = rcCall.current;
    if (s && a) {
      // RingCentral: transfer to a phone number, or to a teammate's own number.
      let to = target.number ?? null, label = target.number ?? '';
      if (target.userId) {
        const team = await api<{ id: string; name: string; twilioNumber?: string | null }[]>('/users').catch(() => []);
        const u = team.find((x) => x.id === target.userId);
        to = u?.twilioNumber ?? null; label = u?.name ?? '';
        if (!to) { toast(`${label || 'That person'} has no phone number to transfer to`, 'alert'); return; }
      }
      if (!to) return;
      try {
        if (mode === 'blind') {
          await s.transfer(rcDigits(to));
          setActive((x) => (x ? { ...x, state: 'ended', endedAt: Date.now(), handedOff: true, transfer: null } : x));
          toast('Call transferred');
        } else {
          const w = await s.warmTransfer(rcDigits(to), { callerId: rcFrom.current });
          rcWarm.current = { complete: w.complete, cancel: w.cancel };
          setActive((x) => (x ? { ...x, transfer: { mode: 'warm', label, state: 'ringing' } } : x));
          w.newSession.once('answered', () => setActive((x) => (x?.transfer ? { ...x, transfer: { ...x.transfer, state: 'joined' } } : x)));
          w.newSession.once('disposed', () => { if (rcWarm.current) setActive((x) => (x?.transfer && x.transfer.state !== 'handoff' ? { ...x, transfer: null } : x)); });
          toast('Calling them… the customer is on hold');
        }
      } catch (e) { toast(err(e), 'alert'); }
      return;
    }
    if (!a?.liveCallId) { toast('Transfers need browser calling', 'alert'); return; }
    try {
      const r = await api<{ transfer: Transfer }>(`/calls/live/${a.liveCallId}/transfer`, { method: 'POST', json: { mode, ...target } });
      setActive((x) => (x ? { ...x, transfer: r.transfer } : x));
      toast(mode === 'blind' ? 'Transferring… you’ve left the call' : 'Calling them… you stay on the line');
    } catch (e) { toast(err(e), 'alert'); }
  }, [setActive, toast]);
  const completeTransfer = useCallback(async () => {
    if (rcWarm.current) {
      const w = rcWarm.current; rcWarm.current = null;
      try { await w.complete(); setActive((x) => (x ? { ...x, state: 'ended', endedAt: Date.now(), handedOff: true, transfer: null } : x)); toast('Call transferred'); }
      catch (e) { toast(err(e), 'alert'); }
      return;
    }
    const a = activeRef.current; if (!a?.liveCallId) return;
    try { await api(`/calls/live/${a.liveCallId}/transfer/complete`, { method: 'POST' }); } catch (e) { toast(err(e), 'alert'); }
  }, [toast]);
  const cancelTransfer = useCallback(async () => {
    if (rcWarm.current) {
      const w = rcWarm.current; rcWarm.current = null;
      try { await w.cancel(); } catch (e) { toast(err(e), 'alert'); }
      setActive((x) => (x ? { ...x, transfer: null } : x));
      return;
    }
    const a = activeRef.current; if (!a?.liveCallId) return;
    try { await api(`/calls/live/${a.liveCallId}/transfer/cancel`, { method: 'POST' }); setActive((x) => (x ? { ...x, transfer: null } : x)); } catch (e) { toast(err(e), 'alert'); }
  }, [setActive, toast]);

  /* ---- admin listen-in ---- */
  const stopListening = useCallback(() => { monitorRef.current?.disconnect(); monitorRef.current = null; setMonitor(null); }, []);
  const listen = useCallback(async (liveCallId: string, mode: 'listen' | 'whisper', label: string) => {
    if (!device.current) { toast('Listening in works on Twilio calls only', 'alert'); return; }
    if (activeRef.current && activeRef.current.state !== 'ended') { toast('Finish your own call first', 'alert'); return; }
    monitorRef.current?.disconnect();
    setMonitor({ liveCallId, mode, label, connected: false });
    try {
      const call = await device.current.connect({ params: { monitor: liveCallId, mode } });
      monitorRef.current = call;
      call.on('accept', () => setMonitor((m) => (m ? { ...m, connected: true } : m)));
      call.on('disconnect', () => { if (monitorRef.current === call) { monitorRef.current = null; setMonitor(null); } });
    } catch (e) { setMonitor(null); toast(err(e), 'alert'); }
  }, [toast]);

  /* ---- power dialer: when a call is logged, start the next lead ---- */
  useEffect(() => {
    if (!auto || active || busy || !queueQ.data) return;
    const next = queue[0];
    if (!next) { setAuto(false); toast('Queue is empty. Unreached numbers return next shift.'); return; }
    const t = setTimeout(() => { if (autoRef.current && !activeRef.current) void callLead(next.lead); }, 900);
    return () => clearTimeout(t);
  }, [auto, active, busy, queueQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: Ctx = {
    voiceReady, phone, reloadPhone, active, muted, note, setNote, auto, setAuto, queue, incoming, monitor, won, clearWon: () => setWon(null), busy, elapsed,
    callLead, callNumber, redial, answer, decline, hangUp, toggleMute, sendDigits, logResult, attachLead, dismiss, endManual,
    transfer, completeTransfer, cancelTransfer, listen, stopListening,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** A ticking clock while a call is going (re-renders the caller every second). */
export function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return; const t = setInterval(() => set((x) => x + 1), 1000); return () => clearInterval(t); }, [on]);
}
