// Browser calling through Twilio (Voice JS SDK). Off until the agency connects Twilio; the dialer then uses manual mode.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Call, Device } from '@twilio/voice-sdk';
import { api } from './api';

type Incoming = { call: Call; from: string };
type VoiceState = {
  ready: boolean;
  connect: (leadId: string) => Promise<Call>;
  /** Dial pad: call a typed number (E.164). */
  connectNumber: (to: string) => Promise<Call>;
  incoming: Incoming | null;
  answer: () => void;
  decline: () => void;
};
const Ctx = createContext<VoiceState>({ ready: false, connect: () => Promise.reject(new Error('Calling is not connected')), connectNumber: () => Promise.reject(new Error('Calling is not connected')), incoming: null, answer: () => {}, decline: () => {} });

export function VoiceProvider({ children }: { children: ReactNode }) {
  const device = useRef<Device | null>(null);
  const [ready, setReady] = useState(false);
  const [incoming, setIncoming] = useState<Incoming | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const st = await api<{ voice: boolean }>('/integrations/status').catch(() => ({ voice: false }));
      if (!st.voice || cancelled) return;
      const { token } = await api<{ token: string }>('/voice/token');
      const d = new Device(token, { codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU], closeProtection: 'A call is in progress. Leave anyway?' });
      // Connection problems (network, firewall, bad keys) are logged; the dialer keeps working in manual mode.
      d.on('error', (e: { code?: number; message?: string }) => console.warn(`Calling error ${e.code ?? ''}: ${e.message ?? ''}`));
      d.on('tokenWillExpire', async () => { const r = await api<{ token: string }>('/voice/token'); d.updateToken(r.token); });
      d.on('incoming', (call: Call) => {
        setIncoming({ call, from: call.parameters.From ?? 'Unknown caller' });
        const clear = () => setIncoming((x) => (x?.call === call ? null : x));
        call.on('cancel', clear); call.on('disconnect', clear); call.on('reject', clear);
      });
      await d.register(); // needed to receive inbound calls
      if (cancelled) { d.destroy(); return; }
      device.current = d; setReady(true);
    })().catch((e) => console.warn('Calling unavailable:', e));
    return () => { cancelled = true; device.current?.destroy(); device.current = null; };
  }, []);

  const connect = useCallback(async (leadId: string) => {
    if (!device.current) throw new Error('Calling is not connected');
    return device.current.connect({ params: { leadId } });
  }, []);
  const connectNumber = useCallback(async (to: string) => {
    if (!device.current) throw new Error('Calling is not connected');
    return device.current.connect({ params: { to } });
  }, []);
  const answer = useCallback(() => { incoming?.call.accept(); setIncoming(null); }, [incoming]);
  const decline = useCallback(() => { incoming?.call.reject(); setIncoming(null); }, [incoming]);
  return <Ctx.Provider value={{ ready, connect, connectNumber, incoming, answer, decline }}>{children}</Ctx.Provider>;
}

export const useVoice = () => useContext(Ctx);
