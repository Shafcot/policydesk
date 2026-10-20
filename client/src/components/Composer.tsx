import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { bookingLink, fillTemplate, useTeam, useTemplates } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { Icon } from './Icon';

type LeadLite = { id: string; firstName: string; line: string; email: string | null; optOut: boolean; agentId?: string | null; agentName?: string | null };

/** SMS / email composer with saved templates. Messages queue until Twilio/SendGrid are connected (Milestone 3). */
export function Composer({ lead, channel }: { lead: LeadLite; channel: 'sms' | 'email' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, agency } = useAuth();
  const tpls = useTemplates();
  const team = useTeam();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => api(`/leads/${lead.id}/messages`, { method: 'POST', json: { channel, subject: subject || undefined, body } }),
    onSuccess: () => { setBody(''); setSubject(''); ['lead', 'inbox'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); toast(`${channel === 'sms' ? 'Text' : 'Email'} queued. It sends once ${channel === 'sms' ? 'Twilio' : 'SendGrid'} is connected.`, channel === 'sms' ? 'msg' : 'mail'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not send', 'alert'),
  });
  if (lead.optOut) return <div className="optout"><Icon name="lock" className="sm" />This lead opted out. Messaging is disabled.</div>;
  if (channel === 'email' && !lead.email) return <p className="help">This lead has no email address. Add one on the lead page to send email.</p>;
  const agentName = lead.agentName ?? user?.name ?? '';
  const useTpl = (id: string) => {
    const t = tpls.data?.find((x) => x.id === id); if (!t) return;
    const owner = (team.data ?? []).find((u) => u.id === (lead.agentId ?? user?.id));
    const v = { first: lead.firstName, agent: agentName, agency: agency?.name ?? '', line: lead.line, booking: bookingLink(owner?.bookingSlug ?? user?.bookingSlug) };
    setBody(fillTemplate(t.body, v)); if (t.subject) setSubject(fillTemplate(t.subject, v));
  };
  return (
    <div className="composer">
      <select className="input" value="" onChange={(e) => useTpl(e.target.value)} aria-label="Insert template">
        <option value="">Insert template…</option>
        {(tpls.data ?? []).filter((t) => t.channel === channel).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      {channel === 'email' && <input className="input" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />}
      <textarea className="input" placeholder={channel === 'sms' ? 'Text message' : 'Email body'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
      <div className="row between"><small className="muted">{channel === 'sms' ? `${body.length} characters` : 'Replies land in the inbox'}</small>
        <button className="btn primary sm" disabled={!body.trim() || send.isPending} onClick={() => send.mutate()}>Send {channel === 'sms' ? 'SMS' : 'email'}</button></div>
    </div>
  );
}
