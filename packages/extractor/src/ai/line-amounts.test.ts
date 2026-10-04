import { describe, expect, it } from 'vitest';
import { AI_CONFIDENCE_BP, toExtraction, type AiReading } from './gemini';

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
      rate: p(AMOUNTS[i] ?? ''),
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
    expect(r.warnings.join(' ')).toMatch(/add up to the invoice’s own totals/);
    // Without a printed goods value, the total less tax and round-off proves it too.
    expect(taxables(toExtraction(reading({ taxable: null }), 'test'))).toEqual([
      345_000, 4_000, 4_000, 125_000,
    ]);
  });

  it('never when the amounts do not add up, or a line carries its own tax: they stay not read', () => {
    const off = toExtraction(reading({ amounts: ['3,450.00', '40.00', '40.00', '1,200.00'] }), 't');
    expect(taxables(off)).toEqual([null, null, null, null]);
    const lineTax = toExtraction(reading({ lineTax: true }), 't');
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
