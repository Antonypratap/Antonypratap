import { describe, expect, it } from 'vitest';
import { ErpAuthenticationError } from '@veyra/erp-connector';
import { Secret } from '../secret';
import {
  DEFAULT_HTTP_POLICY,
  ResilientHttp,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from './http';
import { convert, mapRecord, parseDate } from './mapping';
import { missingRequired, ProfileSchema, type EntityConfig, type Paging } from './profile';
import { GenericApiSource, ResponseShapeError } from './source';

/** A made-up ERP with 7 suppliers, answering according to the paging style asked for. */
const VENDORS = Array.from({ length: 7 }, (_, i) => ({
  vendor_id: `V${String(i + 1)}`,
  vendor_name: `Supplier ${String(i + 1)}`,
  gst_no: '29ABCDE1234F1Z5',
}));

function fakeErp(paging: Paging['style'], calls: HttpRequest[]): Transport {
  return (req) => {
    calls.push(req);
    const q = req.url.searchParams;
    let slice: typeof VENDORS;
    const body: Record<string, unknown> = {};
    if (paging === 'page') {
      const page = Number(q.get('page'));
      const size = Number(q.get('per_page'));
      slice = VENDORS.slice((page - 1) * size, page * size);
    } else if (paging === 'offset') {
      const off = Number(q.get('skip'));
      slice = VENDORS.slice(off, off + Number(q.get('take')));
    } else if (paging === 'cursor') {
      const at = Number(q.get('after') ?? 0);
      slice = VENDORS.slice(at, at + 3);
      body.next = at + 3 < VENDORS.length ? String(at + 3) : null;
    } else if (paging === 'link') {
      const at = Number(q.get('from') ?? 0);
      slice = VENDORS.slice(at, at + 3);
      body.links = {
        next: at + 3 < VENDORS.length ? `/api/suppliers?from=${String(at + 3)}` : null,
      };
    } else slice = VENDORS;
    body.data = { items: slice };
    return Promise.resolve<HttpResponse>({ status: 200, headers: {}, body: JSON.stringify(body) });
  };
}

const vendorConfig = (paging: Paging): EntityConfig => ({
  path: '/api/suppliers',
  query: {},
  listPath: 'data.items',
  paging,
  fields: {
    id: { path: 'vendor_id' },
    name: { path: 'vendor_name' },
    gstin: { path: 'gst_no' },
  },
  lineFields: {},
});

function source(
  paging: Paging,
  transport: Transport,
  auth = { type: 'api_key' as const, headerName: 'X-Api-Key' },
) {
  const profile = ProfileSchema.parse({
    version: 1,
    name: 'Test ERP',
    baseUrl: 'https://erp.example.test/',
    auth,
    entities: { vendors: vendorConfig(paging) },
  });
  const http = new ResilientHttp(
    transport,
    { ...DEFAULT_HTTP_POLICY, minIntervalMs: 0 },
    { sleep: () => Promise.resolve() },
  );
  return new GenericApiSource(
    profile,
    (k) => (k === 'apiKey' ? new Secret('made-up-key') : null),
    http,
  );
}

async function readAll(src: GenericApiSource) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await src.fetchPage('vendors', { cursor, since: null });
    for (const r of page.results) if (r.ok === true) ids.push(r.record.erpId);
    cursor = page.next;
    pages++;
  } while (cursor !== null && pages < 20);
  return { ids, pages };
}

