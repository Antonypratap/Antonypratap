/**
 * @veyra/fake-erp: a SQLite-backed ErpConnector with the DEMO.md seed data.
 *
 * Only the connector class and its options are public. The database schema, SQL and connection
 * stay inside this package: the rest of Veyra sees nothing but `ErpConnector`.
 */
export const PACKAGE_NAME = '@veyra/fake-erp';

export { FakeErpConnector } from './connector';
export type { FakeErpFailpoint, FakeErpOptions, FakeErpTestHooks } from './connector';
export type { FakeErpBusiness, FakeErpSeed } from './seed/seed';
