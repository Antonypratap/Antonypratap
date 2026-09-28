import { isErpConnectorError } from '@veyra/erp-connector';
import { isStorageError } from '../storage';

/**
 * Retry policy (Phase 6, ARCHITECTURE §18). Retried automatically, a bounded number of times:
 * - the ERP is unavailable (unreachable, network, timeout): ErpConnectorError.retryable;
 * - document storage is unavailable: StorageUnavailableError;
 * - Veyra's own database is momentarily busy or locked.
 * Never retried automatically: invalid or unsupported documents, validation and business-rule
 * results, authentication or configuration failures, missing or corrupted documents.
 */
export function isRetryable(error: unknown): boolean {
  if (isErpConnectorError(error)) return error.retryable;
  if (isStorageError(error)) return error.retryable;
  return databaseBusy(error);
}

function databaseBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    error instanceof Error &&
    error.name === 'SqliteError' &&
    (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
  );
}

/** A stable, safe code for logs and job records (never a message or payload). */
export function safeErrorCode(error: unknown): string {
  if (isErpConnectorError(error)) return `ERP_${error.code}`;
  if (isStorageError(error)) return error.code;
  if (databaseBusy(error)) return 'DATABASE_BUSY';
  if (error instanceof Error && error.name === 'SqliteError') return 'DATABASE_ERROR';
  if (error instanceof Error && error.name === 'ExtractorError') return 'EXTRACTION_FAILED';
  if (error instanceof Error && error.name === 'VeyraError') return 'INVALID_REQUEST';
  return 'INTERNAL';
}

/**
 * Whether an error is an internal failure whose message must not reach a person (SQL, filesystem
 * paths, programming errors). Those are shown with a generic reason and logged server-side.
 */
export function isInternalError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (isErpConnectorError(error) || isStorageError(error)) return false;
  return (
    error.name === 'SqliteError' ||
    'errno' in error ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  );
}

export const INTERNAL_FAILURE_REASON =
  'Veyra hit an internal problem while processing this invoice. Nothing was posted; it can be processed again.';
