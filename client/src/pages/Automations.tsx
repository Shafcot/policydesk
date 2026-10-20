import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { RESULTS, STAGES, type CallResult, type Stage } from '../lib/domain';
import { ago, fdt } from '../lib/format';
import { useTemplates } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from '../components/Icon';
import { Loading, Modal, PageHead, Pill } from '../components/ui';

type Trigger = 'new_lead' | 'stage_change' | 'call_result' | 'missed_appointment' | 'policy_won' | 'renewal_date' | 'birthday';
type Action = 'send_sms' | 'send_email' | 'create_task' | 'change_stage' | 'assign_agent' | 'send_booking_link' | 'send_review_request' | 'ai_reply' | 'alert_team';
type Condition = 'no_agent_available' | 'not_replied' | 'is_commercial' | 'is_personal';
type Step =
  | { type: 'wait'; amount: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' }
  | { type: 'condition'; condition: Condition }
  | { type: 'action'; action: Action; templateId?: string | null; stage?: Stage; text?: string };
type Automation = {
  id: string; name: string; active: boolean; trigger: Trigger; triggerConfig: { stages?: Stage[]; results?: CallResult[]; daysBefore?: number[] };
  steps: Step[]; stopOnReply: boolean; stopOnBooking: boolean; stopOnWonLost: boolean; businessHoursOnly: boolean;
  stats?: { active: number; completed: number; stopped: number };
};
type Run = { id: string; contact: string; status: 'active' | 'completed' | 'stopped'; stepIndex: number; nextRunAt: string; stopReason: string | null; updatedAt: string; log: { at: string; text: string }[] };

const TRIGGERS: [Trigger, string][] = [['new_lead', 'New lead'], ['stage_change', 'Stage change'], ['call_result', 'Call result'], ['missed_appointment', 'Missed appointment'], ['policy_won', 'Policy won'], ['renewal_date', 'Renewal date'], ['birthday', 'Birthday']];
const ACTIONS: [Action, string][] = [['send_sms', 'Send SMS'], ['send_email', 'Send email'], ['create_task', 'Create agent task'], ['change_stage', 'Change stage'], ['assign_agent', 'Assign agent'], ['send_booking_link', 'Send booking link'], ['send_review_request', 'Send review request'], ['ai_reply', 'AI reply + screening questions'], ['alert_team', 'Alert agent & admin']];
const CONDITIONS: [Condition, string][] = [['no_agent_available', 'No agent is available'], ['not_replied', 'Lead has not replied'], ['is_commercial', 'Lead is commercial'], ['is_personal', 'Lead is personal']];
const TLABEL = Object.fromEntries(TRIGGERS) as Record<Trigger, string>;
const MSG_ACTIONS: Action[] = ['send_sms', 'send_email', 'send_booking_link', 'send_review_request'];

const blank = (): Automation => ({ id: '', name: 'Untitled automation', active: false, trigger: 'new_lead', triggerConfig: {}, steps: [{ type: 'wait', amount: 1, unit: 'hours' }, { type: 'action', action: 'send_sms' }], stopOnReply: true, stopOnBooking: true, stopOnWonLost: true, businessHoursOnly: true });

export function Automations() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['automations'], queryFn: () => api<Automation[]>('/automations'), refetchInterval: 30_000 });
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Automation | null>(null);
  const [runs, setRuns] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const list = data ?? [];
  const selected = list.find((a) => a.id === selId) ?? list[0];
  useEffect(() => { if (selected && (!draft || (draft.id && draft.id !== selected.id))) setDraft(structuredClone(selected)); /* load selection into the editor */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const onErr = (e: unknown) => toast(e instanceof ApiError ? e.message : 'Could not save', 'alert');
  const strip = (a: Automation) => ({ name: a.name, active: a.active, trigger: a.trigger, triggerConfig: a.triggerConfig, steps: a.steps, stopOnReply: a.stopOnReply, stopOnBooking: a.stopOnBooking, stopOnWonLost: a.stopOnWonLost, businessHoursOnly: a.businessHoursOnly });
  const save = useMutation({
    mutationFn: (a: Automation) => (a.id ? api<Automation>(`/automations/${a.id}`, { method: 'PUT', json: strip(a) }) : api<Automation>('/automations', { method: 'POST', json: strip(a) })),
    onSuccess: (a) => { qc.invalidateQueries({ queryKey: ['automations'] }); setSelId(a.id); setDraft({ ...a, stats: draft?.stats }); toast('Automation saved'); },
    onError: onErr,
  });
  const toggle = useMutation({
    mutationFn: (a: Automation) => api(`/automations/${a.id}`, { method: 'PUT', json: { ...strip(a), active: !a.active } }),
    onSuccess: (_r, a) => { qc.invalidateQueries({ queryKey: ['automations'] }); if (draft?.id === a.id) setDraft({ ...draft, active: !a.active }); toast(`${a.name} ${a.active ? 'paused' : 'turned on'}`); },
    onError: onErr,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/automations/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['automations'] }); setSelId(null); setDraft(null); setConfirmDel(false); toast('Automation deleted'); },
  });

  if (!data) return <Loading />;
  const d = draft;
  const dirty = !!d && (!d.id || JSON.stringify(strip(d)) !== JSON.stringify(strip(list.find((a) => a.id === d.id) ?? d)));
  const setStep = (i: number, s: Step) => d && setDraft({ ...d, steps: d.steps.map((x, j) => (j === i ? s : x)) });
  const move = (i: number, dir: -1 | 1) => { if (!d) return; const s = [...d.steps]; const j = i + dir; if (j < 0 || j >= s.length) return; [s[i], s[j]] = [s[j], s[i]]; setDraft({ ...d, steps: s }); };

  return (
    <>
      <PageHead title="Automations" sub="Trigger → wait → action flows. A flow stops when the lead replies, books, or is won/lost, and only sends during business hours."
        actions={<button className="btn primary" onClick={() => { setSelId(null); setDraft(blank()); }}><Icon name="plus" className="sm" />New automation</button>} />
      <div className="auto-layout">
        <section className="panel">
          <div className="panel-h"><h2>Flows</h2><small className="muted">{list.filter((a) => a.active).length} active</small></div>
          {list.map((a) => (
            <div key={a.id} className={`flow-card ${d?.id === a.id ? 'on' : ''}`} onClick={() => { setSelId(a.id); setDraft(structuredClone(a)); }}>
              <div className="row"><b>{a.name}</b>
                <label className="switch" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={a.active} onChange={() => toggle.mutate(a)} aria-label={`${a.name} active`} /><span /></label></div>
              <small className="muted"><Icon name="zap" className="sm" /> {TLABEL[a.trigger]} · {a.steps.length} steps · {a.stats?.active ?? 0} in flow · {a.stats?.completed ?? 0} finished</small>
            </div>
          ))}
          {!list.length && <div className="empty">No automations yet.</div>}
        </section>

        {d && (
          <section className="panel">
            <div className="panel-h">
              <input className="input" style={{ fontFamily: 'var(--f-display)', fontWeight: 700, fontSize: 17, borderColor: 'transparent', paddingLeft: 0, flex: 1, minWidth: 180 }} value={d.name} onChange={(e) => setDraft({ ...d, name: e.target.value })} aria-label="Automation name" />
              <div className="row">
                <label className="check"><input type="checkbox" checked={d.active} onChange={(e) => setDraft({ ...d, active: e.target.checked })} />Active</label>
                {d.id && <button className="btn sm" onClick={() => setRuns(true)}>Activity</button>}
                <button className="btn primary sm" disabled={!dirty || save.isPending || !d.name.trim()} onClick={() => save.mutate(d)}>{d.id ? 'Save' : 'Create'}</button>
              </div>
            </div>
            <div className="panel-b">
              <div className="flow">
                <div className="node trigger"><span className="kind">Trigger</span>
                  <select className="input" value={d.trigger} onChange={(e) => setDraft({ ...d, trigger: e.target.value as Trigger, triggerConfig: {} })} aria-label="Trigger">{TRIGGERS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
                  {d.trigger === 'stage_change' && <select className="input" value={d.triggerConfig.stages?.[0] ?? ''} onChange={(e) => setDraft({ ...d, triggerConfig: { stages: e.target.value ? [e.target.value as Stage] : [] } })} aria-label="Stage"><option value="">Any stage</option>{STAGES.map((s) => <option key={s.k} value={s.k}>Enters {s.n}</option>)}</select>}
                  {d.trigger === 'call_result' && <select className="input" value={d.triggerConfig.results?.[0] ?? ''} onChange={(e) => setDraft({ ...d, triggerConfig: { results: e.target.value ? [e.target.value as CallResult] : [] } })} aria-label="Result"><option value="">Any result</option>{RESULTS.map((r) => <option key={r.k} value={r.k}>{r.n}</option>)}</select>}
                  {d.trigger === 'renewal_date' && <input className="input" value={(d.triggerConfig.daysBefore ?? []).join(', ')} placeholder="Days before, e.g. 60, 30" onChange={(e) => setDraft({ ...d, triggerConfig: { daysBefore: e.target.value.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !Number.isNaN(n)) } })} aria-label="Days before renewal" />}
                </div>
                {d.steps.map((s, i) => (
                  <div key={i} style={{ display: 'contents' }}>
                    <div className="connector" />
                    <StepNode step={s} onChange={(x) => setStep(i, x)} onRemove={() => setDraft({ ...d, steps: d.steps.filter((_, j) => j !== i) })} onUp={() => move(i, -1)} onDown={() => move(i, 1)} />
                  </div>
                ))}
              </div>
              <div className="row" style={{ marginTop: 14, justifyContent: 'center' }}>
                <button className="btn sm" onClick={() => setDraft({ ...d, steps: [...d.steps, { type: 'wait', amount: 1, unit: 'days' }] })}><Icon name="clock" className="sm" />Add wait</button>
                <button className="btn sm" onClick={() => setDraft({ ...d, steps: [...d.steps, { type: 'action', action: 'send_sms' }] })}><Icon name="zap" className="sm" />Add action</button>
                <button className="btn sm" onClick={() => setDraft({ ...d, steps: [...d.steps, { type: 'condition', condition: 'not_replied' }] })}><Icon name="flag" className="sm" />Add condition</button>
              </div>
              <div className="sep" />
              <div className="stack" style={{ gap: 8 }}>
                <div className="lbl-sm">Stop this flow when the lead…</div>
                <label className="check"><input type="checkbox" checked={d.stopOnReply} onChange={(e) => setDraft({ ...d, stopOnReply: e.target.checked })} />replies by SMS or email</label>
                <label className="check"><input type="checkbox" checked={d.stopOnBooking} onChange={(e) => setDraft({ ...d, stopOnBooking: e.target.checked })} />books an appointment</label>
                <label className="check"><input type="checkbox" checked={d.stopOnWonLost} onChange={(e) => setDraft({ ...d, stopOnWonLost: e.target.checked })} />is won or lost</label>
                <p className="help">Opting out (STOP) always ends every flow.</p>
                <label className="check"><input type="checkbox" checked={d.businessHoursOnly} onChange={(e) => setDraft({ ...d, businessHoursOnly: e.target.checked })} />Only send messages during business hours (set in Settings)</label>
              </div>
              {d.id && <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
                {confirmDel ? <button className="btn sm danger" onClick={() => del.mutate(d.id)}>Confirm delete</button> : <button className="btn sm danger" onClick={() => setConfirmDel(true)}><Icon name="trash" className="sm" />Delete automation</button>}
              </div>}
            </div>
          </section>
        )}
      </div>
      {runs && d?.id && <RunsModal automation={d} onClose={() => setRuns(false)} />}
    </>
  );
}

