import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../lib/api';
import { useMe } from '../lib/auth';
import { STAGES, STG, fullName, type Lead, type Stage } from '../lib/domain';
import { kmoney } from '../lib/format';
import { useTeam } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Avatar, colorFor, PageHead } from '../components/ui';
import { WonModal } from '../components/WonModal';

export function Pipeline() {
  const { isAdmin } = useMe();
  const [agent, setAgent] = useState('');
  const [over, setOver] = useState<Stage | null>(null);
  const [won, setWon] = useState<Lead | null>(null);
  const [, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const team = useTeam();
  const names = new Map((team.data ?? []).map((u) => [u.id, u.name]));
  const { data = [] } = useQuery({ queryKey: ['leads', 'pipeline', agent], queryFn: () => api<Lead[]>(`/leads${qs({ agent, limit: 500 })}`) });

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: Stage }) => api(`/leads/${id}`, { method: 'PATCH', json: { stage } }),
    onMutate: async ({ id, stage }) => {
      // Move the card right away; roll back if the server refuses.
      const key = ['leads', 'pipeline', agent];
      const prev = qc.getQueryData<Lead[]>(key);
      qc.setQueryData<Lead[]>(key, (old) => old?.map((l) => (l.id === id ? { ...l, stage, stageChangedAt: new Date().toISOString() } : l)));
      return { prev, key };
    },
    onError: (e, _v, ctx) => { if (ctx) qc.setQueryData(ctx.key, ctx.prev); toast(e instanceof ApiError ? e.message : 'Could not move the lead', 'alert'); },
    onSuccess: (_r, v) => { toast(`Moved to ${STG[v.stage].n}`); qc.invalidateQueries({ queryKey: ['dashboard'] }); },
  });
  const autoMove = useMutation({
    mutationFn: () => api<{ moved: number }>('/meta/auto-moves', { method: 'POST' }),
    onSuccess: (r) => { toast(r.moved ? `${r.moved} leads moved by auto-move rules` : 'Nothing to move right now. Rules also run nightly.', 'zap'); qc.invalidateQueries({ queryKey: ['leads'] }); },
  });

  const drop = (stage: Stage, id: string) => {
    setOver(null);
    const l = data.find((x) => x.id === id);
    if (!l || l.stage === stage) return;
    if (stage === 'won') { setWon(l); return; }
    move.mutate({ id, stage });
  };

  return (
    <>
      <PageHead title="Pipeline" sub="Drag a card to change its stage. Call results move cards automatically."
        actions={<>
          {isAdmin && <select className="input" style={{ width: 'auto' }} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent"><option value="">All agents</option>{(team.data ?? []).filter((u) => u.role === 'agent').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
          {isAdmin && <button className="btn" onClick={() => autoMove.mutate()}><Icon name="zap" className="sm" />Run auto-moves</button>}
        </>} />
      <div className="rules" style={{ marginBottom: 12 }}><span className="tag">Auto</span>Quoted or Lost for 5 months → Ready for Re-Quote<span className="tag">Auto</span>No contact after all call attempts → Recycled</div>
      <div className="board-wrap"><div className="board">
        {STAGES.map((s) => {
          const items = data.filter((l) => l.stage === s.k).sort((a, b) => +new Date(b.stageChangedAt) - +new Date(a.stageChangedAt));
          const value = items.reduce((a, l) => a + (l.quotePremium ?? 0), 0);
          return (
            <div key={s.k} className={`col ${over === s.k ? 'over' : ''}`} style={{ ['--c' as string]: `var(${s.c})` }}
              onDragOver={(e) => { e.preventDefault(); setOver(s.k); }} onDragLeave={() => setOver((o) => (o === s.k ? null : o))}
              onDrop={(e) => { e.preventDefault(); drop(s.k, e.dataTransfer.getData('text/plain')); }}>
              <div className="col-h"><h3>{s.n}</h3><small className="muted num">{items.length}{value ? ` · ${kmoney(value)}` : ''}</small></div>
              <div className="col-b">
                {items.map((l) => (
                  <div key={l.id} className="card" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', l.id)} onClick={() => setParams((p) => { p.set('lead', l.id); return p; })}>
                    <div className="row between" style={{ flexWrap: 'nowrap' }}><b>{fullName(l)}</b>{l.agentId ? <Avatar name={names.get(l.agentId) ?? '?'} color={colorFor(l.agentId)} size="sm" /> : <span className="av sm" style={{ ['--c' as string]: 'var(--s9)' }}>?</span>}</div>
                    <div className="meta"><span>{l.line} · {l.type === 'commercial' ? 'Comm.' : 'Pers.'}</span><span>{l.quotePremium ? kmoney(l.quotePremium) : ''}</span></div>
                    <div className="meta"><span className="tag">{l.source}</span><span>{Math.max(0, Math.floor((Date.now() - +new Date(l.stageChangedAt)) / 864e5))}d in stage</span></div>
                    <select className="input" value={l.stage} onClick={(e) => e.stopPropagation()} onChange={(e) => drop(e.target.value as Stage, l.id)} aria-label="Move to stage">
                      {STAGES.map((x) => <option key={x.k} value={x.k}>Move: {x.n}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div></div>
      {won && <WonModal lead={won} onClose={() => setWon(null)} />}
    </>
  );
}
