import { describe, expect, it } from 'vitest';
import { AI_CONFIDENCE_BP, describeTaxRow, toExtraction, type AiReading } from './gemini';

/**
 * A Tally-style invoice (tax only in the footer, one "Amount" column) as the AI reader may return
 * it. Every party and number is made up; the amounts reproduce a reported layout: four lines of
 * quantity 1, Basic Value 4,780.00, CGST and SGST 430.20 each, Round Off (-)0.40, total 5,640.00.
 */
const p = (printed: string) => ({ printed, page: 1 });
const AMOUNTS = ['3,450.00', '40.00', '40.00', '1,250.00'];
const NAMES = ['MIRROR', 'WOOD SCREW 2”', 'GATTA', 'Coolie'];
function reading(
  opts: {
    amountKey?: 'taxable' | 'lineTotal';
    amounts?: string[];
    taxable?: string | null;
    lineTax?: boolean;
    /** Leave the unit rate out (only the amount column is given). */
    noRate?: boolean;
  } = {},
): AiReading {
  const key = opts.amountKey ?? 'lineTotal';
  const amounts = opts.amounts ?? AMOUNTS;
  return {
    invoiceCount: 1,
    pageCount: 1,
    header: {
      vendorName: p('SAMPLE ELECTRICAL & HARDWARE'),
      invoiceNumber: p('13839'),
      invoiceDate: p('9-Dec-2025'),
      poNumber: p('684'),
      taxable: opts.taxable === null ? null : p(opts.taxable ?? '4,780.00'),
      cgst: p('430.20'),
      sgst: p('430.20'),
      roundOff: p('(-)0.40'),
      total: p('₹ 5,640.00'),
    },
    lines: NAMES.map((name, i) => ({
      description: p(name),
      quantity: p('1'),
      uom: p('Nos'),
      ...(opts.noRate ? {} : { rate: p(AMOUNTS[i] ?? '') }),
      [key]: p(amounts[i] ?? ''),
      ...(opts.lineTax ? { cgst: p('1.00') } : {}),
    })),
  };
}
const taxables = (r: ReturnType<typeof toExtraction>) => r.lines.map((l) => l.taxablePaise.value);

describe('AI reading of a footer-tax (Tally) invoice', () => {
  it('reads every value of the invoice: lines, goods value, tax, negative round-off, total, PO', () => {
    const r = toExtraction(reading({ amountKey: 'taxable' }), 'test');
    expect(r.header.invoiceNumber.value).toBe('13839');
    expect(r.header.invoiceDate.value).toBe('2025-12-09');
    expect(r.header.poNumber.value).toBe('684');
    expect(r.header.taxablePaise.value).toBe(478_000);
    expect(r.header.cgstPaise.value).toBe(43_020);
    expect(r.header.sgstPaise.value).toBe(43_020);
    expect(r.header.roundOffPaise.value).toBe(-40);
    expect(r.header.totalPaise.value).toBe(564_000);
    expect(taxables(r)).toEqual([345_000, 4_000, 4_000, 125_000]);
    expect(r.lines.map((l) => l.qtyMilli.value)).toEqual([1000, 1000, 1000, 1000]);
  });

  it('a line amount returned as the line total is the line amount when the totals prove it', () => {
    const r = toExtraction(reading(), 'test');
    expect(taxables(r)).toEqual([345_000, 4_000, 4_000, 125_000]);
    expect(r.lines[3]?.taxablePaise).toMatchObject({
      confidenceBp: AI_CONFIDENCE_BP,
      evidence: { text: '1,250.00' },
      source: 'ai_vision',
    });
    expect(r.warnings.join(' ')).toMatch(
      /read from the amount column; they add up exactly to the goods value printed/,
    );
    // Without a printed goods value, the total less tax and round-off proves it too.
    expect(taxables(toExtraction(reading({ taxable: null }), 'test'))).toEqual([
      345_000, 4_000, 4_000, 125_000,
    ]);
  });

  it('never when the amounts do not add up, or a line carries its own tax: they stay not read', () => {
    const off = toExtraction(reading({ amounts: ['3,450.00', '40.00', '40.00', '1,200.00'] }), 't');
    expect(taxables(off)).toEqual([null, null, null, null]);
    // A line total that includes the line's own tax is not its amount before tax.
    const lineTax = toExtraction(reading({ lineTax: true, noRate: true }), 't');
    expect(taxables(lineTax)).toEqual([null, null, null, null]);
  });

  it('an amount the reader could not read stays not read, with no confidence', () => {
    const r = reading({ amountKey: 'taxable' });
    const coolie = r.lines[3] as Record<string, unknown>;
    coolie.taxable = { printed: null, unreadable: true, page: 1 };
    const x = toExtraction(r, 'test');
    expect(x.lines[3]?.taxablePaise).toMatchObject({ value: null, confidenceBp: 0 });
    expect(x.header.taxablePaise.value).toBe(478_000);
  });
});

