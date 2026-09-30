import { describe, expect, it } from 'vitest';
import { GrnSchema, PurchaseInvoiceSchema, PurchaseOrderSchema, VendorSchema } from './entities';
import {
  CreateGrnInputSchema,
  CreateItemInputSchema,
  CreatePurchaseOrderInputSchema,
  CreateVendorInputSchema,
  RecordPurchaseInvoiceInputSchema,
} from './inputs';

const INV = '1'.padStart(26, '0');
const USR = '9'.padStart(26, '0');
const NOW = '2026-09-28T04:26:39.000Z';
const ok = (r: { success: boolean }) => r.success;

describe('VendorSchema', () => {
  const vendor = {
    id: 'V001',
    code: 'V001',
    name: 'Shakti Steel Suppliers Pvt Ltd',
    nameNormalized: 'shakti steel suppliers',
    gstin: '29AAFCS5678K1ZK',
    pan: 'AAFCS5678K',
    stateCode: '29',
    address: 'Bengaluru',
    status: 'active',
    origin: 'seed',
    sourceInvoiceId: null,
    sourceImportId: null,
    createdAt: NOW,
  };

  it('accepts a DEMO seed vendor', () => {
    expect(ok(VendorSchema.safeParse(vendor))).toBe(true);
  });

  it('derived fields must match the GSTIN and name', () => {
    expect(ok(VendorSchema.safeParse({ ...vendor, pan: 'AAFCS5678X' }))).toBe(false);
    expect(ok(VendorSchema.safeParse({ ...vendor, stateCode: '27' }))).toBe(false);
    expect(ok(VendorSchema.safeParse({ ...vendor, nameNormalized: 'shakti' }))).toBe(false);
    expect(ok(VendorSchema.safeParse({ ...vendor, gstin: '29AAGCM4455J1Z5' }))).toBe(false);
  });

  it('records created by Veyrafy reference their invoice; seed records do not', () => {
    expect(ok(VendorSchema.safeParse({ ...vendor, origin: 'created_by_veyra' }))).toBe(false);
    expect(ok(VendorSchema.safeParse({ ...vendor, sourceInvoiceId: INV }))).toBe(false);
    // Imported records name their import, and only they do.
    expect(
      ok(VendorSchema.safeParse({ ...vendor, origin: 'imported', sourceImportId: 'IMP1' })),
    ).toBe(true);
    expect(ok(VendorSchema.safeParse({ ...vendor, origin: 'imported' }))).toBe(false);
    expect(ok(VendorSchema.safeParse({ ...vendor, sourceImportId: 'IMP1' }))).toBe(false);
    expect(
      ok(VendorSchema.safeParse({ ...vendor, origin: 'created_by_veyra', sourceInvoiceId: INV })),
    ).toBe(true);
  });
});

describe('PurchaseOrderSchema', () => {
  const po = {
    id: 'PO1',
    poNumber: 'AUTO/2026-27/1',
    vendorId: 'V100',
    poDate: '2026-09-17',
    status: 'open',
    origin: 'auto_created_from_invoice',
    sourceInvoiceId: INV,
    sourceImportId: null,
    approvedByUserId: null,
    createdAt: NOW,
    lines: [
      {
        id: 'L1',
        poId: 'PO1',
        lineNo: 1,
        itemId: 'I5',
        qtyMilli: 40_000,
        unitPricePaise: 24_500,
        gstRateBp: 1200,
      },
    ],
  };

  it('accepts an auto-created PO', () => {
    expect(ok(PurchaseOrderSchema.safeParse(po))).toBe(true);
  });

  it('enforces origin invariants', () => {
    expect(ok(PurchaseOrderSchema.safeParse({ ...po, sourceInvoiceId: null }))).toBe(false);
    expect(
      ok(PurchaseOrderSchema.safeParse({ ...po, origin: 'created_from_invoice_on_approval' })),
    ).toBe(false);
    expect(
      ok(
        PurchaseOrderSchema.safeParse({
          ...po,
          origin: 'created_from_invoice_on_approval',
          approvedByUserId: USR,
        }),
      ),
    ).toBe(true);
    expect(ok(PurchaseOrderSchema.safeParse({ ...po, origin: 'seed' }))).toBe(false);
  });

  it('lines must be numbered, belong to the PO and have positive quantity', () => {
    const line = po.lines[0];
    expect(ok(PurchaseOrderSchema.safeParse({ ...po, lines: [{ ...line, lineNo: 2 }] }))).toBe(
      false,
    );
    expect(ok(PurchaseOrderSchema.safeParse({ ...po, lines: [{ ...line, poId: 'PO2' }] }))).toBe(
      false,
    );
    expect(ok(PurchaseOrderSchema.safeParse({ ...po, lines: [{ ...line, qtyMilli: 0 }] }))).toBe(
      false,
    );
    expect(ok(PurchaseOrderSchema.safeParse({ ...po, lines: [] }))).toBe(false);
  });
});

