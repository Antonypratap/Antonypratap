import type { z } from 'zod';
import { NonNegativePaiseSchema, PaiseSchema, addPaise, paise, sumPaise } from '@veyra/shared';

/** Schema helpers shared by entities and inputs. Not part of the public API. */

export type Ctx = z.core.$RefinementCtx;
export const issue = (ctx: Ctx, message: string): void => ctx.addIssue({ code: 'custom', message });

export function checkLineNumbers(lines: readonly { lineNo: number }[], ctx: Ctx): void {
  lines.forEach((l, i) => {
    if (l.lineNo !== i + 1) issue(ctx, 'lines must be numbered 1..n in order');
  });
}

export const lineTaxShape = {
  cgstPaise: NonNegativePaiseSchema.nullable(),
  sgstPaise: NonNegativePaiseSchema.nullable(),
  igstPaise: NonNegativePaiseSchema.nullable(),
};
export const headerAmountShape = {
  taxablePaise: NonNegativePaiseSchema,
  cgstPaise: NonNegativePaiseSchema,
  sgstPaise: NonNegativePaiseSchema,
  igstPaise: NonNegativePaiseSchema,
  /** Null when no round-off line was printed on the invoice. */
  roundOffPaise: PaiseSchema.nullable(),
  totalPaise: NonNegativePaiseSchema,
};

/** Internal arithmetic consistency of a purchase invoice (validity versus the rules is Veyra's job). */
export function checkInvoiceArithmetic(
  inv: {
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    roundOffPaise: number | null;
    totalPaise: number;
    lines: readonly { taxablePaise: number }[];
  },
  ctx: Ctx,
): void {
  if (sumPaise(inv.lines.map((l) => paise(l.taxablePaise))) !== inv.taxablePaise) {
    issue(ctx, 'header taxable must equal the sum of line taxable amounts');
  }
  const expected = addPaise(
    paise(inv.taxablePaise),
    paise(inv.cgstPaise),
    paise(inv.sgstPaise),
    paise(inv.igstPaise),
    paise(inv.roundOffPaise ?? 0),
  );
  if (expected !== inv.totalPaise) issue(ctx, 'total must equal taxable + taxes + round-off');
}
