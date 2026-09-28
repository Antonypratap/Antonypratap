import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@veyra/extractor scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@veyra/extractor');
  });
});
