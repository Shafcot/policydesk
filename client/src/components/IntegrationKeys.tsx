// Settings → Integrations: provider API keys entered in the app (stored encrypted on the server), connection tests,
// and lead-vendor addresses.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useLookups } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';
import { Loading, Pill } from './ui';

type Field = { key: string; label: string; secret?: boolean; multiline?: boolean; hint?: string; placeholder?: string; source: 'app' | 'env' | null; value: string | null; preview: string | null };
type Group = { id: string; name: string; about: string; connected: boolean; fields: Field[] };
type Keys = { publicApiUrl: string; groups: Group[] };
const err = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

export function ApiKeys() {
  const keys = useQuery({ queryKey: ['integration-keys'], queryFn: () => api<Keys>('/admin/integrations/keys') });
  const [open, setOpen] = useState<string | null>(null);
  if (!keys.data) return <Loading />;
  return (
    <div className="keygroups">
      {keys.data.groups.map((g) => <KeyGroup key={g.id} g={g} open={open === g.id} onToggle={() => setOpen(open === g.id ? null : g.id)} />)}
    </div>
  );
}

function KeyGroup({ g, open, onToggle }: { g: Group; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const changed = Object.keys(draft).length > 0;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['integration-keys'] }); qc.invalidateQueries({ queryKey: ['integrations'] }); };
  const save = useMutation({
    mutationFn: (values: Record<string, string | null>) => api('/admin/integrations/keys', { method: 'PUT', json: { values } }),
    onSuccess: (_r, v) => { setDraft({}); refresh(); toast(Object.values(v).every((x) => x === null) ? 'Removed' : 'Saved'); },
    onError: (e) => toast(err(e), 'alert'),
  });
  const test = useMutation({ mutationFn: () => api<{ ok: boolean; message: string }>(`/admin/integrations/test/${g.id}`, { method: 'POST' }), onSuccess: setResult, onError: (e) => setResult({ ok: false, message: err(e) }) });
  const setup = useMutation({
    mutationFn: () => api<{ message: string }>('/admin/integrations/twilio/setup', { method: 'POST' }),
    onSuccess: (r) => { refresh(); setResult({ ok: true, message: r.message }); },
    onError: (e) => setResult({ ok: false, message: err(e) }),
  });
  const saved = g.fields.filter((f) => f.source === 'app');
  return (
    <section className={`keygroup ${open ? 'open' : ''}`}>
      <button className="keygroup-h" onClick={onToggle} aria-expanded={open}>
        <b>{g.name}</b>
        {g.connected ? <Pill color="--ok">Connected</Pill> : <Pill color="--s9">Not connected</Pill>}
        <Icon name="left" className="sm chev" />
      </button>
      {open && <div className="keygroup-b">
        <p className="help">{g.about}</p>
        <div className="form-grid">
          {g.fields.map((f) => {
            const id = `k-${f.key}`;
            const ph = f.secret && f.preview ? `Saved ${f.preview}. Type to replace` : f.placeholder ?? '';
            const val = draft[f.key] ?? (f.secret ? '' : f.value ?? '');
            const on = (v: string) => setDraft((d) => { const n = { ...d }; if (v === (f.secret ? '' : f.value ?? '')) delete n[f.key]; else n[f.key] = v; return n; });
            return (
              <div className={`field ${f.multiline ? 'full' : ''}`} key={f.key}>
                <label htmlFor={id}>{f.label}{f.source === 'env' && <small className="muted"> · set on the server</small>}</label>
                {f.multiline
                  ? <textarea id={id} className="input mono" rows={4} value={val} placeholder={ph} onChange={(e) => on(e.target.value)} spellCheck={false} />
                  : <input id={id} className="input mono" type={f.secret ? 'password' : 'text'} autoComplete="off" value={val} placeholder={ph} onChange={(e) => on(e.target.value)} spellCheck={false} />}
                {f.hint && <small className="help">{f.hint}</small>}
              </div>
            );
          })}
        </div>
        {result && <p className={result.ok ? 'ok-note' : 'optout'} role="status">{result.message}</p>}
        <div className="row">
          <button className="btn primary" disabled={!changed || save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? 'Saving…' : 'Save'}</button>
          {g.id !== 'general' && g.id !== 'google' && <button className="btn" disabled={test.isPending || changed} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test connection'}</button>}
          {g.id === 'twilio' && <button className="btn" disabled={setup.isPending || changed} onClick={() => setup.mutate()} title="Creates the API key and TwiML App in your Twilio account">{setup.isPending ? 'Setting up…' : 'Set up calling'}</button>}
          {changed && <button className="btn ghost" onClick={() => setDraft({})}>Discard changes</button>}
          {saved.length > 0 && !changed && <button className="btn ghost danger" onClick={() => { if (confirm(`Remove the keys saved for ${g.name}?`)) save.mutate(Object.fromEntries(saved.map((f) => [f.key, null]))); }}>Remove saved keys</button>}
        </div>
      </div>}
    </section>
  );
}

/** Each lead vendor / website form gets its own address and key. */
export function LeadVendors({ origin }: { origin: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const [name, setName] = useState('');
  const [cost, setCost] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['lookups'] });
  const add = useMutation({ mutationFn: () => api('/admin/lead-sources', { method: 'POST', json: { name: name.trim(), costPerLead: Number(cost) || 0, isVendor: true } }), onSuccess: () => { setName(''); setCost(''); refresh(); toast('Vendor added. Send them its address below.'); }, onError: (e) => toast(err(e), 'alert') });
  const rotate = useMutation({ mutationFn: (id: string) => api(`/admin/lead-sources/${id}/rotate-key`, { method: 'POST' }), onSuccess: () => { refresh(); toast('New address created. The old one no longer works.'); }, onError: (e) => toast(err(e), 'alert') });
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast(t, 'copy'));
  return (
    <>
      <p className="help">Give each vendor (EverQuote, MediaAlpha, SmartFinancial, a website form…) its own address. They send each lead as JSON or form data with <span className="mono">first_name, last_name</span> (or <span className="mono">full_name</span>), <span className="mono">phone, email, zip, insurance_type</span>. Leads are tagged with the vendor, duplicates by phone are ignored, and new leads auto-assign.</p>
      <div className="list">{(lookups.data?.sources ?? []).filter((x) => x.webhookKey).map((x) => { const url = `${origin}/webhooks/leads/${x.webhookKey}`; return (
        <div className="li" key={x.id}><div className="grow"><b>{x.name}</b><small className="mono" style={{ wordBreak: 'break-all' }}>{url}</small></div>
          <button className="icon-btn sm" onClick={() => copy(url)} aria-label={`Copy ${x.name} address`} title="Copy address"><Icon name="copy" className="sm" /></button>
          <button className="btn sm ghost" onClick={() => { if (confirm(`Create a new address for ${x.name}? The current one stops working.`)) rotate.mutate(x.id); }}>New address</button></div>
      ); })}</div>
      <div className="row"><input className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Vendor name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Vendor name" />
        <input className="input num" style={{ width: 130 }} type="number" min={0} placeholder="Cost per lead $" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="Cost per lead" />
        <button className="btn" disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}><Icon name="plus" className="sm" />Add vendor</button></div>
    </>
  );
}
