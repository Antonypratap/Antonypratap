import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiCapabilities } from '@veyra/shared';
import { hasCapability } from '../product/state/capabilities';
import { OPS_SECTIONS, hashForPath, hrefFor, parseHash } from '../product/router';

describe('Veyra Operations routes (Phase 8A)', () => {
  it('every section has its own address, separate from the customer application', () => {
    for (const section of OPS_SECTIONS) {
      const href = hrefFor({ name: 'ops', section, id: null });
      expect(href).toBe(`#/ops/${section}`);
      expect(parseHash(href)).toEqual({ name: 'ops', section, id: null });
    }
    expect(parseHash('#/ops')).toEqual({ name: 'ops', section: 'overview', id: null });
    expect(parseHash('#/ops/commercial/01ORG')).toEqual({
      name: 'ops',
      section: 'commercial',
      id: '01ORG',
    });
    expect(parseHash('#/ops/nonsense')).toMatchObject({ section: 'overview' });
    expect(hashForPath('/ops/plans', '')).toBe('#/ops/plans');
  });
});

describe('capability-driven UI', () => {
  const caps: ApiCapabilities = {
    capabilities: [
      { key: 'reports.exports', name: 'Exports', type: 'BOOLEAN', available: false },
      { key: 'erp.business_record_import', name: 'Import', type: 'BOOLEAN', available: true },
      {
        key: 'invoice.monthly_limit',
        name: 'Invoices',
        type: 'LIMIT',
        available: true,
        limit: 500,
        used: 3,
      },
    ],
  };

  it('asks for a capability, never a plan; unknown or loading means not shown', () => {
    expect(hasCapability(caps, 'erp.business_record_import')).toBe(true);
    expect(hasCapability(caps, 'reports.exports')).toBe(false);
    expect(hasCapability(null, 'reports.exports')).toBe(false);
  });

  it('the customer application contains no plan logic (no plan names in its source)', () => {
    const dirs = ['product', 'access', 'marketing', 'feedback'];
    const files = dirs.flatMap((d) =>
      readdirSync(new URL(`../${d}/`, import.meta.url), { recursive: true })
        .map(String)
        .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
        .map((f) => new URL(`../${d}/${f}`, import.meta.url)),
    );
    expect(files.length).toBeGreaterThan(10);
    for (const f of files)
      expect(readFileSync(f, 'utf8'), f.pathname).not.toMatch(
        /\b(STARTER|BUSINESS|ENTERPRISE)\b|planKey|plan ===/,
      );
  });
});
