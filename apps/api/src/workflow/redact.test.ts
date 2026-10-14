import { describe, expect, it } from 'vitest';
import { redactEvidence, redactReading } from './redact';

/** What leaves a reading when its original is deleted (made-up values only). */
describe('removing the text read from a deleted document', () => {
  const reading = {
    header: {
      totalPaise: {
        value: 118_000,
        confidenceBp: 9900,
        evidence: { page: 1, text: 'Total 1,180.00', bbox: [1, 2, 3, 4] },
      },
    },
    lines: [
      {
        description: {
          value: 'Made-up item',
          evidence: { page: 1, text: 'Made-up item', bbox: null },
        },
      },
    ],
    otherFields: [
      {
        label: 'Bank A/c No.',
        value: '000111222333',
        evidence: { page: 2, text: 'A/c 000111222333' },
      },
      { label: 'IRN', value: 'made-up-irn', evidence: null },
      { label: 'Freight', value: '250.00', evidence: { page: 1, text: 'Freight 250.00' } },
    ],
  };

  it('keeps every value and its position, drops other printed values except freight, blanks quotes', () => {
    const { json, removed } = redactReading(JSON.stringify(reading));
    const out = JSON.parse(json) as typeof reading & { contentsRemoved: boolean };
    expect(out.contentsRemoved).toBe(true);
    expect(out.header.totalPaise.value).toBe(118_000);
    expect(out.header.totalPaise.evidence).toEqual({ page: 1, text: '', bbox: [1, 2, 3, 4] });
    expect(out.lines[0]?.description.value).toBe('Made-up item');
    expect(out.otherFields.map((o) => o.label)).toEqual(['Freight']);
    expect(out.otherFields[0]?.value).toBe('250.00');
    expect(json).not.toMatch(/000111222333|made-up-irn|Total 1,180/);
    expect(removed).toBe(2 + 3);
    // Idempotent.
    expect(redactReading(json).removed).toBe(0);
  });

  it('blanks a stored field’s quoted evidence, keeping page and position', () => {
    expect(
      JSON.parse(
        redactEvidence('{"page":1,"text":"GSTIN 29AAAAA0000A1Z5","bbox":[1,2,3,4]}') ?? '',
      ),
    ).toEqual({
      page: 1,
      text: '',
      bbox: [1, 2, 3, 4],
    });
    expect(redactEvidence(null)).toBeNull();
  });
});
