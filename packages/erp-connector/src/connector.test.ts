import { describe, expectTypeOf, it, expect } from 'vitest';
import type { ErpConnector } from './connector';
import {
  ERP_READ_OPERATIONS,
  ERP_WRITE_OPERATIONS,
  type ErpOperation,
  type ErpReadOperation,
  type ErpWriteOperation,
} from './operations';
import { describeErpConnectorContract } from './contract';

describe('ErpConnector type contract', () => {
  it('its methods are exactly the declared read and write operations', () => {
    expectTypeOf<Exclude<keyof ErpConnector, 'info'>>().toEqualTypeOf<ErpOperation>();
    expectTypeOf<ErpReadOperation & ErpWriteOperation>().toBeNever();
  });

  it('has no payment method', () => {
    expectTypeOf<Extract<keyof ErpConnector, `${string}ay${string}`>>().toBeNever();
    expect(
      [...ERP_READ_OPERATIONS, ...ERP_WRITE_OPERATIONS].filter((op) => /pay/i.test(op)),
    ).toEqual([]);
  });

  it('every write takes an idempotency key as its last argument', () => {
    type Params<K extends ErpWriteOperation> = Parameters<ErpConnector[K]>;
    expectTypeOf<Params<'createVendor'>[1]>().toEqualTypeOf<
      Parameters<ErpConnector['createGrn']>[1]
    >();
    expectTypeOf<Params<'recordPurchaseInvoice'>>().toHaveProperty('length').toEqualTypeOf<2>();
    for (const op of ERP_WRITE_OPERATIONS) expect(typeof op).toBe('string');
  });

  it('writes are listed in commit dependency order (ARCHITECTURE §4.3)', () => {
    expect(ERP_WRITE_OPERATIONS.slice(0, 7)).toEqual([
      'reactivateVendor',
      'createVendor',
      'createItem',
      'createVendorItemAlias',
      'createPurchaseOrder',
      'createGrn',
      'recordPurchaseInvoice',
    ]);
    expect(ERP_WRITE_OPERATIONS.at(-1)).toBe('importBusinessRecords');
  });

  it('exports the contract suite for connector implementations', () => {
    expect(typeof describeErpConnectorContract).toBe('function');
  });
});
