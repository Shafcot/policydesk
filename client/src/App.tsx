import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { AcceptInvite } from './pages/AcceptInvite';
import { Dashboard } from './pages/Dashboard';
import { Leads } from './pages/Leads';
import { Pipeline } from './pages/Pipeline';
import { Dialer } from './pages/Dialer';
import { Calendar } from './pages/Calendar';
import { Inbox } from './pages/Inbox';
import { Customers, Sales, TargetsPage } from './pages/Book';
import { Reports } from './pages/Reports';
import { SettingsPage, Users } from './pages/Admin';
import { ComingSoon } from './pages/ComingSoon';

export function App() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  if (pathname === '/accept-invite') return <AcceptInvite />;
  if (loading) return <div className="empty">Loading…</div>;
  if (!user) return <Login />;
  const isAdmin = user.role === 'admin';
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="leads" element={<Leads />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="dialer" element={<Dialer />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="customers" element={<Customers />} />
        <Route path="sales" element={<Sales />} />
        <Route path="targets" element={<TargetsPage />} />
        <Route path="reports" element={<Reports />} />
        {isAdmin && <>
          <Route path="users" element={<Users />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="automations" element={<ComingSoon />} />
          <Route path="campaigns" element={<ComingSoon />} />
        </>}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
