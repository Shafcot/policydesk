// Idle mode (optional): with IDLE_SLEEP_MINUTES set, the background worker and settings refresh stop touching the
// database once nobody has used the app for that many minutes, so a serverless database (e.g. Neon) can scale to
// zero and stop billing. The next request (a user opening the app, or a Twilio/lead webhook) wakes everything up.
// Leave it unset in production: automations, reminders and scheduled texts only run while the app is awake.
const minutes = Number(process.env.IDLE_SLEEP_MINUTES ?? 0);
let last = Date.now();
export const idleMode = minutes > 0;
/** Record real activity (any request except health checks). */
export function touch() { last = Date.now(); }
/** True when idle mode is on and nothing has happened for IDLE_SLEEP_MINUTES. */
export function sleeping() { return idleMode && Date.now() - last > minutes * 60_000; }
//# sourceMappingURL=activity.js.map