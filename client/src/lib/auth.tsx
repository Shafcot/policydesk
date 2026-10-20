import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler, tokenStore } from './api';
import type { Agency, User } from './domain';

type AuthState = {
  user: User | null; agency: Agency | null; loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (u: User) => void;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [agency, setAgency] = useState<Agency | null>(null);
  const [loading, setLoading] = useState(!!tokenStore.get());

  const logout = useCallback(() => { tokenStore.set(null); setUser(null); setAgency(null); qc.clear(); }, [qc]);
  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  useEffect(() => {
    if (!tokenStore.get()) return;
    api<{ user: User; agency: Agency }>('/auth/me')
      .then((r) => { setUser(r.user); setAgency(r.agency); })
      .catch(() => tokenStore.set(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', json: { email, password } });
    tokenStore.set(r.token);
    const me = await api<{ user: User; agency: Agency }>('/auth/me');
    setUser(me.user); setAgency(me.agency);
  }, []);

  const value = useMemo(() => ({ user, agency, loading, login, logout, setUser }), [user, agency, loading, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
/** For screens inside the signed-in shell. */
export function useMe() {
  const { user } = useAuth();
  if (!user) throw new Error('useMe without a user');
  return { me: user, isAdmin: user.role === 'admin' };
}
