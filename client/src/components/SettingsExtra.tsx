// Settings tabs added from the client's demo-call feedback: target month, call scripts, carriers,
// phone menu (main number) + missed-call text, and AI texting.
import { useState } from 'react';
import { LINES } from '../lib/domain';
import { useTeam, type CallScript } from '../lib/hooks';
import { Icon } from './Icon';
import { prettyNumber, useNumbers } from './NumberPicker';

export type PhoneMenuOption = { digit: string; label: string; userIds: string[] };
export type PhoneMenu = { enabled: boolean; mainNumber: string; greeting: string; options: PhoneMenuOption[]; defaultUserIds: string[]; afterHoursMessage: string };
export type ExtraSettings = {
  agentTargetsVisible: boolean; targetStartDay: number; carriers: string[]; callScripts: Record<string, CallScript>;
  phoneMenu: PhoneMenu; missedCallText: string; missedCallTextOn: boolean; aiConversations: boolean; aiMaxTurns: number; screeningQuestions: string[];
};
type Props<K extends keyof ExtraSettings> = { s: Pick<ExtraSettings, K>; set: <T extends K>(k: T, v: ExtraSettings[T]) => void };

const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function TargetSettings({ s, set }: Props<'targetStartDay' | 'agentTargetsVisible'>) {
  const d = s.targetStartDay;
  return (
    <>
      <h2>Targets</h2>
      <div className="field"><label htmlFor="t-day">Target month starts on the</label>
        <select id="t-day" className="input" style={{ maxWidth: 220 }} value={d} onChange={(e) => set('targetStartDay', Number(e.target.value))}>
          {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{ord(n)}{n === 1 ? ' (calendar month)' : ''}</option>)}
        </select>
        <small className="help">{d === 1 ? 'Targets run by calendar month.' : `Targets run from the ${ord(d)} to the ${ord(d - 1)}, e.g. Sept ${d} – Oct ${d - 1}. Dashboard, Targets and Reports all use this.`}</small>
      </div>
      <label className="check"><input type="checkbox" checked={s.agentTargetsVisible} onChange={(e) => set('agentTargetsVisible', e.target.checked)} />Agents can see other agents’ individual targets</label>
      <p className="help">Agents always see their own target and the team target. Set the team target and each agent’s target on the Targets page.</p>
    </>
  );
}

export function ScriptSettings({ s, set }: Props<'callScripts'>) {
  const keys = ['*', ...LINES];
  const [line, setLine] = useState<string>('*');
  const cur: CallScript = s.callScripts[line] ?? { opening: '', objections: [] };
  const put = (v: CallScript | null) => { const next = { ...s.callScripts }; if (v) next[line] = v; else delete next[line]; set('callScripts', next); };
  const has = (k: string) => !!s.callScripts[k] && (s.callScripts[k].opening || s.callScripts[k].objections.length);
  return (
    <>
      <h2>Call scripts</h2>
      <p className="help">Shown in the call screen. On the first call with a lead it opens automatically. Agents can open it on any call. A policy type without its own script uses “All policy types”. Placeholders: {'{first}'} {'{agent}'} {'{agency}'} {'{line}'}.</p>
      <div className="chips">{keys.map((k) => <button key={k} className={`chip ${line === k ? 'on' : ''}`} onClick={() => setLine(k)}>{k === '*' ? 'All policy types' : k}{has(k) && k !== '*' ? ' •' : ''}</button>)}</div>
      {line !== '*' && !s.callScripts[line] && <p className="help">No {line} script yet, so agents see the “All policy types” script. <button className="btn sm" onClick={() => put({ ...(s.callScripts['*'] ?? { opening: '', objections: [] }) })}>Start from it</button></p>}
      <div className="field"><label htmlFor="sc-open">Conversation opening</label><textarea id="sc-open" className="input" rows={4} value={cur.opening} onChange={(e) => put({ ...cur, opening: e.target.value })} placeholder="Hi {first}, this is {agent} with {agency}…" /></div>
      <div className="lbl-sm">Objection handling</div>
      {cur.objections.map((o, i) => (
        <div className="objection" key={i}>
          <input className="input" value={o.q} placeholder="When they say…" onChange={(e) => put({ ...cur, objections: cur.objections.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)) })} aria-label={`Objection ${i + 1}`} />
          <textarea className="input" rows={2} value={o.a} placeholder="You answer…" onChange={(e) => put({ ...cur, objections: cur.objections.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)) })} aria-label={`Answer ${i + 1}`} />
          <button className="icon-btn sm" onClick={() => put({ ...cur, objections: cur.objections.filter((_, j) => j !== i) })} aria-label="Remove objection"><Icon name="trash" className="sm" /></button>
        </div>
      ))}
      <div className="row"><button className="btn sm" onClick={() => put({ ...cur, objections: [...cur.objections, { q: '', a: '' }] })}><Icon name="plus" className="sm" />Add objection</button>
        {line !== '*' && s.callScripts[line] && <button className="btn sm ghost danger" onClick={() => put(null)}>Remove {line} script</button>}</div>
    </>
  );
}

