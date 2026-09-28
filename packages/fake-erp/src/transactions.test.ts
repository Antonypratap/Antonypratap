import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CreationActionIdSchema,
  InvoiceIdSchema,
  UserIdSchema,
  creationIdempotencyKey,
  purchaseInvoiceIdempotencyKey,
} from '@veyra/shared';
import type { RecordPurchaseInvoiceInput } from '@veyra/erp-connector';
import type { FakeErpFailpoint } from './index';
import { tempErp } from './test/temp-db';

const ulid = (n: number) => n.toString().padStart(26, '0');
const INVOICE = InvoiceIdSchema.parse(ulid(1));
const USER = UserIdSchema.parse(ulid(9));

class SimulatedCrash extends Error {}

/** A failpoint that throws the `nth` time `name` is reached, until disarmed. */
function crashAt(name: FakeErpFailpoint, nth = 1) {
  const state = { armed: true, hits: 0 };
  return {
    state,
    hooks: {
      failpoint: (reached: FakeErpFailpoint) => {
        if (!state.armed || reached !== name) return;
        state.hits++;
        if (state.hits === nth) throw new SimulatedCrash(name);
      },
    },
  };
}

function counts(filename: string): Record<string, number> {
  const db = new Database(filename, { readonly: true });
  try {
    const tables = [
      'vendors',
      'purchase_orders',
      'po_lines',
      'grns',
      'grn_lines',
      'purchase_invoices',
      'purchase_invoice_lines',
      'idempotency_log',
    ];
    return Object.fromEntries(
      tables.map((t) => [
        t,
        (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
      ]),
    );
  } finally {
    db.close();
  }
}

const s01: RecordPurchaseInvoiceInput = {
  vendorId: 'V001',
  vendorInvoiceNo: 'SSS/26-27/0451',
  invoiceDate: '2026-09-15',
  poId: 'PO-2026-0101',
  taxablePaise: 9_650_000,
  cgstPaise: 868_500,
  sgstPaise: 868_500,
  igstPaise: 0,
  roundOffPaise: null,
  totalPaise: 11_387_000,
  veyraInvoiceId: INVOICE,
  lines: [
    {
      lineNo: 1,
      poLineId: 'PO-2026-0101#1',
      itemId: 'ITM-001',
      qtyMilli: 1_000_000,
      unitPricePaise: 6250,
      taxablePaise: 6_250_000,
      gstRateBp: 1800,
      cgstPaise: null,
      sgstPaise: null,
      igstPaise: null,
    },
    {
      lineNo: 2,
      poLineId: 'PO-2026-0101#2',
      itemId: 'ITM-002',
      qtyMilli: 500_000,
      unitPricePaise: 6800,
      taxablePaise: 3_400_000,
      gstRateBp: 1800,
      cgstPaise: null,
      sgstPaise: null,
      igstPaise: null,
    },
  ],
};
const INVOICE_KEY = purchaseInvoiceIdempotencyKey(INVOICE);

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('atomic writes and retry after failure', () => {
  it.each([
    ['purchase_invoice.header_inserted', 1],
    ['purchase_invoice.line_inserted', 1],
    ['purchase_invoice.line_inserted', 2],
    ['write.executed', 1],
  ] as const)(
    'a crash at %s (#%d) leaves no header, no lines and no key; the retry records exactly once',
    async (point, nth) => {
      const crash = crashAt(point, nth);
      const t = tempErp({ reset: 'demo', testHooks: crash.hooks });
      cleanup = t.cleanup;
      const before = counts(t.filename);

      await expect(t.erp.recordPurchaseInvoice(s01, INVOICE_KEY)).rejects.toBeInstanceOf(
        SimulatedCrash,
      );
      expect(counts(t.filename)).toEqual(before);

      crash.state.armed = false;
      const recorded = await t.erp.recordPurchaseInvoice(s01, INVOICE_KEY);
      expect(recorded.lines).toHaveLength(2);
      const after = counts(t.filename);
      expect(after['purchase_invoices']).toBe((before['purchase_invoices'] ?? 0) + 1);
      expect(after['purchase_invoice_lines']).toBe((before['purchase_invoice_lines'] ?? 0) + 2);
      expect(after['idempotency_log']).toBe((before['idempotency_log'] ?? 0) + 1);
    },
  );

  it('a crashed transaction is invisible to a restarted process', async () => {
    const crash = crashAt('purchase_invoice.line_inserted', 2);
    const t = tempErp({ reset: 'demo', testHooks: crash.hooks });
    cleanup = t.cleanup;
    await expect(t.erp.recordPurchaseInvoice(s01, INVOICE_KEY)).rejects.toBeInstanceOf(
      SimulatedCrash,
    );
    t.erp.close();
    const restarted = t.open();
    expect(await restarted.getInvoicedQtyByPoLine('PO-2026-0101#1' as never)).toBe(0);
    expect((await restarted.recordPurchaseInvoice(s01, INVOICE_KEY)).lines).toHaveLength(2);
  });

  it('a PO is never left without its lines', async () => {
    const crash = crashAt('purchase_order.header_inserted');
    const t = tempErp({ reset: 'demo', testHooks: crash.hooks });
    cleanup = t.cleanup;
    const input = {
      vendorId: 'V007',
      poDate: '2026-09-18',
      origin: 'auto_created_from_invoice' as const,
      sourceInvoiceId: INVOICE,
      approvedByUserId: null,
      lines: [
        {
          lineNo: 1,
          itemId: 'ITM-007',
          qtyMilli: 12_000,
          unitPricePaise: 245_000,
          gstRateBp: 1800,
        },
      ],
    };
    const k = creationIdempotencyKey(INVOICE, CreationActionIdSchema.parse(ulid(50)));
    const before = counts(t.filename);
    await expect(t.erp.createPurchaseOrder(input, k)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(counts(t.filename)).toEqual(before);
    crash.state.armed = false;
    expect((await t.erp.createPurchaseOrder(input, k)).poNumber).toBe('AUTO/2026-27/1');
  });

  it('a GRN is never left without its lines', async () => {
    const crash = crashAt('grn.header_inserted');
    const t = tempErp({ reset: 'demo', testHooks: crash.hooks });
    cleanup = t.cleanup;
    const input = {
      poId: 'PO-2026-0104',
      grnDate: '2026-09-20',
      confirmedByUserId: USER,
      sourceInvoiceId: INVOICE,
      lines: [{ poLineId: 'PO-2026-0104#1', receivedQtyMilli: 50_000, acceptedQtyMilli: 50_000 }],
    };
    const k = creationIdempotencyKey(INVOICE, CreationActionIdSchema.parse(ulid(51)));
    const before = counts(t.filename);
    await expect(t.erp.createGrn(input, k)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(counts(t.filename)).toEqual(before);
    crash.state.armed = false;
    expect((await t.erp.createGrn(input, k)).lines).toHaveLength(1);
    expect(counts(t.filename)['grn_lines']).toBe((before['grn_lines'] ?? 0) + 1);
  });

  it('a failed write (validation, conflict) leaves nothing behind', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const before = counts(t.filename);
    await expect(
      t.erp.recordPurchaseInvoice({ ...s01, totalPaise: 1 }, INVOICE_KEY),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      t.erp.createVendor(
        { name: 'Shakti', gstin: '29AAFCS5678K1ZK', address: 'x', sourceInvoiceId: INVOICE },
        creationIdempotencyKey(INVOICE, CreationActionIdSchema.parse(ulid(52))),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(counts(t.filename)).toEqual(before);
  });
});
