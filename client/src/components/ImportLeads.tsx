import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { parseCsv } from '../lib/csv';
import { useLookups } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Modal } from './ui';

const FIELDS = [
  ['firstName', 'First name'], ['lastName', 'Last name'], ['name', 'Full name'], ['phone', 'Phone'], ['email', 'Email'], ['company', 'Company'],
  ['line', 'Line of insurance'], ['source', 'Lead source'], ['stage', 'Stage'], ['agentEmail', 'Agent email'], ['notes', 'Notes'], ['createdAt', 'Created date'],
] as const;
type Field = (typeof FIELDS)[number][0];

/** Column-name guesses for exports from GoHighLevel, AgencyZoom and generic spreadsheets. */
const GUESS: Record<Field, string[]> = {
  firstName: ['first name', 'firstname', 'first_name', 'contact first name'], lastName: ['last name', 'lastname', 'last_name', 'contact last name'],
  name: ['name', 'full name', 'contact name', 'customer name'], phone: ['phone', 'phone number', 'mobile', 'cell', 'primary phone', 'contact phone'],
  email: ['email', 'email address', 'primary email', 'contact email'], company: ['company', 'company name', 'business name', 'business'],
  line: ['line', 'line of business', 'lob', 'product', 'policy type', 'insurance type'], source: ['source', 'lead source', 'vendor', 'campaign'],
  stage: ['stage', 'status', 'pipeline stage', 'lead status'], agentEmail: ['agent email', 'assigned to', 'owner email', 'producer email', 'assigned user email'],
  notes: ['notes', 'note', 'comments', 'description'], createdAt: ['created', 'created at', 'date created', 'created date', 'date added'],
};

export function ImportLeads({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const [rows, setRows] = useState<string[][]>([]);
  const [head, setHead] = useState<string[]>([]);
  const [map, setMap] = useState<Partial<Record<Field, number>>>({});
  const [source, setSource] = useState('Previous CRM');
  const [autoAssign, setAutoAssign] = useState(true);
  const [runAutomations, setRunAutomations] = useState(false);
  const [file, setFile] = useState('');
  const [result, setResult] = useState<{ imported: number; duplicates: number; skipped: { row: number; reason: string }[] } | null>(null);

  const onFile = async (f: File) => {
    const all = parseCsv(await f.text());
    const h = (all.shift() ?? []).map((x) => x.trim());
    setFile(f.name); setHead(h); setRows(all); setResult(null);
    const m: Partial<Record<Field, number>> = {};
    (Object.keys(GUESS) as Field[]).forEach((k) => { const i = h.findIndex((c) => GUESS[k].includes(c.toLowerCase())); if (i >= 0) m[k] = i; });
    setMap(m);
  };
  const mapped = useMemo(() => rows.map((r) => Object.fromEntries((Object.entries(map) as [Field, number][]).map(([k, i]) => [k, (r[i] ?? '').trim()]))), [rows, map]);
  const ok = map.phone !== undefined && (map.firstName !== undefined || map.name !== undefined);
  const run = useMutation({
    mutationFn: () => api<{ imported: number; duplicates: number; skipped: { row: number; reason: string }[] }>('/leads/import', { method: 'POST', json: { rows: mapped, defaultSource: source, autoAssign, runAutomations } }),
    onSuccess: (r) => { setResult(r); ['leads', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`Imported ${r.imported} leads`, 'upload'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Import failed', 'alert'),
  });

  return (
    <Modal wide title="Import leads from a spreadsheet" onClose={onClose}
      footer={result ? <button className="btn primary" onClick={onClose}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok || !rows.length || run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Importing…' : `Import ${rows.length} rows`}</button></>}>
      {result ? (
        <div className="stack" style={{ gap: 8 }}>
          <p><b>{result.imported}</b> leads imported · <b>{result.duplicates}</b> skipped as duplicates (same phone) · <b>{result.skipped.length}</b> rows skipped</p>
          {result.skipped.length > 0 && <div className="list">{result.skipped.slice(0, 20).map((s) => <div className="li" key={s.row}><small>Row {s.row}: {s.reason}</small></div>)}</div>}
        </div>
      ) : (
        <>
          <p className="muted">Use a CSV export from GoHighLevel, AgencyZoom or any spreadsheet. Columns are matched automatically; check them below.</p>
          <label className="btn" style={{ justifySelf: 'start' }}>Choose CSV file<input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} /></label>
          {file && <>
            <p className="help">{file} · {rows.length} rows</p>
            <div className="form-grid">
              {FIELDS.map(([k, label]) => (
                <div className="field" key={k}><label htmlFor={`map-${k}`}>{label}{(k === 'phone') && ' *'}</label>
                  <select id={`map-${k}`} className="input" value={map[k] ?? ''} onChange={(e) => setMap({ ...map, [k]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                    <option value="">Don’t import</option>{head.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </select></div>
              ))}
              <div className="field"><label htmlFor="imp-source">Source when the file has none</label><input id="imp-source" className="input" list="imp-sources" value={source} onChange={(e) => setSource(e.target.value)} /><datalist id="imp-sources">{(lookups.data?.sources ?? []).map((s) => <option key={s.id} value={s.name} />)}</datalist></div>
            </div>
            <label className="check"><input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />Auto-assign leads without an agent email</label>
            <label className="check"><input type="checkbox" checked={runAutomations} onChange={(e) => setRunAutomations(e.target.checked)} />Start new-lead automations (welcome texts, drips) for imported leads</label>
            {!ok && <p className="optout">Map a phone column and a first-name or full-name column.</p>}
            {ok && mapped[0] && <p className="help">First row: {mapped[0].firstName || mapped[0].name} {mapped[0].lastName} · {mapped[0].phone} · {mapped[0].line || 'Auto'}</p>}
          </>}
        </>
      )}
    </Modal>
  );
}
