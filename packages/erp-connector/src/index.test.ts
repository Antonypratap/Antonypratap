import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@veyra/erp-connector scaffold', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@veyra/erp-connector');
  });
});
