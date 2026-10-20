// Business vocabulary shared by the API. The client mirrors these in client/src/lib/domain.ts.

export const STAGES = ['new', 'attempted', 'followup', 'ready', 'quoted', 'won', 'lost', 'requote', 'recycled'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'New',
  attempted: 'Contact Attempted',
  followup: 'Needs Follow-Up',
  ready: 'Ready to Quote',
  quoted: 'Quoted',
  won: 'Won',
  lost: 'Lost',
  requote: 'Ready for Re-Quote',
  recycled: 'Recycled',
};

export const CALL_RESULTS = ['no_answer', 'left_msg', 'voicemail', 'call_back', 'needs_quote', 'quoted', 'sold', 'lost'] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

/** Results where the lead was not actually reached. */
export const NOT_REACHED: readonly CallResult[] = ['no_answer', 'left_msg', 'voicemail'];

/** SOW section 6: call result → pipeline stage. */
export const RESULT_STAGE: Record<CallResult, Stage> = {
  no_answer: 'attempted',
  left_msg: 'attempted',
  voicemail: 'attempted',
  call_back: 'followup',
  needs_quote: 'ready',
  quoted: 'quoted',
  sold: 'won',
  lost: 'lost',
};

export const ROLES = ['admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_STATUSES = ['available', 'oncall', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const PERSONAL_LINES = ['Auto', 'Home', 'Renters', 'Life', 'Umbrella'] as const;
export const COMMERCIAL_LINES = ['Commercial Auto', 'General Liability', 'Workers Comp', 'BOP'] as const;
export const LINES = [...PERSONAL_LINES, ...COMMERCIAL_LINES] as const;
export const lineType = (line: string): 'personal' | 'commercial' =>
  (COMMERCIAL_LINES as readonly string[]).includes(line) ? 'commercial' : 'personal';

export type AgencySettings = {
  assignRule: 'round_robin' | 'availability' | 'line';
  skipOffline: boolean;
  skipAtLimit: boolean;
  attemptsDay1: number;
  attemptsPerDay: number;
  maxAttempts: number;
  retryHours: number;
  requoteMonths: number;
  autoRequote: boolean;
  autoRecycle: boolean;
  teamTarget: number;
  teamTargetVisible: boolean;
  businessDays: string[];
  businessOpen: string;
  businessClose: string;
  timezone: string;
  reviewLinks: { google: string; facebook: string; yelp: string };
  optOutKeywords: string[];
};

export const DEFAULT_SETTINGS: AgencySettings = {
  assignRule: 'round_robin',
  skipOffline: true,
  skipAtLimit: true,
  attemptsDay1: 3,
  attemptsPerDay: 1,
  maxAttempts: 8,
  retryHours: 2,
  requoteMonths: 5,
  autoRequote: true,
  autoRecycle: true,
  teamTarget: 240000,
  teamTargetVisible: true,
  businessDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  businessOpen: '08:00',
  businessClose: '18:00',
  timezone: 'America/Chicago',
  reviewLinks: { google: '', facebook: '', yelp: '' },
  optOutKeywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
};

export const CARRIERS = ['Progressive', 'Travelers', 'Safeco', 'Nationwide', 'The Hartford', 'Liberty Mutual', 'Hiscox'] as const;
