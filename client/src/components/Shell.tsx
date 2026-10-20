import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { STG, fullName, type AgentStatus, type Lead, type Notification, type User } from '../lib/domain';
import { ago } from '../lib/format';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';
import { Avatar, colorFor } from './ui';
import { LeadDrawer } from './LeadDrawer';
import { useTeam } from '../lib/hooks';
import { useLiveUpdates } from '../lib/live';
import { NewLeadModal } from './NewLeadModal';
import { SpeedDial } from './SpeedDial';

type NavItem = { to: string; label: string; icon: string; admin?: boolean; ready?: boolean };
const NAV: [string, NavItem[]][] = [
  ['Work', [
    { to: '/', label: 'Dashboard', icon: 'home', ready: true },
    { to: '/leads', label: 'Leads', icon: 'users', ready: true },
    { to: '/pipeline', label: 'Pipeline', icon: 'kanban', ready: true },
    { to: '/dialer', label: 'Dialer', icon: 'phone' },
    { to: '/calendar', label: 'Calendar', icon: 'calendar' },
    { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  ]],
  ['Growth', [
    { to: '/automations', label: 'Automations', icon: 'zap', admin: true },
    { to: '/campaigns', label: 'Campaigns', icon: 'megaphone', admin: true },
  ]],
  ['Book of business', [
    { to: '/customers', label: 'Customers & policies', icon: 'shield' },
    { to: '/sales', label: 'Sales ledger', icon: 'dollar' },
    { to: '/targets', label: 'Targets', icon: 'target' },
    { to: '/reports', label: 'Reports', icon: 'chart' },
  ]],
  ['Admin', [
    { to: '/users', label: 'Users', icon: 'userplus', admin: true },
    { to: '/settings', label: 'Settings', icon: 'sliders', admin: true },
  ]],
];

export function Shell() {
  const { agency } = useAuth();
  useTeam();
  useLiveUpdates(true);
  const { isAdmin } = useMe();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const brand = agency?.brandName ?? 'Policy-desk CRM';
  return (
    <div id="app">
      <aside id="side" className={open ? 'open' : ''} aria-label="Main navigation">
        <div className="brand"><div className="brand-mark">{brand[0]}</div><div><b>{brand}</b><small>{agency?.name}</small></div></div>
        <nav className="nav">
          {NAV.map(([group, items]) => {
            const vis = items.filter((i) => !i.admin || isAdmin);
            if (!vis.length) return null;
            return (
              <div className="nav-group" key={group}><span>{group}</span>
                {vis.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => (isActive ? 'on' : '')}>
                    <Icon name={i.icon} /><span>{i.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div id="main">
        <TopBar onMenu={() => setOpen((o) => !o)} />
        <main id="view"><Outlet /></main>
      </div>
      <LeadDrawer />
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { me, isAdmin } = useMe();
  const { logout, setUser } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [newLead, setNewLead] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [speed, setSpeed] = useState(false);
  const prefs = useMutation({ mutationFn: (v: boolean) => api<User>('/users/me/prefs', { method: 'PATCH', json: { notifyByEmail: v } }), onSuccess: (u) => setUser({ ...me, ...u }) });

  const notifs = useQuery({ queryKey: ['notifications'], queryFn: () => api<Notification[]>('/notifications'), refetchInterval: 120_000 });
  const unread = (notifs.data ?? []).filter((n) => !n.readAt).length;
  const readAll = useMutation({ mutationFn: () => api('/notifications/read-all', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const status = useMutation({
    mutationFn: (s: AgentStatus) => api<User>('/users/me/status', { method: 'PATCH', json: { status: s } }),
    onSuccess: (u) => { setUser({ ...me, ...u }); toast(`Status: ${{ available: 'Available', oncall: 'On call', offline: 'Offline' }[u.status]}`); },
  });

  return (
    <header id="top">
      <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Menu"><Icon name="menu" /></button>
      <GlobalSearch />
      <div className="top-actions">
        <button className="btn primary" onClick={() => setNewLead(true)}><Icon name="plus" className="sm" /><span className="hide-sm">New lead</span></button>
        <button className="icon-btn" title="Speed dial" aria-label="Speed dial" onClick={() => setSpeed(true)}><Icon name="grid" /></button>
        <div style={{ position: 'relative' }}>
          <button className="icon-btn" onClick={() => setNotifOpen((o) => !o)} aria-label="Notifications"><Icon name="bell" />{unread > 0 && <span className="count">{unread}</span>}</button>
          {notifOpen && (
            <Popover onClose={() => setNotifOpen(false)}>
              <div className="row between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}><h3>Notifications</h3><button className="btn sm ghost" onClick={() => readAll.mutate()}>Mark all read</button></div>
              {(notifs.data ?? []).map((n) => <NotifRow key={n.id} n={n} onOpen={() => setNotifOpen(false)} />)}
              {!notifs.data?.length && <div className="empty">You’re all caught up</div>}
            </Popover>
          )}
        </div>
        <label className="status-sel"><span className={`dot ${me.status}`} />
          <select value={me.status} onChange={(e) => status.mutate(e.target.value as AgentStatus)} aria-label="Status">
            <option value="available">Available</option><option value="oncall">On call</option><option value="offline">Offline</option>
          </select>
        </label>
        <div style={{ position: 'relative' }}>
          <button className="me" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setMenuOpen((o) => !o)} aria-label="Account">
            <Avatar name={me.name} color={isAdmin ? '--accent' : colorFor(me.id)} />
            <div style={{ textAlign: 'left' }}><b>{me.name}</b><small>{isAdmin ? 'Super Admin' : 'Agent'}</small></div>
          </button>
          {menuOpen && (
            <Popover onClose={() => setMenuOpen(false)}>
              <div className="li" style={{ padding: '12px 14px' }}><div className="grow"><b>{me.name}</b><small>{me.email}</small></div></div>
              <label className="li check" style={{ padding: '10px 14px' }}><input type="checkbox" checked={me.notifyByEmail} onChange={(e) => prefs.mutate(e.target.checked)} />Email me notifications</label>
              <div className="li click" style={{ padding: '10px 14px' }} onClick={logout}><Icon name="left" className="sm" /><div className="grow"><b>Sign out</b></div></div>
            </Popover>
          )}
        </div>
      </div>
      {newLead && <NewLeadModal onClose={() => setNewLead(false)} />}
      {speed && <SpeedDial onClose={() => setSpeed(false)} />}
    </header>
  );
}

function NotifRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const [, setParams] = useSearchParams();
  const icon = { lead: 'users', reply: 'msg', warn: 'alert', book: 'calendar', renew: 'shield', bad: 'alert', sale: 'dollar', requote: 'clock', task: 'check', call: 'phone' }[n.kind] ?? 'bell';
  return (
    <div className={`li click ${n.readAt ? '' : 'unread'}`} onClick={() => { if (n.leadId) setParams((p) => { p.set('lead', n.leadId!); return p; }); onOpen(); }}>
      <span className={`n-ico ${n.kind === 'warn' ? 'warn' : n.kind === 'bad' ? 'bad' : ''}`}><Icon name={icon} className="sm" /></span>
      <div className="grow"><b style={{ whiteSpace: 'normal', fontWeight: 500 }}>{n.text}</b><small>{ago(n.createdAt)}</small></div>
    </div>
  );
}

function Popover({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return <div className="pop" ref={ref}>{children}</div>;
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [, setParams] = useSearchParams();
  const res = useQuery({ queryKey: ['search', q], queryFn: () => api<Lead[]>(`/leads${qs({ q, limit: 8 })}`), enabled: q.trim().length > 1 });
  return (
    <div className="search">
      <Icon name="search" className="sm" />
      <input className="input" placeholder="Search leads by name, phone, email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      {q.trim().length > 1 && (
        <Popover onClose={() => setQ('')}>
          {(res.data ?? []).map((l) => (
            <div key={l.id} className="li click" onClick={() => { setParams((p) => { p.set('lead', l.id); return p; }); setQ(''); }}>
              <Avatar name={fullName(l)} color={STG[l.stage].c} size="sm" />
              <div className="grow"><b>{fullName(l)}</b><small>{l.phone} · {STG[l.stage].n}</small></div>
            </div>
          ))}
          {res.data && !res.data.length && <div className="empty">No matches</div>}
        </Popover>
      )}
    </div>
  );
}