describe('generic API source: paging', () => {
  const all = VENDORS.map((v) => v.vendor_id);
  it.each<[string, Paging, number]>([
    ['none', { style: 'none' }, 1],
    ['page', { style: 'page', pageParam: 'page', sizeParam: 'per_page', size: 3, firstPage: 1 }, 3],
    ['offset', { style: 'offset', offsetParam: 'skip', limitParam: 'take', limit: 3 }, 3],
    ['cursor', { style: 'cursor', cursorParam: 'after', nextCursorPath: 'next' }, 3],
    ['link', { style: 'link', nextLinkPath: 'links.next' }, 3],
  ])('%s paging reads every record exactly once', async (_name, paging, expectedPages) => {
    const calls: HttpRequest[] = [];
    const { ids, pages } = await readAll(source(paging, fakeErp(paging.style, calls)));
    expect(ids).toEqual(all);
    expect(pages).toBe(expectedPages);
    expect(calls.every((c) => c.headers['X-Api-Key'] === 'made-up-key')).toBe(true);
  });

  it('a next link to another address is refused', async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: { items: [] },
          links: { next: 'https://elsewhere.example/steal' },
        }),
      });
    await expect(
      source({ style: 'link', nextLinkPath: 'links.next' }, transport).fetchPage('vendors', {
        cursor: null,
        since: null,
      }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('a response without the list where the mapping expects it is a shape change', async () => {
    const transport: Transport = () =>
      Promise.resolve({ status: 200, headers: {}, body: '{"result":[]}' });
    const err = await source({ style: 'none' }, transport)
      .fetchPage('vendors', { cursor: null, since: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseShapeError);
    expect((err as ResponseShapeError).problem).toBe('no_list');
  });

  it('adds the "changed since" filter only when set up for it', async () => {
    const calls: HttpRequest[] = [];
    const src = source({ style: 'none' }, fakeErp('none', calls));
    await src.fetchPage('vendors', { cursor: null, since: '2026-10-01T00:00:00.000Z' });
    expect(calls[0]?.url.searchParams.has('updated_since')).toBe(false);
    const profile = { ...src.profile };
    profile.entities = {
      vendors: {
        ...vendorConfig({ style: 'none' }),
        incremental: { param: 'updated_since', format: 'date' },
      },
    };
    const http = new ResilientHttp(fakeErp('none', calls), {
      ...DEFAULT_HTTP_POLICY,
      minIntervalMs: 0,
    });
    await new GenericApiSource(profile, () => new Secret('k'), http).fetchPage('vendors', {
      cursor: null,
      since: '2026-10-01T10:00:00.000Z',
    });
    expect(calls[1]?.url.searchParams.get('updated_since')).toBe('2026-10-01');
  });
});

describe('generic API source: login', () => {
  it('fails as an authentication problem when no secret is saved', async () => {
    const profile = ProfileSchema.parse({
      version: 1,
      name: 'T',
      baseUrl: 'https://erp.example.test',
      auth: { type: 'bearer' },
      entities: { vendors: vendorConfig({ style: 'none' }) },
    });
    const http = new ResilientHttp(fakeErp('none', []), DEFAULT_HTTP_POLICY);
    await expect(
      new GenericApiSource(profile, () => null, http).fetchPage('vendors', {
        cursor: null,
        since: null,
      }),
    ).rejects.toBeInstanceOf(ErpAuthenticationError);
  });

  it('OAuth2: fetches a token, reuses it, and renews it once after a 401', async () => {
    let tokens = 0;
    let rejectNext = false;
    const seen: string[] = [];
    const transport: Transport = (req) => {
      if (req.url.pathname === '/oauth/token') {
        tokens++;
        expect(req.body).toContain('grant_type=client_credentials');
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({ access_token: `t${String(tokens)}`, expires_in: 3600 }),
        });
      }
      seen.push(req.headers.authorization ?? '');
      if (rejectNext) {
        rejectNext = false;
        return Promise.resolve({ status: 401, headers: {}, body: '' });
      }
      return Promise.resolve({ status: 200, headers: {}, body: '{"data":{"items":[]}}' });
    };
    const profile = ProfileSchema.parse({
      version: 1,
      name: 'T',
      baseUrl: 'https://erp.example.test',
      auth: {
        type: 'oauth2_client_credentials',
        tokenUrl: 'https://erp.example.test/oauth/token',
        clientId: 'veyrafy',
      },
      entities: { vendors: vendorConfig({ style: 'none' }) },
    });
    const http = new ResilientHttp(transport, { ...DEFAULT_HTTP_POLICY, minIntervalMs: 0 });
    const src = new GenericApiSource(
      profile,
      (k) => (k === 'clientSecret' ? new Secret('made-up') : null),
      http,
    );
    await src.fetchPage('vendors', { cursor: null, since: null });
    await src.fetchPage('vendors', { cursor: null, since: null });
    expect(tokens).toBe(1);
    rejectNext = true;
    await src.fetchPage('vendors', { cursor: null, since: null });
    expect(tokens).toBe(2);
    expect(seen).toEqual(['Bearer t1', 'Bearer t1', 'Bearer t1', 'Bearer t2']);
  });
});

