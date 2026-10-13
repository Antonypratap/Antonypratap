import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  ErpAuthenticationError,
  ErpConfigurationError,
  ErpConnectorError,
  ErpUnavailableError,
} from '@veyra/erp-connector';
import { BlockedAddressError, addressAllowed, guardedLookup, type PrivateAllowance } from './ssrf';

/**
 * The HTTP layer every ERP API connection goes through. It owns the rules that keep a slow, busy
 * or misconfigured ERP from hurting Veyrafy or being hurt by it:
 * - one request at a time per connection, with a minimum gap between requests;
 * - a timeout per request and a size limit per response;
 * - retries with exponential backoff and jitter on network errors, 429 and 5xx (honouring
 *   Retry-After), never on 4xx;
 * - 401/403 end at once as an authentication failure (someone must fix the credentials);
 * - outbound address safety on every hop (ssrf.ts), https only unless explicitly allowed;
 * - nothing about the request (URL query, headers, body) is ever put in an error or log; callers
 *   get a typed ErpConnectorError with a safe message.
 */

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Sends one request (no retries). The network transport, or an in-process one (Sample ERP). */
export type Transport = (req: HttpRequest, signal: AbortSignal) => Promise<HttpResponse>;

export interface HttpPolicy {
  timeoutMs: number;
  maxBytes: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  minIntervalMs: number;
  maxRedirects: number;
  allowHttp: boolean;
  /** Never set in production; see PrivateAllowance. */
  allowPrivate: PrivateAllowance;
}

export const DEFAULT_HTTP_POLICY: HttpPolicy = {
  timeoutMs: 20_000,
  maxBytes: 20 * 1024 * 1024,
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  minIntervalMs: 100,
  maxRedirects: 3,
  allowHttp: false,
  allowPrivate: false,
};

/** One request/response over the network, with the address guard, size limit and redirects. */
export function networkTransport(policy: HttpPolicy): Transport {
  const lookup = guardedLookup(policy.allowPrivate);
  const once = (req: HttpRequest, signal: AbortSignal): Promise<HttpResponse> =>
    new Promise((resolve, reject) => {
      const { url } = req;
      if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
        reject(new ErpConfigurationError());
        return;
      }
      // An address typed as an IP skips DNS, so it is checked here.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && !addressAllowed(host, policy.allowPrivate)) {
        reject(new BlockedAddressError());
        return;
      }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const r = send(
        url,
        {
          method: req.method,
          headers: { ...req.headers, accept: 'application/json', 'user-agent': 'Veyrafy' },
          lookup: lookup as never,
          signal,
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > policy.maxBytes) {
              res.destroy();
              reject(new ResponseTooLargeError());
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers))
              if (typeof v === 'string') headers[k] = v;
              else if (Array.isArray(v)) headers[k] = v.join(', ');
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', reject);
        },
      );
      r.on('error', reject);
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });

  return async (req, signal) => {
    let current = req;
    for (let hop = 0; ; hop++) {
      const res = await once(current, signal);
      if (![301, 302, 303, 307, 308].includes(res.status)) return res;
      const location = res.headers.location;
      if (!location || hop >= policy.maxRedirects) return res;
      // The next hop is a new request: it passes the same address and scheme checks.
      const next = new URL(location, current.url);
      const sameOrigin = next.origin === current.url.origin;
      const keepsBody = res.status === 307 || res.status === 308;
      // A request body can carry a secret (the OAuth token request's client secret): it never
      // follows a redirect to another origin. Such a redirect is answered as it is (a setup error).
      if (!sameOrigin && keepsBody && current.body !== undefined) return res;
      current = {
        // 301/302/303 continue as a GET without the body (as browsers do); 307/308 keep both.
        method: keepsBody ? current.method : 'GET',
        url: next,
        // Credentials never follow a redirect to another origin.
        headers: sameOrigin ? current.headers : {},
        ...(keepsBody && current.body !== undefined ? { body: current.body } : {}),
      };
    }
  };
}