describe('GrnSchema', () => {
  const grn = {
    id: 'G1',
    grnNumber: 'GRN-2026-0203',
    poId: 'PO1',
    grnDate: '2026-09-17',
    origin: 'seed',
    confirmedByUserId: null,
    sourceInvoiceId: null,
    sourceImportId: null,
    createdAt: NOW,
    lines: [
      {
        id: 'GL1',
        grnId: 'G1',
        poLineId: 'L1',
        receivedQtyMilli: 50_000,
        acceptedQtyMilli: 40_000,
      },
    ],
  };

  it('accepts a seed GRN; accepted cannot exceed received', () => {
    expect(ok(GrnSchema.safeParse(grn))).toBe(true);
    const over = { ...grn, lines: [{ ...grn.lines[0], acceptedQtyMilli: 50_001 }] };
    expect(ok(GrnSchema.safeParse(over))).toBe(false);
  });

  it('GRNs via Veyrafy must name the confirming user and invoice', () => {
    expect(ok(GrnSchema.safeParse({ ...grn, origin: 'user_confirmed_via_veyra' }))).toBe(false);
    expect(
      ok(
        GrnSchema.safeParse({
          ...grn,
          origin: 'user_confirmed_via_veyra',
          confirmedByUserId: USR,
          sourceInvoiceId: INV,
        }),
      ),
    ).toBe(true);
  });
});

describe('PurchaseInvoiceSchema', () => {
  const inv = {
    id: 'PI1',
    vendorId: 'V100',
    vendorInvoiceNo: 'ns-0092',
    vendorInvoiceNoNormalized: 'NS-0092',
    invoiceDate: '2026-09-17',
    fy: '2026-27',
    poId: 'PO1',
    taxablePaise: 980_000,
    cgstPaise: 58_800,
    sgstPaise: 58_800,
    igstPaise: 0,
    roundOffPaise: null,
    totalPaise: 1_097_600,
    status: 'verified_pending_payment',
    veyraInvoiceId: INV,
    idempotencyKey: `veyra:${INV}:purchase_invoice`,
    createdAt: NOW,
    lines: [
      {
        id: 'PIL1',
        purchaseInvoiceId: 'PI1',
        lineNo: 1,
        poLineId: 'L1',
        itemId: 'I5',
        qtyMilli: 40_000,
        unitPricePaise: 24_500,
        taxablePaise: 980_000,
        gstRateBp: 1200,
        cgstPaise: null,
        sgstPaise: null,
        igstPaise: null,
      },
    ],
  };

  it('accepts DEMO S03 as recorded', () => {
    expect(ok(PurchaseInvoiceSchema.safeParse(inv))).toBe(true);
  });

  it('has no status other than verified_pending_payment', () => {
    for (const status of ['paid', 'payment_scheduled', 'approved']) {
      expect(ok(PurchaseInvoiceSchema.safeParse({ ...inv, status }))).toBe(false);
    }
  });

  it('checks derived fields and arithmetic exactly', () => {
    expect(
      ok(PurchaseInvoiceSchema.safeParse({ ...inv, vendorInvoiceNoNormalized: 'ns-0092' })),
    ).toBe(false);
    expect(ok(PurchaseInvoiceSchema.safeParse({ ...inv, fy: '2025-26' }))).toBe(false);
    expect(ok(PurchaseInvoiceSchema.safeParse({ ...inv, totalPaise: 1_097_601 }))).toBe(false);
    expect(
      ok(PurchaseInvoiceSchema.safeParse({ ...inv, taxablePaise: 980_001, totalPaise: 1_097_601 })),
    ).toBe(false);
    expect(
      ok(PurchaseInvoiceSchema.safeParse({ ...inv, idempotencyKey: `veyra:${INV}:${USR}` })),
    ).toBe(false);
  });

  it('includes a printed round-off in the total', () => {
    // S06-shaped: 3,687.50 + 0.50 = 3,688.00
    const withRoundOff = {
      ...inv,
      taxablePaise: 312_500,
      cgstPaise: 28_125,
      sgstPaise: 28_125,
      roundOffPaise: 50,
      totalPaise: 368_800,
      lines: [
        {
          ...inv.lines[0],
          qtyMilli: 50_000,
          unitPricePaise: 6250,
          taxablePaise: 312_500,
          gstRateBp: 1800,
        },
      ],
    };
    expect(ok(PurchaseInvoiceSchema.safeParse(withRoundOff))).toBe(true);
    expect(ok(PurchaseInvoiceSchema.safeParse({ ...withRoundOff, roundOffPaise: null }))).toBe(
      false,
    );
  });
});

