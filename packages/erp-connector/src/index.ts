/**
 * @veyra/erp-connector: the ErpConnector port, its record/input contracts, typed errors and the
 * idempotency contract. The reusable contract test suite is exported from
 * `@veyra/erp-connector/contract`.
 */
export const PACKAGE_NAME = '@veyra/erp-connector';

export * from './entities';
export * from './inputs';
export * from './errors';
export * from './operations';
export * from './idempotency';
export type * from './connector';
