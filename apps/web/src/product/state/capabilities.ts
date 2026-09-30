import type { ApiCapabilities, CapabilityKey } from '@veyra/shared';
import { api } from '../api/client';
import { useResource } from './data';

/**
 * The organization's commercial capabilities, as the server reports them (Phase 8A). The product
 * asks "is this capability available?", never "which plan is this?": packaging can change without
 * touching the UI. This only decides what to show; the server enforces every capability anyway.
 */
export function useCapabilities(): ApiCapabilities | null {
  return useResource(() => api.capabilities(), 'capabilities').data;
}

/** Available: on (BOOLEAN) or a quota above 0 (LIMIT). Unknown (still loading): not shown yet. */
export function hasCapability(caps: ApiCapabilities | null, key: CapabilityKey): boolean {
  return caps?.capabilities.find((c) => c.key === key)?.available ?? false;
}