describe('write inputs', () => {
  it('createVendor needs a checksum-valid canonical GSTIN', () => {
    const base = { name: 'Nandi Stationers Pvt Ltd', address: 'Bengaluru', sourceInvoiceId: INV };
    expect(ok(CreateVendorInputSchema.safeParse({ ...base, gstin: '29AADCN9753P1ZH' }))).toBe(true);
    expect(ok(CreateVendorInputSchema.safeParse({ ...base, gstin: '29AAGCM4455J1Z5' }))).toBe(
      false,
    );
  });

  it('createItem requires an approver and a valid HSN', () => {
    const base = {
      name: 'Whiteboard Marker Box of 10',
      uom: 'BOX',
      gstRateBp: 1800,
      sourceInvoiceId: INV,
    };
    expect(
      ok(CreateItemInputSchema.safeParse({ ...base, hsnSac: '9608', approvedByUserId: USR })),
    ).toBe(true);
    expect(ok(CreateItemInputSchema.safeParse({ ...base, hsnSac: '9608' }))).toBe(false);
    expect(
      ok(CreateItemInputSchema.safeParse({ ...base, hsnSac: '960', approvedByUserId: USR })),
    ).toBe(false);
  });

  it('createPurchaseOrder cannot carry a PO number and ties approver to origin', () => {
    const base = {
      vendorId: 'V100',
      poDate: '2026-09-17',
      origin: 'auto_created_from_invoice',
      sourceInvoiceId: INV,
      approvedByUserId: null,
      lines: [
        { lineNo: 1, itemId: 'I5', qtyMilli: 40_000, unitPricePaise: 24_500, gstRateBp: 1200 },
      ],
    };
    expect(ok(CreatePurchaseOrderInputSchema.safeParse(base))).toBe(true);
    expect(
      CreatePurchaseOrderInputSchema.parse({ ...base, poNumber: 'PO-2026-0199' }),
    ).not.toHaveProperty('poNumber');
    expect(ok(CreatePurchaseOrderInputSchema.safeParse({ ...base, origin: 'seed' }))).toBe(false);
    expect(ok(CreatePurchaseOrderInputSchema.safeParse({ ...base, approvedByUserId: USR }))).toBe(
      false,
    );
  });

  it('createGrn requires explicit, consistent quantities and a confirming user', () => {
    const base = {
      poId: 'PO1',
      grnDate: '2026-09-17',
      confirmedByUserId: USR,
      sourceInvoiceId: INV,
      lines: [{ poLineId: 'L1', receivedQtyMilli: 50_000, acceptedQtyMilli: 40_000 }],
    };
    expect(ok(CreateGrnInputSchema.safeParse(base))).toBe(true);
    const line = base.lines[0];
    expect(
      ok(
        CreateGrnInputSchema.safeParse({ ...base, lines: [{ ...line, acceptedQtyMilli: 50_001 }] }),
      ),
    ).toBe(false);
    expect(
      ok(
        CreateGrnInputSchema.safeParse({
          ...base,
          lines: [{ ...line, receivedQtyMilli: 0, acceptedQtyMilli: 0 }],
        }),
      ),
    ).toBe(false);
    expect(ok(CreateGrnInputSchema.safeParse({ ...base, lines: [line, line] }))).toBe(false);
    expect(ok(CreateGrnInputSchema.safeParse({ ...base, confirmedByUserId: undefined }))).toBe(
      false,
    );
  });

  it('recordPurchaseInvoice requires consistent totals', () => {
    const base = {
      vendorId: 'V100',
      vendorInvoiceNo: 'NS-0092',
      invoiceDate: '2026-09-17',
      poId: 'PO1',
      taxablePaise: 980_000,
      cgstPaise: 58_800,
      sgstPaise: 58_800,
      igstPaise: 0,
      roundOffPaise: null,
      totalPaise: 1_097_600,
      veyraInvoiceId: INV,
      lines: [
        {
          lineNo: 1,
          poLineId: 'L1',
          itemId: 'I5',
          qtyMilli: 40_000,
          unitPricePaise: 24_500,
          taxablePaise: 980_000,
          gstRateBp: 1200,
          cgstPaise: null,
          sgstPaise: null,
          igstPaise: null,
        },
      ],
    };
    expect(ok(RecordPurchaseInvoiceInputSchema.safeParse(base))).toBe(true);
    expect(ok(RecordPurchaseInvoiceInputSchema.safeParse({ ...base, totalPaise: 1_097_599 }))).toBe(
      false,
    );
    expect(ok(RecordPurchaseInvoiceInputSchema.safeParse({ ...base, cgstPaise: 58_800.5 }))).toBe(
      false,
    );
  });
});
