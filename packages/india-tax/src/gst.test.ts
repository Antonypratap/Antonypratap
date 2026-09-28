import { describe, expect, it } from 'vitest';
import { milliQty, paise, rateBp, type StateCode } from '@veyra/shared';
import {
  calculatedTotal,
  chargedTaxHeads,
  checkTaxHeadsForSupplyType,
  computeTax,
  computeTaxPerLine,
  computeTaxPerRateGroup,
  determineSupplyType,
  grandTotal,
  lineTaxableAmount,
  totalTax,
} from './gst';

const KA = '29' as StateCode;
const MH = '27' as StateCode;
const TN = '33' as StateCode;
const heads = (cgst: number, sgst: number, igst: number) => ({
  cgstPaise: paise(cgst),
  sgstPaise: paise(sgst),
  igstPaise: paise(igst),
});

describe('supply type (R08 basis)', () => {
  it('same state is intra-state, otherwise inter-state', () => {
    expect(determineSupplyType(KA, KA)).toBe('intra_state');
    expect(determineSupplyType(MH, KA)).toBe('inter_state');
    expect(determineSupplyType(TN, KA)).toBe('inter_state');
  });
});

describe('line taxable amount', () => {
  it('is qty × price, half-up to the paisa', () => {
    expect(lineTaxableAmount(milliQty(1_000_000), paise(6250))).toBe(6_250_000); // 1000 KGS @ 62.50
    expect(lineTaxableAmount(milliQty(100_000), paise(6801))).toBe(680_100); // S09: 100 @ 68.01
    expect(lineTaxableAmount(milliQty(1500), paise(1001))).toBe(1502); // 15.015 → 15.02
    expect(lineTaxableAmount(milliQty(1), paise(1))).toBe(0); // 0.001 paise → 0
    expect(lineTaxableAmount(milliQty(500), paise(1))).toBe(1); // 0.5 paise → 1 (half up)
  });

  it('refuses negative quantities', () => {
    expect(() => lineTaxableAmount(milliQty(-1000), paise(100))).toThrow(RangeError);
  });
});

describe('computeTax against DEMO.md scenarios', () => {
  it.each([
    ['S01', 9_650_000, 1800, KA, heads(868_500, 868_500, 0), 11_387_000],
    ['S02', 1_450_000, 1800, MH, heads(0, 0, 261_000), 1_711_000],
    ['S03', 980_000, 1200, KA, heads(58_800, 58_800, 0), 1_097_600],
    ['S04', 2_940_000, 1800, KA, heads(264_600, 264_600, 0), 3_469_200],
    ['S06', 312_500, 1800, KA, heads(28_125, 28_125, 0), 368_750],
    ['S07', 380_000, 1800, TN, heads(0, 0, 68_400), 448_400],
    ['S09', 680_100, 1800, KA, heads(61_209, 61_209, 0), 802_518],
    ['S12', 625_000, 1800, KA, heads(56_250, 56_250, 0), 737_500],
    ['S16', 1_200_000, 1200, KA, heads(72_000, 72_000, 0), 1_344_000],
    ['S17', 2_450_000, 1800, KA, heads(220_500, 220_500, 0), 2_891_000],
  ] as const)('%s', (_s, taxable, rate, supplier, expected, total) => {
    const supply = determineSupplyType(supplier, KA);
    const tax = computeTax(paise(taxable), rateBp(rate), supply);
    expect(tax).toEqual(expected);
    expect(calculatedTotal(paise(taxable), tax)).toBe(total);
  });

  it('S12: the printed 563.00 differs from the computed 562.50 by exactly 50 paise', () => {
    const tax = computeTax(paise(625_000), rateBp(1800), 'intra_state');
    expect(tax.cgstPaise).toBe(56_250);
    expect(56_300 - tax.cgstPaise).toBe(50);
  });

  it('keeps odd basis-point rates exact (0.25% ⇒ 0.125% each)', () => {
    expect(computeTax(paise(100_000), rateBp(25), 'intra_state')).toEqual(heads(125, 125, 0));
    expect(computeTax(paise(100_000), rateBp(25), 'inter_state')).toEqual(heads(0, 0, 250));
    expect(computeTax(paise(100), rateBp(25), 'intra_state')).toEqual(heads(0, 0, 0)); // 0.125 paise → 0
    expect(computeTax(paise(400), rateBp(25), 'intra_state')).toEqual(heads(1, 1, 0)); // 0.5 → 1
  });

  it('zero rate and zero amount yield zero tax', () => {
    expect(computeTax(paise(1_000_000), rateBp(0), 'intra_state')).toEqual(heads(0, 0, 0));
    expect(computeTax(paise(0), rateBp(1800), 'inter_state')).toEqual(heads(0, 0, 0));
  });
});

