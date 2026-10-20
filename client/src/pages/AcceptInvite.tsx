import { useState, type FormEvent } from 'react';
import { api, ApiError, tokenStore } from '../lib/api';

/** Opened from the invitation link: the new user sets a password, then lands in the app. */
export function AcceptInvite() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw.length < 8) return setErr('Use at least 8 characters.');
    if (pw !== pw2) return setErr('The two passwords don’t match.');
    setBusy(true);
    try {
      const r = await api<{ token: string }>('/auth/accept-invite', { method: 'POST', json: { token, password: pw } });
      tokenStore.set(r.token); location.assign('/');
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not accept the invitation'); setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="login-card panel" onSubmit={submit}>
        <div><h2>Welcome to Policy-desk CRM</h2><p className="muted">Set a password to finish setting up your account.</p></div>
        {!token && <p className="optout">This link is missing its invitation code. Ask your Super Admin to send it again.</p>}
        <div className="field"><label htmlFor="pw">New password</label><input id="pw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <div className="field"><label htmlFor="pw2">Confirm password</label><input id="pw2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
        {err && <p className="optout">{err}</p>}
        <button className="btn primary lg" disabled={busy || !token}>{busy ? 'Saving…' : 'Set password and sign in'}</button>
      </form>
    </div>
  );
}
