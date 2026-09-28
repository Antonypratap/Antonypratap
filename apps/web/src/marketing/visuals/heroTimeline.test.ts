import { describe, expect, it } from 'vitest';
import { HERO_STEPS, heroStateAt } from './heroTimeline';

describe('hero preview timeline', () => {
  it('starts empty', () => {
    const s = heroStateAt(0);
    expect(s.stage).toBeNull();
    expect(s.rows.every((r) => !r.visible)).toBe(true);
  });

  it('invoices arrive one by one as received', () => {
    const s = heroStateAt(3);
    expect(s.stage).toBe('arrive');
    expect(s.rows.map((r) => r.visible)).toEqual([true, true, true, false, false]);
    expect(s.rows.every((r) => r.status === 'received')).toBe(true);
  });

  it('then each is handled, and exactly one needs a person', () => {
    const s = heroStateAt(10);
    expect(s.stage).toBe('handle');
    expect(s.rows.map((r) => r.status)).toEqual([
      'handled',
      'handled',
      'handled',
      'attention',
      'handled',
    ]);
    expect(s.showCallout).toBe(false);
  });

  it('the exception reaches the team before the rest is ready', () => {
    const people = heroStateAt(11);
    expect(people.stage).toBe('people');
    expect(people.showCallout).toBe(true);
    expect(people.showReady).toBe(false);
    const done = heroStateAt(HERO_STEPS);
    expect(done.stage).toBe('ready');
    expect(done.counts).toEqual({ arrived: 5, handled: 4, people: 1, ready: 4 });
  });

  it('clamps out-of-range steps', () => {
    expect(heroStateAt(99)).toEqual(heroStateAt(HERO_STEPS));
    expect(heroStateAt(-3)).toEqual(heroStateAt(0));
  });
});
