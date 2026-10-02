import type { z } from 'zod';
import type { ApiErpSchema } from '@veyra/shared';

export type ErpConnectionView = z.infer<typeof ApiErpSchema.connection>;

const STATUS_TEXT: Record<ErpConnectionView['status'], string> = {
  CONNECTED: 'Connected',
  AUTHENTICATION_FAILED: 'Sign-in refused',
  UNAVAILABLE: 'Not reachable',
  CONFIGURATION_ERROR: 'Not set up correctly',
  UNKNOWN: 'Status unknown',
};

/** The connection status in plain words. */
export function connectionStatusText(status: ErpConnectionView['status']): string {
  return STATUS_TEXT[status];
}

/** "Sample ERP · Veyra Demo Industries Pvt Ltd · Connected": which system, which business. */
/** The business system's name as people see it (the demo's built-in system is "Sample ERP"). */
export function systemName(c: Pick<ErpConnectionView, 'type' | 'displayName'>): string {
  return c.type === 'fake-erp' ? 'Sample ERP' : c.displayName;
}

export function connectionIdentity(c: ErpConnectionView): string {
  return [systemName(c), c.company?.name, connectionStatusText(c.status)]
    .filter(Boolean)
    .join(' · ');
}

/** What the business system lets Veyrafy do, supported first. */
export function capabilityList(c: ErpConnectionView): { label: string; supported: boolean }[] {
  return [
    ...c.capabilities.filter((x) => x.supported),
    ...c.capabilities.filter((x) => !x.supported),
  ].map(({ label, supported }) => ({ label, supported }));
}
