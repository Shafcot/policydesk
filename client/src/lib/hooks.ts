import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { User } from './domain';

export type Lookups = { sources: { id: string; name: string; costPerLead: number; isVendor: boolean }[]; carriers: string[]; lines: string[] };
export const useLookups = () => useQuery({ queryKey: ['lookups'], queryFn: () => api<Lookups>('/meta/lookups'), staleTime: 5 * 60_000 });
export const useTeam = () => useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users'), staleTime: 60_000 });
