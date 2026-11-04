// Live updates: one Socket.IO connection per signed-in session. Server events refresh the affected data,
// and components can listen for specific events with useLiveEvent (calls, transfers, status).
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { tokenStore } from './api';
import { useToast } from './toast';
import type { Notification } from './domain';

const bus = new EventTarget();

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
    socket.on('calls:changed', () => refresh('live-calls'));
    socket.on('users:changed', () => refresh('users', 'dashboard'));
    socket.on('voicemail:new', () => refresh('voicemails'));
    socket.onAny((event: string, payload: unknown) => bus.dispatchEvent(new CustomEvent(event, { detail: payload })));
    return () => { socket.disconnect(); };
  }, [enabled, qc, toast]);
}

/** Runs `fn` for each `event` from the server (latest `fn` is always used). */
export function useLiveEvent<T = unknown>(event: string, fn: (payload: T) => void) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    const h = (e: Event) => ref.current((e as CustomEvent).detail as T);
    bus.addEventListener(event, h);
    return () => bus.removeEventListener(event, h);
  }, [event]);
}
