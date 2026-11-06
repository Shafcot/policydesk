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

export const CALL_RESULTS = ['no_answer', 'voicemail', 'sent_text', 'call_back', 'needs_quote', 'quoted', 'sold', 'lost'] as const;
export type CallResult = (typeof CALL_RESULTS)[number];

/** Results where the lead was not actually reached. */
export const NOT_REACHED: readonly CallResult[] = ['no_answer', 'voicemail', 'sent_text'];

/** SOW section 6: call result → pipeline stage. */
export const RESULT_STAGE: Record<CallResult, Stage> = {
  no_answer: 'attempted',
  sent_text: 'attempted',
  voicemail: 'attempted',
  call_back: 'followup',
  needs_quote: 'ready',
  quoted: 'quoted',
  sold: 'won',
  lost: 'lost',
};

/** Bad-lead categories (client request): kept out of the dialer queue and automations, reported in Admin. */
export const BAD_REASONS = ['bad_number', 'unreachable', 'dns', 'dnc'] as const;
export type BadReason = (typeof BAD_REASONS)[number];
export const BAD_REASON_LABELS: Record<BadReason, string> = {
  bad_number: 'Bad number',
  unreachable: 'Unreachable',
  dns: 'Do Not Solicit',
  dnc: 'Do Not Call',
};
/** These also opt the lead out of texts/emails and block calling. */
export const BLOCKING_BAD: readonly BadReason[] = ['dns', 'dnc'];

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
  /** Legacy (agents now always see the team target). */
  teamTargetVisible: boolean;
  /** Agents can see other agents' individual targets. Agents always see their own and the team target. */
  agentTargetsVisible: boolean;
  /** Day of the month the agency's target month starts (e.g. 20 → Sept 20 – Oct 19). */
  targetStartDay: number;
  businessDays: string[];
  businessOpen: string;
  businessClose: string;
  timezone: string;
  reviewLinks: { google: string; facebook: string; yelp: string };
  optOutKeywords: string[];
  customFields: { key: string; label: string; type: 'text' | 'number' | 'date' }[];
  reminderMinutes: number;
  /** Speed-to-lead screening questions used by the AI reply (SOW 4). */
  screeningQuestions: string[];
  /** Carriers offered when recording a policy. */
  carriers: string[];
  /** Call scripts shown in the call screen. Key "*" = all policy types; otherwise a line of insurance. */
  callScripts: Record<string, CallScript>;
  /** Main number phone menu (IVR). */
  phoneMenu: PhoneMenu;
  /** Text sent to callers whose call was missed or came after hours ({booking} = booking link). */
  missedCallText: string;
  missedCallTextOn: boolean;
  /** When a lead replies, the AI holds the conversation and books them into the agent's calendar. */
  aiConversations: boolean;
  aiMaxTurns: number;
};

export type CallScript = { opening: string; objections: { q: string; a: string }[] };
export type PhoneMenuOption = { digit: string; label: string; userIds: string[] };
export type PhoneMenu = {
  enabled: boolean;
  /** E.164 main agency number (from Phone numbers). */
  mainNumber: string;
  greeting: string;
  options: PhoneMenuOption[];
  /** Caller presses nothing: ring these users (empty = any available agent). */
  defaultUserIds: string[];
  afterHoursMessage: string;
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
  teamTarget: 0, // set by the admin on the Targets page
  teamTargetVisible: true,
  businessDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  businessOpen: '08:00',
  businessClose: '18:00',
  timezone: 'America/Chicago',
  reviewLinks: { google: '', facebook: '', yelp: '' },
  optOutKeywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
  customFields: [
    { key: 'dob', label: 'Date of birth', type: 'date' },
    { key: 'zip', label: 'ZIP code', type: 'text' },
    { key: 'carrier', label: 'Current carrier', type: 'text' },
  ],
  reminderMinutes: 10,
  screeningQuestions: ['What ZIP code is the property or vehicle in?', 'Who insures you now?', 'When does your current policy renew?'],
  agentTargetsVisible: false,
  targetStartDay: 1,
  carriers: [],
  callScripts: {
    '*': {
      opening: 'Hi {first}, this is {agent} with {agency}. You asked for a {line} insurance quote, and I can get you a few options in about five minutes. Is now still a good time?',
      objections: [
        { q: 'I’m happy with my current carrier.', a: 'That’s great to hear. Most of my clients were too. It takes five minutes to compare, and if we can’t beat your coverage and price, you keep what you have. Who are you with right now?' },
        { q: 'Just send me something by email.', a: 'Happy to. To make sure the numbers are accurate, I need two or three details first. It’ll take about two minutes. What’s the ZIP code?' },
        { q: 'It’s too expensive.', a: 'Understood. Let’s look at deductibles and discounts together. Bundling and paperless often bring the price down. What monthly price were you hoping for?' },
        { q: 'I need to talk to my spouse.', a: 'Of course. Would it help if I booked a quick call when you’re both available? What time works best?' },
      ],
    },
  },
  phoneMenu: {
    enabled: false,
    mainNumber: '',
    greeting: 'Thanks for calling {agency}.',
    options: [],
    defaultUserIds: [],
    afterHoursMessage: 'Thanks for calling {agency}. We’re closed right now. Please leave a message and we’ll call you back, or book a time with the link we’re texting you.',
  },
  missedCallText: 'Hi, this is {agency}. Sorry we missed your call! Book a time that suits you here: {booking}. Reply STOP to opt out.',
  missedCallTextOn: true,
  aiConversations: true,
  aiMaxTurns: 8,
};

export const CARRIERS = ['Progressive', 'Travelers', 'Safeco', 'Nationwide', 'The Hartford', 'Liberty Mutual', 'Hiscox'] as const;

/* ---------- automations (SOW 4) ---------- */
export const TRIGGERS = ['new_lead', 'stage_change', 'call_result', 'missed_appointment', 'policy_won', 'renewal_date', 'birthday', 'inactive'] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const ACTIONS = ['send_sms', 'send_email', 'create_task', 'change_stage', 'assign_agent', 'send_booking_link', 'send_review_request', 'ai_reply', 'alert_team'] as const;
export type ActionKind = (typeof ACTIONS)[number];
export const CONDITIONS = ['no_agent_available', 'not_replied', 'not_reached', 'is_commercial', 'is_personal'] as const;
export type ConditionKind = (typeof CONDITIONS)[number];

export type TriggerConfig = {
  /** stage_change: fire when the lead enters one of these stages (empty = any). */
  stages?: Stage[];
  /** call_result: fire on these results (empty = any). */
  results?: CallResult[];
  /** renewal_date: days before renewal to fire, e.g. [60, 30]. */
  daysBefore?: number[];
  /** inactive: fire when an open lead has had no contact for this many days. */
  days?: number;
  /** stage_change only: how long the lead must stay in the stage before the flow continues is a Wait step. */
};

export type Step =
  | { type: 'wait'; amount: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months' }
  | { type: 'condition'; condition: ConditionKind }
  | { type: 'action'; action: ActionKind; templateId?: string | null; stage?: Stage; text?: string };

export const UNIT_MS = { minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5, months: 2592e6 } as const;
