import { OPERATION_CAPABILITY, supportsOperation } from './capabilities';
import { connectionStatusOf, type ErpConnection } from './connection';
import type { ErpConnector } from './connector';
import { ErpUnsupportedOperationError } from './errors';
import { ERP_READ_OPERATIONS, ERP_WRITE_OPERATIONS, type ErpOperation } from './operations';

const OPERATIONS: ReadonlySet<string> = new Set<string>([
  ...ERP_READ_OPERATIONS,
  ...ERP_WRITE_OPERATIONS,
]);

/**
 * Enforces a connector's declared capabilities at the boundary (Phase 4): an operation the
 * connector does not declare is rejected with ErpUnsupportedOperationError before the connector
 * is called, whatever the connector itself would have done. The composition root wraps every
 * connector with this, so an adapter that forgets a check still cannot fall back silently.
 */
export function guardCapabilities(connector: ErpConnector): ErpConnector {
  return new Proxy(connector, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop === 'string' && OPERATIONS.has(prop)) {
        const operation = prop as ErpOperation;
        return (...args: unknown[]) =>
          supportsOperation(target.capabilities(), operation)
            ? fn.apply(target, args)
            : Promise.reject(
                new ErpUnsupportedOperationError(operation, OPERATION_CAPABILITY[operation]),
              );
      }
      return fn.bind(target);
    },
  });
}

/**
 * Safe metadata about a connector (what it is, whether it is connected, what it can do). Built
 * only from `info`, `capabilities()` and `checkConnection()`: no settings, credentials or errors.
 */
export async function describeConnection(connector: ErpConnector): Promise<ErpConnection> {
  const check = await connector
    .checkConnection()
    .catch((error: unknown) => ({ status: connectionStatusOf(error), company: null }));
  return {
    type: connector.info.type,
    displayName: connector.info.displayName,
    version: connector.info.version || null,
    status: check.status,
    company: check.company,
    capabilities: [...connector.capabilities()],
  };
}
