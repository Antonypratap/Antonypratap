import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErpIdSchema, IdempotencyKeySchema } from '@veyra/shared';
import {
  ErpConflictError,
  ErpConnectorError,
  ErpIdempotencyConflictError,
  ErpNotFoundError,
  ErpAuthenticationError,
  ErpConfigurationError,
  ErpUnavailableError,
  ErpUnsupportedOperationError,
  RETRYABLE_ERP_ERRORS,
  safeErpError,
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
    new ErpUnavailableError({ reason: 'network' }),
    new ErpUnsupportedOperationError('createGrn', 'goods_receipt.create'),
    new ErpAuthenticationError(),
    new ErpConfigurationError(),
  ];

  it('have distinct codes and are all ErpConnectorErrors', () => {
    expect(all.map((e) => e.code)).toEqual([
      'NOT_FOUND',
      'CONFLICT',
      'VALIDATION',
      'IDEMPOTENCY_CONFLICT',
      'UNAVAILABLE',
      'UNSUPPORTED',
      'AUTHENTICATION_FAILED',
      'CONFIGURATION_ERROR',
    ]);
    for (const e of all) {
      expect(e).toBeInstanceOf(ErpConnectorError);
      expect(e).toBeInstanceOf(Error);
      expect(isErpConnectorError(e)).toBe(true);
    }
    expect(isErpConnectorError(new Error('plain'))).toBe(false);
  });

  it('only UNAVAILABLE (unavailable, network, timeout) is retryable', () => {
    expect(all.filter((e) => e.retryable).map((e) => e.code)).toEqual(['UNAVAILABLE']);
    expect(RETRYABLE_ERP_ERRORS).toEqual(['UNAVAILABLE']);
    for (const reason of ['unavailable', 'network', 'timeout'] as const)
      expect(new ErpUnavailableError({ reason }).retryable).toBe(true);
    for (const e of [new ErpAuthenticationError(), new ErpConfigurationError()])
      expect(e.retryable).toBe(false);
  });

  it('every error has a safe user message and a safe JSON form', () => {
    for (const e of all) {
      expect(e.userMessage.length).toBeGreaterThan(10);
      expect(e.toSafeJSON()).toEqual({
        code: e.code,
        message: e.userMessage,
        retryable: e.retryable,
        externalReference: e.externalReference,
      });
    }
    expect(safeErpError(new Error('x'))).toBeNull();
  });

  it('never carries secrets or infrastructure detail from the underlying failure', () => {
    const cause = new Error(
      'connect ECONNREFUSED 10.1.2.3:5432 password=hunter2 Authorization: Bearer abc.def',
    );
    for (const e of [
      new ErpUnavailableError({ reason: 'network', cause }),
      new ErpUnavailableError({ reason: 'timeout', writeOutcome: 'unknown', cause }),
      new ErpAuthenticationError({ cause }),
      new ErpConfigurationError({ cause }),
    ]) {
      const shown = `${e.message} ${e.userMessage} ${JSON.stringify(e.toSafeJSON())} ${JSON.stringify(e)}`;
      expect(shown).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|hunter2|Bearer|password|5432/);
    }
  });

  it('an unavailable write says whether it was sent: not sent is plainly retryable, unknown needs reconciling', () => {
    expect(new ErpUnavailableError().writeOutcome).toBe('not_sent');
    const lost = new ErpUnavailableError({ reason: 'timeout', writeOutcome: 'unknown' });
    expect(lost.userMessage).toMatch(/could not confirm/);
    expect(new ErpUnavailableError().userMessage).toBe(
      "Veyrafy couldn't reach the business system. Nothing was posted.",
    );
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
