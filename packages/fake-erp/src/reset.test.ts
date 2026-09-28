import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { InvoiceIdSchema, creationIdempotencyKey, CreationActionIdSchema } from '@veyra/shared';
import { tempErp } from './test/temp-db';

const TABLES = [
  'company',
  'vendors',
  'items',
  'vendor_item_aliases',
  'purchase_orders',
  'po_lines',
  'grns',
  'grn_lines',
  'purchase_invoices',
  'purchase_invoice_lines',
  'idempotency_log',
];

function dump(filename: string): Record<string, unknown[]> {
  const db = new Database(filename, { readonly: true });
  try {
    return Object.fromEntries(
      TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]),
    );
  } finally {
    db.close();
  }
}

const ulid = (n: number) => n.toString().padStart(26, '0');
const INVOICE = InvoiceIdSchema.parse(ulid(1));
const key = (n: number) => creationIdempotencyKey(INVOICE, CreationActionIdSchema.parse(ulid(n)));

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('deterministic seed / reset', () => {
  it('seeding twice yields the identical database', () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const first = dump(t.filename);
    t.erp.reset('demo');
    expect(dump(t.filename)).toEqual(first);
    expect(first['vendors']).toHaveLength(7);
    expect(first['items']).toHaveLength(7);
    expect(first['purchase_orders']).toHaveLength(13);
    expect(first['po_lines']).toHaveLength(14);
    expect(first['grns']).toHaveLength(12);
    expect(first['grn_lines']).toHaveLength(13);
    expect(first['purchase_invoices']).toHaveLength(0);
    expect(first['vendor_item_aliases']).toHaveLength(0);
  });

  it('reset removes everything written since, including idempotency keys', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const pristine = dump(t.filename);
    const input = {
      name: 'Nandi Stationers Pvt Ltd',
      gstin: '29AADCN9753P1ZH',
      address: 'Karnataka',
      sourceInvoiceId: INVOICE,
    };
    const created = await t.erp.createVendor(input, key(100));
    expect(created.code).toBe('V008');
    t.erp.reset('demo');
    expect(dump(t.filename)).toEqual(pristine);
    // The key is forgotten: the same write executes again and yields the same deterministic code.
    expect((await t.erp.createVendor(input, key(100))).code).toBe('V008');
  });

  it('reopening a seeded file without reset leaves it untouched', () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const before = dump(t.filename);
    t.open();
    expect(dump(t.filename)).toEqual(before);
  });

  it('company-only seed contains just the company', () => {
    const t = tempErp({ reset: 'company-only' });
    cleanup = t.cleanup;
    const d = dump(t.filename);
    expect(d['company']).toHaveLength(1);
    for (const table of TABLES.filter((x) => x !== 'company')) expect(d[table]).toHaveLength(0);
  });

  it('a fresh, unseeded database has no company', async () => {
    const t = tempErp();
    cleanup = t.cleanup;
    await expect(t.erp.getCompany()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
