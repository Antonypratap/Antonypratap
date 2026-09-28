import { createHash } from 'node:crypto';
import type { ErpId, IdempotencyKey } from '@veyra/shared';
import { ErpIdempotencyConflictError } from './errors';
import type { ErpWriteOperation } from './operations';

/**
 * Idempotency contract for ERP writes (ARCHITECTURE §4.3, decision D4).
 *
 * Every write takes an IdempotencyKey. An implementation MUST:
 *
 *  1. Execute: on first use of a key, validate the input, perform the write, and durably record
 *     `{ key, operation, payloadHash, resultId }` atomically with the write itself.
 *  2. Replay: for the same key, same operation and same payload hash, perform no write and return
 *     the record identified by `resultId` (same id, current state). This holds across restarts.
 *  3. Refuse misuse: for the same key with a different operation or payload, throw
 *     ErpIdempotencyConflictError and write nothing.
 *  4. Not consume keys on failure: a write that fails (validation, not found, conflict,
 *     unavailable before commit) records nothing under its key.
 *  5. Never resolve natural-key conflicts silently: if a record with the same natural key already
 *     exists under a different key, throw ErpConflictError with its id; never return that record.
 *
 * Consequently: same key + same operation + same payload ⇒ same resulting record, and a commit
 * that crashes anywhere can be re-run with the same keys without creating duplicates.
 */

export interface IdempotencyRecord {
  key: IdempotencyKey;
  operation: ErpWriteOperation;
  payloadHash: string;
  resultId: ErpId;
}

export interface IdempotentWriteAttempt {
  key: IdempotencyKey;
  operation: ErpWriteOperation;
  payloadHash: string;
}

export type IdempotencyDecision =
  | { kind: 'execute' }
  | { kind: 'replay'; resultId: ErpId }
  | { kind: 'conflict'; error: ErpIdempotencyConflictError };

/** Rules 1–3 as a pure decision, given the ledger entry recorded for the key (if any). */
export function decideIdempotentWrite(
  recorded: IdempotencyRecord | null,
  attempt: IdempotentWriteAttempt,
): IdempotencyDecision {
  if (recorded === null) return { kind: 'execute' };
  if (recorded.key !== attempt.key)
    throw new Error('ledger lookup returned a record for a different key');
  if (recorded.operation !== attempt.operation) {
    return {
      kind: 'conflict',
      error: new ErpIdempotencyConflictError(
        attempt.key,
        'operation_mismatch',
        recorded.operation,
        attempt.operation,
      ),
    };
  }
  if (recorded.payloadHash !== attempt.payloadHash) {
    return {
      kind: 'conflict',
      error: new ErpIdempotencyConflictError(
        attempt.key,
        'payload_mismatch',
        recorded.operation,
        attempt.operation,
      ),
    };
  }
  return { kind: 'replay', resultId: recorded.resultId };
}

/**
 * Deterministic JSON for hashing write payloads: object keys sorted, undefined properties
 * omitted. Only plain objects, arrays, strings, booleans, null and safe integers are allowed:
 * ERP payloads never contain floating-point numbers.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new TypeError(`non-integer number in payload: ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((v: unknown) => {
        if (v === undefined) throw new TypeError('undefined inside an array');
        return canonicalJson(v);
      })
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError('only plain objects are allowed');
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`unsupported value in payload: ${typeof value}`);
}

/** SHA-256 (hex) of the canonical JSON of a write payload. */
export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
