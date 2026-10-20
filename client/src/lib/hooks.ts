import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { User } from './domain';
import { registerTeamColors } from '../components/ui';

export type Lookups = { sources: { id: string; name: string; costPerLead: number; isVendor: boolean; webhookKey: string | null }[]; carriers: string[]; lines: string[] };
export const useLookups = () => useQuery({ queryKey: ['lookups'], queryFn: () => api<Lookups>('/meta/lookups'), staleTime: 5 * 60_000 });
export const useTeam = () => useQuery({
  queryKey: ['users'],
  queryFn: async () => { const list = await api<User[]>('/users'); registerTeamColors(list.filter((u) => u.role === 'agent').map((u) => u.id)); return list; },
  staleTime: 60_000,
});

export type PublicSettings = { attemptsDay1: number; attemptsPerDay: number; maxAttempts: number; retryHours: number; reminderMinutes: number; customFields: { key: string; label: string; type: 'text' | 'number' | 'date' }[]; teamTargetVisible: boolean; businessOpen: string; businessClose: string; businessDays: string[] };
export const usePublicSettings = () => useQuery({ queryKey: ['settings-public'], queryFn: () => api<PublicSettings>('/settings/public'), staleTime: 5 * 60_000 });

export type Template = { id: string; channel: 'sms' | 'email'; name: string; subject: string | null; body: string };
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: () => api<Template[]>('/templates'), staleTime: 5 * 60_000 });

/** Fills {first} {agent} {agency} {line} {booking} in a template. */
export const fillTemplate = (text: string, v: { first: string; agent: string; agency: string; line: string; booking: string }) =>
  text.replace(/\{first\}/g, v.first).replace(/\{agent\}/g, v.agent).replace(/\{agency\}/g, v.agency).replace(/\{line\}/g, v.line.toLowerCase()).replace(/\{booking\}/g, v.booking);

/** Public booking page for an agent (their unique slug). */
export const bookingLink = (slug: string | null | undefined) => (slug ? `${location.origin}/book/${slug}` : '');
