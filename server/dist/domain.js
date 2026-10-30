// Business vocabulary shared by the API. The client mirrors these in client/src/lib/domain.ts.
export const STAGES = ['new', 'attempted', 'followup', 'ready', 'quoted', 'won', 'lost', 'requote', 'recycled'];
export const STAGE_LABELS = {
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
export const CALL_RESULTS = ['no_answer', 'left_msg', 'voicemail', 'call_back', 'needs_quote', 'quoted', 'sold', 'lost'];
/** Results where the lead was not actually reached. */
export const NOT_REACHED = ['no_answer', 'left_msg', 'voicemail'];
/** SOW section 6: call result → pipeline stage. */
export const RESULT_STAGE = {
    no_answer: 'attempted',
    left_msg: 'attempted',
    voicemail: 'attempted',
    call_back: 'followup',
    needs_quote: 'ready',
    quoted: 'quoted',
    sold: 'won',
    lost: 'lost',
};
export const ROLES = ['admin', 'agent'];
export const AGENT_STATUSES = ['available', 'oncall', 'offline'];
export const PERSONAL_LINES = ['Auto', 'Home', 'Renters', 'Life', 'Umbrella'];
export const COMMERCIAL_LINES = ['Commercial Auto', 'General Liability', 'Workers Comp', 'BOP'];
export const LINES = [...PERSONAL_LINES, ...COMMERCIAL_LINES];
export const lineType = (line) => COMMERCIAL_LINES.includes(line) ? 'commercial' : 'personal';
export const DEFAULT_SETTINGS = {
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
};
export const CARRIERS = ['Progressive', 'Travelers', 'Safeco', 'Nationwide', 'The Hartford', 'Liberty Mutual', 'Hiscox'];
/* ---------- automations (SOW 4) ---------- */
export const TRIGGERS = ['new_lead', 'stage_change', 'call_result', 'missed_appointment', 'policy_won', 'renewal_date', 'birthday'];
export const ACTIONS = ['send_sms', 'send_email', 'create_task', 'change_stage', 'assign_agent', 'send_booking_link', 'send_review_request', 'ai_reply', 'alert_team'];
export const CONDITIONS = ['no_agent_available', 'not_replied', 'is_commercial', 'is_personal'];
export const UNIT_MS = { minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5, months: 2592e6 };
//# sourceMappingURL=domain.js.map