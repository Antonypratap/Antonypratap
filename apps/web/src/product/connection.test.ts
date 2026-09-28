import { describe, expect, it } from 'vitest';
import { ApiErpSchema } from '@veyra/shared';
import { capabilityList, connectionIdentity, connectionStatusText } from './state/connection';

const connection = ApiErpSchema.connection.parse({
  type: 'fake-erp',
  displayName: 'Fake ERP',
  version: '1',
  status: 'CONNECTED',
  company: { name: 'Veyra Demo Industries Pvt Ltd', identifier: '29AAACS1111A1Z6' },
  capabilities: [
    { key: 'vendor.one_time', label: 'One-time suppliers', supported: false },
    { key: 'vendor.read', label: 'Read suppliers', supported: true },
    { key: 'purchase_invoice.create', label: 'Record purchase invoices', supported: true },
  ],
});

describe('ERP connection (Phase 4)', () => {
  it('names the system, the business and the status in one line', () => {
    expect(connectionIdentity(connection)).toBe(
      'Fake ERP · Veyra Demo Industries Pvt Ltd · Connected',
    );
    expect(connectionIdentity({ ...connection, status: 'UNAVAILABLE', company: null })).toBe(
      'Fake ERP · Not reachable',
    );
  });

  it('every typed status reads in plain words', () => {
    for (const s of ApiErpSchema.connection.shape.status.options)
      expect(connectionStatusText(s)).not.toMatch(/_/);
  });

  it('lists what the system supports first', () => {
    expect(capabilityList(connection)).toEqual([
      { label: 'Read suppliers', supported: true },
      { label: 'Record purchase invoices', supported: true },
      { label: 'One-time suppliers', supported: false },
    ]);
  });

  it('refuses a connection payload carrying anything extra (no settings or secrets)', () => {
    expect(() => ApiErpSchema.connection.parse({ ...connection, apiKey: 'x' })).toThrow();
  });
});
