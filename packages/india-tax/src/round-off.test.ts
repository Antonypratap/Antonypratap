import { describe, expect, it } from 'vitest';
import { paise } from '@veyra/shared';
import { evaluateRoundOff, requiredRoundOff } from './round-off';

const evaluate = (calculated: number, roundOff: number | null, total: number) =>
  evaluateRoundOff({
    calculatedTotalPaise: paise(calculated),
    printedRoundOffPaise: roundOff === null ? null : paise(roundOff),
    printedInvoiceTotalPaise: paise(total),
  });

describe('requiredRoundOff', () => {
  it.each([
    [368_750, 50], // S06: 3,687.50 → +0.50
    [73_750, 50], // S18: 737.50 → +0.50
    [368_749, -49],
    [368_751, 49],
    [368_700, 0],
    [0, 0],
  ])('%d → %d', (calculated, expected) => {
    expect(requiredRoundOff(paise(calculated))).toBe(expected);
  });

  it('stays within −49…+50 paise for every paisa value', () => {
    for (let p = 0; p < 100; p++) {
      const r = requiredRoundOff(paise(1_000_000 + p));
      expect(r).toBeGreaterThanOrEqual(-49);
      expect(r).toBeLessThanOrEqual(50);
      expect((1_000_000 + p + r) % 100).toBe(0);
    }
  });

  it('refuses negative totals', () => {
    expect(() => requiredRoundOff(paise(-1))).toThrow(RangeError);
  });
});

describe('evaluateRoundOff', () => {
  it('S06: printed +0.50 reaching the nearest rupee is accepted', () => {
    const r = evaluate(368_750, 50, 368_800);
    expect(r.accepted).toBe(true);
    expect(r.basis).toBe('printed_round_off');
    expect(r.display).toEqual({
      calculatedTotalPaise: 368_750,
      roundOffPaise: 50,
      invoiceTotalPaise: 368_800,
    });
  });

  it('accepts a negative round-off when that is the nearest rupee', () => {
    expect(evaluate(368_749, -49, 368_700).accepted).toBe(true);
  });

  it('no round-off line: the total must equal the calculated total exactly', () => {
    const r = evaluate(1_604_800, null, 1_604_800);
    expect(r.accepted).toBe(true);
    expect(r.basis).toBe('no_round_off_line');
    expect(r.display.roundOffPaise).toBeNull();
  });

  it('never absorbs an unprinted rounding difference, even one that would be a valid round-off', () => {
    const r = evaluate(368_750, null, 368_800);
    expect(r.accepted).toBe(false);
    expect(r.issues).toEqual(['total_mismatch']);
    expect(r.unexplainedDifferencePaise).toBe(50);
  });

  it('rejects a printed round-off that is not the nearest-rupee amount', () => {
    const wrongDirection = evaluate(368_749, 51, 368_800); // rounds up instead of down
    expect(wrongDirection.issues).toEqual(['round_off_incorrect']);
    expect(wrongDirection.requiredRoundOffPaise).toBe(-49);
    const oneRupee = evaluate(368_750, 150, 368_900);
    expect(oneRupee.issues).toEqual(['round_off_incorrect']);
  });

  it('rejects a total that does not equal calculated + printed round-off', () => {
    const r = evaluate(368_750, 50, 368_900);
    expect(r.issues).toEqual(['total_mismatch']);
    expect(r.expectedInvoiceTotalPaise).toBe(368_800);
    expect(r.unexplainedDifferencePaise).toBe(100);
  });

  it('reports both problems when both exist', () => {
    expect(evaluate(368_750, 30, 368_900).issues).toEqual([
      'round_off_incorrect',
      'total_mismatch',
    ]);
  });

  it('a printed 0.00 round-off is fine on a whole-rupee total and wrong otherwise', () => {
    expect(evaluate(368_700, 0, 368_700).accepted).toBe(true);
    expect(evaluate(368_750, 0, 368_750).issues).toEqual(['round_off_incorrect']);
  });

  it('one paisa off is a mismatch (no tolerance)', () => {
    expect(evaluate(1_604_800, null, 1_604_801).issues).toEqual(['total_mismatch']);
  });
});
