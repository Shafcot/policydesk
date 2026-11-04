// One call manager for the whole app: the Twilio browser phone, the call in progress, incoming calls,
// transfers, admin listen-in, and the power-dialer queue. It lives above the pages, so a call keeps going
// (and the call bar stays on screen) when the agent moves to another page.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Call, Device } from '@twilio/voice-sdk';
import { api, ApiError } from './api';
import { useAuth } from './auth';
import { fullName, type CallResult, type Lead, type Stage } from './domain';
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
  logResult: (r: CallResult) => Promise<void>;
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

export function CallProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, setUser } = useAuth();
  const device = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const monitorRef = useRef<Call | null>(null);
  const incomingCall = useRef<Call | null>(null);
  const incomingInfo = useRef(new Map<string, IncomingInfo>());
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

  /* ---- Twilio Device ---- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
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
      device.current = d; setVoiceReady(true);
    })().catch((e) => console.warn('Calling unavailable:', e));
    return () => { cancelled = true; device.current?.destroy(); device.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ended = useCallback(() => {
    setActive((a) => (a && a.state !== 'ended' ? { ...a, state: 'ended', endedAt: Date.now() } : a));
  }, [setActive]);

  const track = useCallback((call: Call) => {
    callRef.current = call;
    call.on('disconnect', () => { if (callRef.current === call) ended(); });
    call.on('cancel', () => { if (callRef.current === call) ended(); });
    call.on('error', (e: { message?: string }) => { if (callRef.current === call) { ended(); toast(`Call error: ${e.message ?? 'unknown'}`, 'alert'); } });
  }, [ended, toast]);

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
    if (!device.current) {
      setActive({ ...base, live: false, state: 'manual', liveCallId: null, startedAt: Date.now(), endedAt: null, transfer: null });
      void setStatus('oncall');
      return;
    }
    setActive({ ...base, live: true, state: 'ringing', liveCallId: null, startedAt: null, endedAt: null, transfer: null });
    try { track(await device.current.connect({ params })); }
    catch (e) { ended(); toast(err(e), 'alert'); }
  }, [setActive, setStatus, track, ended, toast]);

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
  }, [incoming, track, setActive]);

  const decline = useCallback(() => { incomingCall.current?.reject(); incomingCall.current = null; setIncoming(null); }, []);

  const hangUp = useCallback(() => { callRef.current?.disconnect(); ended(); }, [ended]);
  const endManual = useCallback(() => ended(), [ended]);
  const toggleMute = useCallback(() => { callRef.current?.mute(!muted); setMuted(!muted); }, [muted]);
  const sendDigits = useCallback((d: string) => { callRef.current?.sendDigits(d); }, []);

  const reset = useCallback(() => {
    const wasManual = activeRef.current && !activeRef.current.live;
    setActive(null); callRef.current = null; setMuted(false); setNote('');
    if (wasManual) void setStatus('available');
  }, [setActive, setStatus]);

  const elapsed = useCallback(() => {
    const a = activeRef.current;
    return a?.startedAt ? ((a.endedAt ?? Date.now()) - a.startedAt) / 1000 : 0;
  }, []);

  const logResult = useCallback(async (result: CallResult) => {
    const a = activeRef.current;
    if (!a?.lead) return;
    if (a.state !== 'ended' && !a.handedOff) { callRef.current?.disconnect(); }
    const callSid = callRef.current?.parameters?.CallSid;
    try {
      const l = await api<Lead & { stage: Stage }>(`/leads/${a.lead.id}/calls`, { method: 'POST', json: {
        result, durationSec: Math.round(elapsed()), notes: note.trim() || undefined,
        ...(a.liveCallId ? { liveCallId: a.liveCallId } : callSid ? { callSid } : {}),
      } });
      ['queue', 'dashboard', 'leads', 'lead'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      if (result === 'sold') { setWon(l); setAuto(false); } else toast(`${fullName(l)} → ${l.stage.replace('_', ' ')}`);
      reset();
    } catch (e) { toast(err(e), 'alert'); }
  }, [elapsed, note, qc, reset, toast]);

  const attachLead = useCallback((l: Lead) => { setActive((a) => (a ? { ...a, lead: l, state: a.state === 'manual' ? 'ended' : a.state, endedAt: a.endedAt ?? Date.now() } : a)); qc.invalidateQueries({ queryKey: ['queue'] }); }, [setActive, qc]);
  const dismiss = useCallback(() => reset(), [reset]);

  /* ---- transfers ---- */
  const transfer = useCallback(async (mode: 'warm' | 'blind', target: { userId?: string; number?: string }) => {
    const a = activeRef.current;
    if (!a?.liveCallId) { toast('Transfers need browser calling (Twilio)', 'alert'); return; }
    try {
      const r = await api<{ transfer: Transfer }>(`/calls/live/${a.liveCallId}/transfer`, { method: 'POST', json: { mode, ...target } });
      setActive((x) => (x ? { ...x, transfer: r.transfer } : x));
      toast(mode === 'blind' ? 'Transferring… you’ve left the call' : 'Calling them… you stay on the line');
    } catch (e) { toast(err(e), 'alert'); }
  }, [setActive, toast]);
  const completeTransfer = useCallback(async () => {
    const a = activeRef.current; if (!a?.liveCallId) return;
    try { await api(`/calls/live/${a.liveCallId}/transfer/complete`, { method: 'POST' }); } catch (e) { toast(err(e), 'alert'); }
  }, [toast]);
  const cancelTransfer = useCallback(async () => {
    const a = activeRef.current; if (!a?.liveCallId) return;
    try { await api(`/calls/live/${a.liveCallId}/transfer/cancel`, { method: 'POST' }); setActive((x) => (x ? { ...x, transfer: null } : x)); } catch (e) { toast(err(e), 'alert'); }
  }, [setActive, toast]);

  /* ---- admin listen-in ---- */
  const stopListening = useCallback(() => { monitorRef.current?.disconnect(); monitorRef.current = null; setMonitor(null); }, []);
  const listen = useCallback(async (liveCallId: string, mode: 'listen' | 'whisper', label: string) => {
    if (!device.current) { toast('Listening in needs browser calling (Twilio)', 'alert'); return; }
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
    voiceReady, active, muted, note, setNote, auto, setAuto, queue, incoming, monitor, won, clearWon: () => setWon(null), busy, elapsed,
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
