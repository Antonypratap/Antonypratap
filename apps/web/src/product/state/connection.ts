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

/** "Fake ERP · Veyra Demo Industries Pvt Ltd · Connected": which system, which business. */
export function connectionIdentity(c: ErpConnectionView): string {
  return [c.displayName, c.company?.name, connectionStatusText(c.status)]
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
