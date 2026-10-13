import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ErpAuthenticationError,
  ErpConfigurationError,
  ErpUnavailableError,
} from '@veyra/erp-connector';
import {
  DEFAULT_HTTP_POLICY,
  ResilientHttp,
  isBlockedAddress,
  networkTransport,
  retryAfterMs,
  type HttpPolicy,
  type RequestOutcome,
} from './http';
import { isPublicAddress } from './ssrf';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = (_req, res) => res.end('{}');
const seen: { url: string; auth: string | undefined }[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
});

const local: HttpPolicy = {
  ...DEFAULT_HTTP_POLICY,
  allowHttp: true,
  allowPrivate: true,
  minIntervalMs: 0,
  timeoutMs: 1_000,
};

function client(policy: Partial<HttpPolicy> = {}) {
  const waits: number[] = [];
  const outcomes: RequestOutcome[] = [];
  const p = { ...local, ...policy };
  const http = new ResilientHttp(networkTransport(p), p, {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    onOutcome: (o) => outcomes.push(o),
  });
  return { http, waits, outcomes };
}

const get = (path: string, headers: Record<string, string> = {}) => ({
  method: 'GET' as const,
  url: new URL(path, base),
  headers,
});

describe('resilient HTTP for ERP connections', () => {
  it('returns a 2xx body', async () => {
    handler = (_req, res) => res.end('{"ok":true}');
    const { http } = client();
    const res = await http.send(get('/vendors?page=1'));
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('retries 5xx with backoff, then succeeds', async () => {
    let n = 0;
    handler = (_req, res) => {
      n++;
      res.statusCode = n < 3 ? 503 : 200;
      res.end('{}');
    };
    const { http, waits } = client();
    await http.send(get('/x'));
    expect(n).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('honours Retry-After on 429 and reports rate limiting when it keeps happening', async () => {
    handler = (_req, res) => {
      res.statusCode = 429;
      res.setHeader('retry-after', '7');
      res.end();
    };
    const { http, waits } = client({ maxAttempts: 3 });
    const err = await http.send(get('/x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpUnavailableError);
    expect((err as ErpUnavailableError).reason).toBe('rate_limited');
    expect(waits).toEqual([7000, 7000]);
  });

  it('does not retry 401/403: the credentials need fixing', async () => {
    let n = 0;
    handler = (_req, res) => {
      n++;
      res.statusCode = 401;
      res.end();
    };
    const { http } = client();
    await expect(http.send(get('/x'))).rejects.toBeInstanceOf(ErpAuthenticationError);
    expect(n).toBe(1);
  });

  it('does not retry other 4xx: a wrong path is a setup problem', async () => {
    let n = 0;
    handler = (_req, res) => {
      n++;
      res.statusCode = 404;
      res.end();
    };
    const { http } = client();
    await expect(http.send(get('/x'))).rejects.toBeInstanceOf(ErpConfigurationError);
    expect(n).toBe(1);
  });

  it('times out a slow answer and retries it', async () => {
    let n = 0;
    handler = (_req, res) => {
      n++;
      if (n === 1) setTimeout(() => res.end('{}'), 400);
      else res.end('{}');
    };
    const { http } = client({ timeoutMs: 100 });
    await http.send(get('/slow'));
    expect(n).toBe(2);
  });

  it('gives up after the last attempt with a timeout reason', async () => {
    handler = (_req, res) => setTimeout(() => res.end('{}'), 300);
    const { http } = client({ timeoutMs: 50, maxAttempts: 2 });
    const err = await http.send(get('/slow')).catch((e: unknown) => e);
    expect((err as ErpUnavailableError).reason).toBe('timeout');
  });

  it('refuses a response larger than the limit', async () => {
    handler = (_req, res) => res.end('x'.repeat(5000));
    const { http } = client({ maxBytes: 1000 });
    await expect(http.send(get('/big'))).rejects.toBeInstanceOf(ErpConfigurationError);
  });

  it('follows a same-origin redirect with credentials, and drops them across origins', async () => {
    handler = (req, res) => {
      if (req.url === '/old') {
        res.statusCode = 302;
        res.setHeader('location', '/new');
        res.end();
      } else res.end('{}');
    };
    const { http } = client();
    await http.send(get('/old', { authorization: 'Bearer made-up' }));
    expect(seen.map((s) => [s.url, s.auth])).toEqual([
      ['/old', 'Bearer made-up'],
      ['/new', 'Bearer made-up'],
    ]);
  });

  it('never sends a request body (such as an OAuth client secret) to another origin', async () => {
    // A second server: another origin on this machine.
    const received: { method: string; body: string; auth: string | undefined }[] = [];
    const other = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ method: req.method ?? '', body, auth: req.headers.authorization });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    const elsewhere = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}/token`;
    try {
      const post = {
        method: 'POST' as const,
        url: new URL('/token', base),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&client_secret=made-up-secret',
      };
      // 307 and 308 would repeat the POST with its body: refused, answered as a setup error.
      for (const status of [307, 308]) {
        handler = (_req, res) => {
          res.statusCode = status;
          res.setHeader('location', elsewhere);
          res.end();
        };
        await expect(client({ maxAttempts: 1 }).http.send(post)).rejects.toBeInstanceOf(
          ErpConfigurationError,
        );
      }
      // 302 continues as a GET without the body (and without credentials).
      handler = (_req, res) => {
        res.statusCode = 302;
        res.setHeader('location', elsewhere);
        res.end();
      };
      await client().http.send({ ...post, headers: { ...post.headers, authorization: 'Basic x' } });
      expect(received).toEqual([{ method: 'GET', body: '', auth: undefined }]);
      expect(JSON.stringify(received)).not.toContain('made-up-secret');
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it('never puts the URL, query or credentials into an error or outcome', async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end('internal detail');
    };
    const { http, outcomes } = client({ maxAttempts: 1 });
    const err = await http
      .send(get('/x?token=made-up-secret', { 'x-api-key': 'made-up-key' }))
      .catch((e: unknown) => e);
    const text = JSON.stringify([String(err), (err as Error).message, outcomes]);
    expect(text).not.toMatch(/made-up|token|127\.0\.0\.1|internal detail/);
  });

  it('sends one request at a time', async () => {
    let inFlight = 0;
    let max = 0;
    handler = (_req, res) => {
      inFlight++;
      max = Math.max(max, inFlight);
      setTimeout(() => {
        inFlight--;
        res.end('{}');
      }, 20);
    };
    const { http } = client();
    await Promise.all([http.send(get('/a')), http.send(get('/b')), http.send(get('/c'))]);
    expect(max).toBe(1);
  });
});

describe('outbound address safety', () => {
  it('knows public from private addresses', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::127.0.0.1',
      '2002:7f00:1::1',
      '2002:a9fe:a9fe::1',
      '64:ff9b:1::a00:1',
      'fec0::1',
      'not-an-ip',
    ])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
      expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses to call a private address, typed or resolved', async () => {
    handler = (_req, res) => res.end('{}');
    const { http } = client({ allowPrivate: false });
    const typed = await http.send(get('/x')).catch((e: unknown) => e);
    expect(isBlockedAddress(typed)).toBe(true);
    const port = new URL(base).port;
    const resolved = await http
      .send({ method: 'GET', url: new URL(`http://localhost:${port}/x`), headers: {} })
      .catch((e: unknown) => e);
    expect(isBlockedAddress(resolved)).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('refuses a redirect into a private network', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
      res.end();
    };
    // This machine's test server is allowed; nothing else private is.
    const { http } = client({ allowPrivate: (a) => a === '127.0.0.1' });
    const err = await http.send(get('/r')).catch((e: unknown) => e);
    expect(isBlockedAddress(err)).toBe(true);
    expect(seen.map((s) => s.url)).toEqual(['/r']);
  });

  it('refuses plain http unless allowed', async () => {
    const { http } = client({ allowHttp: false });
    await expect(http.send(get('/x'))).rejects.toBeInstanceOf(ErpConfigurationError);
    expect(seen).toHaveLength(0);
  });
});

describe('Retry-After', () => {
  it('reads seconds and HTTP dates, capped', () => {
    expect(retryAfterMs('3', 0, 60_000)).toBe(3000);
    expect(retryAfterMs('999', 0, 60_000)).toBe(60_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0, 60_000)).toBe(10_000);
    expect(retryAfterMs('soon', 0, 60_000)).toBeNull();
    expect(retryAfterMs(undefined, 0, 60_000)).toBeNull();
  });
});
