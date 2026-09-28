import {
  ZERO_PAISE,
  addPaise,
  mulDivPaiseRoundHalfUp,
  paise,
  sumPaise,
  type MilliQty,
  type Paise,
  type RateBp,
  type StateCode,
} from '@veyra/shared';

/**
 * Exact GST arithmetic (RULES §4.1). All amounts are integer paise, quantities milli-units and
 * rates basis points; every rounding is half up to the paisa. These functions compute; deciding
 * whether an invoice passes is the validation engine's job.
 */

export type SupplyType = 'intra_state' | 'inter_state';

export interface TaxHeads {
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
}

export const NO_TAX: TaxHeads = {
  cgstPaise: ZERO_PAISE,
  sgstPaise: ZERO_PAISE,
  igstPaise: ZERO_PAISE,
};

/** Supplier state (from the vendor GSTIN) equal to place of supply ⇒ intra-state (RULES R08). */
export function determineSupplyType(
  supplierState: StateCode,
  placeOfSupply: StateCode,
): SupplyType {
  return supplierState === placeOfSupply ? 'intra_state' : 'inter_state';
}

/** Line taxable value = round_half_up(qty_milli × unit_price_paise / 1000). */
export function lineTaxableAmount(qty: MilliQty, unitPrice: Paise): Paise {
  if (qty < 0) throw new RangeError('quantity must be non-negative');
  return mulDivPaiseRoundHalfUp(unitPrice, qty, 1000);
}

/**
 * Tax on one taxable amount.
 * Intra-state: CGST = SGST = round_half_up(taxable × rate / 2 / 10000), computed as
 * taxable × rate / 20000 so odd basis-point rates (e.g. 0.25%) stay exact.
 * Inter-state: IGST = round_half_up(taxable × rate / 10000).
 */
export function computeTax(taxable: Paise, rate: RateBp, supply: SupplyType): TaxHeads {
  if (supply === 'intra_state') {
    const half = mulDivPaiseRoundHalfUp(taxable, rate, 20_000);
    return { cgstPaise: half, sgstPaise: half, igstPaise: ZERO_PAISE };
  }
  return {
    cgstPaise: ZERO_PAISE,
    sgstPaise: ZERO_PAISE,
    igstPaise: mulDivPaiseRoundHalfUp(taxable, rate, 10_000),
  };
}

export function sumTaxHeads(heads: readonly TaxHeads[]): TaxHeads {
  return {
    cgstPaise: sumPaise(heads.map((h) => h.cgstPaise)),
    sgstPaise: sumPaise(heads.map((h) => h.sgstPaise)),
    igstPaise: sumPaise(heads.map((h) => h.igstPaise)),
  };
}

export function totalTax(heads: TaxHeads): Paise {
  return addPaise(heads.cgstPaise, heads.sgstPaise, heads.igstPaise);
}

/** Calculated total before any round-off: taxable + CGST + SGST + IGST. */
export function calculatedTotal(taxable: Paise, heads: TaxHeads): Paise {
  return addPaise(taxable, totalTax(heads));
}

/** Invoice grand total = calculated total + printed round-off (0 when no round-off line is printed). */
export function grandTotal(taxable: Paise, heads: TaxHeads, printedRoundOff: Paise | null): Paise {
  return addPaise(calculatedTotal(taxable, heads), printedRoundOff ?? paise(0));
}

export interface TaxableLine {
  taxablePaise: Paise;
  gstRateBp: RateBp;
}

/** Per-line method: tax computed on each line, then summed. */
export function computeTaxPerLine(
  lines: readonly TaxableLine[],
  supply: SupplyType,
): { lines: TaxHeads[]; taxablePaise: Paise; total: TaxHeads } {
  const perLine = lines.map((l) => computeTax(l.taxablePaise, l.gstRateBp, supply));
  return {
    lines: perLine,
    taxablePaise: sumPaise(lines.map((l) => l.taxablePaise)),
    total: sumTaxHeads(perLine),
  };
}

export interface RateGroupTax {
  gstRateBp: RateBp;
  taxablePaise: Paise;
  tax: TaxHeads;
}

/** Per-rate-group method: taxable summed per rate, tax computed once per group. Groups sorted by rate. */
export function computeTaxPerRateGroup(
  lines: readonly TaxableLine[],
  supply: SupplyType,
): { groups: RateGroupTax[]; taxablePaise: Paise; total: TaxHeads } {
  const byRate = new Map<RateBp, Paise[]>();
  for (const line of lines)
    byRate.set(line.gstRateBp, [...(byRate.get(line.gstRateBp) ?? []), line.taxablePaise]);
  const groups = [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([gstRateBp, amounts]) => {
      const taxablePaise = sumPaise(amounts);
      return { gstRateBp, taxablePaise, tax: computeTax(taxablePaise, gstRateBp, supply) };
    });
  return {
    groups,
    taxablePaise: sumPaise(groups.map((g) => g.taxablePaise)),
    total: sumTaxHeads(groups.map((g) => g.tax)),
  };
}

export type TaxHead = 'cgst' | 'sgst' | 'igst';
export type TaxHeadIssue =
  | 'igst_charged_on_intra_state'
  | 'cgst_sgst_unequal'
  | 'cgst_charged_on_inter_state'
  | 'sgst_charged_on_inter_state';

/** Heads with a non-zero amount, i.e. the heads the invoice actually charges. */
export function chargedTaxHeads(heads: TaxHeads): TaxHead[] {
  const charged: TaxHead[] = [];
  if (heads.cgstPaise !== 0) charged.push('cgst');
  if (heads.sgstPaise !== 0) charged.push('sgst');
  if (heads.igstPaise !== 0) charged.push('igst');
  return charged;
}

/**
 * Whether the heads charged fit the supply type (RULES R08): intra-state ⇒ IGST = 0 and CGST = SGST;
 * inter-state ⇒ CGST = SGST = 0. Absent heads must be passed as 0 by the caller.
 */
export function checkTaxHeadsForSupplyType(
  supply: SupplyType,
  heads: TaxHeads,
): { consistent: boolean; issues: TaxHeadIssue[]; allowedHeads: TaxHead[] } {
  const issues: TaxHeadIssue[] = [];
  if (supply === 'intra_state') {
    if (heads.igstPaise !== 0) issues.push('igst_charged_on_intra_state');
    if (heads.cgstPaise !== heads.sgstPaise) issues.push('cgst_sgst_unequal');
  } else {
    if (heads.cgstPaise !== 0) issues.push('cgst_charged_on_inter_state');
    if (heads.sgstPaise !== 0) issues.push('sgst_charged_on_inter_state');
  }
  return {
    consistent: issues.length === 0,
    issues,
    allowedHeads: supply === 'intra_state' ? ['cgst', 'sgst'] : ['igst'],
  };
}
