import { afterEach, describe, expect, it } from 'vitest';
import {
  CreationActionIdSchema,
  InvoiceIdSchema,
  creationIdempotencyKey,
  purchaseInvoiceIdempotencyKey,
} from '@veyra/shared';
import {
  ERP_CAPABILITIES,
  describeConnection,
  guardCapabilities,
  isErpConnectorError,
  type ErpConnectorError,
} from '@veyra/erp-connector';
import { describeErpConnectorContract } from '@veyra/erp-connector/contract';
import { scriptedConnector } from '@veyra/erp-connector/testing';
import { tempErp } from './test/temp-db';

/**
 * Phase 4: the fake ERP at the production boundary (capabilities, connection, reconciliation,
 * safe errors), and the test-only scripted connector that simulates what a real ERP can do.
 */
const ulid = (n: number) => n.toString().padStart(26, '0');
const key = (n: number) =>
  creationIdempotencyKey(
    InvoiceIdSchema.parse(ulid(1)),
    CreationActionIdSchema.parse(ulid(5000 + n)),
  );
const vendorInput = {
  name: 'Nandi Stationers Pvt Ltd',
  gstin: '29AADCN9753P1ZH',
  address: 'Bengaluru',
  sourceInvoiceId: InvoiceIdSchema.parse(ulid(1)),
};

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});
const demo = () => {
  const t = tempErp({ reset: 'demo' });
  cleanup = t.cleanup;
  return t.erp;
};
const caught = async (p: Promise<unknown>): Promise<ErpConnectorError> => {
  const e = await p.then(
    () => {
      throw new Error('expected a failure');
    },
    (x: unknown) => x,
  );
  if (!isErpConnectorError(e)) throw e;
  return e;
};

describe('fake ERP: connector boundary', () => {
  it('reports its identity and capabilities: everything except one-time suppliers', () => {
    const erp = demo();
    expect(erp.info).toMatchObject({ type: 'fake-erp', displayName: 'Fake ERP' });
    expect(erp.capabilities()).toEqual(ERP_CAPABILITIES.filter((c) => c !== 'vendor.one_time'));
  });

  it('connection: connected, to the demo company; metadata carries no secrets', async () => {
    const erp = demo();
    const c = await describeConnection(erp);
    expect(c).toMatchObject({
      type: 'fake-erp',
      displayName: 'Fake ERP',
      status: 'CONNECTED',
      company: { name: 'Veyra Demo Industries Pvt Ltd', identifier: '29AAACS1111A1Z6' },
    });
  });

  it('reconciliation reads the idempotency log and never writes', async () => {
    const erp = demo();
    const before = (await erp.listVendors()).length;
    expect(await erp.reconcileWrite(key(1))).toEqual({ outcome: 'not_created' });
    const v = await erp.createVendor(vendorInput, key(1));
    expect(await erp.reconcileWrite(key(1))).toEqual({
      outcome: 'created',
      operation: 'createVendor',
      recordId: v.id,
    });
    expect((await erp.listVendors()).length).toBe(before + 1);
  });
});

