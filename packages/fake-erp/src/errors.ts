import Database from 'better-sqlite3';
import {
  ErpUnavailableError,
  ErpValidationError,
  isErpConnectorError,
  type ErpOperation,
} from '@veyra/erp-connector';

const UNAVAILABLE = /^SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN|FULL|READONLY|PROTOCOL)/;

/**
 * Maps storage errors onto the connector's typed errors. Connector errors pass through; lock and
 * I/O errors become UNAVAILABLE (retry with the same key); constraint violations that slipped past
 * the explicit checks become VALIDATION. Anything else is a bug and is rethrown unchanged.
 */
export function mapError(operation: ErpOperation, error: unknown): unknown {
  if (isErpConnectorError(error)) return error;
  if (error instanceof Database.SqliteError) {
    if (UNAVAILABLE.test(error.code))
      return new ErpUnavailableError(`${operation}: ${error.message}`, { cause: error });
    if (error.code.startsWith('SQLITE_CONSTRAINT')) {
      return new ErpValidationError(operation, [
        { path: '', message: `${error.code}: ${error.message}` },
      ]);
    }
  }
  return error;
}
