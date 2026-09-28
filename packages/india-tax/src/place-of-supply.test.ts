import { describe, expect, it } from 'vitest';
import {
  resolvePlaceOfSupply,
  type EvidenceValue,
  type PlaceOfSupplyEvidence,
} from './place-of-supply';

const absent: EvidenceValue = { status: 'absent' };
const unusable: EvidenceValue = { status: 'unusable' };
const usable = (text: string): EvidenceValue => ({ status: 'usable', text });
const evidence = (p: Partial<PlaceOfSupplyEvidence>): PlaceOfSupplyEvidence => ({
  printedPlaceOfSupply: absent,
  shipToState: absent,
  shipToGstin: absent,
  ...p,
});

describe('resolvePlaceOfSupply — step 1: printed', () => {
  it('uses a printed place of supply', () => {
    const r = resolvePlaceOfSupply(evidence({ printedPlaceOfSupply: usable('Karnataka (29)') }));
    expect(r).toMatchObject({ status: 'established', stateCode: '29', basis: 'printed' });
  });

  it('printed wins over ship-to evidence', () => {
    const r = resolvePlaceOfSupply(
      evidence({ printedPlaceOfSupply: usable('29'), shipToState: usable('Tamil Nadu') }),
    );
    expect(r).toMatchObject({ status: 'established', stateCode: '29', basis: 'printed' });
  });

  it('a printed but unusable value is not skipped: ask', () => {
    const r = resolvePlaceOfSupply(
      evidence({ printedPlaceOfSupply: unusable, shipToGstin: usable('29AAACS1111A1Z6') }),
    );
    expect(r).toMatchObject({ status: 'needs_user_input', reason: 'printed_unusable' });
  });

  it('a printed value that names no known state: ask', () => {
    const r = resolvePlaceOfSupply(evidence({ printedPlaceOfSupply: usable('Bangalore') }));
    expect(r).toMatchObject({ status: 'needs_user_input', reason: 'printed_unparseable' });
    const mismatch = resolvePlaceOfSupply(
      evidence({ printedPlaceOfSupply: usable('Karnataka (33)') }),
    );
    expect(mismatch).toMatchObject({ status: 'needs_user_input', reason: 'printed_unparseable' });
  });
});

describe('resolvePlaceOfSupply — step 2: ship-to evidence (nothing printed)', () => {
  it('a printed ship-to state establishes it', () => {
    const r = resolvePlaceOfSupply(evidence({ shipToState: usable('Karnataka') }));
    expect(r).toMatchObject({ status: 'established', stateCode: '29', basis: 'ship_to_evidence' });
  });

  it('a checksum-valid ship-to GSTIN establishes it', () => {
    const r = resolvePlaceOfSupply(evidence({ shipToGstin: usable('33AAHCK1357R1Z3') }));
    expect(r).toMatchObject({ status: 'established', stateCode: '33', basis: 'ship_to_evidence' });
  });

  it('agreeing pieces establish it and are all recorded', () => {
    const r = resolvePlaceOfSupply(
      evidence({ shipToState: usable('Karnataka'), shipToGstin: usable('29AAACS1111A1Z6') }),
    );
    expect(r.status).toBe('established');
    expect(r.evidence.map((e) => [e.source, e.stateCode])).toEqual([
      ['ship_to_state', '29'],
      ['ship_to_gstin', '29'],
    ]);
  });

  it('disagreeing pieces: ask', () => {
    const r = resolvePlaceOfSupply(
      evidence({ shipToState: usable('Karnataka'), shipToGstin: usable('33AAHCK1357R1Z3') }),
    );
    expect(r).toMatchObject({ status: 'needs_user_input', reason: 'conflicting_evidence' });
  });

  it('a ship-to GSTIN failing its checksum is unusable evidence: ask', () => {
    const r = resolvePlaceOfSupply(evidence({ shipToGstin: usable('29AAGCM4455J1Z5') }));
    expect(r).toMatchObject({ status: 'needs_user_input', reason: 'unusable_evidence' });
    expect(r.evidence[0]?.problem).toBe('bad_checksum');
  });

  it('any unusable piece blocks, even if another piece is fine', () => {
    const r = resolvePlaceOfSupply(
      evidence({ shipToState: usable('Karnataka'), shipToGstin: unusable }),
    );
    expect(r).toMatchObject({ status: 'needs_user_input', reason: 'unusable_evidence' });
    const unknownState = resolvePlaceOfSupply(evidence({ shipToState: usable('Mysore Road') }));
    expect(unknownState).toMatchObject({ status: 'needs_user_input', reason: 'unusable_evidence' });
  });
});

describe('resolvePlaceOfSupply — step 3 and the buyer GSTIN', () => {
  it('no evidence at all: ask', () => {
    expect(resolvePlaceOfSupply(evidence({}))).toMatchObject({
      status: 'needs_user_input',
      reason: 'no_evidence',
    });
  });

  it('the buyer GSTIN alone never establishes the place of supply', () => {
    // A caller passing the whole header still gets no answer from the bill-to GSTIN.
    const headerLike = { ...evidence({}), buyerGstin: usable('29AAACS1111A1Z6') };
    expect(resolvePlaceOfSupply(headerLike)).toMatchObject({
      status: 'needs_user_input',
      reason: 'no_evidence',
    });
  });
});
