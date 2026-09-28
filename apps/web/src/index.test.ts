import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@veyra/web scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@veyra/web');
  });
});