function StepNode({ step: s, onChange, onRemove, onUp, onDown }: { step: Step; onChange: (s: Step) => void; onRemove: () => void; onUp: () => void; onDown: () => void }) {
  const tpls = useTemplates();
  const tools = (
    <span className="row" style={{ gap: 4, marginLeft: 'auto', flexWrap: 'nowrap' }}>
      <button className="icon-btn sm" onClick={onUp} aria-label="Move up"><Icon name="left" className="sm rot90" /></button>
      <button className="icon-btn sm" onClick={onDown} aria-label="Move down"><Icon name="right" className="sm rot90" /></button>
      <button className="icon-btn sm" onClick={onRemove} aria-label="Remove step"><Icon name="trash" className="sm" /></button>
    </span>
  );
  if (s.type === 'wait') return (
    <div className="node wait"><span className="kind">Wait</span>
      <input type="number" min={0} className="input num-in" value={s.amount} onChange={(e) => onChange({ ...s, amount: Math.max(0, Number(e.target.value)) })} aria-label="Amount" />
      <select className="input" value={s.unit} onChange={(e) => onChange({ ...s, unit: e.target.value as typeof s.unit })} aria-label="Unit">{['minutes', 'hours', 'days', 'weeks', 'months'].map((u) => <option key={u}>{u}</option>)}</select>{tools}
    </div>
  );
  if (s.type === 'condition') return (
    <div className="node cond"><span className="kind">Only if</span>
      <select className="input" value={s.condition} onChange={(e) => onChange({ ...s, condition: e.target.value as Condition })} aria-label="Condition">{CONDITIONS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
      <small className="muted">otherwise the flow ends</small>{tools}
    </div>
  );
  const channel = s.action === 'send_email' ? 'email' : 'sms';
  return (
    <div className="node action"><span className="kind">Action</span>
      <select className="input" value={s.action} onChange={(e) => onChange({ type: 'action', action: e.target.value as Action })} aria-label="Action">{ACTIONS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
      {MSG_ACTIONS.includes(s.action) && <select className="input" value={s.templateId ?? ''} onChange={(e) => onChange({ ...s, templateId: e.target.value || null })} aria-label="Template">
        <option value="">Default message</option>{(tpls.data ?? []).filter((t) => t.channel === channel).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
      {s.action === 'change_stage' && <select className="input" value={s.stage ?? ''} onChange={(e) => onChange({ ...s, stage: e.target.value as Stage })} aria-label="Stage"><option value="">Choose stage…</option>{STAGES.map((x) => <option key={x.k} value={x.k}>{x.n}</option>)}</select>}
      {(s.action === 'create_task' || s.action === 'alert_team') && <input className="input" value={s.text ?? ''} onChange={(e) => onChange({ ...s, text: e.target.value })} placeholder={s.action === 'create_task' ? 'Task title' : 'Alert text'} aria-label="Text" />}
      {tools}
    </div>
  );
}

function RunsModal({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['runs', automation.id], queryFn: () => api<Run[]>(`/automations/${automation.id}/runs`), refetchInterval: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Modal wide title={`${automation.name} · activity`} onClose={onClose}>
      {!data ? <Loading /> : !data.length ? <p className="muted">No one has entered this flow yet.</p> : (
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Contact</th><th>Status</th><th>Step</th><th>Next</th><th>Updated</th></tr></thead><tbody>
          {data.map((r) => (
            <Fragment key={r.id}>
              <tr className="click" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <td>{r.contact}</td>
                <td>{r.status === 'active' ? <Pill color="--info">In flow</Pill> : r.status === 'completed' ? <Pill color="--ok">Finished</Pill> : <Pill color="--s9">Stopped · {r.stopReason?.replace('_', ' ')}</Pill>}</td>
                <td className="num">{Math.min(r.stepIndex + 1, automation.steps.length)} / {automation.steps.length}</td>
                <td>{r.status === 'active' ? fdt(r.nextRunAt) : '—'}</td><td className="muted">{ago(r.updatedAt)}</td>
              </tr>
              {open === r.id && <tr><td colSpan={5}><div className="list">{r.log.map((l, i) => <div key={i} className="li"><span className="time">{new Date(l.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span><div className="grow"><small>{l.text}</small></div></div>)}</div></td></tr>}
            </Fragment>
          ))}
        </tbody></table></div>
      )}
    </Modal>
  );
}