describe('per-line vs per-rate-group methods', () => {
  const lines = [
    { taxablePaise: paise(5), gstRateBp: rateBp(1800) },
    { taxablePaise: paise(5), gstRateBp: rateBp(1800) },
  ];

  it('are both exact and can legitimately differ; the rules pick the method', () => {
    expect(computeTaxPerLine(lines, 'intra_state').total).toEqual(heads(0, 0, 0)); // 0.45 each → 0
    expect(computeTaxPerRateGroup(lines, 'intra_state').total).toEqual(heads(1, 1, 0)); // 0.9 → 1
  });

  it('group by rate, sorted, for DEMO S01 (two 18% lines)', () => {
    const s01 = [
      { taxablePaise: paise(6_250_000), gstRateBp: rateBp(1800) },
      { taxablePaise: paise(3_400_000), gstRateBp: rateBp(1800) },
    ];
    const perLine = computeTaxPerLine(s01, 'intra_state');
    const perGroup = computeTaxPerRateGroup(s01, 'intra_state');
    expect(perLine.lines).toEqual([heads(562_500, 562_500, 0), heads(306_000, 306_000, 0)]);
    expect(perLine.total).toEqual(heads(868_500, 868_500, 0));
    expect(perGroup.groups).toHaveLength(1);
    expect(perGroup.total).toEqual(perLine.total);
    expect(perGroup.taxablePaise).toBe(9_650_000);
  });

  it('keeps mixed rates in separate groups', () => {
    const mixed = [
      { taxablePaise: paise(1000), gstRateBp: rateBp(1800) },
      { taxablePaise: paise(1000), gstRateBp: rateBp(500) },
      { taxablePaise: paise(1000), gstRateBp: rateBp(1800) },
    ];
    const g = computeTaxPerRateGroup(mixed, 'inter_state').groups;
    expect(g.map((x) => [x.gstRateBp, x.taxablePaise, x.tax.igstPaise])).toEqual([
      [500, 1000, 50],
      [1800, 2000, 360],
    ]);
  });
});

describe('totals', () => {
  it('total tax and grand total', () => {
    const t = heads(868_500, 868_500, 0);
    expect(totalTax(t)).toBe(1_737_000);
    expect(grandTotal(paise(9_650_000), t, null)).toBe(11_387_000);
    expect(grandTotal(paise(312_500), heads(28_125, 28_125, 0), paise(50))).toBe(368_800); // S06
    expect(grandTotal(paise(100), heads(0, 0, 0), paise(-49))).toBe(51);
  });
});

describe('tax heads vs supply type', () => {
  it('S13: CGST+SGST on an inter-state supply is flagged', () => {
    const r = checkTaxHeadsForSupplyType(determineSupplyType(MH, KA), heads(26_100, 26_100, 0));
    expect(r.consistent).toBe(false);
    expect(r.issues).toEqual(['cgst_charged_on_inter_state', 'sgst_charged_on_inter_state']);
    expect(r.allowedHeads).toEqual(['igst']);
  });

  it('IGST on an intra-state supply is flagged', () => {
    expect(checkTaxHeadsForSupplyType('intra_state', heads(0, 0, 100)).issues).toEqual([
      'igst_charged_on_intra_state',
    ]);
  });

  it('unequal CGST and SGST are flagged', () => {
    expect(checkTaxHeadsForSupplyType('intra_state', heads(56_300, 56_250, 0)).issues).toEqual([
      'cgst_sgst_unequal',
    ]);
  });

  it('correct heads pass, including zero tax', () => {
    expect(checkTaxHeadsForSupplyType('intra_state', heads(868_500, 868_500, 0)).consistent).toBe(
      true,
    );
    expect(checkTaxHeadsForSupplyType('inter_state', heads(0, 0, 261_000)).consistent).toBe(true);
    expect(checkTaxHeadsForSupplyType('inter_state', heads(0, 0, 0)).consistent).toBe(true);
  });

  it('lists charged heads', () => {
    expect(chargedTaxHeads(heads(1, 1, 0))).toEqual(['cgst', 'sgst']);
    expect(chargedTaxHeads(heads(0, 0, 5))).toEqual(['igst']);
    expect(chargedTaxHeads(heads(0, 0, 0))).toEqual([]);
  });
});
