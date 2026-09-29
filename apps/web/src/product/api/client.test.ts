import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type ApiError } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

const respond = (status: number, body: string) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(body, { status }))),
  );

const failure = async () => {
  try {
    await api.inbox();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected a failure');
};

describe('API client: an unreachable API', () => {
  it('no connection at all is OFFLINE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const e = await failure();
    expect(e.code).toBe('OFFLINE');
    expect(e.message).not.toMatch(/npm|localhost|127\.0\.0\.1/);
  });

  it.each([502, 503, 504])(
    'a gateway %i for an API that is down is OFFLINE (the proxy answers, not Veyra)',
    async (status) => {
      respond(status, '<html>Bad Gateway</html>');
      expect((await failure()).code).toBe('OFFLINE');
    },
  );

  it('a Veyra error body keeps its own code, even with 503', async () => {
    respond(503, JSON.stringify({ error: { code: 'NOT_READY', message: 'Not ready yet.' } }));
    const e = await failure();
    expect(e.code).toBe('NOT_READY');
    expect(e.message).toBe('Not ready yet.');
  });

  it('other failures without a body stay HTTP errors', async () => {
    respond(500, '');
    expect((await failure()).code).toBe('HTTP');
  });
});
