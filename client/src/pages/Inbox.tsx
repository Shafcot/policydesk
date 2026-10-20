import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import { STG, type LeadDetail, type Stage } from '../lib/domain';
import { ago, fdt } from '../lib/format';
import { useOpenLead } from '../lib/leadLink';
import { Avatar, Empty, Loading, PageHead, StagePill } from '../components/ui';
import { Composer } from '../components/Composer';

type Conv = { leadId: string; name: string; stage: Stage; phone: string; email: string | null; optOut: boolean; lastAt: string; unread: number; sms: number; email_count: number; last: { channel: 'sms' | 'email'; direction: 'in' | 'out'; subject: string | null; body: string } | null };
type Filter = 'all' | 'sms' | 'email' | 'unread';

export function Inbox() {
  const { isAdmin } = useMe();
  const [f, setF] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['inbox'], queryFn: () => api<Conv[]>('/inbox'), refetchInterval: 30_000 });
  const list = (data ?? []).filter((c) => (f === 'sms' ? c.sms > 0 : f === 'email' ? c.email_count > 0 : f === 'unread' ? c.unread > 0 : true) && (!q || c.name.toLowerCase().includes(q.toLowerCase())));
  const current = sel && list.find((c) => c.leadId === sel) ? sel : list[0]?.leadId ?? null;
  return (
    <>
      <PageHead title="Inbox" sub={isAdmin ? 'Every SMS and email conversation.' : 'SMS and email with your leads only.'} />
      <section className="panel inbox">
        <div className="inbox-list">
          <div style={{ padding: 12, display: 'grid', gap: 8, borderBottom: '1px solid var(--line)' }}>
            <div className="seg">{(['all', 'sms', 'email', 'unread'] as Filter[]).map((k) => <button key={k} className={f === k ? 'on' : ''} onClick={() => setF(k)}>{{ all: 'All', sms: 'SMS', email: 'Email', unread: 'Unread' }[k]}</button>)}</div>
            <input className="input" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
          </div>
          <div className="scroll">
            {isLoading && <Loading />}
            {list.map((c) => (
              <div key={c.leadId} className={`conv ${c.leadId === current ? 'on' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => setSel(c.leadId)}>
                <Avatar name={c.name} color={STG[c.stage].c} />
                <div className="grow"><b><span>{c.name}</span><time>{ago(c.lastAt)}</time></b>
                  <p>{c.last?.channel === 'email' ? '✉ ' : ''}{c.last?.direction === 'out' ? 'You: ' : ''}{c.last?.channel === 'email' && c.last.subject ? c.last.subject : c.last?.body}</p></div>
              </div>
            ))}
            {data && !list.length && <Empty>No conversations</Empty>}
          </div>
        </div>
        <div className="inbox-thread">{current ? <Thread leadId={current} filter={f} /> : <Empty>Select a conversation</Empty>}</div>
      </section>
    </>
  );
}

function Thread({ leadId, filter }: { leadId: string; filter: Filter }) {
  const qc = useQueryClient();
  const openLead = useOpenLead();
  const { data: l } = useQuery({ queryKey: ['lead', leadId], queryFn: () => api<LeadDetail>(`/leads/${leadId}`) });
  const [ch, setCh] = useState<'sms' | 'email'>('sms');
  const read = useMutation({ mutationFn: () => api(`/leads/${leadId}/read`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }) });
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { read.mutate(); /* mark read on open */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [l?.messages.length]);
  if (!l) return <Loading />;
  const channel = filter === 'sms' || filter === 'email' ? filter : ch;
  const msgs = l.messages.filter((m) => (filter === 'sms' || filter === 'email' ? m.channel === filter : true));
  return (
    <>
      <div className="th-h">
        <div className="who"><Avatar name={`${l.firstName} ${l.lastName}`} color={STG[l.stage].c} /><div><b>{l.firstName} {l.lastName}</b><small>{l.phone}{l.email ? ` · ${l.email}` : ''}{l.agentName ? ` · ${l.agentName}` : ''}</small></div></div>
        <div className="row"><StagePill stage={l.stage} /><button className="btn sm" onClick={() => openLead(l.id)}>Lead page</button></div>
      </div>
      <div className="scroll" ref={scroller}><div className="thread">
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.direction} ${m.channel === 'email' ? 'email' : ''}`}>
            {m.channel === 'email' && <span className="subj">✉ {m.subject}</span>}{m.body}
            <small>{m.channel.toUpperCase()} · {fdt(m.createdAt)}{m.automated ? ' · automation' : ''}{m.status === 'queued' ? ' · queued' : ''}</small>
          </div>
        ))}
      </div></div>
      <div style={{ borderTop: '1px solid var(--line)', padding: 10, display: 'grid', gap: 8 }}>
        {filter === 'all' && !l.optOut && <div className="seg" style={{ justifySelf: 'start' }}>{(['sms', 'email'] as const).map((k) => <button key={k} className={ch === k ? 'on' : ''} onClick={() => setCh(k)}>{k === 'sms' ? 'SMS' : 'Email'}</button>)}</div>}
        <Composer lead={l} channel={channel} />
      </div>
    </>
  );
}
