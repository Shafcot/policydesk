// Idle mode: with IDLE_SLEEP_MINUTES set, the app stops touching the database after that long without requests.
import { describe, expect, it, vi } from 'vitest';

describe('idle mode', () => {
  it('sleeps after the idle window, wakes on activity, and is off unless configured', async () => {
    vi.resetModules();
    delete process.env.IDLE_SLEEP_MINUTES;
    const off = await import('../src/services/activity.js');
    expect(off.idleMode).toBe(false);
    expect(off.sleeping()).toBe(false);

    vi.resetModules();
    process.env.IDLE_SLEEP_MINUTES = '10';
    vi.useFakeTimers();
    const a = await import('../src/services/activity.js');
    expect(a.sleeping()).toBe(false);
    vi.advanceTimersByTime(11 * 60_000);
    expect(a.sleeping()).toBe(true);
    a.touch();
    expect(a.sleeping()).toBe(false);
    vi.useRealTimers();
    delete process.env.IDLE_SLEEP_MINUTES;
  });
});
