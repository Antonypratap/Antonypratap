import type { StateCode } from '@veyra/shared';
import { validateGstin } from './gstin';
import { resolveStateCode } from './states';

/**
 * Place of supply (RULES §1.6, decision D3). Deterministic hierarchy:
 *   1. printed place of supply;
 *   2. only if nothing is printed: ship-to / consignee evidence (printed state, or a
 *      checksum-valid GSTIN in that block), all pieces agreeing;
 *   3. otherwise: needs user input.
 *
 * The buyer (bill-to) GSTIN is deliberately not an input: it can never establish the place of supply.
 * Whether a value is "usable" (confidence, human confirmation) is decided by the caller.
 */

export type EvidenceValue =
  { status: 'absent' } | { status: 'unusable' } | { status: 'usable'; text: string };

export interface PlaceOfSupplyEvidence {
  printedPlaceOfSupply: EvidenceValue;
  shipToState: EvidenceValue;
  shipToGstin: EvidenceValue;
}

export type EvidenceSource = 'printed_place_of_supply' | 'ship_to_state' | 'ship_to_gstin';

export interface EvidenceItem {
  source: EvidenceSource;
  text: string | null;
  stateCode: StateCode | null;
  problem: string | null;
}

export type PlaceOfSupplyResolution =
  | {
      status: 'established';
      stateCode: StateCode;
      basis: 'printed' | 'ship_to_evidence';
      evidence: EvidenceItem[];
    }
  | {
      status: 'needs_user_input';
      reason:
        | 'printed_unusable'
        | 'printed_unparseable'
        | 'no_evidence'
        | 'unusable_evidence'
        | 'conflicting_evidence';
      evidence: EvidenceItem[];
    };

export function resolvePlaceOfSupply(input: PlaceOfSupplyEvidence): PlaceOfSupplyResolution {
  const printed = input.printedPlaceOfSupply;
  // Step 1. A printed place of supply that cannot be used is still "printed": ask, don't fall through.
  if (printed.status === 'unusable') {
    return {
      status: 'needs_user_input',
      reason: 'printed_unusable',
      evidence: [
        { source: 'printed_place_of_supply', text: null, stateCode: null, problem: 'not usable' },
      ],
    };
  }
  if (printed.status === 'usable') {
    const r = resolveStateCode(printed.text);
    const item: EvidenceItem = {
      source: 'printed_place_of_supply',
      text: printed.text,
      stateCode: r.ok ? r.value : null,
      problem: r.ok ? null : r.error,
    };
    return r.ok
      ? { status: 'established', stateCode: r.value, basis: 'printed', evidence: [item] }
      : { status: 'needs_user_input', reason: 'printed_unparseable', evidence: [item] };
  }

  // Step 2. Ship-to / consignee evidence.
  const evidence: EvidenceItem[] = [];
  let unusable = false;
  const consider = (
    source: EvidenceSource,
    value: EvidenceValue,
    parse: (t: string) => StateCode | string,
  ): void => {
    if (value.status === 'absent') return;
    if (value.status === 'unusable') {
      unusable = true;
      evidence.push({ source, text: null, stateCode: null, problem: 'not usable' });
      return;
    }
    const parsed = parse(value.text);
    const isCode = /^\d{2}$/.test(parsed);
    if (!isCode) unusable = true;
    evidence.push({
      source,
      text: value.text,
      stateCode: isCode ? (parsed as StateCode) : null,
      problem: isCode ? null : parsed,
    });
  };
  consider('ship_to_state', input.shipToState, (t) => {
    const r = resolveStateCode(t);
    return r.ok ? r.value : r.error;
  });
  consider('ship_to_gstin', input.shipToGstin, (t) => {
    const r = validateGstin(t);
    return r.ok ? r.value.stateCode : r.error.code;
  });

  if (evidence.length === 0) return { status: 'needs_user_input', reason: 'no_evidence', evidence };
  if (unusable) return { status: 'needs_user_input', reason: 'unusable_evidence', evidence };
  const codes = new Set(evidence.map((e) => e.stateCode));
  if (codes.size !== 1)
    return { status: 'needs_user_input', reason: 'conflicting_evidence', evidence };
  const [stateCode] = [...codes] as [StateCode];
  return { status: 'established', stateCode, basis: 'ship_to_evidence', evidence };
}
