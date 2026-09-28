import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CreationActionIdSchema,
  ErpIdSchema,
  InvoiceIdSchema,
  UserIdSchema,
  creationIdempotencyKey,
} from '@veyra/shared';
import { ErpConnectorError, ErpUnavailableError } from '@veyra/erp-connector';
import { tempErp } from './test/temp-db';

const ulid = (n: number) => n.toString().padStart(26, '0');
const INVOICE = InvoiceIdSchema.parse(ulid(1));
const USER = UserIdSchema.parse(ulid(9));
const key = (n: number) => creationIdempotencyKey(INVOICE, CreationActionIdSchema.parse(ulid(n)));
const marker = {
  name: 'Whiteboard Marker Box of 10',
  hsnSac: '9608',
  uom: 'BOX',
  gstRateBp: 1800,
  sourceInvoiceId: INVOICE,
  approvedByUserId: USER,
};

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe('connector error mapping', () => {
  it('a locked database is UNAVAILABLE (retryable), and the retry with the same key succeeds once', async () => {
    const t = tempErp({ reset: 'demo', busyTimeoutMs: 20 });
    cleanup = t.cleanup;
    const blocker = new Database(t.filename);
    blocker.exec('BEGIN IMMEDIATE');
    const error = await t.erp.createItem(marker, key(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErpUnavailableError);
    expect((error as ErpUnavailableError).retryable).toBe(true);
    blocker.exec('ROLLBACK');
    blocker.close();
    const item = await t.erp.createItem(marker, key(1));
    expect(item.code).toBe('ITM-008');
    expect((await t.erp.createItem(marker, key(1))).id).toBe(item.id);
  });

  it('every failure surfaces as a typed ErpConnectorError', async () => {
    const t = tempErp({ reset: 'demo' });
    cleanup = t.cleanup;
    const cases: [Promise<unknown>, string][] = [
      [t.erp.listGrnsForPo(ErpIdSchema.parse('PO-NOPE')), 'NOT_FOUND'],
      [t.erp.createItem({ ...marker, hsnSac: '96' }, key(2)), 'VALIDATION'],
      [t.erp.createItem(marker, 'not-a-key' as never), 'VALIDATION'],
      [
        t.erp.createVendor(
          { name: 'Dup', gstin: '29AAFCS5678K1ZK', address: 'x', sourceInvoiceId: INVOICE },
          key(3),
        ),
        'CONFLICT',
      ],
    ];
    for (const [promise, code] of cases) {
      const e = await promise.catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ErpConnectorError);
      expect((e as ErpConnectorError).code).toBe(code);
    }
    await t.erp.createItem(marker, key(4));
    const e = await t.erp
      .createVendor(
        { name: 'X', gstin: '29AADCN9753P1ZH', address: 'x', sourceInvoiceId: INVOICE },
        key(4),
      )
      .catch((x: unknown) => x);
    expect((e as ErpConnectorError).code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
