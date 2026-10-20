import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { AcceptInvite } from './pages/AcceptInvite';
import { BookingPage, ForgotPassword, ResetPassword } from './pages/PublicPages';
import { Dashboard } from './pages/Dashboard';
import { Leads } from './pages/Leads';
import { Pipeline } from './pages/Pipeline';
import { Dialer } from './pages/Dialer';
import { Calendar } from './pages/Calendar';
import { Inbox } from './pages/Inbox';
import { Customers, Sales, TargetsPage } from './pages/Book';
import { Reports } from './pages/Reports';
import { SettingsPage, Users } from './pages/Admin';
import { Automations } from './pages/Automations';
import { Campaigns } from './pages/Campaigns';

export function App() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  // Pages that work without signing in.
  if (pathname === '/accept-invite') return <AcceptInvite />;
  if (pathname === '/forgot-password') return <ForgotPassword />;
  if (pathname === '/reset-password') return <ResetPassword />;
  if (pathname.startsWith('/book/')) return <BookingPage slug={decodeURIComponent(pathname.slice(6))} />;
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
          <Route path="automations" element={<Automations />} />
          <Route path="campaigns" element={<Campaigns />} />
        </>}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
