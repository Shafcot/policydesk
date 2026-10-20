// Mirrors server/src/domain.ts.
export const STAGES = [
  { k: 'new', n: 'New', c: '--s1' }, { k: 'attempted', n: 'Contact Attempted', c: '--s2' }, { k: 'followup', n: 'Needs Follow-Up', c: '--s3' },
  { k: 'ready', n: 'Ready to Quote', c: '--s4' }, { k: 'quoted', n: 'Quoted', c: '--s5' }, { k: 'won', n: 'Won', c: '--s6' },
  { k: 'lost', n: 'Lost', c: '--s7' }, { k: 'requote', n: 'Ready for Re-Quote', c: '--s8' }, { k: 'recycled', n: 'Recycled', c: '--s9' },
] as const;
export type Stage = (typeof STAGES)[number]['k'];
export const STG = Object.fromEntries(STAGES.map((s) => [s.k, s])) as Record<Stage, (typeof STAGES)[number]>;

export const RESULTS = [
  { k: 'no_answer', n: 'No answer', c: '--s9' }, { k: 'left_msg', n: 'Left message', c: '--s9' }, { k: 'voicemail', n: 'Voicemail', c: '--s2' },
  { k: 'call_back', n: 'Call back', c: '--s3' }, { k: 'needs_quote', n: 'Needs quote', c: '--s4' }, { k: 'quoted', n: 'Quoted', c: '--s5' },
  { k: 'sold', n: 'Sold', c: '--s6' }, { k: 'lost', n: 'Lost', c: '--s7' },
] as const;
export type CallResult = (typeof RESULTS)[number]['k'];
export const RES = Object.fromEntries(RESULTS.map((r) => [r.k, r])) as Record<CallResult, (typeof RESULTS)[number]>;

export const PERSONAL_LINES = ['Auto', 'Home', 'Renters', 'Life', 'Umbrella'];
export const COMMERCIAL_LINES = ['Commercial Auto', 'General Liability', 'Workers Comp', 'BOP'];
export const LINES = [...PERSONAL_LINES, ...COMMERCIAL_LINES];

export type Role = 'admin' | 'agent';
export type AgentStatus = 'available' | 'oncall' | 'offline';

export type User = {
  id: string; agencyId: string; name: string; email: string; phone: string | null; role: Role; status: AgentStatus;
  lines: string[]; hoursStart: string; hoursEnd: string; daysOff: string[]; minCallsPerDay: number; maxCallsPerDay: number;
  monthlyTarget: number; active: boolean; createdAt: string; callsToday?: number; invited?: boolean; bookingSlug: string | null; notifyByEmail: boolean;
};
export type Agency = { id: string; name: string; brandName: string; brandColor: string | null; logoUrl: string | null };

export type Lead = {
  id: string; firstName: string; lastName: string; company: string | null; phone: string; email: string | null;
  stage: Stage; stageChangedAt: string; source: string; agentId: string | null; line: string; type: 'personal' | 'commercial';
  attempts: number; lastAttemptAt: string | null; lastContactAt: string | null; lastCallById: string | null;
  followUpAt: string | null; callbackRequested: boolean; quotePremium: number | null; optOut: boolean; automation: string | null;
  custom: Record<string, string>; createdAt: string; flags?: string[];
};
export type Call = { id: string; startedAt: string; durationSec: number; result: CallResult; recordingUrl: string | null; summary: string | null; notes: string | null; transcript: { speaker: string; text: string }[] | null; userName: string | null };
export type Note = { id: string; body: string; createdAt: string; userName: string | null };
export type Message = { id: string; channel: 'sms' | 'email'; direction: 'in' | 'out'; subject: string | null; body: string; automated: boolean; status: string; createdAt: string };
export type Appointment = { id: string; startsAt: string; durationMin: number; type: string; status: 'scheduled' | 'done' | 'noshow' | 'cancelled'; userId: string };
export type Policy = { id: string; policyNumber: string; carrier: string; line: string; premium: number; renewalDate: string; effectiveDate: string };
export type LeadDetail = Lead & {
  agentName: string | null; lastCallByName: string | null; lockedByName: string | null;
  calls: Call[]; notes: Note[]; messages: Message[]; appointments: Appointment[]; policies: Policy[];
};
export type Notification = { id: string; kind: string; text: string; leadId: string | null; readAt: string | null; createdAt: string };
export const fullName = (l: { firstName: string; lastName: string }) => `${l.firstName} ${l.lastName}`;
