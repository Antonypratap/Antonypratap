import { describe, expect, it } from 'vitest';
import { HERO_STEPS, HERO_TASKS, heroStateAt } from './heroTimeline';

describe('hero story: the work disappears', () => {
  it('starts before the invoice arrives', () => {
    const s = heroStateAt(0);
    expect(s.arrived).toBe(false);
    expect(s.remaining).toBe(HERO_TASKS.length);
  });

  it('arrives with all the work still attached', () => {
    const s = heroStateAt(1);
    expect(s.arrived).toBe(true);
    expect(s.tasks.every((t) => t.status === 'todo')).toBe(true);
  });

  it('takes the work away one task at a time', () => {
    expect(heroStateAt(3).tasks.map((t) => t.status)).toEqual([
      'done',
      'done',
      'todo',
      'todo',
      'todo',
      'todo',
    ]);
    expect(heroStateAt(3).remaining).toBe(4);
  });

  it('leaves exactly one decision, then shows it to the team', () => {
    const worked = heroStateAt(HERO_TASKS.length + 1);
    expect(worked.tasks.map((t) => t.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'decision',
      'done',
    ]);
    expect(worked.remaining).toBe(1);
    expect(worked.showDecision).toBe(false);
    expect(heroStateAt(HERO_TASKS.length + 2).showDecision).toBe(true);
    expect(heroStateAt(HERO_STEPS).settled).toBe(true);
  });

  it('clamps out-of-range steps', () => {
    expect(heroStateAt(99)).toEqual(heroStateAt(HERO_STEPS));
    expect(heroStateAt(-2)).toEqual(heroStateAt(0));
  });
});
