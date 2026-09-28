import { describe, expect, it } from 'vitest';
import { IsoDateSchema, compareIsoDate, isoDate } from './dates';
import {
  CreationActionIdSchema,
  IdempotencyKeySchema,
  InvoiceIdSchema,
  creationIdempotencyKey,
  purchaseInvoiceIdempotencyKey,
} from './ids';
import { normalizeInvoiceNumber, normalizeName } from './text';

describe('IsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(IsoDateSchema.safeParse('2026-09-28').success).toBe(true);
    expect(IsoDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '28/09/2026',
      '2026-9-28',
    ]) {
      expect(IsoDateSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('orders chronologically', () => {
    expect(compareIsoDate(isoDate('2026-03-31'), isoDate('2026-04-01'))).toBe(-1);
    expect(compareIsoDate(isoDate('2026-09-15'), isoDate('2026-09-15'))).toBe(0);
  });
});

describe('ids', () => {
  const inv = InvoiceIdSchema.parse('01J9ZQ3V8X4N6T2K5M7P9R1S3W');
  const act = CreationActionIdSchema.parse('01J9ZQ3V8X4N6T2K5M7P9R1S3X');

  it('ULIDs reject lowercase and ambiguous letters', () => {
    expect(InvoiceIdSchema.safeParse('01j9zq3v8x4n6t2k5m7p9r1s3w').success).toBe(false);
    expect(InvoiceIdSchema.safeParse('01J9ZQ3V8X4N6T2K5M7P9R1S3I').success).toBe(false);
    expect(InvoiceIdSchema.safeParse('01J9ZQ3V8X4N6T2K5M7P9R1S3').success).toBe(false);
  });

  it('build idempotency keys of the documented shape', () => {
    expect(creationIdempotencyKey(inv, act)).toBe(`veyra:${inv}:${act}`);
    expect(purchaseInvoiceIdempotencyKey(inv)).toBe(`veyra:${inv}:purchase_invoice`);
    expect(IdempotencyKeySchema.safeParse(creationIdempotencyKey(inv, act)).success).toBe(true);
    expect(IdempotencyKeySchema.safeParse(`veyra:${inv}:something`).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse(`${inv}:${act}`).success).toBe(false);
  });
});

describe('normalizeName (candidate lists only)', () => {
  it('collapses legal forms and punctuation', () => {
    expect(normalizeName('Vasudha Traders')).toBe('vasudha traders');
    expect(normalizeName('Vasudha Traders & Co')).toBe('vasudha traders'); // DEMO S17 ambiguity
    expect(normalizeName('M/s. Shakti Steel Suppliers Pvt. Ltd.')).toBe('shakti steel suppliers');
    expect(normalizeName('  Kaveri Tools & Hardware (Private) Limited ')).toBe(
      'kaveri tools hardware',
    );
    expect(normalizeName('A.B.C. Traders')).toBe('a b c traders');
  });

  it('applies NFKC', () => {
    expect(normalizeName('ＡＰＥＸ Components')).toBe('apex components');
  });
});

describe('normalizeInvoiceNumber', () => {
  it('uppercases and removes whitespace only', () => {
    expect(normalizeInvoiceNumber(' sss/26-27/ 0451 ')).toBe('SSS/26-27/0451');
    expect(normalizeInvoiceNumber('APX-0007781')).toBe('APX-0007781'); // leading zeros kept
    expect(normalizeInvoiceNumber('ＡＰＸ－７７８１')).toBe('APX-7781');
    expect(normalizeInvoiceNumber('APX-7781')).not.toBe(normalizeInvoiceNumber('APX7781'));
  });
});
