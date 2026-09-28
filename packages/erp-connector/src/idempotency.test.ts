import { describe, expect, it } from 'vitest';
import { ErpIdSchema, IdempotencyKeySchema, type ErpId } from '@veyra/shared';
import { ErpIdempotencyConflictError } from './errors';
import {
  canonicalJson,
  decideIdempotentWrite,
  payloadHash,
  type IdempotencyRecord,
} from './idempotency';
import type { ErpWriteOperation } from './operations';

const KEY = IdempotencyKeySchema.parse(`veyra:${'1'.padStart(26, '0')}:${'2'.padStart(26, '0')}`);
const OTHER_KEY = IdempotencyKeySchema.parse(`veyra:${'1'.padStart(26, '0')}:purchase_invoice`);
const id = (s: string): ErpId => ErpIdSchema.parse(s);

describe('decideIdempotentWrite', () => {
  const recorded: IdempotencyRecord = {
    key: KEY,
    operation: 'createVendor',
    payloadHash: payloadHash({ gstin: '29AADCN9753P1ZH' }),
    resultId: id('V100'),
  };

  it('executes the first use of a key', () => {
    expect(
      decideIdempotentWrite(null, { key: KEY, operation: 'createVendor', payloadHash: 'x' }),
    ).toEqual({
      kind: 'execute',
    });
  });

  it('replays the same operation and payload to the same record', () => {
    const decision = decideIdempotentWrite(recorded, {
      key: KEY,
      operation: 'createVendor',
      payloadHash: payloadHash({ gstin: '29AADCN9753P1ZH' }),
    });
    expect(decision).toEqual({ kind: 'replay', resultId: 'V100' });
  });

  it('refuses a different payload under the same key', () => {
    const decision = decideIdempotentWrite(recorded, {
      key: KEY,
      operation: 'createVendor',
      payloadHash: payloadHash({ gstin: '29AAKCE3344D1ZP' }),
    });
    expect(decision.kind).toBe('conflict');
    if (decision.kind === 'conflict') {
      expect(decision.error).toBeInstanceOf(ErpIdempotencyConflictError);
      expect(decision.error.reason).toBe('payload_mismatch');
      expect(decision.error.retryable).toBe(false);
    }
  });

  it('refuses a different operation under the same key', () => {
    const decision = decideIdempotentWrite(recorded, {
      key: KEY,
      operation: 'createItem',
      payloadHash: recorded.payloadHash,
    });
    expect(decision.kind === 'conflict' && decision.error.reason).toBe('operation_mismatch');
  });

  it('treats a ledger entry for another key as a bug', () => {
    expect(() =>
      decideIdempotentWrite(recorded, {
        key: OTHER_KEY,
        operation: 'createVendor',
        payloadHash: recorded.payloadHash,
      }),
    ).toThrow();
  });

  it('a crash-and-retry sequence against a durable ledger never executes twice', () => {
    // Simulates the ledger an implementation keeps; `executions` counts real writes.
    const ledger = new Map<string, IdempotencyRecord>();
    let executions = 0;
    const write = (operation: ErpWriteOperation, payload: unknown): ErpId => {
      const hash = payloadHash(payload);
      const decision = decideIdempotentWrite(ledger.get(KEY) ?? null, {
        key: KEY,
        operation,
        payloadHash: hash,
      });
      if (decision.kind === 'conflict') throw decision.error;
      if (decision.kind === 'replay') return decision.resultId;
      executions++;
      const resultId = id(`R${executions}`);
      ledger.set(KEY, { key: KEY, operation, payloadHash: hash, resultId });
      return resultId;
    };
    const payload = { name: 'Nandi Stationers Pvt Ltd', gstin: '29AADCN9753P1ZH' };
    const first = write('createVendor', payload);
    const retries = [
      write('createVendor', { gstin: payload.gstin, name: payload.name }),
      write('createVendor', payload),
    ];
    expect(retries).toEqual([first, first]);
    expect(executions).toBe(1);
    expect(() => write('createVendor', { ...payload, name: 'Other' })).toThrow(
      ErpIdempotencyConflictError,
    );
    expect(executions).toBe(1);
  });
});

describe('canonicalJson / payloadHash', () => {
  it('is independent of key order and ignores undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,2]},"b":1}',
    );
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('distinguishes different values and array order', () => {
    expect(payloadHash({ qty: 40_000 })).not.toBe(payloadHash({ qty: 40_001 }));
    expect(payloadHash([1, 2])).not.toBe(payloadHash([2, 1]));
    expect(payloadHash({ a: null })).not.toBe(payloadHash({}));
  });

  it('refuses floats and non-JSON values', () => {
    for (const bad of [
      { price: 62.5 },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      [undefined],
      { d: new Date(0) },
      { b: 1n },
      { f: () => 1 },
      new Map(),
    ]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
  });

  it('hashes are hex SHA-256', () => {
    expect(payloadHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});
