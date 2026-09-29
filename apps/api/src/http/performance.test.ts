import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScenario, scenarioById } from '@veyra/extractor';
import { createTestApp } from '../test/app';
import { DEMO_NOW } from '../test/harness';

/**
 * Phase 7: response compression is on for lists, never for documents, spreadsheets or the sign-in
 * responses (which carry the CSRF token), and never removes a security header.
 */
type App = Awaited<ReturnType<typeof createTestApp>>;
let app: App | undefined;
let dir = '';
afterEach(async () => {
  await app?.close(0);
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function withInvoices(): Promise<App> {
  dir = mkdtempSync(join(tmpdir(), 'veyra-perf-'));
  app = await createTestApp({
    dataDir: dir,
    demo: true,
    allowFixtureExtractor: true,
    nodeEnv: 'test',
    clock: () => DEMO_NOW,
  });
  for (const id of ['S01', 'S02', 'S03', 'S08', 'S09', 'S10']) {
    const s = scenarioById(id);
    if (!s) throw new Error(id);
    const boundary = '----veyra-perf';
    await app.server.inject({
      method: 'POST',
      url: '/api/v1/documents',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${s.file}"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        Buffer.from(renderScenario(s)),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  }
  await app.runner.drain();
  return app;
}

describe('response compression (Phase 7)', () => {
  it('compresses JSON lists, keeps the content identical and every security header', async () => {
    const a = await withInvoices();
    const plain = await a.server.inject({ method: 'GET', url: '/api/v1/invoices' });
    const gz = await a.server.inject({
      method: 'GET',
      url: '/api/v1/invoices',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toEqual(plain.json());
    for (const h of [
      'content-security-policy',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
      'x-request-id',
    ])
      expect(gz.headers[h], h).toBeDefined();
    expect(gz.headers['cache-control']).toBe('no-store');
  });

  it('never compresses documents, spreadsheets or the sign-in responses', async () => {
    const a = await withInvoices();
    const enc = { 'accept-encoding': 'gzip, br' };
    const inbox = (await a.server.inject({ method: 'GET', url: '/api/v1/invoices' })).json<{
      invoices: { documentId: string }[];
    }>();
    const doc = inbox.invoices[0]?.documentId ?? '';
    const pdf = await a.server.inject({
      method: 'GET',
      url: `/api/v1/documents/${doc}/file`,
      headers: enc,
    });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-encoding']).toBeUndefined();
    const xlsx = await a.server.inject({
      method: 'GET',
      url: '/api/v1/exports/invoices.xlsx',
      headers: enc,
    });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.headers['content-encoding']).toBeUndefined();
    for (const [method, url] of [
      ['GET', '/api/v1/auth/session'],
      ['POST', '/api/v1/auth/demo'],
    ] as const) {
      const r = await a.server.inject({
        method,
        url,
        headers: enc,
        ...(method === 'POST' ? { payload: { pin: '0000' } } : {}),
      });
      expect(r.headers['content-encoding'], url).toBeUndefined();
    }
  });
});
