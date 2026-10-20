import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fdt } from '../lib/format';
import { useOpenLead } from '../lib/leadLink';

type Task = { id: string; title: string; dueAt: string; leadId: string | null; contact: string | null };

/** Tasks created by automations (re-quotes, renewal reviews) or by the team. */
export function TasksPanel() {
  const qc = useQueryClient();
  const openLead = useOpenLead();
  const { data = [] } = useQuery({ queryKey: ['tasks'], queryFn: () => api<Task[]>('/tasks') });
  const done = useMutation({ mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'PATCH', json: { done: true } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }) });
  return (
    <section className="panel"><div className="panel-h"><h2>My tasks</h2><small className="muted">{data.length} open</small></div>
      <div className="panel-b"><div className="list">
        {data.slice(0, 8).map((t) => (
          <div className="li" key={t.id}>
            <input type="checkbox" onChange={() => done.mutate(t.id)} aria-label={`Done: ${t.title}`} style={{ width: 16, height: 16, accentColor: 'var(--brand)' }} />
            <div className={`grow ${t.leadId ? 'click' : ''}`} style={t.leadId ? { cursor: 'pointer' } : undefined} onClick={() => t.leadId && openLead(t.leadId)}><b style={{ whiteSpace: 'normal' }}>{t.title}</b><small>{t.contact ? `${t.contact} · ` : ''}{fdt(t.dueAt)}</small></div>
          </div>
        ))}
        {!data.length && <p className="muted">No open tasks.</p>}
      </div></div>
    </section>
  );
}
