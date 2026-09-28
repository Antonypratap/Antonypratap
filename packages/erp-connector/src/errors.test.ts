import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErpIdSchema, IdempotencyKeySchema } from '@veyra/shared';
import {
  ErpConflictError,
  ErpConnectorError,
  ErpIdempotencyConflictError,
  ErpNotFoundError,
  ErpUnavailableError,
  ErpUnsupportedOperationError,
  ErpValidationError,
  isErpConnectorError,
} from './errors';

describe('ERP connector errors', () => {
  const key = IdempotencyKeySchema.parse(`veyra:${'1'.padStart(26, '0')}:purchase_invoice`);
  const all = [
    new ErpNotFoundError('purchase_order', 'PO-9'),
    new ErpConflictError('vendor', { gstin: '29AADCN9753P1ZH' }, ErpIdSchema.parse('V1')),
    new ErpValidationError('createGrn', [{ path: 'lines.0', message: 'bad' }]),
    new ErpIdempotencyConflictError(key, 'payload_mismatch', 'createVendor', 'createVendor'),
    new ErpUnavailableError('connection refused'),
    new ErpUnsupportedOperationError('createGrn'),
  ];

  it('have distinct codes and are all ErpConnectorErrors', () => {
    expect(all.map((e) => e.code)).toEqual([
      'NOT_FOUND',
      'CONFLICT',
      'VALIDATION',
      'IDEMPOTENCY_CONFLICT',
      'UNAVAILABLE',
      'UNSUPPORTED_OPERATION',
    ]);
    for (const e of all) {
      expect(e).toBeInstanceOf(ErpConnectorError);
      expect(e).toBeInstanceOf(Error);
      expect(isErpConnectorError(e)).toBe(true);
    }
    expect(isErpConnectorError(new Error('plain'))).toBe(false);
  });

  it('only UNAVAILABLE is retryable', () => {
    expect(all.filter((e) => e.retryable).map((e) => e.code)).toEqual(['UNAVAILABLE']);
  });

  it('conflicts carry the existing record id so the workflow can re-match', () => {
    const e = all[1] as ErpConflictError;
    expect(e.existingId).toBe('V1');
    expect(e.naturalKey).toEqual({ gstin: '29AADCN9753P1ZH' });
  });

  it('validation errors can be built from Zod issues', () => {
    const result = z.object({ qty: z.int().positive() }).safeParse({ qty: 0 });
    if (result.success) throw new Error('expected failure');
    const e = ErpValidationError.fromZod('createPurchaseOrder', result.error);
    expect(e.issues).toHaveLength(1);
    expect(e.issues[0]?.path).toBe('qty');
    expect(e.message).toContain('createPurchaseOrder');
  });
});
