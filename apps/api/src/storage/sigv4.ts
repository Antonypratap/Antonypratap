import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for the S3-compatible storage adapter (Phase 6), with no SDK. Signs the
 * headers it is given plus the payload hash. Secrets are used only to derive the signing key and
 * never leave this function.
 */
export interface SignInput {
  method: string;
  url: URL;
  /** Headers to sign; must include `host` and `x-amz-date`. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();
export const sha256Hex = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

/** RFC 3986 encoding as SigV4 requires (everything but A–Z a–z 0–9 - _ . ~). */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20150830T123600Z` for a date. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** The `Authorization` header value. */
export function signV4(input: SignInput): string {
  const date = input.headers['x-amz-date'];
  if (!date) throw new Error('x-amz-date is required');
  const day = date.slice(0, 8);
  const names = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]),
  );
  const canonicalUri =
    input.url.pathname
      .split('/')
      .map((s) => uriEncode(decodeURIComponent(s)))
      .join('/') || '/';
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    names.map((n) => `${n}:${lower[n]}\n`).join(''),
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}
