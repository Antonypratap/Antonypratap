/**
 * TESTS ONLY (`@veyra/erp-connector/testing`). Never wired into the application.
 *
 * A controllable connector that wraps a real one (normally the fake ERP) and injects the failures
 * a production ERP can produce: unavailability, timeouts before and after a write, rejected
 * credentials, bad configuration, validation and not-found errors, missing capabilities, and
 * changed data between matching and commit. Everything not scripted goes to the wrapped connector.
 */

import { OPERATION_CAPABILITY, supportsOperation, type ErpCapability } from '../capabilities';
import type { ErpConnectionStatus } from '../connection';
import type { ErpConnector } from '../connector';
import {
  ErpAuthenticationError,
  ErpConfigurationError,
  ErpNotFoundError,
  ErpUnavailableError,
  ErpUnsupportedOperationError,
  ErpValidationError,
} from '../errors';
import { ERP_READ_OPERATIONS, ERP_WRITE_OPERATIONS, type ErpOperation } from '../operations';

export type ErpFault =
  /** The ERP cannot be reached. A write was not sent. */
  | 'unavailable'
  /** The call timed out before the request was sent. A write was not sent. */
  | 'timeout_before_write'
  /** The wrapped connector performs the call, then the response is lost (outcome unknown). */
  | 'timeout_after_write'
  | 'authentication_failed'
  | 'configuration_error'
  | 'validation'
  | 'not_found';

export interface ErpScript {
  /** Fail the next `times` calls of `operation` with `fault`. */
  fail(operation: ErpOperation, fault: ErpFault, times?: number): void;
  /** Replace an operation's behaviour (e.g. return a changed PO) until cleared. */
  override(operation: ErpOperation, fn: (...args: unknown[]) => unknown): void;
  clear(operation?: ErpOperation): void;
  /** Connection status to report instead of asking the wrapped connector. */
  connection(status: ErpConnectionStatus | null): void;
  /** Every call that reached this connector, with what happened. */
  readonly calls: { operation: ErpOperation; outcome: 'ok' | ErpFault | 'unsupported' }[];
}

const OPERATIONS: ReadonlySet<string> = new Set<string>([
  ...ERP_READ_OPERATIONS,
  ...ERP_WRITE_OPERATIONS,
]);

function faultError(operation: ErpOperation, fault: ErpFault): Error {
  const secret = new Error(
    'connect ECONNREFUSED 10.20.30.40:443 Authorization: Bearer sk_test_secret password=hunter2',
  );
  switch (fault) {
    case 'unavailable':
      return new ErpUnavailableError({ reason: 'network', cause: secret });
    case 'timeout_before_write':
      return new ErpUnavailableError({
        reason: 'timeout',
        writeOutcome: 'not_sent',
        cause: secret,
      });
    case 'timeout_after_write':
      return new ErpUnavailableError({ reason: 'timeout', writeOutcome: 'unknown', cause: secret });
    case 'authentication_failed':
      return new ErpAuthenticationError({ cause: secret });
    case 'configuration_error':
      return new ErpConfigurationError({ cause: secret });
    case 'validation':
      return new ErpValidationError(operation, [{ path: '', message: 'rejected by the ERP' }]);
    case 'not_found':
      return new ErpNotFoundError('purchase_order', 'scripted');
  }
}

/**
 * Wraps `delegate`. `capabilities` narrows what the connector declares (to test UNSUPPORTED).
 */
export function scriptedConnector(
  delegate: ErpConnector,
  options: { capabilities?: readonly ErpCapability[] } = {},
): { connector: ErpConnector; script: ErpScript } {
  const faults = new Map<ErpOperation, { fault: ErpFault; times: number }[]>();
  const overrides = new Map<ErpOperation, (...args: unknown[]) => unknown>();
  let status: ErpConnectionStatus | null = null;
  const calls: ErpScript['calls'] = [];
  const capabilities = () => options.capabilities ?? delegate.capabilities();

  const script: ErpScript = {
    fail(operation, fault, times = 1) {
      faults.set(operation, [...(faults.get(operation) ?? []), { fault, times }]);
    },
    override(operation, fn) {
      overrides.set(operation, fn);
    },
    clear(operation) {
      if (operation) {
        faults.delete(operation);
        overrides.delete(operation);
      } else {
        faults.clear();
        overrides.clear();
      }
    },
    connection(s) {
      status = s;
    },
    calls,
  };

  const connector = new Proxy(delegate, {
    get(target, prop) {
      if (prop === 'info')
        return { ...target.info, type: 'scripted', displayName: 'Scripted test ERP' };
      if (prop === 'capabilities') return () => [...capabilities()];
      if (prop === 'checkConnection')
        return async () => (status === null ? target.checkConnection() : { status, company: null });
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string' || !OPERATIONS.has(prop))
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      const operation = prop as ErpOperation;
      const real = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        if (!supportsOperation(capabilities(), operation)) {
          calls.push({ operation, outcome: 'unsupported' });
          throw new ErpUnsupportedOperationError(operation, OPERATION_CAPABILITY[operation]);
        }
        const queue = faults.get(operation) ?? [];
        const next = queue[0];
        if (next) {
          next.times -= 1;
          if (next.times <= 0) queue.shift();
          calls.push({ operation, outcome: next.fault });
          // A lost response: the ERP did the work, Veyra never heard back.
          if (next.fault === 'timeout_after_write') await real.apply(target, args);
          throw faultError(operation, next.fault);
        }
        calls.push({ operation, outcome: 'ok' });
        const override = overrides.get(operation);
        return override ? override(...args) : real.apply(target, args);
      };
    },
  });
  return { connector, script };
}