/** Lines given only as quantity and rate (the amount column left out), as a reading may return. */
function rateOnly(
  over: {
    rates?: string[];
    qty?: string[];
    discount?: (string | null)[];
    taxable?: string | null;
    amount?: (string | null)[];
    unreadable?: number;
    other?: { label: string; printed: string }[];
    cgst?: string;
    sgst?: string;
    igst?: string;
  } = {},
): AiReading {
  const rates = over.rates ?? AMOUNTS;
  return {
    invoiceCount: 1,
    pageCount: 1,
    header: {
      vendorName: p('SAMPLE ELECTRICAL & HARDWARE'),
      invoiceNumber: p('13839'),
      invoiceDate: p('9-Dec-2025'),
      taxable: over.taxable === null ? null : p(over.taxable ?? '4,780.00'),
      ...(over.igst
        ? { igst: p(over.igst) }
        : { cgst: p(over.cgst ?? '430.20'), sgst: p(over.sgst ?? '430.20') }),
      roundOff: p('(-)0.40'),
      total: p('5,640.00'),
    },
    lines: rates.map((rate, i) => ({
      description: p(NAMES[i] ?? `ITEM ${i + 1}`),
      quantity: p(over.qty?.[i] ?? '1'),
      uom: p('Nos'),
      rate: p(rate),
      ...(over.discount?.[i] ? { discount: p(over.discount[i] as string) } : {}),
      ...(over.amount?.[i] ? { taxable: p(over.amount[i] as string) } : {}),
      ...(over.unreadable === i ? { taxable: { printed: null, unreadable: true, page: 1 } } : {}),
    })),
    otherPrinted: (over.other ?? []).map((o) => ({ ...o, page: 1 })),
  };
}
const FOOTER = [
  { label: 'CGST @ 9%', printed: '430.20' },
  { label: 'SGST @ 9%', printed: '430.20' },
];
const rates = (r: ReturnType<typeof toExtraction>) => r.lines.map((l) => l.gstRateBp.value);

