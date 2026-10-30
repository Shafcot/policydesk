// Live updates: one Socket.IO connection per signed-in session. Server events refresh the affected data.
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { tokenStore } from './api';
import { useToast } from './toast';
import type { Notification } from './domain';

export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    if (!enabled) return;
    const socket: Socket = io({ path: '/socket.io', auth: { token: tokenStore.get() }, transports: ['websocket', 'polling'] });
    const refresh = (...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    socket.on('notification', (n: Notification) => { refresh('notifications'); toast(n.text, 'bell'); });
    socket.on('lead:new', () => refresh('leads', 'dashboard', 'queue'));
    socket.on('lead:changed', (p: { id: string }) => { refresh('leads', 'dashboard', 'queue'); qc.invalidateQueries({ queryKey: ['lead', p.id] }); });
    socket.on('lead:deleted', (p: { id: string }) => { refresh('leads', 'dashboard', 'queue', 'inbox'); qc.removeQueries({ queryKey: ['lead', p.id] }); });
    socket.on('message:new', (p: { leadId: string }) => { refresh('inbox'); qc.invalidateQueries({ queryKey: ['lead', p.leadId] }); });
    return () => { socket.disconnect(); };
  }, [enabled, qc, toast]);
}
