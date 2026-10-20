// Pages that work without signing in: forgot password, reset password, and the public booking page.
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, tokenStore } from '../lib/api';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    try { await api('/auth/forgot', { method: 'POST', json: { email } }); setSent(true); } catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not send the email'); }
  };
  return (
    <div className="login-wrap"><form className="login-card panel" onSubmit={submit}>
      <div><h2>Reset your password</h2><p className="muted">We’ll email you a link to set a new password.</p></div>
      {sent ? <p>If an account exists for <b>{email}</b>, a reset link is on its way. It works for 1 hour.</p> : <>
        <div className="field"><label htmlFor="fp-email">Email</label><input id="fp-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
        {err && <p className="optout">{err}</p>}
        <button className="btn primary lg">Send reset link</button>
      </>}
      <a href="/" className="help">Back to sign in</a>
    </form></div>
  );
}

export function ResetPassword() {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw.length < 8) return setErr('Use at least 8 characters.');
    if (pw !== pw2) return setErr('The two passwords don’t match.');
    setBusy(true);
    try { const r = await api<{ token: string }>('/auth/reset', { method: 'POST', json: { token, password: pw } }); tokenStore.set(r.token); location.assign('/'); }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Could not reset the password'); setBusy(false); }
  };
  return (
    <div className="login-wrap"><form className="login-card panel" onSubmit={submit}>
      <div><h2>Set a new password</h2></div>
      <div className="field"><label htmlFor="rp1">New password</label><input id="rp1" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
      <div className="field"><label htmlFor="rp2">Confirm password</label><input id="rp2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
      {err && <p className="optout">{err}</p>}
      <button className="btn primary lg" disabled={busy || !token}>{busy ? 'Saving…' : 'Save and sign in'}</button>
    </form></div>
  );
}

type BookingInfo = { agent: string; agency: string; brandName: string; timezone: string; lines: string[]; days: { date: string; label: string; slots: string[] }[] };

/** Public booking page: a lead picks a free slot in the agent's calendar. */
export function BookingPage({ slug }: { slug: string }) {
  const [info, setInfo] = useState<BookingInfo | null>(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState(0);
  const [slot, setSlot] = useState('');
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', email: '', line: 'Auto', note: '' });
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<BookingInfo>(`/public/book/${encodeURIComponent(slug)}`).then(setInfo).catch((e) => setError(e instanceof ApiError ? e.message : 'This booking page could not be loaded'));
  useEffect(() => { load(); }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: info?.timezone });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!slot) return; setBusy(true); setError('');
    try { const r = await api<{ when: string }>(`/public/book/${encodeURIComponent(slug)}`, { method: 'POST', json: { ...f, slot } }); setDone(r.when); }
    catch (x) { setError(x instanceof ApiError ? x.message : 'Could not book'); setSlot(''); load(); }
    finally { setBusy(false); }
  };
  if (error && !info) return <div className="login-wrap"><div className="login-card panel"><h2>Booking unavailable</h2><p className="muted">{error}</p></div></div>;
  if (!info) return <div className="empty">Loading…</div>;
  if (done) return <div className="login-wrap"><div className="login-card panel"><h2>You’re booked</h2><p>{info.agent} from {info.agency} will call you on <b>{done}</b>.</p><p className="help">Times shown in {info.timezone.replace('_', ' ')}.</p></div></div>;
  const d = info.days[day];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="login-wrap">
      <form className="panel booking" onSubmit={submit}>
        <div><div className="eyebrow">{info.agency}</div><h2>Book a call with {info.agent}</h2><p className="muted">30 minutes · times in {info.timezone.replace('_', ' ')}</p></div>
        {!info.days.length ? <p>No free times in the next two weeks. Please call the agency directly.</p> : <>
          <div className="chips">{info.days.map((x, i) => <button type="button" key={x.date} className={`chip ${i === day ? 'on' : ''}`} onClick={() => { setDay(i); setSlot(''); }}>{x.label}</button>)}</div>
          <div className="slots">{d.slots.map((s) => <button type="button" key={s} className={`chip ${slot === s ? 'on' : ''}`} onClick={() => setSlot(s)}>{time(s)}</button>)}</div>
          {slot && <div className="form-grid">
            <div className="field"><label htmlFor="b-first">First name</label><input id="b-first" className="input" required value={f.firstName} onChange={set('firstName')} /></div>
            <div className="field"><label htmlFor="b-last">Last name</label><input id="b-last" className="input" required value={f.lastName} onChange={set('lastName')} /></div>
            <div className="field"><label htmlFor="b-phone">Phone</label><input id="b-phone" className="input" type="tel" required minLength={7} value={f.phone} onChange={set('phone')} /></div>
            <div className="field"><label htmlFor="b-email">Email</label><input id="b-email" className="input" type="email" value={f.email} onChange={set('email')} /></div>
            <div className="field full"><label htmlFor="b-line">What do you want to insure?</label><select id="b-line" className="input" value={f.line} onChange={set('line')}>{info.lines.map((l) => <option key={l}>{l}</option>)}</select></div>
            <div className="field full"><label htmlFor="b-note">Anything we should know? (optional)</label><textarea id="b-note" className="input" value={f.note} onChange={set('note')} /></div>
          </div>}
          {error && <p className="optout">{error}</p>}
          <button className="btn primary lg" disabled={!slot || busy}>{slot ? `Book ${d.label}, ${time(slot)}` : 'Pick a time'}</button>
        </>}
      </form>
    </div>
  );
}