describe('scripted test connector', () => {
  it('unsupported capability → typed UNSUPPORTED, not retryable, nothing called', async () => {
    const { connector, script } = scriptedConnector(demo(), {
      capabilities: ERP_CAPABILITIES.filter((c) => c !== 'goods_receipt.create'),
    });
    const e = await caught(connector.createGrn({} as never, key(2)));
    expect(e).toMatchObject({
      code: 'UNSUPPORTED',
      retryable: false,
      capability: 'goods_receipt.create',
    });
    expect(script.calls).toEqual([{ operation: 'createGrn', outcome: 'unsupported' }]);
  });

  it('unavailable is retryable; authentication and configuration failures are not', async () => {
    const { connector, script } = scriptedConnector(demo());
    script.fail('getCompany', 'unavailable');
    script.fail('findVendorByGstin', 'authentication_failed');
    script.fail('listVendors', 'configuration_error');
    expect(await caught(connector.getCompany())).toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true,
    });
    expect(await caught(connector.findVendorByGstin('29AADCN9753P1ZH' as never))).toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
    });
    expect(await caught(connector.listVendors())).toMatchObject({
      code: 'CONFIGURATION_ERROR',
      retryable: false,
    });
  });

  it('validation failure is not retryable', async () => {
    const { connector, script } = scriptedConnector(demo());
    script.fail('createVendor', 'validation');
    expect(await caught(connector.createVendor(vendorInput, key(3)))).toMatchObject({
      code: 'VALIDATION',
      retryable: false,
    });
  });

  it('timeout before a write: nothing written, the same key then succeeds once', async () => {
    const erp = demo();
    const { connector, script } = scriptedConnector(erp);
    script.fail('createVendor', 'timeout_before_write');
    const e = await caught(connector.createVendor(vendorInput, key(4)));
    expect(e).toMatchObject({ code: 'UNAVAILABLE', retryable: true, writeOutcome: 'not_sent' });
    expect(await erp.reconcileWrite(key(4))).toEqual({ outcome: 'not_created' });
    await connector.createVendor(vendorInput, key(4));
    expect((await erp.listVendors()).filter((v) => v.gstin === vendorInput.gstin)).toHaveLength(1);
  });

  it('timeout after a write: the outcome is unknown; reconciliation finds it; a retry does not duplicate', async () => {
    const erp = demo();
    const { connector, script } = scriptedConnector(erp);
    script.fail('createVendor', 'timeout_after_write');
    const e = await caught(connector.createVendor(vendorInput, key(5)));
    expect(e).toMatchObject({ code: 'UNAVAILABLE', writeOutcome: 'unknown' });
    const r = await connector.reconcileWrite(key(5));
    expect(r.outcome).toBe('created');
    const again = await connector.createVendor(vendorInput, key(5));
    expect(r).toMatchObject({ recordId: again.id });
    expect((await erp.listVendors()).filter((v) => v.gstin === vendorInput.gstin)).toHaveLength(1);
  });

  it('duplicate idempotency request returns the same record; other details are refused', async () => {
    const { connector } = scriptedConnector(demo());
    const a = await connector.createVendor(vendorInput, key(6));
    expect((await connector.createVendor(vendorInput, key(6))).id).toBe(a.id);
    expect(
      await caught(connector.createVendor({ ...vendorInput, name: 'Other Pvt Ltd' }, key(6))),
    ).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  it('errors never expose secrets from the underlying failure', async () => {
    const { connector, script } = scriptedConnector(demo());
    const faults = [
      'unavailable',
      'timeout_before_write',
      'timeout_after_write',
      'authentication_failed',
      'configuration_error',
    ] as const;
    for (const f of faults) {
      script.fail('recordPurchaseInvoice', f);
      const e = await caught(
        connector.recordPurchaseInvoice(
          {} as never,
          purchaseInvoiceIdempotencyKey(InvoiceIdSchema.parse(ulid(2))),
        ),
      ).catch((x: unknown) => x as ErpConnectorError);
      const shown = `${e.message} ${e.userMessage} ${JSON.stringify(e.toSafeJSON())}`;
      expect(shown, f).not.toMatch(/ECONNREFUSED|10\.20\.30\.40|Bearer|sk_test|hunter2|password/);
    }
  });

  it('connection status can be scripted into each typed state', async () => {
    const { connector, script } = scriptedConnector(demo());
    for (const s of [
      'UNAVAILABLE',
      'AUTHENTICATION_FAILED',
      'CONFIGURATION_ERROR',
      'UNKNOWN',
    ] as const) {
      script.connection(s);
      expect((await describeConnection(connector)).status).toBe(s);
    }
  });

  it('the capability guard rejects an undeclared operation even if the connector would run it', async () => {
    const erp = demo();
    const narrowed = guardCapabilities(
      Object.assign(Object.create(erp) as typeof erp, {
        capabilities: () => erp.capabilities().filter((c) => c !== 'vendor.create'),
      }),
    );
    expect(await caught(narrowed.createVendor(vendorInput, key(7)))).toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect(await erp.findVendorByGstin('29AADCN9753P1ZH' as never)).toBeNull();
  });
});

// The full contract, through the scripted wrapper with nothing scripted: a wrapping adapter keeps
// every guarantee of the connector it wraps.
describeErpConnectorContract({
  name: 'scripted(FakeErpConnector)',
  setup: async () => {
    const t = tempErp({ reset: 'company-only' });
    return {
      connector: scriptedConnector(t.erp).connector,
      reopen: async () => scriptedConnector(t.open()).connector,
      teardown: async () => t.cleanup(),
    };
  },
});
