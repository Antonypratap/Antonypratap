import { describe, expect, it } from 'vitest';
import * as publicApi from './index';
import { tempErp } from './test/temp-db';

describe('database boundary', () => {
  it('the package exports only the connector (no schema, SQL or connection)', () => {
    expect(Object.keys(publicApi).sort()).toEqual(['FakeErpConnector', 'PACKAGE_NAME']);
  });

  it('a connector instance exposes no database handle', () => {
    const t = tempErp({ reset: 'company-only' });
    try {
      expect(Object.keys(t.erp)).toEqual(['info']);
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(t.erp));
      for (const forbidden of ['db', 'sqlite', 'sql', 'exec', 'prepare', 'query', 'raw']) {
        expect(methods).not.toContain(forbidden);
      }
      expect(methods.filter((m) => /pay/i.test(m))).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
