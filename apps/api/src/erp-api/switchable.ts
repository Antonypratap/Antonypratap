import type { ErpConnector } from '@veyra/erp-connector';

/**
 * The ERP the workflow talks to: the built-in records, or the business's own ERP over its API,
 * whichever the admin chose (ErpApi.activate / deactivate). Switching changes no record on either
 * side, so switching back restores the built-in records exactly as they were.
 *
 * Each call goes to whichever is chosen at that moment; `capabilities()` follows the same choice,
 * so the capability guard around this refuses writes while the (read-only) API connection is used.
 */
export function switchableErp(
  builtIn: ErpConnector,
  connected: ErpConnector,
  useConnected: () => boolean,
): ErpConnector {
  return new Proxy(builtIn, {
    get(_target, prop) {
      const impl = useConnected() ? connected : builtIn;
      const value: unknown = Reflect.get(impl, prop, impl);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(impl)
        : value;
    },
  });
}
