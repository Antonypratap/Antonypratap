import { describe, expect, it } from 'vitest';
import { digest, isDemoPin } from './demoAccess';

describe('demo access gate', () => {
  it('accepts only the demo PIN', () => {
    expect(isDemoPin('8824')).toBe(true);
    for (const pin of ['8825', '0000', '4288', '882', '88240', ' 8824', 'abcd', ''])
      expect(isDemoPin(pin)).toBe(false);
  });

  it('keeps no other four-digit PIN valid', () => {
    const valid = Array.from({ length: 10_000 }, (_, i) => String(i).padStart(4, '0')).filter(
      isDemoPin,
    );
    expect(valid).toEqual(['8824']);
  });

  it('digests deterministically', () => {
    expect(digest('')).toBe('811c9dc5');
  });
});
