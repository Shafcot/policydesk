// Super Admin screens: Users and Settings.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { LINES, RESULTS, STG, type User } from '../lib/domain';
import { fdateY } from '../lib/format';
import { useLookups, useTeam, useTemplates, type Template } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Avatar, colorFor, Loading, Modal, PageHead, Pill, ResultPill, StagePill } from '../components/ui';
import { ApiKeys, LeadVendors } from '../components/IntegrationKeys';
import { BuySearch, prettyNumber, useNumbers } from '../components/NumberPicker';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const err = (e: unknown, fallback = 'Something went wrong') => (e instanceof ApiError ? e.message : fallback);

/* ============ Users ============ */

export function Users() {
  const { me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const team = useTeam();
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: (id: string) => api<{ resetLink: string }>(`/admin/users/${id}/reset`, { method: 'POST' }),
    onSuccess: (r) => setInvite(r.resetLink),
    onError: (e) => toast(err(e), 'alert'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ leadsMovedToIntake: number }>(`/admin/users/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['users'] }); setConfirm(null); toast(`User removed${r.leadsMovedToIntake ? `. ${r.leadsMovedToIntake} leads moved to intake` : ''}.`); },
    onError: (e) => toast(err(e), 'alert'),
  });
  if (!team.data) return <Loading />;
  return (
    <>
      <PageHead title="Users" sub="Invite agents and set roles, lines of insurance, working hours and daily call limits."
        actions={<button className="btn primary" onClick={() => setEdit('new')}><Icon name="userplus" className="sm" />Invite user</button>} />
      <section className="panel"><div className="tbl-wrap"><table className="tbl"><thead><tr><th>User</th><th>Role</th><th>Lines of insurance</th><th>Phone number</th><th>Hours</th><th className="r">Calls / day</th><th>Status</th><th /></tr></thead><tbody>
        {team.data.map((u) => (
          <tr key={u.id}>
            <td><div className="who"><Avatar name={u.name} color={u.role === 'admin' ? '--accent' : colorFor(u.id)} /><div><b>{u.name}</b><small>{u.email}</small></div></div></td>
            <td>{u.role === 'admin' ? <Pill color="--accent">Super Admin</Pill> : <Pill color="--info">Agent</Pill>}</td>
            <td>{u.role === 'admin' ? <span className="muted">All</span> : <div className="chips">{u.lines.map((l) => <span key={l} className="tag">{l}</span>)}</div>}</td>
            <td className="mono">{u.twilioNumber ? prettyNumber(u.twilioNumber) : <span className="muted">Default</span>}</td>
            <td className="num">{u.hoursStart}–{u.hoursEnd}</td>
            <td className="r num">{u.role === 'admin' ? '—' : `${u.callsToday ?? 0} / ${u.maxCallsPerDay}`}</td>
            <td>{u.invited ? <Pill color="--warn">Invite sent</Pill> : <span className="row" style={{ gap: 6 }}><span className={`dot ${u.status}`} />{{ available: 'Available', oncall: 'On call', offline: 'Offline' }[u.status]}</span>}</td>
            <td><div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn sm" onClick={() => setEdit(u)}><Icon name="edit" className="sm" />Edit</button>
              {!u.invited && <button className="btn sm" onClick={() => reset.mutate(u.id)} title="Email a password reset link">Reset password</button>}
              {u.id !== me.id && (confirm === u.id
                ? <button className="btn sm danger" onClick={() => remove.mutate(u.id)}>Confirm remove</button>
                : <button className="btn sm danger" onClick={() => setConfirm(u.id)}>Remove</button>)}
            </div></td>
          </tr>
        ))}
      </tbody></table></div></section>
      <p className="help" style={{ marginTop: 8 }}>Removing a user keeps their history and moves their open leads to intake for reassignment.</p>
      {edit && <UserModal user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onInvited={setInvite} />}
      {invite && (
        <Modal title={invite.includes('reset-password') ? 'Password reset link' : 'Invitation created'} onClose={() => setInvite(null)} footer={<button className="btn primary" onClick={() => setInvite(null)}>Done</button>}>
          <p>{invite.includes('reset-password') ? 'We emailed this link to the user (valid for 1 hour). You can also send it to them directly.' : 'We emailed this invitation to the new user. You can also send them the link directly.'} Emails go out once SendGrid is connected.</p>
          <div className="copybox"><input className="input" readOnly value={invite} aria-label="Invite link" /><button className="icon-btn" onClick={() => navigator.clipboard.writeText(invite).then(() => toast('Link copied'), () => toast(invite, 'copy'))} aria-label="Copy"><Icon name="copy" className="sm" /></button></div>
        </Modal>
      )}
    </>
  );
}

function UserModal({ user, onClose, onInvited }: { user: User | null; onClose: () => void; onInvited: (link: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? 'agent', lines: user?.lines ?? [],
    hoursStart: user?.hoursStart ?? '08:00', hoursEnd: user?.hoursEnd ?? '17:00', daysOff: user?.daysOff ?? ['Sat', 'Sun'],
    minCallsPerDay: user?.minCallsPerDay ?? 50, maxCallsPerDay: user?.maxCallsPerDay ?? 100,
  });
  const toggle = (k: 'lines' | 'daysOff', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  // Phone number: keep, none, one from the list (new or already used), or buy a new one.
  const nums = useNumbers();
  const current = nums.data?.numbers.find((n) => n.userId === user?.id && user);
  const [pick, setPick] = useState<string>('keep'); // 'keep' | 'none' | <number id> | 'buy'
  const [buyNumber, setBuyNumber] = useState('');
  const applyNumber = async (userId: string) => {
    if (pick === 'keep' || (pick === 'none' && !current)) return;
    if (pick === 'none') await api(`/admin/numbers/${current!.id}`, { method: 'PATCH', json: { userId: null } });
    else if (pick === 'buy') await api('/admin/numbers/buy', { method: 'POST', json: { number: buyNumber, userId } });
    else await api(`/admin/numbers/${pick}`, { method: 'PATCH', json: { userId } });
  };
  const save = useMutation({
    mutationFn: async () => {
      const r = user
        ? await api(`/admin/users/${user.id}`, { method: 'PATCH', json: { name: f.name, role: f.role, lines: f.lines, hoursStart: f.hoursStart, hoursEnd: f.hoursEnd, daysOff: f.daysOff, minCallsPerDay: f.minCallsPerDay, maxCallsPerDay: f.maxCallsPerDay } })
        : await api<{ inviteLink: string; user: { id: string } }>('/admin/users/invite', { method: 'POST', json: { name: f.name, email: f.email, role: f.role, lines: f.lines, hoursStart: f.hoursStart, hoursEnd: f.hoursEnd, minCallsPerDay: f.minCallsPerDay, maxCallsPerDay: f.maxCallsPerDay } });
      const id = user?.id ?? (r as { user: { id: string } }).user.id;
      try { await applyNumber(id); } catch (e) { toast(`${user ? 'Saved' : 'User created'}, but the phone number wasn’t set: ${err(e)}`, 'alert'); }
      return r;
    },
    onSuccess: (r) => { ['users', 'numbers'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onClose(); if (!user) onInvited((r as { inviteLink: string }).inviteLink); else toast('User updated'); },
    onError: (e) => toast(err(e), 'alert'),
  });
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Invite user'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name || !f.email || save.isPending || (pick === 'buy' && !buyNumber)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : user ? 'Save changes' : 'Create invitation'}</button></>}>
      <div className="form-grid">
        <div className="field"><label htmlFor="u-name">Full name</label><input id="u-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="u-email">Email</label><input id="u-email" className="input" type="email" value={f.email} disabled={!!user} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div className="field"><label htmlFor="u-role">Role</label><select id="u-role" className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as User['role'] })}><option value="agent">Agent</option><option value="admin">Super Admin</option></select></div>
        <div className="field"><label>Working hours</label><div className="row" style={{ flexWrap: 'nowrap' }}><input className="input" type="time" value={f.hoursStart} onChange={(e) => setF({ ...f, hoursStart: e.target.value })} aria-label="Start" /><input className="input" type="time" value={f.hoursEnd} onChange={(e) => setF({ ...f, hoursEnd: e.target.value })} aria-label="End" /></div></div>
        <div className="field"><label htmlFor="u-min">Min calls / day</label><input id="u-min" className="input num" type="number" value={f.minCallsPerDay} onChange={(e) => setF({ ...f, minCallsPerDay: Number(e.target.value) })} /></div>
        <div className="field"><label htmlFor="u-max">Max calls / day</label><input id="u-max" className="input num" type="number" value={f.maxCallsPerDay} onChange={(e) => setF({ ...f, maxCallsPerDay: Number(e.target.value) })} /></div>
        <div className="field full"><label>Lines of insurance</label><div className="chips">{LINES.map((l) => <button type="button" key={l} className={`chip ${f.lines.includes(l) ? 'on' : ''}`} onClick={() => toggle('lines', l)}>{l}</button>)}</div></div>
        <div className="field full"><label htmlFor="u-num">Phone number</label>
          <select id="u-num" className="input" value={pick} onChange={(e) => { setPick(e.target.value); setBuyNumber(''); }}>
            <option value="keep">{current ? `Keep ${prettyNumber(current.number)}` : user ? 'No number (uses the default caller ID)' : 'No number for now (uses the default caller ID)'}</option>
            {current && <option value="none">Remove their number</option>}
            {(nums.data?.numbers ?? []).filter((n) => n.id !== current?.id).map((n) => <option key={n.id} value={n.id}>{prettyNumber(n.number)}{n.label ? ` · ${n.label}` : ''}{n.userName ? ` (taken from ${n.userName})` : ' (free)'}</option>)}
            {nums.data?.twilio && <option value="buy">Buy a new number…</option>}
          </select>
          {pick === 'buy' && <BuySearch value={buyNumber} onPick={setBuyNumber} />}
        </div>
        {user && <div className="field full"><label>Days off</label><div className="chips">{DAYS.map((d) => <button type="button" key={d} className={`chip ${f.daysOff.includes(d) ? 'on' : ''}`} onClick={() => toggle('daysOff', d)}>{d}</button>)}</div></div>}
      </div>
      {!user && <p className="help">You’ll get an invitation link to send. Permissions are checked on the server for every request.</p>}
      {user && <p className="help">Member since {fdateY(user.createdAt)}.</p>}
    </Modal>
  );
}

/* ============ Settings ============ */

type Settings = {
  assignRule: 'round_robin' | 'availability' | 'line'; skipOffline: boolean; skipAtLimit: boolean;
  attemptsDay1: number; attemptsPerDay: number; maxAttempts: number; retryHours: number; requoteMonths: number; autoRequote: boolean; autoRecycle: boolean;
  teamTarget: number; teamTargetVisible: boolean; businessDays: string[]; businessOpen: string; businessClose: string; timezone: string;
  reviewLinks: { google: string; facebook: string; yelp: string }; optOutKeywords: string[];
  customFields: { key: string; label: string; type: 'text' | 'number' | 'date' }[]; reminderMinutes: number; screeningQuestions: string[];
};
type SettingsResp = { agency: { name: string; brandName: string; brandColor: string | null; logoUrl: string | null }; settings: Settings };

const TABS = [['assignment', 'Lead assignment'], ['calls', 'Call schedule'], ['pipeline', 'Pipeline rules'], ['fields', 'Custom fields'], ['sources', 'Lead sources'], ['templates', 'Message templates'], ['reviews', 'Review links'], ['hours', 'Business hours'], ['brand', 'Branding'], ['optout', 'Opt-out'], ['integrations', 'Integrations']] as const;
type Tab = (typeof TABS)[number][0];

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('assignment');
  const { data } = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<SettingsResp>('/admin/settings') });
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [agency, setAgency] = useState<Partial<SettingsResp['agency']>>({});
  const save = useMutation({
    mutationFn: () => api('/admin/settings', { method: 'PATCH', json: { ...(Object.keys(draft).length ? { settings: draft } : {}), ...(Object.keys(agency).length ? { agency } : {}) } }),
    onSuccess: () => { setDraft({}); setAgency({}); ['admin-settings', 'settings-public', 'targets'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast('Settings saved'); },
    onError: (e) => toast(err(e), 'alert'),
  });
  if (!data) return <Loading />;
  const s: Settings = { ...data.settings, ...draft };
  const a = { ...data.agency, ...agency };
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = Object.keys(draft).length > 0 || Object.keys(agency).length > 0;
  const num = (k: keyof Settings, label: string) => <div className="field"><label htmlFor={`s-${k}`}>{label}</label><input id={`s-${k}`} className="input num" type="number" value={s[k] as number} onChange={(e) => set(k, Number(e.target.value) as never)} /></div>;
  const savesHere = !['sources', 'templates'].includes(tab);

  return (
    <>
      <PageHead title="Settings" sub="Agency-wide configuration. Only the Super Admin can change these." />
      <div className="settings">
        <nav className="panel set-nav">{TABS.map(([k, n]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n}</button>)}</nav>
        <section className="panel"><div className="panel-b set-sec" style={{ paddingTop: 18 }}>
          {tab === 'assignment' && <>
            <h2>Lead assignment</h2>
            <div className="field"><label>Auto-assign new leads by</label><div className="seg">{([['round_robin', 'Round robin'], ['availability', 'Availability'], ['line', 'Line of insurance']] as const).map(([k, n]) => <button key={k} className={s.assignRule === k ? 'on' : ''} onClick={() => set('assignRule', k)}>{n}</button>)}</div></div>
            <label className="check"><input type="checkbox" checked={s.skipOffline} onChange={(e) => set('skipOffline', e.target.checked)} />Skip agents who are offline</label>
            <label className="check"><input type="checkbox" checked={s.skipAtLimit} onChange={(e) => set('skipAtLimit', e.target.checked)} />Skip agents at their daily call limit</label>
            <p className="help">No match → the lead stays unassigned in intake and you’re notified.</p>
          </>}
          {tab === 'calls' && <><h2>Call schedule</h2><div className="form-grid">{num('attemptsDay1', 'Attempts on day 1')}{num('attemptsPerDay', 'Attempts per day after')}{num('maxAttempts', 'Max attempts before Recycled')}{num('retryHours', 'Hours between retries')}</div><p className="help">Per-agent min/max calls per day are set in Users.</p></>}
          {tab === 'pipeline' && <>
            <h2>Auto-move rules</h2>
            <label className="check"><input type="checkbox" checked={s.autoRequote} onChange={(e) => set('autoRequote', e.target.checked)} />Quoted or Lost for <input className="input num" type="number" style={{ width: 64 }} value={s.requoteMonths} onChange={(e) => set('requoteMonths', Number(e.target.value))} aria-label="Months" /> months → Ready for Re-Quote + agent reminder</label>
            <label className="check"><input type="checkbox" checked={s.autoRecycle} onChange={(e) => set('autoRecycle', e.target.checked)} />No contact after all call attempts → Recycled</label>
            <div className="sep" /><h3>Call result → stage</h3>
            <div className="tbl-wrap"><table className="tbl"><tbody>{RESULTS.map((r) => <tr key={r.k}><td><ResultPill result={r.k} /></td><td>→</td><td><StagePill stage={({ no_answer: 'attempted', left_msg: 'attempted', voicemail: 'attempted', call_back: 'followup', needs_quote: 'ready', quoted: 'quoted', sold: 'won', lost: 'lost' } as const)[r.k]} /></td>
              <td className="muted">{({ call_back: 'call-back booked for the requested time', sold: 'after the policy is created; review request sent', no_answer: 'retry later', voicemail: 'retry later', left_msg: 'retry later' } as Record<string, string>)[r.k] ?? ''}</td></tr>)}</tbody></table></div>
            <p className="help">Stages: {Object.values(STG).map((x) => x.n).join(' → ')}</p>
          </>}
          {tab === 'fields' && <CustomFields value={s.customFields} onChange={(v) => set('customFields', v)} />}
          {tab === 'sources' && <Sources />}
          {tab === 'templates' && <Templates />}
          {tab === 'reviews' && <>
            <h2>Review links</h2><p className="help">Sent together in one review-request message after a policy is won.</p>
            {(['google', 'facebook', 'yelp'] as const).map((k) => <div className="field" key={k}><label htmlFor={`r-${k}`}>{k[0].toUpperCase() + k.slice(1)}</label><input id={`r-${k}`} className="input" value={s.reviewLinks[k]} onChange={(e) => set('reviewLinks', { ...s.reviewLinks, [k]: e.target.value })} placeholder="https://" /></div>)}
          </>}
          {tab === 'hours' && <>
            <h2>Business hours</h2>
            <div className="field"><label>Open days</label><div className="chips">{DAYS.map((d) => <button key={d} className={`chip ${s.businessDays.includes(d) ? 'on' : ''}`} onClick={() => set('businessDays', s.businessDays.includes(d) ? s.businessDays.filter((x) => x !== d) : [...s.businessDays, d])}>{d}</button>)}</div></div>
            <div className="form-grid">
              <div className="field"><label htmlFor="bh-open">Opens</label><input id="bh-open" className="input" type="time" value={s.businessOpen} onChange={(e) => set('businessOpen', e.target.value)} /></div>
              <div className="field"><label htmlFor="bh-close">Closes</label><input id="bh-close" className="input" type="time" value={s.businessClose} onChange={(e) => set('businessClose', e.target.value)} /></div>
              <div className="field full"><label htmlFor="bh-tz">Time zone</label><select id="bh-tz" className="input" value={s.timezone} onChange={(e) => set('timezone', e.target.value)}>{['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'].map((t) => <option key={t}>{t}</option>)}</select></div>
              {num('reminderMinutes', 'Reminder before appointments (minutes)')}
            </div>
            <p className="help">Automations and campaigns only send inside these hours.</p>
          </>}
          {tab === 'brand' && <>
            <h2>Branding</h2>
            <div className="form-grid">
              <div className="field"><label htmlFor="b-app">App name</label><input id="b-app" className="input" value={a.brandName} onChange={(e) => setAgency({ ...agency, brandName: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-agency">Agency name</label><input id="b-agency" className="input" value={a.name} onChange={(e) => setAgency({ ...agency, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="b-color">Brand color</label><input id="b-color" className="input" type="color" style={{ height: 40, padding: 3 }} value={a.brandColor ?? '#0d5049'} onChange={(e) => setAgency({ ...agency, brandColor: e.target.value })} /></div>
            </div>
            <p className="help">Logo upload arrives with file storage once hosting is decided. Each agency gets its own name and colors (white-label).</p>
          </>}
          {tab === 'optout' && <>
            <h2>Opt-out (STOP) handling</h2>
            <p>When a lead replies with any of these words, they’re removed from every SMS, email, automation and campaign.</p>
            <div className="field"><label htmlFor="oo">Keywords (comma separated)</label><input id="oo" className="input mono" value={s.optOutKeywords.join(', ')} onChange={(e) => set('optOutKeywords', e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))} /></div>
          </>}
          {tab === 'integrations' && <Integrations questions={s.screeningQuestions} onQuestions={(v) => set('screeningQuestions', v)} />}
          {savesHere && <div className="row" style={{ justifyContent: 'flex-end' }}>{dirty && <button className="btn" onClick={() => { setDraft({}); setAgency({}); }}>Discard</button>}<button className="btn primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save changes</button></div>}
        </div></section>
      </div>
    </>
  );
}

function CustomFields({ value, onChange }: { value: Settings['customFields']; onChange: (v: Settings['customFields']) => void }) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<'text' | 'number' | 'date'>('text');
  const add = () => {
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (!key || value.some((f) => f.key === key)) return;
    onChange([...value, { key, label: label.trim(), type }]); setLabel('');
  };
  return (
    <>
      <h2>Custom fields</h2><p className="help">Shown on every lead page. Removing a field hides it; saved values are kept.</p>
      <div className="list">{value.map((f) => <div className="li" key={f.key}><div className="grow"><b>{f.label}</b><small>{f.type}</small></div><button className="icon-btn sm" onClick={() => onChange(value.filter((x) => x.key !== f.key))} aria-label={`Remove ${f.label}`}><Icon name="trash" className="sm" /></button></div>)}</div>
      <div className="row"><input className="input" style={{ flex: 1 }} placeholder="Field name, e.g. Number of drivers" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Field name" />
        <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label="Type"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option></select>
        <button className="btn" onClick={add} disabled={!label.trim()}><Icon name="plus" className="sm" />Add field</button></div>
    </>
  );
}

function Sources() {
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const [name, setName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['lookups'] });
  const upd = useMutation({ mutationFn: (b: { id: string; costPerLead: number }) => api(`/admin/lead-sources/${b.id}`, { method: 'PATCH', json: { costPerLead: b.costPerLead } }), onSuccess: () => { refresh(); toast('Cost per lead saved'); }, onError: (e) => toast(err(e), 'alert') });
  const add = useMutation({ mutationFn: () => api('/admin/lead-sources', { method: 'POST', json: { name, isVendor: true } }), onSuccess: () => { setName(''); refresh(); toast('Source added'); }, onError: (e) => toast(err(e), 'alert') });
  return (
    <>
      <h2>Lead sources & cost per lead</h2><p className="help">Cost per lead feeds the ROI report. Vendor addresses for sending leads are under Integrations.</p>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Source</th><th>Type</th><th>Cost per lead ($)</th></tr></thead><tbody>
        {(lookups.data?.sources ?? []).map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.isVendor ? 'Lead vendor' : 'Channel'}</td>
          <td><input className="input num" type="number" style={{ width: 100 }} defaultValue={s.costPerLead} aria-label={`${s.name} cost`} onBlur={(e) => Number(e.target.value) !== s.costPerLead && upd.mutate({ id: s.id, costPerLead: Number(e.target.value) })} /></td></tr>)}
      </tbody></table></div>
      <div className="row"><input className="input" style={{ flex: 1 }} placeholder="New source or vendor" value={name} onChange={(e) => setName(e.target.value)} aria-label="New source" /><button className="btn" disabled={!name.trim()} onClick={() => add.mutate()}><Icon name="plus" className="sm" />Add source</button></div>
    </>
  );
}

function Templates() {
  const qc = useQueryClient();
  const toast = useToast();
  const tpls = useTemplates();
  const [edit, setEdit] = useState<Partial<Template> | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['templates'] });
  const save = useMutation({
    mutationFn: (t: Partial<Template>) => t.id ? api(`/admin/templates/${t.id}`, { method: 'PATCH', json: { name: t.name, subject: t.subject, body: t.body } }) : api('/admin/templates', { method: 'POST', json: { channel: t.channel, name: t.name, subject: t.subject ?? null, body: t.body } }),
    onSuccess: () => { setEdit(null); refresh(); toast('Template saved'); }, onError: (e) => toast(err(e), 'alert'),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/admin/templates/${id}`, { method: 'DELETE' }), onSuccess: () => { refresh(); toast('Template deleted'); } });
  return (
    <>
      <div className="row between"><h2>Message templates</h2><button className="btn" onClick={() => setEdit({ channel: 'sms', name: '', body: '' })}><Icon name="plus" className="sm" />New template</button></div>
      <p className="help">Variables: {'{first} {agent} {agency} {line} {booking}'}</p>
      <div className="list">{(tpls.data ?? []).map((t) => (
        <div className="li" key={t.id} style={{ alignItems: 'flex-start' }}><span className="tag">{t.channel.toUpperCase()}</span><div className="grow"><b>{t.name}</b><small style={{ whiteSpace: 'normal' }}>{t.body}</small></div>
          <button className="icon-btn sm" onClick={() => setEdit(t)} aria-label={`Edit ${t.name}`}><Icon name="edit" className="sm" /></button><button className="icon-btn sm" onClick={() => del.mutate(t.id)} aria-label={`Delete ${t.name}`}><Icon name="trash" className="sm" /></button></div>
      ))}</div>
      {edit && (
        <Modal title={edit.id ? 'Edit template' : 'New template'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={!edit.name || !edit.body} onClick={() => save.mutate(edit)}>Save template</button></>}>
          <div className="form-grid">
            <div className="field"><label htmlFor="t-name">Name</label><input id="t-name" className="input" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="t-ch">Channel</label><select id="t-ch" className="input" disabled={!!edit.id} value={edit.channel} onChange={(e) => setEdit({ ...edit, channel: e.target.value as 'sms' | 'email' })}><option value="sms">SMS</option><option value="email">Email</option></select></div>
            {edit.channel === 'email' && <div className="field full"><label htmlFor="t-subj">Subject</label><input id="t-subj" className="input" value={edit.subject ?? ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></div>}
            <div className="field full"><label htmlFor="t-body">Message</label><textarea id="t-body" className="input" rows={5} value={edit.body ?? ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </>
  );
}

type Status = { voice: boolean; sms: boolean; email: boolean; inboundEmail: boolean; ai: boolean; push: boolean; facebook: boolean; googleAds: boolean; webhooks: Record<string, string> };
const INTEGRATIONS: { key: keyof Omit<Status, 'webhooks'>; name: string; does: string; needs: string }[] = [
  { key: 'voice', name: 'Twilio Voice', does: 'Browser calling, power dialer, recordings, inbound calls', needs: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID, PUBLIC_API_URL' },
  { key: 'sms', name: 'Twilio SMS', does: 'Two-way texting, STOP handling, delivery status', needs: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID (A2P 10DLC approved)' },
  { key: 'email', name: 'SendGrid email', does: 'Emails to leads, invites, password resets, notification emails', needs: '' },
  { key: 'inboundEmail', name: 'SendGrid Inbound Parse', does: 'Email replies land in the inbox and stop automations', needs: 'SENDGRID_INBOUND_DOMAIN, SENDGRID_INBOUND_KEY' },
  { key: 'ai', name: 'OpenAI', does: 'Call transcripts, call summaries, AI speed-to-lead replies', needs: 'OPENAI_API_KEY' },
  { key: 'push', name: 'Firebase push', does: 'Browser push notifications', needs: 'FIREBASE_SERVICE_ACCOUNT_JSON (server) + VITE_FIREBASE_* (app build)' },
  { key: 'facebook', name: 'Facebook Lead Ads', does: 'Facebook / Instagram leads arrive automatically', needs: 'FACEBOOK_APP_SECRET, FACEBOOK_VERIFY_TOKEN, FACEBOOK_PAGE_ACCESS_TOKEN' },
  { key: 'googleAds', name: 'Google Ads lead forms', does: 'Google lead form submissions arrive automatically', needs: 'GOOGLE_ADS_WEBHOOK_KEY' },
];

function Integrations({ questions, onQuestions }: { questions: string[]; onQuestions: (v: string[]) => void }) {
  const toast = useToast();
  const status = useQuery({ queryKey: ['integrations'], queryFn: () => api<Status>('/integrations/status') });
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast(t, 'copy'));
  if (!status.data) return <Loading />;
  const origin = status.data.webhooks.leads.replace('/webhooks/leads/<source key>', '');
  return (
    <>
      <h2>Integrations</h2>
      <p className="help">Paste each provider’s keys below. They’re stored encrypted, and each service switches on as soon as its keys are saved. No restart needed.</p>
      <ApiKeys />
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Service</th><th>What it does</th><th>Status</th></tr></thead><tbody>
        {INTEGRATIONS.map((i) => <tr key={i.key}><td><b>{i.name}</b></td><td>{i.does}</td><td>{status.data![i.key] ? <Pill color="--ok">Connected</Pill> : <Pill color="--s9">Not connected</Pill>}</td></tr>)}
      </tbody></table></div>
      <div className="sep" /><h3>Webhook addresses</h3>
      <p className="help">Paste these into each provider’s dashboard. “Set up calling” and buying numbers fill in the Twilio ones for you.</p>
      <div className="list">{Object.entries({ 'Twilio TwiML App → Voice URL': status.data.webhooks.twilioVoiceApp, 'Twilio phone numbers → A call comes in': status.data.webhooks.twilioInbound, 'Twilio Messaging Service → incoming messages': status.data.webhooks.twilioSms, 'SendGrid Inbound Parse URL': status.data.webhooks.sendgridInbound, 'Facebook app → Webhooks (Page, leadgen)': status.data.webhooks.facebook, 'Google Ads lead form → Webhook URL': status.data.webhooks.googleAds }).map(([k, v]) => (
        <div className="li" key={k}><div className="grow"><b>{k}</b><small className="mono" style={{ wordBreak: 'break-all' }}>{v}</small></div><button className="icon-btn sm" onClick={() => copy(v)} aria-label={`Copy ${k}`}><Icon name="copy" className="sm" /></button></div>
      ))}</div>
      <div className="sep" /><h3>Lead vendors & website forms</h3>
      <LeadVendors origin={origin} />
      <div className="sep" /><h3>Phone numbers</h3>
      <p className="help">Add, buy and assign numbers on the <Link to="/numbers">Phone numbers</Link> page.</p>
      <div className="sep" /><h3>Speed-to-lead screening questions</h3>
      <p className="help">The AI reply asks these when a new lead arrives and no agent is free (needs OpenAI). Save with the button below.</p>
      {questions.map((q, i) => <div className="row" key={i} style={{ flexWrap: 'nowrap' }}><input className="input" value={q} onChange={(e) => onQuestions(questions.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Question ${i + 1}`} /><button className="icon-btn sm" onClick={() => onQuestions(questions.filter((_, j) => j !== i))} aria-label="Remove question"><Icon name="trash" className="sm" /></button></div>)}
      {questions.length < 6 && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => onQuestions([...questions, ''])}><Icon name="plus" className="sm" />Add question</button>}
    </>
  );
}
