import { timingSafeEqual } from 'node:crypto';
import { SAMPLE_ERP } from '@veyra/shared/erp-profile';
import type { HttpRequest, HttpResponse, Transport } from '../http';

/**
 * The built-in Sample ERP's API ("Example Co. ERP"): a small REST/JSON ERP that runs inside
 * Veyrafy at sample://example-erp, so the full connect → map → sync → check story can be shown
 * without anyone's real ERP, and the connector is tested end to end against something shaped like
 * a real one:
 * - API key in the X-Api-Key header (401 without it);
 * - GET /api/v2/{vendors,items,purchase-orders,goods-receipts,purchase-bills};
 * - cursor paging (?cursor=…&limit=…, `next_cursor` in the answer), "changed since"
 *   (?updated_since=ISO), lines nested in each order and receipt;
 * - its own field names (vendor_code, gst_no, po_no, qty_recd, rate, bill_no …), unlike Veyrafy's,
 *   so the mapping step has real work to do.
 * Tests can script faults (rate limits, outages, timeouts, a changed answer) per collection.
 */

export const SAMPLE_BASE_URL = SAMPLE_ERP.baseUrl;
/** The Sample ERP's demo key: not a secret (it opens only made-up records), shown on screen. */
export const SAMPLE_API_KEY = SAMPLE_ERP.apiKey;

export interface SampleDataset {
  vendors: Record<string, unknown>[];
  items: Record<string, unknown>[];
  purchaseOrders: Record<string, unknown>[];
  goodsReceipts: Record<string, unknown>[];
  purchaseBills: Record<string, unknown>[];
}

const COLLECTIONS: Record<string, keyof SampleDataset> = {
  vendors: 'vendors',
  items: 'items',
  'purchase-orders': 'purchaseOrders',
  'goods-receipts': 'goodsReceipts',
  'purchase-bills': 'purchaseBills',
};

export type SampleFault =
  | { kind: 'status'; status: number; retryAfter?: string }
  | { kind: 'timeout' }
  | { kind: 'reshape' };

export interface SampleErpOptions {
  apiKey?: string;
  /** Default page size when the caller gives none. */
  pageSize?: number;
  /** Scripted faults, consumed in order, per collection path ("vendors", "goods-receipts"…). */
  faults?: Map<string, SampleFault[]>;
  /** Every request, for tests. */
  onRequest?: (req: HttpRequest) => void;
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

function sameKey(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A Transport serving `data` (read on each request, so tests can change it between syncs). */
export function sampleErpTransport(
  data: () => SampleDataset,
  options: SampleErpOptions = {},
): Transport {
  const key = options.apiKey ?? SAMPLE_API_KEY;
  return (req, signal) =>
    new Promise<HttpResponse>((resolve, reject) => {
      options.onRequest?.(req);
      const url = req.url;
      if (url.protocol !== 'sample:' || url.host !== 'example-erp') {
        resolve(json(404, { error: 'not_found' }));
        return;
      }
      const headerKey = Object.entries(req.headers).find(
        ([k]) => k.toLowerCase() === 'x-api-key',
      )?.[1];
      if (!sameKey(headerKey, key)) {
        resolve(json(401, { error: 'unauthorized', message: 'Missing or wrong X-Api-Key.' }));
        return;
      }
      const m = /^\/api\/v2\/([a-z-]+)\/?$/.exec(url.pathname);
      const collection = m ? COLLECTIONS[m[1] ?? ''] : undefined;
      if (!m || !collection) {
        resolve(json(404, { error: 'not_found' }));
        return;
      }
      const fault = options.faults?.get(m[1] ?? '')?.shift();
      if (fault?.kind === 'timeout') {
        // Never answers; the caller's timeout ends it.
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        return;
      }
      if (fault?.kind === 'status') {
        resolve(
          json(
            fault.status,
            { error: 'scripted' },
            fault.retryAfter ? { 'retry-after': fault.retryAfter } : {},
          ),
        );
        return;
      }
      const since = url.searchParams.get('updated_since');
      const rows = data()[collection].filter((r) => !since || String(r.updated_at ?? '') > since);
      const limit = Math.min(
        Number(url.searchParams.get('limit') ?? options.pageSize ?? 50) || 50,
        500,
      );
      const start = Number(url.searchParams.get('cursor') ?? 0) || 0;
      const page = rows.slice(start, start + limit);
      const next = start + limit < rows.length ? String(start + limit) : null;
      if (fault?.kind === 'reshape') {
        resolve(json(200, { rows: page, next }));
        return;
      }
      resolve(json(200, { data: page, next_cursor: next, total: rows.length }));
    });
}
