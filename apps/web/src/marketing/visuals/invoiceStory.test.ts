import { describe, expect, it } from 'vitest';
import { DELIVERY_DECIDED, STORY_ROWS, STORY_STEPS, storyAt } from './invoiceStory';

const statuses = (step: number) => storyAt(step).rows.map((r) => r.status);

describe('hero story: a short delivery, caught before you pay', () => {
  it('starts on the first check, with nothing decided', () => {
    expect(statuses(0)).toEqual(['working', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(storyAt(0)).toMatchObject({ question: false, decided: false, checked: 0 });
  });

  it('works through the checks one at a time', () => {
    expect(statuses(3)).toEqual(['done', 'done', 'done', 'working', 'waiting', 'waiting']);
    expect(storyAt(3).checked).toBe(3);
  });

  it('stops at the short delivery and asks a person', () => {
    for (const step of [6, 7, 8]) {
      const s = storyAt(step);
      expect(s.question, `step ${step}`).toBe(true);
      expect(statuses(step), `step ${step}`).toEqual([
        'done',
        'done',
        'done',
        'done',
        'done',
        'ask',
      ]);
    }
  });

  it('ends with the person’s decision on record, and stays there', () => {
    const end = storyAt(STORY_STEPS);
    expect(end).toMatchObject({ question: false, decided: true });
    expect(end.rows[5]).toMatchObject({ status: 'decided', detail: DELIVERY_DECIDED });
    expect(storyAt(STORY_STEPS + 5)).toEqual(end);
    expect(storyAt(-1)).toEqual(storyAt(0));
    expect(STORY_ROWS).toHaveLength(6);
  });
});
