import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@veyra/fake-erp scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@veyra/fake-erp');
  });
});
