import { addPaise, roundToRupeeHalfUp, subtractPaise, type Paise } from '@veyra/shared';

/**
 * Round-off (RULES §4.1, decision D2). A round-off is accepted only when it is printed on the
 * invoice and equals exactly the amount needed to reach the nearest rupee (half up). Any other
 * difference between the calculated total and the invoice total is reported, never absorbed.
 */

/** The only acceptable round-off for a calculated total: nearest rupee − total, in −49…+50 paise. */
export function requiredRoundOff(calculatedTotal: Paise): Paise {
  if (calculatedTotal < 0) throw new RangeError('calculated total must be non-negative');
  return subtractPaise(roundToRupeeHalfUp(calculatedTotal), calculatedTotal);
}

export type RoundOffIssue = 'round_off_incorrect' | 'total_mismatch';

export interface RoundOffEvaluation {
  accepted: boolean;
  /** Whether the invoice prints a round-off line. `no_round_off_line` maps to R10 not_applicable. */
  basis: 'no_round_off_line' | 'printed_round_off';
  issues: RoundOffIssue[];
  requiredRoundOffPaise: Paise;
  /** Calculated total + printed round-off (or the calculated total when none is printed). */
  expectedInvoiceTotalPaise: Paise;
  /** Printed invoice total − expected invoice total. Non-zero is never absorbed. */
  unexplainedDifferencePaise: Paise;
  /** What the UI shows: calculated total → round-off → invoice total. */
  display: {
    calculatedTotalPaise: Paise;
    roundOffPaise: Paise | null;
    invoiceTotalPaise: Paise;
  };
}

export function evaluateRoundOff(input: {
  calculatedTotalPaise: Paise;
  printedRoundOffPaise: Paise | null;
  printedInvoiceTotalPaise: Paise;
}): RoundOffEvaluation {
  const { calculatedTotalPaise, printedRoundOffPaise, printedInvoiceTotalPaise } = input;
  const required = requiredRoundOff(calculatedTotalPaise);
  const expected =
    printedRoundOffPaise === null
      ? calculatedTotalPaise
      : addPaise(calculatedTotalPaise, printedRoundOffPaise);
  const difference = subtractPaise(printedInvoiceTotalPaise, expected);

  const issues: RoundOffIssue[] = [];
  if (printedRoundOffPaise !== null && printedRoundOffPaise !== required)
    issues.push('round_off_incorrect');
  if (difference !== 0) issues.push('total_mismatch');

  return {
    accepted: issues.length === 0,
    basis: printedRoundOffPaise === null ? 'no_round_off_line' : 'printed_round_off',
    issues,
    requiredRoundOffPaise: required,
    expectedInvoiceTotalPaise: expected,
    unexplainedDifferencePaise: difference,
    display: {
      calculatedTotalPaise,
      roundOffPaise: printedRoundOffPaise,
      invoiceTotalPaise: printedInvoiceTotalPaise,
    },
  };
}
