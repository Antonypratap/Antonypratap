import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The browser side of sign-in (Phase 6C). The PIN and the password are checked by the server; the
 * browser keeps the CSRF token in memory only and never stores anything about the session.
 */
const SESSION = {
  authenticated: true,
  demoSignIn: true,
  user: { id: 'u1', name: 'Asha Rao', email: 'asha@toit.example', role: 'REVIEWER' },
  permissions: ['invoices.view', 'documents.view', 'questions.answer', 'audit.invoice'],
  organization: { id: 'o1', name: 'Toit' },
  csrfToken: 'csrf-token-in-memory',
  expiresAt: '2026-09-28T18:30:00.000Z',
};

const json = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('sign-in state', () => {
  it('the demo PIN is sent to the server, never checked in the browser', async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'That PIN isn’t correct.' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const s = await import('./session');
    await expect(s.demoSignIn('1234')).rejects.toThrow('That PIN isn’t correct.');
    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/auth/demo',
      expect.objectContaining({ method: 'POST', body: '{"pin":"1234"}' }),
    );
    expect(s.sessionState().status).toBe('loading');
  });

  it('signed in: the CSRF header comes from memory; permissions decide what is shown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(200, SESSION)),
    );
    const s = await import('./session');
    expect(s.csrfHeaders()).toEqual({});
    await s.signIn('asha@toit.example', 'a password');
    expect(s.csrfHeaders()).toEqual({ 'x-veyra-csrf': 'csrf-token-in-memory' });
    expect(s.allowed('questions.answer')).toBe(true);
    expect(s.allowed('invoices.reject')).toBe(false);
    s.sessionEnded();
    expect(s.sessionState()).toMatchObject({ status: 'signedOut', demoSignIn: true });
    expect(s.csrfHeaders()).toEqual({});
  });

  it('no session material is ever put in web storage or URLs (source check)', () => {
    const root = join(import.meta.dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts'))
          files.push(join(dir, e.name));
    };
    walk(root);
    for (const f of files) {
      // Code only: comments may say what is never done.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(src, f).not.toMatch(/[?&](token|session|csrf)=/i);
    }
  });
});