export function CarrierSettings({ s, set, fallback }: Props<'carriers'> & { fallback: string[] }) {
  const list = s.carriers.length ? s.carriers : fallback;
  const [text, setText] = useState('');
  const add = () => { const v = text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean); if (v.length) { set('carriers', [...new Set([...list, ...v])]); setText(''); } };
  return (
    <>
      <h2>Carriers</h2>
      <p className="help">The carriers agents pick from when recording a policy. Paste several at once, separated by commas or new lines.</p>
      <div className="chips">{list.map((c) => <span className="chip on" key={c}>{c}<button className="chip-x" onClick={() => set('carriers', list.filter((x) => x !== c))} aria-label={`Remove ${c}`}>×</button></span>)}</div>
      <div className="row"><textarea className="input" rows={2} style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Progressive, Travelers, Safeco" aria-label="Add carriers" />
        <button className="btn" disabled={!text.trim()} onClick={add}><Icon name="plus" className="sm" />Add</button></div>
      {!s.carriers.length && <p className="help">Showing the starter list. Your changes replace it.</p>}
    </>
  );
}

export function PhoneMenuSettings({ s, set }: Props<'phoneMenu' | 'missedCallText' | 'missedCallTextOn'>) {
  const team = useTeam();
  const nums = useNumbers();
  const m = s.phoneMenu;
  const put = (v: Partial<PhoneMenu>) => set('phoneMenu', { ...m, ...v });
  const people = (team.data ?? []).filter((u) => !u.invited);
  const used = new Set(m.options.map((o) => o.digit));
  const nextDigit = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].find((d) => !used.has(d));
  const Picker = ({ ids, onChange, label }: { ids: string[]; onChange: (v: string[]) => void; label: string }) => (
    <div className="chips" role="group" aria-label={label}>{people.map((u) => <button type="button" key={u.id} className={`chip ${ids.includes(u.id) ? 'on' : ''}`} onClick={() => onChange(ids.includes(u.id) ? ids.filter((x) => x !== u.id) : [...ids, u.id])}>{u.name}</button>)}</div>
  );
  return (
    <>
      <h2>Phone menu (main number)</h2>
      <p className="help">Callers to the main number hear a menu (“Press 1 for …”) and ring the first available person you pick for that option. Anyone on a call or offline is skipped. If nobody is free, the caller leaves a voicemail for that person. Outside business hours callers hear the after-hours message and leave a voicemail.</p>
      <label className="check"><input type="checkbox" checked={m.enabled} onChange={(e) => put({ enabled: e.target.checked })} />Use a phone menu on the main number</label>
      <div className="field"><label htmlFor="pm-num">Main agency number</label>
        <select id="pm-num" className="input" value={m.mainNumber} onChange={(e) => put({ mainNumber: e.target.value })}>
          <option value="">Pick a number…</option>
          {(nums.data?.numbers ?? []).map((n) => <option key={n.id} value={n.number}>{prettyNumber(n.number)}{n.label ? ` · ${n.label}` : ''}{n.userName ? ` (assigned to ${n.userName})` : ''}</option>)}
        </select>
        <small className="help">Add or buy numbers on the Phone numbers page. Best practice: a number not assigned to one agent.</small></div>
      <div className="field"><label htmlFor="pm-greet">Greeting</label><input id="pm-greet" className="input" value={m.greeting} onChange={(e) => put({ greeting: e.target.value })} /><small className="help">The options are read out after it, e.g. “For auto and home, press 1.”</small></div>
      <div className="lbl-sm">Menu options</div>
      {m.options.map((o, i) => (
        <div className="menu-opt" key={i}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="key-badge">{o.digit}</span>
            <input className="input" value={o.label} placeholder="e.g. auto and home insurance" onChange={(e) => put({ options: m.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} aria-label={`Option ${o.digit} label`} />
            <button className="icon-btn sm" onClick={() => put({ options: m.options.filter((_, j) => j !== i) })} aria-label={`Remove option ${o.digit}`}><Icon name="trash" className="sm" /></button>
          </div>
          <Picker label={`Who answers option ${o.digit}`} ids={o.userIds} onChange={(v) => put({ options: m.options.map((x, j) => (j === i ? { ...x, userIds: v } : x)) })} />
        </div>
      ))}
      {nextDigit && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => put({ options: [...m.options, { digit: nextDigit, label: '', userIds: [] }] })}><Icon name="plus" className="sm" />Add option {nextDigit}</button>}
      <div className="field"><label>If the caller presses nothing</label><Picker label="Default people" ids={m.defaultUserIds} onChange={(v) => put({ defaultUserIds: v })} />
        <small className="help">{m.defaultUserIds.length ? 'Rings these people (first available).' : 'Rings any available agent. Known leads go to their own agent first.'}</small></div>
      <div className="field"><label htmlFor="pm-after">After-hours message</label><textarea id="pm-after" className="input" rows={2} value={m.afterHoursMessage} onChange={(e) => put({ afterHoursMessage: e.target.value })} /></div>
      <div className="sep" /><h3>Missed-call text</h3>
      <label className="check"><input type="checkbox" checked={s.missedCallTextOn} onChange={(e) => set('missedCallTextOn', e.target.checked)} />Text callers we miss (or who call after hours) a link to book a time</label>
      <div className="field"><label htmlFor="mc-text">Text</label><textarea id="mc-text" className="input" rows={3} value={s.missedCallText} onChange={(e) => set('missedCallText', e.target.value)} /><small className="help">{'{booking}'} = the booking link of the agent they were calling; {'{agency}'} = agency name. Sent at most once every 12 hours per number. Unknown callers are added as leads (source “Inbound call”).</small></div>
    </>
  );
}

