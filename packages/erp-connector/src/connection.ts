import type { ErpCapability } from './capabilities';
import { isErpConnectorError } from './errors';

/**
 * Connection state of an ERP connector (Phase 4). The application uses only these values; raw
 * infrastructure errors (ECONNREFUSED, SQLITE_ERROR, stack traces) never leave the connector.
 */
export const ERP_CONNECTION_STATUSES = [
  'CONNECTED',
  'AUTHENTICATION_FAILED',
  'UNAVAILABLE',
  'CONFIGURATION_ERROR',
  'UNKNOWN',
] as const;
export type ErpConnectionStatus = (typeof ERP_CONNECTION_STATUSES)[number];

/** The result of `checkConnection()`: status, and the business the connector is connected to. */
export interface ErpConnectionCheck {
  status: ErpConnectionStatus;
  /** The company/business in the ERP; null when it could not be read. */
  company: { name: string; identifier: string | null } | null;
}

/**
 * Safe metadata about a connector: what it is, whether it is connected, and what it can do.
 * Never contains credentials, tokens, keys, hosts or raw errors.
 */
export interface ErpConnection extends ErpConnectionCheck {
  type: string;
  displayName: string;
  version: string | null;
  capabilities: ErpCapability[];
}

/** Maps any failure while checking a connection onto a typed status. */
export function connectionStatusOf(error: unknown): ErpConnectionStatus {
  if (!isErpConnectorError(error)) return 'UNKNOWN';
  switch (error.code) {
    case 'UNAVAILABLE':
      return 'UNAVAILABLE';
    case 'AUTHENTICATION_FAILED':
      return 'AUTHENTICATION_FAILED';
    case 'CONFIGURATION_ERROR':
      return 'CONFIGURATION_ERROR';
    default:
      return 'UNKNOWN';
  }
}
