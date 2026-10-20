import { useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await login(email, password); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not sign in. Check your connection.'); } finally { setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="login-card panel" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}><div className="brand-mark">P</div><div><b style={{ color: 'var(--ink)' }}>Policy-desk CRM</b><small className="muted">Sign in to your agency</small></div></div>
        <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="password">Password</label><input id="password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {err && <p className="optout">{err}</p>}
        <button className="btn primary lg" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="help">Forgot your password? Ask your agency’s Super Admin to resend your invitation.</p>
      </form>
    </div>
  );
}
