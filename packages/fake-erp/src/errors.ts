import Database from 'better-sqlite3';
import {
  ErpConfigurationError,
  ErpUnavailableError,
  ErpValidationError,
  isErpConnectorError,
  type ErpOperation,
} from '@veyra/erp-connector';

const UNAVAILABLE = /^SQLITE_(BUSY|LOCKED|IOERR|FULL|PROTOCOL)/;
const CONFIGURATION = /^SQLITE_(CANTOPEN|READONLY|NOTADB|CORRUPT)/;

/**
 * Maps storage errors onto the connector's typed errors. Connector errors pass through; lock and
 * I/O errors become UNAVAILABLE (retry with the same key); constraint violations that slipped past
 * the explicit checks become VALIDATION. Anything else is a bug and is rethrown unchanged.
 */
export function mapError(operation: ErpOperation, error: unknown): unknown {
  if (isErpConnectorError(error)) return error;
  if (error instanceof Database.SqliteError) {
    // The SQLite text stays in `cause` only: it never reaches a message, log line or screen.
    if (UNAVAILABLE.test(error.code)) return new ErpUnavailableError({ cause: error });
    if (CONFIGURATION.test(error.code)) return new ErpConfigurationError({ cause: error });
    if (error.code.startsWith('SQLITE_CONSTRAINT')) {
      return new ErpValidationError(operation, [
        { path: '', message: 'The record breaks a rule of the business system.' },
      ]);
    }
  }
  return error;
}
