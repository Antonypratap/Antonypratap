import {
  ErpUnsupportedOperationError,
  type ErpCapability,
  type ErpConnector,
  type ErpOperation,
} from '@veyra/erp-connector';
import { capabilityDefinition, type CapabilityKey } from '@veyra/shared';
import type { Entitlements } from './entitlements';

/**
 * An ERP feature needs BOTH checks (Phase 8A, docs/COMMERCIAL_ENTITLEMENTS.md "ERP"):
 *
 * - the commercial entitlement: is this customer ALLOWED to use it? (NotEntitledError)
 * - the connector's technical capability: can the connected ERP DO it? (ErpUnsupportedOperationError)
 *
 * Neither grants the other. The commercial check comes first, so a customer without the feature is
 * told so, whatever their ERP supports.
 */
export async function requireErpFeature(
  entitlements: Entitlements,
  organizationId: string,
  key: CapabilityKey,
  erp: ErpConnector,
  operation: ErpOperation,
): Promise<void> {
  await entitlements.require(organizationId, key);
  const needed = capabilityDefinition(key)?.erpCapability as ErpCapability | undefined;
  if (needed && !erp.capabilities().includes(needed))
    throw new ErpUnsupportedOperationError(operation, needed);
}