describe('mapping records', () => {
  const po: EntityConfig = {
    path: '/po',
    query: {},
    listPath: '',
    paging: { style: 'none' },
    linesPath: 'items',
    fields: {
      id: { path: 'id' },
      poNumber: { path: 'po_no' },
      vendorRef: { path: 'vendor.code' },
      poDate: { path: 'po_date' },
      status: { path: 'status' },
    },
    lineFields: {
      itemRef: { path: 'item_code' },
      qtyMilli: { path: 'qty' },
      unitPricePaise: { path: 'rate' },
      gstRateBp: { path: 'gst' },
    },
  };
  const scope = { query: {} };

  it('converts amounts, quantities, rates, dates and status words', () => {
    const r = mapRecord(
      'purchase_orders',
      {
        id: 101,
        po_no: 'PO/26-27/0042',
        vendor: { code: 'SUP-7' },
        po_date: '22-09-2026',
        status: 'Released',
        items: [{ item_code: 'ITM-1', qty: '1,250.5', rate: '84.75', gst: 18 }],
      },
      po,
      scope,
    );
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.record.erpId).toBe('101');
    expect(r.record.doc).toEqual({
      poNumber: 'PO/26-27/0042',
      vendorRef: 'SUP-7',
      poDate: '2026-09-22',
      status: 'open',
      lines: [
        {
          lineRef: null,
          lineNo: null,
          itemRef: 'ITM-1',
          qtyMilli: 1_250_500,
          unitPricePaise: 8475,
          gstRateBp: 1800,
        },
      ],
    });
  });

  it('keeps a record out when a required field is missing or unreadable, naming fields only', () => {
    const r = mapRecord(
      'purchase_orders',
      {
        id: 'P1',
        po_no: 'PO-1',
        vendor: { code: 'S' },
        po_date: '31-02-2026',
        items: [{ item_code: 'I', qty: 'lots', rate: 10 }],
      },
      po,
      scope,
    );
    expect(r).toEqual({
      ok: false,
      invalid: { erpId: 'P1', fields: ['poDate', 'lines.1.qtyMilli'] },
    });
    expect(JSON.stringify(r)).not.toContain('lots');
  });

  it('drops records of another company or outlet', () => {
    const r = mapRecord(
      'vendors',
      { vendor_id: 'V1', vendor_name: 'X', company: 'C2' },
      vendorConfig({ style: 'none' }),
      { query: {}, companyPath: 'company', companyValue: 'C1' },
    );
    expect(r).toEqual({ ok: 'out_of_scope' });
  });

  it('hashes the record as received, so an unchanged record is recognised', () => {
    const cfg = vendorConfig({ style: 'none' });
    const a = mapRecord('vendors', { vendor_id: 'V1', vendor_name: 'X', b: 1, a: 2 }, cfg, scope);
    const b = mapRecord('vendors', { a: 2, b: 1, vendor_name: 'X', vendor_id: 'V1' }, cfg, scope);
    const c = mapRecord('vendors', { vendor_id: 'V1', vendor_name: 'Y', a: 2, b: 1 }, cfg, scope);
    if (a.ok !== true || b.ok !== true || c.ok !== true) throw new Error('expected mapped');
    expect(a.record.rawHash).toBe(b.record.rawHash);
    expect(a.record.rawHash).not.toBe(c.record.rawHash);
  });

  it('hashes the mapping too, so a changed mapping is not mistaken for an unchanged record', () => {
    const cfg = vendorConfig({ style: 'none' });
    const raw = { vendor_id: 'V1', vendor_name: 'X', alias: 'Y' };
    const a = mapRecord('vendors', raw, cfg, scope);
    const b = mapRecord(
      'vendors',
      raw,
      { ...cfg, fields: { ...cfg.fields, name: { path: 'alias' } } },
      scope,
    );
    if (a.ok !== true || b.ok !== true) throw new Error('expected mapped');
    expect(a.record.rawHash).not.toBe(b.record.rawHash);
  });

  it('reads Indian date styles and refuses impossible ones', () => {
    expect(parseDate('2026-09-22')).toBe('2026-09-22');
    expect(parseDate('2026-09-22T10:30:00Z')).toBe('2026-09-22');
    expect(parseDate('22/09/2026')).toBe('2026-09-22');
    expect(parseDate('22.09.2026')).toBe('2026-09-22');
    expect(parseDate('22-Sep-2026')).toBe('2026-09-22');
    expect(parseDate('22 September 2026')).toBe('2026-09-22');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('09/22/2026')).toBeNull();
    expect(parseDate(20260922)).toBeNull();
  });

  it('converts without guessing', () => {
    expect(convert('18', 'percent')).toBe(1800);
    expect(convert(1800, 'basis_points')).toBe(1800);
    expect(convert('12.5', 'paise')).toBeNull();
    expect(convert('-5', 'rupees')).toBeNull();
    expect(convert('', 'text')).toBeUndefined();
    expect(convert('maybe', 'status')).toBeNull();
  });

  it('reports what must still be mapped', () => {
    expect(missingRequired('purchase_orders', { ...po, fields: { id: { path: 'id' } } })).toEqual([
      'poNumber',
      'vendorRef',
      'poDate',
    ]);
    expect(missingRequired('purchase_orders', po)).toEqual([]);
  });
});
