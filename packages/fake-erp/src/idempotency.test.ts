import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CreationActionIdSchema,
  InvoiceIdSchema,
  UserIdSchema,
  creationIdempotencyKey,
  purchaseInvoiceIdempotencyKey,
} from '@veyra/shared';
import {
  ErpIdempotencyConflictError,
  type CreateItemInput,
  type RecordPurchaseInvoiceInput,
} from '@veyra/erp-connector';
import { tempErp } from './test/temp-db';

const ulid = (n: number) => n.toString().padStart(26, '0');
const INVOICE = InvoiceIdSchema.parse(ulid(1));
const USER = UserIdSchema.parse(ulid(9));
const key = (n: number) => creationIdempotencyKey(INVOICE, CreationActionIdSchema.parse(ulid(n)));

const marker: CreateItemInput = {
  name: 'Whiteboard Marker Box of 10',
  hsnSac: '9608',
  uom: 'BOX',
  gstRateBp: 1800,
  sourceInvoiceId: INVOICE,
  approvedByUserId: USER,
};

const count = (filename: string, table: string): number => {
  const db = new Database(filename, { readonly: true });
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('idempotent writes', () => {
  it('1–2: first write succeeds; an identical retry returns it without a duplicate', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const first = await t.erp.createItem(marker, key(1));
    const again = await t.erp.createItem({ ...marker }, key(1));
    expect(again).toEqual(first);
    expect(count(t.filename, 'items')).toBe(8);
    expect(count(t.filename, 'idempotency_log')).toBe(1);
  });

  it('3: a retry after a restart does not duplicate', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const first = await t.erp.createItem(marker, key(1));
    t.erp.close(); // the process "dies" after committing, before the caller saw the result
    const restarted = t.open();
    expect(await restarted.createItem(marker, key(1))).toEqual(first);
    expect(count(t.filename, 'items')).toBe(8);
  });

  it('4: the same key with a changed payload fails and writes nothing', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    await t.erp.createItem(marker, key(1));
    const error = await t.erp
      .createItem({ ...marker, gstRateBp: 1200 }, key(1))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErpIdempotencyConflictError);
    expect((error as ErpIdempotencyConflictError).reason).toBe('payload_mismatch');
    expect(count(t.filename, 'items')).toBe(8);
  });

  it('5: different keys create separate legitimate records', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const a = await t.erp.createItem(marker, key(1));
    const b = await t.erp.createItem(marker, key(2));
    expect([a.code, b.code]).toEqual(['ITM-008', 'ITM-009']);
    expect(count(t.filename, 'items')).toBe(9);
  });

  it('replays return the current state of the original record', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const input = {
      name: 'Nandi Stationers Pvt Ltd',
      gstin: '29AADCN9753P1ZH',
      address: 'Bengaluru',
      sourceInvoiceId: INVOICE,
    };
    const v = await t.erp.createVendor(input, key(1));
    await t.erp.reactivateVendor(
      { vendorId: v.id, sourceInvoiceId: INVOICE, approvedByUserId: USER },
      key(2),
    );
    expect((await t.erp.createVendor(input, key(1))).id).toBe(v.id);
  });

  it('a whole purchase invoice replays after restart with no duplicate header or lines', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const input: RecordPurchaseInvoiceInput = {
      vendorId: 'V002',
      vendorInvoiceNo: 'APX-7781',
      invoiceDate: '2026-09-16',
      poId: 'PO-2026-0103',
      taxablePaise: 1_450_000,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 261_000,
      roundOffPaise: null,
      totalPaise: 1_711_000,
      veyraInvoiceId: INVOICE,
      lines: [
        {
          lineNo: 1,
          poLineId: 'PO-2026-0103#1',
          itemId: 'ITM-003',
          qtyMilli: 100_000,
          unitPricePaise: 14_500,
          taxablePaise: 1_450_000,
          gstRateBp: 1800,
          cgstPaise: null,
          sgstPaise: null,
          igstPaise: 261_000,
        },
      ],
    };
    const k = purchaseInvoiceIdempotencyKey(INVOICE);
    const first = await t.erp.recordPurchaseInvoice(input, k);
    t.erp.close();
    const restarted = t.open();
    expect(await restarted.recordPurchaseInvoice(input, k)).toEqual(first);
    expect(count(t.filename, 'purchase_invoices')).toBe(1);
    expect(count(t.filename, 'purchase_invoice_lines')).toBe(1);
    expect(await restarted.getInvoicedQtyByPoLine(first.lines[0]?.poLineId ?? ('' as never))).toBe(
      100_000,
    );
  });
});
