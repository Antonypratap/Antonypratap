import { describe, expect, it } from 'vitest';
import { CORRECTION, SCRIPT, STAGES } from './controlFlowScript';

describe('the hero animation script', () => {
  it('plays a match, then a difference put right, through known stages', () => {
    expect(SCRIPT.every((s) => STAGES.includes(s.stage))).toBe(true);
    expect(SCRIPT[0]?.path).toBe('match');
    expect(SCRIPT.at(-1)).toMatchObject({ path: 'difference', correction: CORRECTION.length - 1 });
    // One purchase follows the other: never back to match once the difference started.
    const firstDifference = SCRIPT.findIndex((s) => s.path === 'difference');
    expect(SCRIPT.slice(firstDifference).every((s) => s.path === 'difference')).toBe(true);
  });

  it('never says Veyrafy pays or approves: people do', () => {
    for (const s of SCRIPT) expect(s.caption).not.toMatch(/Veyrafy (pays|approves|releases)/i);
    expect(SCRIPT.filter((s) => /releases the payment/.test(s.caption))).toHaveLength(2);
  });
});