describe('line amounts not given separately: quantity × rate, only when proven', () => {
  it('quantity × rate, exact to the paisa and adding up to the goods value, is the line amount', () => {
    const r = toExtraction(rateOnly(), 'test');
    expect(taxables(r)).toEqual([345_000, 4_000, 4_000, 125_000]);
    // 3,450.00 + 40.00 + 40.00 + 1,250.00 = 4,780.00, the Basic Value printed.
    expect(taxables(r).reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(478_000);
    expect(r.lines[0]?.taxablePaise.evidence?.text).toMatch(/^quantity × rate \(1 × 3,450\.00\)$/);
    expect(r.warnings.join(' ')).toMatch(/quantity × rate, exact to the paisa/);
    // Unit rate and quantity keep their own values: nothing else changed.
    expect(r.lines.map((l) => l.unitPricePaise.value)).toEqual([345_000, 4_000, 4_000, 125_000]);
    expect(r.lines.map((l) => l.qtyMilli.value)).toEqual([1000, 1000, 1000, 1000]);
  });

  it('one amount given and the others only as rates (three amounts were left unresolved)', () => {
    const r = toExtraction(rateOnly({ amount: ['3,450.00'] }), 'test');
    expect(taxables(r)).toEqual([345_000, 4_000, 4_000, 125_000]);
    expect(r.lines[0]?.taxablePaise.evidence?.text).toBe('3,450.00');
  });

  it('quantities other than 1: 2.5 × 18.00 = 45.00 exactly', () => {
    const r = toExtraction(
      rateOnly({ rates: ['18.00', '10.00'], qty: ['2.5', '3'], taxable: '75.00' }),
      'test',
    );
    expect(taxables(r)).toEqual([4_500, 3_000]);
  });

  it('never when quantity × rate is not exact, a discount is printed, or the sum disagrees', () => {
    // 3 × 33.333 is not a whole number of paise: never rounded into an amount.
    expect(
      taxables(toExtraction(rateOnly({ rates: ['33.333'], qty: ['3'], taxable: '100.00' }), 't')),
    ).toEqual([null]);
    // A discount on a line: the amount is not quantity × rate.
    expect(taxables(toExtraction(rateOnly({ discount: [null, '5.00', null, null] }), 't'))).toEqual(
      [null, null, null, null],
    );
    // The lines do not add up to the goods value printed: all stay not read (asked).
    expect(taxables(toExtraction(rateOnly({ taxable: '4,880.00' }), 't'))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('an amount the reader could not read stays not read, even when quantity × rate would fit', () => {
    const r = toExtraction(rateOnly({ unreadable: 3 }), 'test');
    expect(r.lines[3]?.taxablePaise).toMatchObject({ value: null, confidenceBp: 0 });
    // And the others are not filled either: the whole set must be proven together.
    expect(taxables(r)).toEqual([null, null, null, null]);
  });

  it('an amount column that disagrees with quantity × rate is never chosen between', () => {
    const x = reading({ amounts: ['3,450.00', '40.00', '40.00', '1,250.00'] });
    (x.lines[1] as Record<string, unknown>).rate = p('45.00');
    expect(taxables(toExtraction(x, 'test'))).toEqual([null, null, null, null]);
  });
});

describe('the GST rate printed only under the items, as the AI reader reports it', () => {
  it('"CGST @ 9%" and "SGST @ 9%" give 18% to every line when they reproduce the tax exactly', () => {
    const r = toExtraction(rateOnly({ other: FOOTER }), 'test');
    expect(rates(r)).toEqual([1800, 1800, 1800, 1800]);
    // 4,780.00 × 9% = 430.20, for CGST and for SGST.
    expect(r.header.cgstPaise.value).toBe(43_020);
    expect(r.header.sgstPaise.value).toBe(43_020);
    expect(r.lines[0]?.gstRateBp.evidence?.text).toMatch(/CGST @ 9%/);
    expect(r.warnings.join(' ')).toMatch(/GST rate 18% read from the tax printed under the items/);
  });

  it('IGST only: one rate, proven the same way', () => {
    const r = toExtraction(
      rateOnly({ igst: '860.40', other: [{ label: 'IGST @ 18%', printed: '860.40' }] }),
      'test',
    );
    expect(rates(r)).toEqual([1800, 1800, 1800, 1800]);
  });

  it('never for mixed rates, an exempt line, conflicting totals or no printed rate', () => {
    // Two CGST rates printed: which line has which is not known.
    const mixed = rateOnly({
      other: [...FOOTER, { label: 'CGST @ 2.5%', printed: '10.00' }],
    });
    expect(rates(toExtraction(mixed, 't'))).toEqual([null, null, null, null]);
    // An exempt labour line: 9% of the goods value is not the tax printed.
    const exempt = rateOnly({ cgst: '317.70', sgst: '317.70', other: FOOTER });
    expect(rates(toExtraction(exempt, 't'))).toEqual([null, null, null, null]);
    // CGST and SGST printed differently.
    const conflict = rateOnly({ sgst: '430.00', other: FOOTER });
    expect(rates(toExtraction(conflict, 't'))).toEqual([null, null, null, null]);
    // CGST at 9%, SGST at 6%.
    const unequal = rateOnly({
      other: [
        FOOTER[0] as { label: string; printed: string },
        { label: 'SGST @ 6%', printed: '430.20' },
      ],
    });
    expect(rates(toExtraction(unequal, 't'))).toEqual([null, null, null, null]);
    // No rate printed anywhere: asked.
    expect(rates(toExtraction(rateOnly(), 't'))).toEqual([null, null, null, null]);
  });

  it('a line that prints its own rate keeps it; the footer is not used', () => {
    const x = rateOnly({ other: FOOTER });
    (x.lines[0] as Record<string, unknown>).gstRate = p('12%');
    expect(rates(toExtraction(x, 't'))).toEqual([1200, null, null, null]);
  });
});

describe('a tax row’s value under "Also printed on the invoice"', () => {
  const shown = (other: { label: string; printed: string }[]) =>
    (toExtraction(rateOnly({ other }), 'test').otherFields ?? []).map((f) => [f.label, f.value]);

  it('the value the tax is charged on is named as such, with the tax beside it', () => {
    // "CGST @ 9%   4780.00   430.20": the reader gave the middle column.
    expect(shown(FOOTER.map((f) => ({ ...f, printed: '4780.00' })))).toEqual([
      ['CGST @ 9% · taxable value', '4780.00 (tax 430.20)'],
      ['SGST @ 9% · taxable value', '4780.00 (tax 430.20)'],
    ]);
  });

  it('the tax itself, or both columns, is shown as printed', () => {
    expect(shown(FOOTER)).toEqual([
      ['CGST @ 9%', '430.20'],
      ['SGST @ 9%', '430.20'],
    ]);
    expect(shown([{ label: 'CGST @ 9%', printed: '4780.00 430.20' }])).toEqual([
      ['CGST @ 9%', '4780.00 430.20'],
    ]);
  });

  it('any other value beside a tax label is marked as not the tax read', () => {
    expect(shown([{ label: 'CGST @ 9%', printed: '1234.00' }])).toEqual([
      ['CGST @ 9% · not the tax read', '1234.00 (CGST read: 430.20)'],
    ]);
    // Labels that are not tax rows are untouched.
    expect(shown([{ label: 'Total', printed: '4' }])).toEqual([['Total', '4']]);
  });

  it('the footer rate is still proven from the label when the taxable value is beside it', () => {
    const r = toExtraction(
      rateOnly({ other: FOOTER.map((f) => ({ ...f, printed: '4780.00' })) }),
      'test',
    );
    expect(rates(r)).toEqual([1800, 1800, 1800, 1800]);
  });
});

describe('a tax row read before the check existed, as it is shown', () => {
  const read = { cgst: 43_020, sgst: 43_020, igst: null, taxable: 478_000 };

  it('the taxable value beside "CGST @ 9%" is named as such, with the tax read', () => {
    expect(describeTaxRow('CGST @ 9%', '4780.00', read)).toEqual({
      label: 'CGST @ 9% · taxable value',
      value: '4780.00 (tax 430.20)',
    });
    expect(describeTaxRow('SGST @ 9%', '4780.00', read).label).toBe('SGST @ 9% · taxable value');
  });

  it('even when the tax itself was not read, the goods value is not shown as the tax', () => {
    expect(describeTaxRow('CGST @ 9%', '4780.00', { ...read, cgst: null })).toEqual({
      label: 'CGST @ 9% · taxable value',
      value: '4780.00',
    });
  });

  it('the tax itself, other labels and rows already described are left as they are', () => {
    expect(describeTaxRow('CGST @ 9%', '430.20', read).label).toBe('CGST @ 9%');
    expect(describeTaxRow('Total', '4', read).label).toBe('Total');
    expect(describeTaxRow('CGST @ 9% · taxable value', '4780.00', read).label).toBe(
      'CGST @ 9% · taxable value',
    );
  });
});
