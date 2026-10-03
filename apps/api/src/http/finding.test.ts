import { describe, expect, it } from 'vitest';
import type { StoredField } from '../engine/fields';
import { buildFinding, type FindingInput, type FindingQuestion } from './finding';

const field = (
  path: string,
  value: string | number,
  evidence: StoredField['evidence'] = null,
): [string, StoredField] => [
  path,
  {
    path: path as never,
    value,
    confidenceBp: 9900,
    source: 'extracted',
    evidence,
    evidenceDetail: null,
  },
];

const base = (over: Partial<FindingInput>): FindingInput => ({
  questions: [],
  failed: [],
  fields: new Map(),
  totalPaise: null,
  receipt: null,
  ...over,
});

const vf = (
  code: string,
  subjectKey: string,
  facts: FindingQuestion['facts'],
): FindingQuestion => ({
  code,
  kind: 'VALIDATION_FAILURE',
  subjectKey,
  summary: 'Summary',
  headline: 'Headline.',
  facts,
  paths: [],
});

describe('the exception as a conclusion', () => {
  it('a rate difference: amount = rate difference × quantity, agreed value first', () => {
    const f = buildFinding(
      base({
        questions: [
          {
            ...vf('VF_R21', 'R21:line:1', [
              { label: 'Invoice price', value: '₹105.00 per KG', tone: 'attention' },
              { label: 'PO-9 price', value: '₹100.00 per KG' },
              { label: 'Difference', value: '₹5.00 per KG' },
            ]),
            paths: ['lines[1].unitPricePaise'],
          },
        ],
        failed: [{ rule: 'R21', lineNo: 1, expected: 10000, actual: 10500 }],
        fields: new Map([
          field('lines[1].qtyMilli', 250000),
          field('lines[1].uom', 'KG'),
          field('lines[1].unitPricePaise', 10500, {
            page: 1,
            text: '105.00',
            bbox: [400, 300, 40, 10],
          }),
        ]),
      }),
    );
    expect(f).toMatchObject({
      type: 'rate',
      state: 'review',
      label: 'Rate difference',
      action: 'Check rate',
      impactPaise: 125000,
      compare: [
        { label: 'PO-9 price', value: '₹100.00 per KG' },
        { label: 'Invoice price', value: '₹105.00 per KG', tone: 'attention' },
      ],
      more: 0,
    });
    expect(f?.impact).toBe('₹1,250.00 more than agreed');
    expect(f?.calculation).toBe('₹5.00 per KG × 250 KG = ₹1,250.00 overbilled');
    expect(f?.evidence[0]).toMatchObject({ source: 'invoice', page: 1, bbox: [400, 300, 40, 10] });
    expect(f?.evidence.at(-1)).toMatchObject({ source: 'erp', value: '₹100.00 per KG' });
  });

  it('a quantity above what was received: extra quantity × invoice rate', () => {
    const f = buildFinding(
      base({
        questions: [vf('VF_R26', 'R26:line:2', [])],
        failed: [{ rule: 'R26', lineNo: 2, expected: 8000, actual: 10000 }],
        fields: new Map([field('lines[2].unitPricePaise', 5000), field('lines[2].uom', 'NOS')]),
      }),
    );
    expect(f).toMatchObject({ type: 'quantity', action: 'Check quantity', impactPaise: 10000 });
    expect(f?.explanation).toBe('The invoice bills 2 NOS more than was received.');
  });

  it('tax: printed less calculated, over every tax head', () => {
    const f = buildFinding(
      base({
        questions: [vf('VF_R07', 'R07', [])],
        failed: [{ rule: 'R07', lineNo: null, expected: [900, 900], actual: [1000, 1000] }],
      }),
    );
    expect(f).toMatchObject({ type: 'tax', action: 'Check tax', impactPaise: 200 });
  });

  it('a duplicate puts the whole invoice at stake', () => {
    const f = buildFinding(base({ questions: [vf('VF_R11', 'R11', [])], totalPaise: 5_000_00 }));
    expect(f).toMatchObject({
      type: 'duplicate',
      action: 'Resolve duplicate',
      impactPaise: 500000,
    });
    expect(f?.impact).toBe('₹5,000.00 could be paid twice');
  });

  it('a value to confirm never claims an amount', () => {
    const f = buildFinding(
      base({
        questions: [
          { ...vf('MD_FIELD', 'header.invoiceDate', []), kind: 'MISSING_DATA' },
          vf('VF_R21', 'R21:line:1', []),
        ],
      }),
    );
    expect(f).toMatchObject({
      type: 'value',
      state: 'confirm',
      action: 'Confirm value',
      impactPaise: null,
      impact: 'Needs confirmation',
      more: 1,
    });
  });

  it('an ERP receipt difference: the line value first, the total difference as the amount', () => {
    const f = buildFinding(
      base({
        receipt: {
          grnNo: 'G-1',
          differences: [
            {
              section: 'Totals',
              label: 'Invoice total',
              invoice: '₹110.00',
              erp: '₹100.00',
              path: null,
            },
            {
              section: 'Line 1 · Bolts',
              label: 'Rate',
              invoice: '₹11.00',
              erp: '₹10.00',
              path: 'lines[1].unitPricePaise',
            },
          ],
          totalDeltaPaise: 1000,
        },
      }),
    );
    expect(f).toMatchObject({ type: 'rate', action: 'Check rate', impactPaise: 1000, more: 1 });
    expect(f?.compare[0]).toEqual({ label: 'ERP receipt GRN G-1', value: '₹10.00' });
  });

  it('nothing open, nothing to show', () => {
    expect(buildFinding(base({}))).toBeNull();
  });
});
