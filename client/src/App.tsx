import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Leads } from './pages/Leads';
import { Pipeline } from './pages/Pipeline';
import { ComingSoon } from './pages/ComingSoon';

const LATER = ['dialer', 'calendar', 'inbox', 'customers', 'sales', 'targets', 'reports'];
const ADMIN_LATER = ['automations', 'campaigns', 'users', 'settings'];

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="empty">Loading…</div>;
  if (!user) return <Login />;
  const isAdmin = user.role === 'admin';
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="leads" element={<Leads />} />
        <Route path="pipeline" element={<Pipeline />} />
        {LATER.map((p) => <Route key={p} path={p} element={<ComingSoon />} />)}
        {isAdmin && ADMIN_LATER.map((p) => <Route key={p} path={p} element={<ComingSoon />} />)}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
