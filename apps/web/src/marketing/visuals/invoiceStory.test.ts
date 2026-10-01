import { describe, expect, it } from 'vitest';
import { RECEIPT_CONFIRMED, STORY_ROWS, STORY_STEPS, storyAt } from './invoiceStory';

const statuses = (step: number) => storyAt(step).rows.map((r) => r.status);

describe('hero story: one invoice, checked before you pay', () => {
  it('starts on the first check, with nothing decided', () => {
    expect(statuses(0)).toEqual(['working', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(storyAt(0)).toMatchObject({ question: false, answered: false, ready: false });
  });

  it('works through the checks one at a time', () => {
    expect(statuses(3)).toEqual(['done', 'done', 'done', 'working', 'waiting', 'waiting']);
  });

  it('stops at the goods receipt and asks a person; nothing is recorded meanwhile', () => {
    for (const step of [5, 6, 7]) {
      const s = storyAt(step);
      expect(s.question, `step ${step}`).toBe(true);
      expect(statuses(step), `step ${step}`).toEqual([
        'done',
        'done',
        'done',
        'done',
        'ask',
        'waiting',
      ]);
    }
  });

  it('records the invoice only after the person answers', () => {
    const answered = storyAt(STORY_STEPS - 1);
    expect(answered.question).toBe(false);
    expect(answered.answered).toBe(true);
    expect(answered.rows[4]).toMatchObject({ status: 'decided', detail: RECEIPT_CONFIRMED });
    expect(answered.rows[5]?.status).toBe('working');
    expect(answered.ready).toBe(false);
  });

  it('ends ready, every row settled, and stays there', () => {
    const end = storyAt(STORY_STEPS);
    expect(end.ready).toBe(true);
    expect(end.rows.every((r) => r.status === 'done' || r.status === 'decided')).toBe(true);
    expect(storyAt(STORY_STEPS + 5)).toEqual(end);
    expect(storyAt(-1)).toEqual(storyAt(0));
    expect(STORY_ROWS).toHaveLength(6);
  });
});
