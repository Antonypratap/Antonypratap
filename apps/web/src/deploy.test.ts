import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseApiBase, refuseUnknownWebEnv } from './api-base';
import { hashForPath, parseHash } from './product/router';
import {
  CONTENT_SECURITY_POLICY,
  WEB_SECURITY_HEADERS,
  webSecurityHeaders,
} from './security-headers';
import { vercelConfigProblems } from './vercel-config';

/** Phase 7C: the web app as it is built and hosted for the public demo. */
const vercelJson = JSON.parse(
  readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
) as unknown;

describe('VITE_API_BASE_URL', () => {
  it('defaults to /api/v1 on the same origin (no hardcoded host)', () => {
    expect(parseApiBase(undefined)).toEqual({ base: '/api/v1', origin: null });
    expect(parseApiBase('')).toEqual({ base: '/api/v1', origin: null });
    expect(parseApiBase('/veyra/api/v1/')).toEqual({ base: '/veyra/api/v1', origin: null });
  });

  it('accepts an https API on another origin, and names that origin', () => {
    expect(parseApiBase('https://api.veyra.example/api/v1')).toEqual({
      base: 'https://api.veyra.example/api/v1',
      origin: 'https://api.veyra.example',
    });
    expect(parseApiBase('http://localhost:8787/api/v1').origin).toBe('http://localhost:8787');
  });

  it.each([
    ['http://api.veyra.example/api/v1', /https/],
    ['https://user:pass@api.veyra.example/api/v1', /credentials/],
    ['https://api.veyra.example/api/v1?key=x', /query/],
    ['//api.veyra.example/api/v1', /single/],
    ['api.veyra.example', /path|https/],
    ['/api/v1"><script>', /letters/],
  ])('refuses %s', (value, why) => {
    expect(() => parseApiBase(value)).toThrow(why);
  });

  it('the build refuses every other VITE_ variable (they would be published)', () => {
    expect(() => refuseUnknownWebEnv({ VITE_API_BASE_URL: '/api/v1' })).not.toThrow();
    expect(() => refuseUnknownWebEnv({ VITE_DEMO_PIN: '8824' })).toThrow(/VITE_DEMO_PIN/);
    expect(() => refuseUnknownWebEnv({ VITE_DATABASE_URL: 'postgres://x' })).toThrow(
      /refusing VITE_DATABASE_URL/,
    );
    expect(() => refuseUnknownWebEnv({ PATH: '/usr/bin', VERCEL: '1' })).not.toThrow();
  });
});

describe('Content-Security-Policy', () => {
  it("stays connect-src 'self' for the same-origin API; adds exactly the API origin otherwise", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self';");
    const cross = webSecurityHeaders('https://api.veyra.example')['Content-Security-Policy'] ?? '';
    expect(cross).toContain("connect-src 'self' https://api.veyra.example;");
    expect(cross.replace(' https://api.veyra.example', '')).toBe(CONTENT_SECURITY_POLICY);
    expect(cross).not.toMatch(/unsafe|\*/);
  });
});

describe('vercel.json', () => {
  it('matches the reviewed policy: API rewrite, SPA fallback, exactly our headers, no env', () => {
    expect(
      vercelConfigProblems(vercelJson, WEB_SECURITY_HEADERS, { allowPlaceholder: true }),
    ).toEqual([]);
  });

  it('refuses to deploy while the API host is still the placeholder', () => {
    expect(vercelConfigProblems(vercelJson, WEB_SECURITY_HEADERS)).toEqual([
      expect.stringMatching(/placeholder host/),
    ]);
    const real = structuredClone(vercelJson) as { rewrites: { destination: string }[] };
    real.rewrites[0] = {
      ...real.rewrites[0],
      destination: 'https://veyra-api.fly.dev/api/:path*',
    } as { destination: string };
    expect(vercelConfigProblems(real, WEB_SECURITY_HEADERS)).toEqual([]);
  });

  it('catches drift: a weakened header, a missing one, an insecure API host, env in Git', () => {
    const bad = structuredClone(vercelJson) as {
      rewrites: { source: string; destination: string }[];
      headers: { source: string; headers: { key: string; value: string }[] }[];
      env?: unknown;
    };
    const pages = bad.headers.find((h) => h.source === '/((?!api/).*)');
    if (!pages) throw new Error('no page headers');
    pages.headers = pages.headers
      .filter((h) => h.key !== 'X-Frame-Options')
      .map((h) =>
        h.key === 'Content-Security-Policy'
          ? { ...h, value: "default-src *; script-src 'unsafe-inline'" }
          : h,
      );
    bad.rewrites[0] = { source: '/api/:path*', destination: 'http://api.example.com/api/:path*' };
    bad.env = { DATABASE_URL: 'postgres://x' };
    const problems = vercelConfigProblems(bad, WEB_SECURITY_HEADERS, { allowPlaceholder: true });
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/environment variables/),
        expect.stringMatching(/https/),
        'header Content-Security-Policy differs from security-headers.ts',
        'header X-Frame-Options differs from security-headers.ts',
      ]),
    );
  });
});

describe('addresses', () => {
  it('/app/… as a path opens the same screen as the hash route (direct links, refresh)', () => {
    expect(hashForPath('/app/inbox', '')).toBe('#/app/inbox');
    expect(hashForPath('/app', '')).toBe('#/app');
    expect(hashForPath('/app/invoices/01K0', '')).toBe('#/app/invoices/01K0');
    expect(hashForPath('/app/invoices/', '?attention')).toBe('#/app/invoices?attention');
    expect(parseHash(hashForPath('/app/erp/data', '') ?? '')).toEqual({ name: 'erp', tab: 'data' });
    expect(hashForPath('/', '')).toBeNull();
    expect(hashForPath('/apples', '')).toBeNull();
    expect(hashForPath('/assets/index.js', '')).toBeNull();
  });
});
