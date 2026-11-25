// "Connect RingCentral" in the account menu: each user links their own RingCentral line once, so the browser phone
// calls and texts from their RingCentral number. Shown only when the Super Admin has added the RingCentral app keys.
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useCalls } from '../lib/calls';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';

type Status = { enabled: boolean; connected: boolean; lapsed: boolean; extensionNumber: string | null; useRingCentral: boolean; line: { number: string; provider: string } | null };
const err = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong');

export function useRingCentralStatus() {
  return useQuery({ queryKey: ['ringcentral-status'], queryFn: () => api<Status>('/ringcentral/status'), staleTime: 60_000 });
}

export function RingCentralLink() {
  const qc = useQueryClient();
  const toast = useToast();
  const { reloadPhone } = useCalls();
  const st = useRingCentralStatus();
  const poll = useRef<number | null>(null);
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);

  const done = (connected: boolean) => {
    if (poll.current) { window.clearInterval(poll.current); poll.current = null; }
    qc.invalidateQueries({ queryKey: ['ringcentral-status'] }); qc.invalidateQueries({ queryKey: ['numbers'] }); qc.invalidateQueries({ queryKey: ['users'] });
    reloadPhone();
    if (connected) toast('RingCentral connected. Your calls and texts now use your RingCentral number.', 'phone');
  };

  const connect = async () => {
    // Open the window straight away (popup blockers allow it only during the click), then send it to RingCentral.
    const w = window.open('about:blank', 'ringcentral-connect', 'width=520,height=720');
    try {
      const { url } = await api<{ url: string }>('/ringcentral/connect', { method: 'POST' });
      if (w) w.location.href = url; else window.location.href = url;
    } catch (e) { w?.close(); toast(err(e), 'alert'); return; }
    // The popup can't always report back (it passes through RingCentral's site), so check every few seconds.
    let tries = 0;
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(async () => {
      tries++;
      const s = await api<Status>('/ringcentral/status').catch(() => null);
      if (s?.connected) done(true);
      else if (tries > 90 || (w && w.closed && tries > 2)) done(false);
    }, 2000);
  };
  const disconnect = useMutation({
    mutationFn: () => api('/ringcentral/connection', { method: 'DELETE' }),
    onSuccess: () => { done(false); toast('RingCentral disconnected'); },
    onError: (e) => toast(err(e), 'alert'),
  });

  if (!st.data?.enabled) return null;
  const s = st.data;
  if (!s.connected) return (
    <div className="li click" style={{ padding: '10px 14px' }} onClick={connect}>
      <Icon name="phone" className="sm" />
      <div className="grow"><b>{s.lapsed ? 'Reconnect RingCentral' : 'Connect RingCentral'}</b><small>{s.lapsed ? 'Your RingCentral sign-in expired' : 'Call and text from your RingCentral number'}</small></div>
    </div>
  );
  return (
    <div className="li" style={{ padding: '10px 14px' }}>
      <Icon name="phone" className="sm" />
      <div className="grow"><b>RingCentral connected</b><small>{s.extensionNumber ? `Extension ${s.extensionNumber}` : 'Your line'}{s.useRingCentral ? ' · in use for calls' : s.line ? ' · your number is on Twilio' : ' · no number assigned yet'}</small></div>
      <button className="btn sm ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</button>
    </div>
  );
}