export function AiTextingSettings({ s, set }: Props<'aiConversations' | 'aiMaxTurns' | 'screeningQuestions'>) {
  return (
    <>
      <h2>AI texting</h2>
      <p className="help">When a lead texts or emails back, the AI answers, asks a screening question if needed, offers the agent’s real free times and books the one the lead picks into the agent’s calendar. It never quotes prices. It hands over to the agent when the lead asks for a person, after the reply limit, or as soon as the agent replies by hand. Needs OpenAI (Settings → Integrations). AI is used for texting only, not voice calls.</p>
      <label className="check"><input type="checkbox" checked={s.aiConversations} onChange={(e) => set('aiConversations', e.target.checked)} />Let the AI answer lead replies and book appointments</label>
      <div className="field"><label htmlFor="ai-max">Hand over to the agent after</label><div className="row"><input id="ai-max" className="input num" type="number" min={1} max={30} style={{ width: 90 }} value={s.aiMaxTurns} onChange={(e) => set('aiMaxTurns', Number(e.target.value))} /><span className="muted">AI replies per lead</span></div></div>
      <div className="lbl-sm">Screening questions</div>
      <p className="help">The AI asks these (one at a time) when it needs more detail. The first reply to a brand-new lead uses them too.</p>
      {s.screeningQuestions.map((q, i) => <div className="row" key={i} style={{ flexWrap: 'nowrap' }}><input className="input" value={q} onChange={(e) => set('screeningQuestions', s.screeningQuestions.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Question ${i + 1}`} /><button className="icon-btn sm" onClick={() => set('screeningQuestions', s.screeningQuestions.filter((_, j) => j !== i))} aria-label="Remove question"><Icon name="trash" className="sm" /></button></div>)}
      {s.screeningQuestions.length < 6 && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => set('screeningQuestions', [...s.screeningQuestions, ''])}><Icon name="plus" className="sm" />Add question</button>}
    </>
  );
}
