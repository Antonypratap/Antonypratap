import type { z } from 'zod';
import type { ErpEntityType, ErpId, IdempotencyKey } from '@veyra/shared';
import type { ErpOperation, ErpWriteOperation } from './operations';

export type ErpErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNAVAILABLE'
  | 'UNSUPPORTED_OPERATION';

/**
 * Base class of every error an ErpConnector may throw. Anything else escaping a connector is a
 * connector bug. Only UNAVAILABLE is retryable; retrying any write uses the same idempotency key.
 */
export abstract class ErpConnectorError extends Error {
  abstract readonly code: ErpErrorCode;
  abstract readonly retryable: boolean;
}

/** A referenced record does not exist (e.g. createGrn for an unknown PO). */
export class ErpNotFoundError extends ErpConnectorError {
  readonly code = 'NOT_FOUND';
  readonly retryable = false;
  constructor(
    readonly entity: ErpEntityType,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = 'ErpNotFoundError';
  }
}

/**
 * A natural key is already taken by a record written under a different idempotency key
 * (vendor GSTIN, vendor+alias code, vendor+invoice no+FY). The workflow reacts by re-running
 * MATCHING, which will now find `existingId`.
 */
export class ErpConflictError extends ErpConnectorError {
  readonly code = 'CONFLICT';
  readonly retryable = false;
  constructor(
    readonly entity: ErpEntityType,
    readonly naturalKey: Record<string, string>,
    readonly existingId: ErpId,
  ) {
    super(`${entity} already exists for ${JSON.stringify(naturalKey)}`);
    this.name = 'ErpConflictError';
  }
}

export interface ErpValidationIssue {
  path: string;
  message: string;
}

/** The input violates the operation's schema or the ERP's own rules. Nothing was written. */
export class ErpValidationError extends ErpConnectorError {
  readonly code = 'VALIDATION';
  readonly retryable = false;
  constructor(
    readonly operation: ErpOperation,
    readonly issues: readonly ErpValidationIssue[],
  ) {
    super(`${operation}: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'ErpValidationError';
  }

  static fromZod(operation: ErpOperation, error: z.ZodError): ErpValidationError {
    return new ErpValidationError(
      operation,
      error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
}

/** The key was already used for a different operation or a different payload. Nothing was written. */
export class ErpIdempotencyConflictError extends ErpConnectorError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly retryable = false;
  constructor(
    readonly key: IdempotencyKey,
    readonly reason: 'operation_mismatch' | 'payload_mismatch',
    readonly recordedOperation: ErpWriteOperation,
    readonly attemptedOperation: ErpWriteOperation,
  ) {
    super(`idempotency key ${key} was already used (${reason})`);
    this.name = 'ErpIdempotencyConflictError';
  }
}

/** The ERP could not be reached or failed transiently. The outcome of a write is unknown: retry with the same key. */
export class ErpUnavailableError extends ErpConnectorError {
  readonly code = 'UNAVAILABLE';
  readonly retryable = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ErpUnavailableError';
  }
}

/** This connector cannot perform the operation (e.g. an ERP without GRNs). */
export class ErpUnsupportedOperationError extends ErpConnectorError {
  readonly code = 'UNSUPPORTED_OPERATION';
  readonly retryable = false;
  constructor(readonly operation: ErpOperation) {
    super(`operation ${operation} is not supported by this connector`);
    this.name = 'ErpUnsupportedOperationError';
  }
}

export function isErpConnectorError(error: unknown): error is ErpConnectorError {
  return error instanceof ErpConnectorError;
}
