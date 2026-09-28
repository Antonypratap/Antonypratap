import type { z } from 'zod';
import type { ErpEntityType, ErpId, IdempotencyKey } from '@veyra/shared';
import type { ErpCapability } from './capabilities';
import type { ErpOperation, ErpWriteOperation } from './operations';

export type ErpErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'UNSUPPORTED'
  | 'CONFIGURATION_ERROR';

/**
 * Which errors may be retried (Phase 4). Only a transient failure is: the ERP was unavailable,
 * the network failed, or the call timed out. Every retry of a write re-uses its idempotency key.
 */
export const RETRYABLE_ERP_ERRORS: readonly ErpErrorCode[] = ['UNAVAILABLE'];

/** What a person may be told about an ERP error. Stable, and free of any secret or host detail. */
export interface SafeErpError {
  code: ErpErrorCode;
  message: string;
  retryable: boolean;
  externalReference: string | null;
}

/**
 * Base class of every error an ErpConnector may throw. Anything else escaping a connector is a
 * connector bug. `userMessage` is safe to show and log; `message` is safe to log (it never contains
 * credentials, tokens, hosts or raw infrastructure errors, which stay in `cause` at most).
 */
export abstract class ErpConnectorError extends Error {
  abstract readonly code: ErpErrorCode;
  abstract readonly retryable: boolean;
  abstract readonly userMessage: string;
  /** An identifier the ERP gave for this request or record, when it gave one. */
  externalReference: string | null = null;

  toSafeJSON(): SafeErpError {
    return {
      code: this.code,
      message: this.userMessage,
      retryable: this.retryable,
      externalReference: this.externalReference,
    };
  }
}

/** A referenced record does not exist (e.g. createGrn for an unknown PO). */
export class ErpNotFoundError extends ErpConnectorError {
  readonly code = 'NOT_FOUND';
  readonly retryable = false;
  readonly userMessage = 'A record Veyra needed is not in the business system. Nothing was posted.';
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
  readonly userMessage = 'The business system already has this record. Nothing was posted.';
  constructor(
    readonly entity: ErpEntityType,
    readonly naturalKey: Record<string, string>,
    readonly existingId: ErpId,
  ) {
    super(`${entity} already exists for ${JSON.stringify(naturalKey)}`);
    this.name = 'ErpConflictError';
    this.externalReference = existingId;
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
  readonly userMessage = 'The business system rejected the record as invalid. Nothing was posted.';
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
  readonly userMessage =
    'This request was already sent to the business system with different details. Nothing new was posted.';
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

/**
 * The ERP could not be reached, the network failed, or the call timed out. Retryable.
 *
 * `writeOutcome` matters for writes: `not_sent` means the request certainly did not reach the ERP
 * (retrying is plainly safe); `unknown` means it may have been applied (the caller reconciles, then
 * retries with the SAME key, never as a new transaction).
 */
export class ErpUnavailableError extends ErpConnectorError {
  readonly code = 'UNAVAILABLE';
  readonly retryable = true;
  readonly reason: 'unavailable' | 'network' | 'timeout';
  readonly writeOutcome: 'not_sent' | 'unknown';
  readonly userMessage: string;
  constructor(
    options: {
      reason?: 'unavailable' | 'network' | 'timeout';
      writeOutcome?: 'not_sent' | 'unknown';
      externalReference?: string;
      /** The underlying failure. Kept for debugging only; never shown or copied into messages. */
      cause?: unknown;
    } = {},
  ) {
    const reason = options.reason ?? 'unavailable';
    super(
      reason === 'timeout'
        ? 'The business system did not answer in time'
        : "The business system couldn't be reached",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ErpUnavailableError';
    this.reason = reason;
    this.writeOutcome = options.writeOutcome ?? 'not_sent';
    this.externalReference = options.externalReference ?? null;
    this.userMessage =
      this.writeOutcome === 'unknown'
        ? 'Veyra could not confirm whether the business system recorded this. Nothing is shown as recorded until it is confirmed.'
        : "Veyra couldn't reach the business system. Nothing was posted.";
  }
}

/** The ERP refused the connector's credentials. Not retryable: someone has to fix the connection. */
export class ErpAuthenticationError extends ErpConnectorError {
  readonly code = 'AUTHENTICATION_FAILED';
  readonly retryable = false;
  readonly userMessage =
    'The business system refused Veyra’s connection. Nothing was posted. The connection needs attention.';
  constructor(options: { cause?: unknown } = {}) {
    super('The business system refused the connection', options);
    this.name = 'ErpAuthenticationError';
  }
}

/** The connector is set up wrongly (missing company, wrong database, bad settings). Not retryable. */
export class ErpConfigurationError extends ErpConnectorError {
  readonly code = 'CONFIGURATION_ERROR';
  readonly retryable = false;
  readonly userMessage =
    'The connection to the business system is not set up correctly. Nothing was posted.';
  constructor(options: { cause?: unknown } = {}) {
    super('The connection to the business system is not configured correctly', options);
    this.name = 'ErpConfigurationError';
  }
}

/** This connector cannot perform the operation (e.g. an ERP without GRNs). Never a fallback. */
export class ErpUnsupportedOperationError extends ErpConnectorError {
  readonly code = 'UNSUPPORTED';
  readonly retryable = false;
  readonly userMessage = 'The business system does not support this. Nothing was posted.';
  constructor(
    readonly operation: ErpOperation,
    readonly capability: ErpCapability | null = null,
  ) {
    super(`operation ${operation} is not supported by this connector`);
    this.name = 'ErpUnsupportedOperationError';
  }
}

export function isErpConnectorError(error: unknown): error is ErpConnectorError {
  return error instanceof ErpConnectorError;
}

/** What may be shown about any error that came from, or through, the ERP boundary. */
export function safeErpError(error: unknown): SafeErpError | null {
  return isErpConnectorError(error) ? error.toSafeJSON() : null;
}
