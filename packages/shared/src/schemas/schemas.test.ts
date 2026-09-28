import { describe, expect, it } from 'vitest';
import { AuditEventSchema } from './audit';
import { CreationActionSchema } from './creation';
import { ExtractionResultSchema, FieldRecordSchema } from './extraction';
import { InvoiceLineSchema } from './invoice';
import { MatchResultSchema } from './match';
import { QuestionSchema } from './question';
import { VendorRefSchema } from './refs';
import { ValidationResultSchema } from './validation';

const INV = '01J9ZQ3V8X4N6T2K5M7P9R1S3W';
const ACT = '01J9ZQ3V8X4N6T2K5M7P9R1S3X';
const USR = '01J9ZQ3V8X4N6T2K5M7P9R1S3Y';
const QID = '01J9ZQ3V8X4N6T2K5M7P9R1S3Z';
const EVT = '01J9ZQ3V8X4N6T2K5M7P9R1S40';
const EXT = '01J9ZQ3V8X4N6T2K5M7P9R1S41';
const NOW = '2026-09-28T04:26:39.000Z';

const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : (r.error?.issues.map((i) => i.message) ?? []);

describe('QuestionSchema', () => {
  const base = {
    id: QID,
    invoiceId: INV,
    kind: 'CREATION_APPROVAL',
    code: 'CA_GRN',
    subjectKey: 'grn:PO-2026-0104',
    prompt: 'Confirm goods receipt for PO-2026-0104',
    context: { poNumber: 'PO-2026-0104' },
    options: [
      {
        id: 'confirm',
        label: 'Confirm receipt',
        effect: { type: 'APPROVE_CREATION', entity: 'grn' },
      },
      { id: 'reject', label: 'Goods not received', effect: { type: 'REJECT_INVOICE' } },
    ],
    inputSchema: { type: 'object' },
    status: 'open',
    assignedToUserId: USR,
    answer: null,
    answeredByUserId: null,
    answeredAt: null,
    createdAt: NOW,
  };

  it('accepts a well-formed open question', () => {
    expect(issues(QuestionSchema.safeParse(base))).toEqual([]);
  });

  it('accepts a well-formed answered question', () => {
    const answered = {
      ...base,
      status: 'answered',
      answer: { optionId: 'confirm', input: { grnDate: '2026-09-20' } },
      answeredByUserId: USR,
      answeredAt: NOW,
    };
    expect(issues(QuestionSchema.safeParse(answered))).toEqual([]);
  });

  it('rejects a kind that does not match the code', () => {
    expect(QuestionSchema.safeParse({ ...base, kind: 'BUSINESS_DECISION' }).success).toBe(false);
  });

  it('requires a reject option', () => {
    expect(issues(QuestionSchema.safeParse({ ...base, options: [base.options[0]] }))).toContain(
      'every question offers a reject option',
    );
  });

  it('rejects an effect not allowed for the code', () => {
    const options = [
      ...base.options,
      { id: 'po', label: 'Create PO', effect: { type: 'APPROVE_CREATION', entity: 'po' } },
    ];
    expect(QuestionSchema.safeParse({ ...base, options }).success).toBe(false);
  });

  it('rejects duplicate option ids and answers to missing options', () => {
    const dup = [base.options[0], { ...base.options[1], id: 'confirm' }];
    expect(QuestionSchema.safeParse({ ...base, options: dup }).success).toBe(false);
    const badAnswer = {
      ...base,
      status: 'answered',
      answer: { optionId: 'nope', input: null },
      answeredByUserId: USR,
      answeredAt: NOW,
    };
    expect(QuestionSchema.safeParse(badAnswer).success).toBe(false);
  });

  it('keeps answer fields consistent with status', () => {
    expect(QuestionSchema.safeParse({ ...base, status: 'answered' }).success).toBe(false);
    expect(
      QuestionSchema.safeParse({
        ...base,
        answer: { optionId: 'confirm', input: null },
        answeredByUserId: USR,
        answeredAt: NOW,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid subject key', () => {
    expect(QuestionSchema.safeParse({ ...base, subjectKey: 'vendor' }).success).toBe(false);
  });
});

describe('ValidationResultSchema', () => {
  const base = {
    invoiceId: INV,
    runNo: 1,
    ruleCode: 'R21',
    lineNo: 1,
    outcome: 'fail',
    naReason: null,
    expected: 680000,
    actual: 680100,
    message: 'unit price differs from PO',
    createdAt: NOW,
  };

  it('accepts pass/fail without reason', () => {
    expect(ValidationResultSchema.safeParse(base).success).toBe(true);
  });

  it('not_applicable needs an allowed reason', () => {
    const na = { ...base, outcome: 'not_applicable' };
    expect(
      ValidationResultSchema.safeParse({ ...na, naReason: 'PO_DERIVED_FROM_INVOICE' }).success,
    ).toBe(true);
    expect(ValidationResultSchema.safeParse(na).success).toBe(false);
    expect(ValidationResultSchema.safeParse({ ...na, naReason: 'NO_ROUND_OFF_LINE' }).success).toBe(
      false,
    );
    expect(
      ValidationResultSchema.safeParse({
        ...na,
        ruleCode: 'R26',
        naReason: 'PO_DERIVED_FROM_INVOICE',
      }).success,
    ).toBe(false);
  });

  it('a reason on anything but not_applicable is invalid', () => {
    expect(
      ValidationResultSchema.safeParse({ ...base, naReason: 'PO_DERIVED_FROM_INVOICE' }).success,
    ).toBe(false);
  });
});

describe('MatchResultSchema', () => {
  const base = { invoiceId: INV, runNo: 1, entity: 'vendor', lineNo: null, method: 'gstin' };

  it('found = exactly one candidate, chosen', () => {
    expect(
      MatchResultSchema.safeParse({
        ...base,
        outcome: 'found',
        candidates: ['V001'],
        chosenErpId: 'V001',
      }).success,
    ).toBe(true);
    expect(
      MatchResultSchema.safeParse({
        ...base,
        outcome: 'found',
        candidates: ['V001', 'V002'],
        chosenErpId: 'V001',
      }).success,
    ).toBe(false);
    expect(
      MatchResultSchema.safeParse({
        ...base,
        outcome: 'found',
        candidates: ['V001'],
        chosenErpId: 'V002',
      }).success,
    ).toBe(false);
  });

  it('ambiguous never has a choice (no best-candidate auto-pick)', () => {
    const amb = {
      ...base,
      method: 'normalized_name',
      outcome: 'ambiguous',
      candidates: ['V005', 'V006'],
    };
    expect(MatchResultSchema.safeParse({ ...amb, chosenErpId: null }).success).toBe(true);
    expect(MatchResultSchema.safeParse({ ...amb, chosenErpId: 'V005' }).success).toBe(false);
    expect(
      MatchResultSchema.safeParse({ ...amb, candidates: ['V005'], chosenErpId: null }).success,
    ).toBe(false);
  });

  it('not_found has nothing', () => {
    expect(
      MatchResultSchema.safeParse({
        ...base,
        outcome: 'not_found',
        candidates: [],
        chosenErpId: null,
      }).success,
    ).toBe(true);
    expect(
      MatchResultSchema.safeParse({
        ...base,
        outcome: 'not_found',
        candidates: ['V1'],
        chosenErpId: null,
      }).success,
    ).toBe(false);
  });

  it('methods and line numbers must fit the entity', () => {
    const found = { outcome: 'found', candidates: ['I1'], chosenErpId: 'I1' };
    expect(MatchResultSchema.safeParse({ ...base, ...found, method: 'vendor_alias' }).success).toBe(
      false,
    );
    expect(
      MatchResultSchema.safeParse({
        ...base,
        ...found,
        entity: 'item',
        method: 'vendor_alias',
        lineNo: 1,
      }).success,
    ).toBe(true);
    expect(
      MatchResultSchema.safeParse({ ...base, ...found, entity: 'item', method: 'vendor_alias' })
        .success,
    ).toBe(false);
  });
});

describe('CreationActionSchema', () => {
  const base = {
    id: ACT,
    invoiceId: INV,
    entity: 'po',
    payload: { lines: [] },
    policyCode: 'CP_PO_BELOW_THRESHOLD',
    trigger: 'auto_policy',
    approvedByUserId: null,
    questionId: null,
    status: 'staged',
    erpId: null,
    idempotencyKey: `veyra:${INV}:${ACT}`,
    createdAt: NOW,
    committedAt: null,
  };

  it('accepts a staged auto-created PO', () => {
    expect(issues(CreationActionSchema.safeParse(base))).toEqual([]);
  });

  it('a GRN can never be auto-created', () => {
    expect(
      CreationActionSchema.safeParse({
        ...base,
        entity: 'grn',
        policyCode: 'CP_GRN_USER_CONFIRMED',
      }).success,
    ).toBe(false);
    expect(
      CreationActionSchema.safeParse({
        ...base,
        entity: 'grn',
        policyCode: 'CP_PO_BELOW_THRESHOLD',
      }).success,
    ).toBe(false);
    const confirmed = {
      ...base,
      entity: 'grn',
      policyCode: 'CP_GRN_USER_CONFIRMED',
      trigger: 'user_approval',
      approvedByUserId: USR,
      questionId: QID,
    };
    expect(issues(CreationActionSchema.safeParse(confirmed))).toEqual([]);
  });

  it('approvals record the user and question', () => {
    expect(
      CreationActionSchema.safeParse({
        ...base,
        policyCode: 'CP_PO_APPROVED',
        trigger: 'user_approval',
      }).success,
    ).toBe(false);
  });

  it('erpId and committedAt exist exactly when committed', () => {
    expect(CreationActionSchema.safeParse({ ...base, status: 'committed' }).success).toBe(false);
    expect(CreationActionSchema.safeParse({ ...base, erpId: 'PO-9' }).success).toBe(false);
    expect(
      CreationActionSchema.safeParse({
        ...base,
        status: 'committed',
        erpId: 'PO-9',
        committedAt: NOW,
      }).success,
    ).toBe(true);
    expect(CreationActionSchema.safeParse({ ...base, status: 'discarded' }).success).toBe(true);
  });

  it('the idempotency key is derived from invoice and action', () => {
    expect(
      CreationActionSchema.safeParse({ ...base, idempotencyKey: `veyra:${INV}:${EVT}` }).success,
    ).toBe(false);
  });
});

describe('AuditEventSchema', () => {
  const base = {
    id: EVT,
    invoiceId: INV,
    actorType: 'system',
    actorUserId: null,
    event: 'invoice.state_changed',
    fromState: 'VALIDATING',
    toState: 'COMMITTING',
    detail: {},
    createdAt: NOW,
  };

  it('accepts a system state change', () => {
    expect(AuditEventSchema.safeParse(base).success).toBe(true);
  });

  it('user actions name the user; others do not', () => {
    expect(AuditEventSchema.safeParse({ ...base, actorType: 'user' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...base, actorUserId: USR }).success).toBe(false);
  });

  it('state fields only on state changes', () => {
    expect(AuditEventSchema.safeParse({ ...base, fromState: null }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...base, event: 'question.raised' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...base, toState: 'PAID' }).success).toBe(false);
  });
});

describe('ExtractionResultSchema', () => {
  const f = (value: unknown, confidenceBp = 9800) => ({
    value,
    confidenceBp,
    evidence: null,
    source: 'pdf_text',
  });
  const header = {
    vendorName: f('Shakti Steel Suppliers Pvt Ltd'),
    vendorGstin: f('29AAFCS5678K1ZK'),
    vendorAddress: f('Bengaluru'),
    vendorPan: f('AAFCS5678K'),
    buyerGstin: f('29AAACS1111A1Z6'),
    billingAddress: f(null, 0),
    placeOfSupply: f('Karnataka (29)'),
    shipToState: f(null, 0),
    shipToGstin: f(null, 0),
    shipToAddress: f(null, 0),
    invoiceNumber: f('SSS/26-27/0451'),
    invoiceDate: f('2026-09-15'),
    poNumber: f('PO-2026-0101'),
    taxablePaise: f(9650000),
    cgstPaise: f(868500),
    sgstPaise: f(868500),
    igstPaise: f(null, 0),
    cessPaise: f(null, 0),
    roundOffPaise: f(null, 0),
    totalPaise: f(11387000),
  };
  const line = (lineNo: number) => ({
    lineNo,
    description: f('MS Steel Rod 12mm'),
    vendorItemCode: f(null, 0),
    hsnSac: f('7214'),
    qtyMilli: f(1_000_000),
    uom: f('KGS'),
    unitPricePaise: f(6250),
    discountPaise: f(null, 0),
    taxablePaise: f(6250000),
    gstRateBp: f(1800),
    cgstPaise: f(null, 0),
    sgstPaise: f(null, 0),
    igstPaise: f(null, 0),
    lineTotalPaise: f(null, 0),
  });
  const valid = {
    extractor: { id: 'local_ocr', version: '1' },
    header,
    lines: [line(1)],
    pages: 1,
    warnings: [],
  };

  it('requires every field to say how it was read', () => {
    const unsourced = { value: 'SSS/26-27/0451', confidenceBp: 9800, evidence: null };
    expect(
      ExtractionResultSchema.safeParse({
        ...valid,
        header: { ...header, invoiceNumber: unsourced },
      }).success,
    ).toBe(false);
    expect(
      ExtractionResultSchema.safeParse({
        ...valid,
        header: { ...header, invoiceNumber: { ...f('X'), source: 'guess' } },
      }).success,
    ).toBe(false);
  });

  it('accepts DEMO S01-shaped output', () => {
    expect(issues(ExtractionResultSchema.safeParse(valid))).toEqual([]);
  });

  it('rejects rupee floats, fractional confidence and bad dates', () => {
    expect(
      ExtractionResultSchema.safeParse({
        ...valid,
        header: { ...header, totalPaise: f(113870.0 + 0.5) },
      }).success,
    ).toBe(false);
    expect(
      ExtractionResultSchema.safeParse({
        ...valid,
        header: { ...header, totalPaise: f(11387000, 0.98) },
      }).success,
    ).toBe(false);
    expect(
      ExtractionResultSchema.safeParse({
        ...valid,
        header: { ...header, invoiceDate: f('15/09/2026') },
      }).success,
    ).toBe(false);
  });

  it('requires lines numbered 1..n', () => {
    expect(ExtractionResultSchema.safeParse({ ...valid, lines: [line(2)] }).success).toBe(false);
    expect(ExtractionResultSchema.safeParse({ ...valid, lines: [line(1), line(2)] }).success).toBe(
      true,
    );
  });
});

describe('FieldRecordSchema', () => {
  const base = {
    invoiceId: INV,
    path: 'header.totalPaise',
    value: 1604800,
    confidenceBp: 4100,
    evidence: null,
    evidenceDetail: null,
    source: 'extracted',
    extractionId: EXT,
    updatedByUserId: null,
    updatedAt: NOW,
  };

  it('extracted values carry confidence and extraction', () => {
    expect(FieldRecordSchema.safeParse(base).success).toBe(true);
    expect(FieldRecordSchema.safeParse({ ...base, confidenceBp: null }).success).toBe(false);
  });

  it('human corrections record the user; derived values record the evidence', () => {
    expect(FieldRecordSchema.safeParse({ ...base, source: 'human_corrected' }).success).toBe(false);
    expect(
      FieldRecordSchema.safeParse({ ...base, source: 'human_corrected', updatedByUserId: USR })
        .success,
    ).toBe(true);
    expect(
      FieldRecordSchema.safeParse({ ...base, source: 'derived_from_document_evidence' }).success,
    ).toBe(false);
  });

  it('rejects unknown paths', () => {
    expect(FieldRecordSchema.safeParse({ ...base, path: 'header.grandTotal' }).success).toBe(false);
  });
});

describe('InvoiceLineSchema / refs', () => {
  it('rejects fractional quantities and non-digit HSN', () => {
    const line = {
      lineNo: 1,
      description: 'Rod',
      vendorItemCode: null,
      hsnSac: '7214',
      qtyMilli: 1000,
      uom: 'KGS',
      unitPricePaise: 6250,
      taxablePaise: 6250,
      gstRateBp: 1800,
      cgstPaise: null,
      sgstPaise: null,
      igstPaise: null,
    };
    expect(InvoiceLineSchema.safeParse(line).success).toBe(true);
    expect(InvoiceLineSchema.safeParse({ ...line, qtyMilli: 1.5 }).success).toBe(false);
    expect(InvoiceLineSchema.safeParse({ ...line, hsnSac: '72A4' }).success).toBe(false);
  });

  it('vendor refs need a 2-digit state code', () => {
    const ref = {
      erpId: 'V001',
      code: 'V001',
      name: 'Shakti',
      gstin: '29AAFCS5678K1ZK',
      stateCode: '29',
      status: 'active',
    };
    expect(VendorRefSchema.safeParse(ref).success).toBe(true);
    expect(VendorRefSchema.safeParse({ ...ref, stateCode: '9' }).success).toBe(false);
  });
});
