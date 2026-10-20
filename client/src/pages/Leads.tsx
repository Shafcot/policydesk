import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../lib/api';
import { useMe } from '../lib/auth';
import { LINES, STAGES, STG, fullName, type Lead, type Stage } from '../lib/domain';
import { ago, fdt } from '../lib/format';
import { useLookups, useTeam } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Avatar, colorFor, Empty, Loading, PageHead, Pill, StagePill } from '../components/ui';
import { NewLeadModal } from '../components/NewLeadModal';
import { ImportLeads } from '../components/ImportLeads';

type Filters = { q: string; stage: string; source: string; agent: string; line: string; type: string; days: string };
const EMPTY: Filters = { q: '', stage: '', source: '', agent: '', line: '', type: '', days: '' };

function exportCsv(rows: Lead[], team: Map<string, string>) {
  const head = ['Name', 'Company', 'Phone', 'Email', 'Stage', 'Source', 'Line', 'Type', 'Agent', 'Created', 'Last contact', 'Attempts'];
  const lines = rows.map((l) => [fullName(l), l.company, l.phone, l.email, STG[l.stage].n, l.source, l.line, l.type, l.agentId ? team.get(l.agentId) : 'Unassigned', l.createdAt.slice(0, 10), l.lastContactAt?.slice(0, 10), l.attempts]);
  const csv = [head, ...lines].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

export function Leads() {
  const { isAdmin } = useMe();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'intake' ? 'intake' : 'all';
  const [f, setF] = useState<Filters>(EMPTY);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [newLead, setNewLead] = useState(false);
  const [importing, setImporting] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const lookups = useLookups();
  const team = useTeam();
  const agents = (team.data ?? []).filter((u) => u.role === 'agent');
  const names = useMemo(() => new Map((team.data ?? []).map((u) => [u.id, u.name])), [team.data]);

  const query = useQuery({
    queryKey: ['leads', tab, f],
    queryFn: () => api<Lead[]>(`/leads${qs({ ...f, intake: tab === 'intake' || undefined })}`),
    placeholderData: (prev) => prev,
  });
  const rows = query.data ?? [];
  const intakeCount = useQuery({ queryKey: ['leads', 'intake-count'], queryFn: () => api<Lead[]>('/leads?intake=true'), enabled: isAdmin });

  const done = (msg: string) => { setSel(new Set()); qc.invalidateQueries({ queryKey: ['leads'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); toast(msg); };
  const onErr = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Something went wrong', 'alert');
  const bulk = useMutation({ mutationFn: (body: { agentId?: string; stage?: Stage }) => api<{ updated: number }>('/leads/bulk', { method: 'POST', json: { ids: [...sel], ...body } }), onSuccess: (r, b) => done(`${r.updated} leads ${b.agentId ? `assigned to ${names.get(b.agentId)}` : `moved to ${STG[b.stage!].n}`}`), onError: onErr });
  const assignOne = useMutation({ mutationFn: ({ id, agentId }: { id: string; agentId: string | null }) => api(`/leads/${id}`, { method: 'PATCH', json: { agentId } }), onSuccess: (_r, v) => done(v.agentId ? `Assigned to ${names.get(v.agentId)}` : 'Lead unassigned'), onError: onErr });

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setSel(new Set()); };
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const openLead = (id: string) => setParams((p) => { p.set('lead', id); return p; });
  const setTab = (t: string) => { setSel(new Set()); setParams((p) => { if (t === 'intake') p.set('tab', 'intake'); else p.delete('tab'); return p; }); };

  return (
    <>
      <PageHead title={isAdmin ? 'Leads' : 'My leads'} sub={isAdmin ? 'Every lead in the agency. New leads land in intake, tagged by source, then auto-assign.' : 'Only leads assigned to you.'}
        actions={<>{isAdmin && <button className="btn" onClick={() => setImporting(true)}><Icon name="upload" className="sm" />Import</button>}<button className="btn" onClick={() => exportCsv(rows, names)}><Icon name="download" className="sm" />Export</button><button className="btn primary" onClick={() => setNewLead(true)}><Icon name="plus" className="sm" />New lead</button></>} />
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All leads</button>
        <button className={tab === 'intake' ? 'on' : ''} onClick={() => setTab('intake')}>Lead intake {isAdmin && <span className="badge">{(intakeCount.data ?? []).filter((l) => !l.agentId).length}</span>}</button>
      </div>
      <div className="filters" style={{ marginBottom: 12 }}>
        <input className="input grow" placeholder="Search name, phone, email" value={f.q} onChange={set('q')} aria-label="Search leads" />
        <select className="input" value={f.stage} onChange={set('stage')} aria-label="Stage"><option value="">All stages</option>{STAGES.map((s) => <option key={s.k} value={s.k}>{s.n}</option>)}</select>
        <select className="input" value={f.source} onChange={set('source')} aria-label="Source"><option value="">All sources</option>{(lookups.data?.sources ?? []).map((s) => <option key={s.id}>{s.name}</option>)}</select>
        {isAdmin && <select className="input" value={f.agent} onChange={set('agent')} aria-label="Agent"><option value="">All agents</option><option value="none">Unassigned</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>}
        <select className="input" value={f.line} onChange={set('line')} aria-label="Line"><option value="">All lines</option>{LINES.map((l) => <option key={l}>{l}</option>)}</select>
        <select className="input" value={f.type} onChange={set('type')} aria-label="Type"><option value="">Personal & commercial</option><option value="personal">Personal</option><option value="commercial">Commercial</option></select>
        <select className="input" value={f.days} onChange={set('days')} aria-label="Date"><option value="">Any date</option><option value="1">Today</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>
      </div>
      {isAdmin && sel.size > 0 && (
        <div className="bulk"><b>{sel.size} selected</b>
          <select value="" onChange={(e) => e.target.value && bulk.mutate({ agentId: e.target.value })} aria-label="Assign to"><option value="">Assign to…</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <select value="" onChange={(e) => e.target.value && bulk.mutate({ stage: e.target.value as Stage })} aria-label="Change stage"><option value="">Change stage…</option>{STAGES.filter((s) => s.k !== 'won').map((s) => <option key={s.k} value={s.k}>{s.n}</option>)}</select>
          <button className="btn sm" onClick={() => exportCsv(rows.filter((r) => sel.has(r.id)), names)}><Icon name="download" className="sm" />Export</button>
          <button className="btn sm" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      <div className="panel"><div className="tbl-wrap"><table className="tbl">
        <thead><tr>
          {isAdmin && <th style={{ width: 36 }}><input type="checkbox" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" /></th>}
          <th>Lead</th><th>Stage</th><th>Source</th><th>Line</th><th>Agent</th><th>{tab === 'intake' ? 'Received' : 'Last contact'}</th><th>Follow-up</th><th>Flags</th>
        </tr></thead>
        <tbody>
          {rows.map((l) => {
            const overdue = l.followUpAt && +new Date(l.followUpAt) < Date.now() && !['won', 'lost', 'recycled'].includes(l.stage);
            return (
              <tr key={l.id} className={`click ${sel.has(l.id) ? 'sel' : ''}`} onClick={() => openLead(l.id)}>
                {isAdmin && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${fullName(l)}`} /></td>}
                <td><div className="who"><Avatar name={fullName(l)} color={STG[l.stage].c} /><div><b>{fullName(l)}</b><small>{l.company ? `${l.company} · ` : ''}{l.phone}</small></div></div></td>
                <td><StagePill stage={l.stage} /></td>
                <td><span className="tag">{l.source}</span></td>
                <td>{l.line}<small className="muted" style={{ display: 'block' }}>{l.type === 'commercial' ? 'Commercial' : 'Personal'}</small></td>
                <td onClick={(e) => tab === 'intake' && isAdmin && e.stopPropagation()}>
                  {tab === 'intake' && isAdmin
                    ? <select className="input" style={{ padding: '4px 6px', width: 'auto' }} value={l.agentId ?? ''} onChange={(e) => assignOne.mutate({ id: l.id, agentId: e.target.value || null })} aria-label="Assign">
                      <option value="">Unassigned</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                    : l.agentId ? <div className="who"><Avatar name={names.get(l.agentId) ?? '?'} color={colorFor(l.agentId)} size="sm" /><span>{(names.get(l.agentId) ?? '').split(' ')[0]}</span></div>
                      : <Pill color="--warn">Unassigned</Pill>}
                </td>
                <td className="muted">{tab === 'intake' ? ago(l.createdAt) : ago(l.lastContactAt)}</td>
                <td style={overdue ? { color: 'var(--bad)', fontWeight: 600 } : undefined} className={overdue ? '' : 'muted'}>{['won', 'lost', 'recycled'].includes(l.stage) ? '—' : fdt(l.followUpAt)}</td>
                <td>{(l.flags ?? []).map((x) => <Pill key={x} color="--warn">{x === 'duplicate' ? 'Duplicate' : 'No email'}</Pill>)}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
        {query.isLoading && <Loading />}
        {query.isSuccess && !rows.length && <Empty>No leads match these filters.</Empty>}
      </div>
      <p className="help" style={{ marginTop: 8 }}>{rows.length} leads</p>
      {newLead && <NewLeadModal onClose={() => setNewLead(false)} />}
      {importing && <ImportLeads onClose={() => setImporting(false)} />}
    </>
  );
}