export class ResponseTooLargeError extends Error {
  constructor() {
    super('The response was larger than Veyrafy accepts.');
    this.name = 'ResponseTooLargeError';
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Seconds or an HTTP date, capped; null when absent or unreadable. */
export function retryAfterMs(value: string | undefined, now: number, capMs: number): number | null {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, capMs);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - now), capMs);
}

/** What the client reports for each finished request (for logs and timings): nothing sensitive. */
export interface RequestOutcome {
  status: number | null;
  attempt: number;
  ms: number;
  error: string | null;
}

/**
 * Sends requests through a transport with the retry, pacing and error rules above. A request
 * either returns a 2xx response or throws an ErpConnectorError.
 */
export class ResilientHttp {
  #queue: Promise<unknown> = Promise.resolve();
  #lastAt = 0;

  constructor(
    private readonly transport: Transport,
    private readonly policy: HttpPolicy,
    private readonly options: {
      now?: () => number;
      random?: () => number;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
      onOutcome?: (o: RequestOutcome) => void;
    } = {},
  ) {}

  send(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    // One request at a time for this connection.
    const run = this.#queue.then(() => this.#send(req, signal));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #send(req: HttpRequest, outer?: AbortSignal): Promise<HttpResponse> {
    const now = this.options.now ?? Date.now;
    const wait = this.options.sleep ?? sleep;
    const random = this.options.random ?? Math.random;
    const p = this.policy;
    for (let attempt = 1; ; attempt++) {
      const gap = this.#lastAt + p.minIntervalMs - now();
      if (gap > 0) await wait(gap, outer);
      this.#lastAt = now();
      const started = now();
      const timeout = AbortSignal.timeout(p.timeoutMs);
      const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
      let res: HttpResponse | null = null;
      let failure: ErpConnectorError | null = null;
      try {
        res = await this.transport(req, signal);
      } catch (e) {
        if (outer?.aborted) throw outer.reason;
        failure = classifyNetworkError(e, timeout.aborted);
      }
      const ms = now() - started;
      if (res && res.status >= 200 && res.status < 300) {
        this.options.onOutcome?.({ status: res.status, attempt, ms, error: null });
        return res;
      }
      if (res) failure = classifyStatus(res.status);
      const error = failure ?? new ErpUnavailableError();
      this.options.onOutcome?.({ status: res?.status ?? null, attempt, ms, error: error.code });
      if (!error.retryable || attempt >= p.maxAttempts) throw error;
      const backoff = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1));
      const hinted = res ? retryAfterMs(res.headers['retry-after'], now(), p.maxDelayMs) : null;
      // Full jitter on the computed backoff; a server's Retry-After is respected as a floor.
      await wait(Math.max(hinted ?? 0, Math.round(backoff * (0.5 + random() / 2))), outer);
    }
  }
}

function classifyStatus(status: number): ErpConnectorError {
  if (status === 401 || status === 403) return new ErpAuthenticationError();
  if (status === 429) return new ErpUnavailableError({ reason: 'rate_limited' });
  if (status >= 500) return new ErpUnavailableError();
  // Any other 4xx (or 3xx left over after too many redirects) is a setup problem: wrong path,
  // wrong parameters. Retrying will not help.
  return new ErpConfigurationError();
}

function classifyNetworkError(e: unknown, timedOut: boolean): ErpConnectorError {
  if (e instanceof ErpConnectorError) return e;
  if (e instanceof BlockedAddressError || (e as { code?: string })?.code === 'EBLOCKED')
    return new ErpConfigurationError({ cause: new BlockedAddressError() });
  if (e instanceof ResponseTooLargeError) return new ErpConfigurationError({ cause: e });
  if (timedOut) return new ErpUnavailableError({ reason: 'timeout' });
  return new ErpUnavailableError({ reason: 'network' });
}

/** Whether an error came from the address guard (for a precise message on the connect screen). */
export function isBlockedAddress(e: unknown): boolean {
  return e instanceof ErpConfigurationError && e.cause instanceof BlockedAddressError;
}
