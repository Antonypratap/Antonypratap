import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiInstanceSchema } from '@veyra/shared';
import { webSecurityHeaders } from '@veyra/web/security-headers';
import { loadConfig, loadSiteConfig, type ConfigError } from '../config';
import { createTestApp } from '../test/app';
import { buildSiteServer } from './site-server';
import { loadWebDist, WebDistError, type WebFiles } from './web-static';

/**
 * Production setup: a client instance serves its own web app and /api/v1 from one origin; the
 * public website (VEYRA_SITE_ONLY=true) serves the web app and nothing of the application.
 */
let dist: string;
let web: WebFiles;
const INDEX = '<!doctype html><title>Veyrafy</title><div id="root"></div>';
const SCRIPT = 'console.log("app")';

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'veyra-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX);
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), SCRIPT);
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dist, 'notes.bin'), 'not a web file type: never served');
  web = await loadWebDist(dist);
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const PAGE_HEADERS = webSecurityHeaders();

describe('web build loading', () => {
  it('reads the build into memory; only known web file types; index.html required', async () => {
    expect([...web.files.keys()].sort()).toEqual([
      '/assets/index-abc123.js',
      '/favicon.svg',
      '/index.html',
    ]);
    const empty = mkdtempSync(join(tmpdir(), 'veyra-empty-'));
    await expect(loadWebDist(empty)).rejects.toBeInstanceOf(WebDistError);
    await expect(loadWebDist(join(empty, 'missing'))).rejects.toBeInstanceOf(WebDistError);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('client instance: the web app and /api/v1 on one origin', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'veyra-web-'));
    app = await createTestApp({
      dataDir: dir,
      demo: false,
      allowFixtureExtractor: false,
      nodeEnv: 'test',
      environment: 'staging',
      organizationName: 'Northwind Traders',
      web,
      release: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    });
  });
  afterAll(async () => {
    await app.close(0);
    rmSync(dir, { recursive: true, force: true });
  });
  const get = (url: string, method: 'GET' | 'HEAD' = 'GET') => app.anonymous({ method, url });

  it('serves the app with the web security headers; revalidated, never cached stale', async () => {
    for (const url of ['/', '/index.html']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body).toBe(INDEX);
      expect(res.headers['cache-control']).toBe('no-cache');
      for (const [name, value] of Object.entries(PAGE_HEADERS))
        expect(res.headers[name.toLowerCase()], name).toBe(value);
    }
    expect((await get('/', 'HEAD')).statusCode).toBe(200);
  });

  it('app routes fall back to the app (SPA); the path decides the screen in the browser', async () => {
    for (const url of ['/app', '/app/inbox', '/app/invoices/01K00000000000000000000000', '/ops']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(INDEX);
    }
  });

  it('content-hashed assets are immutable; a missing asset is a 404, never the app', async () => {
    const js = await get('/assets/index-abc123.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(js.body).toBe(SCRIPT);
    for (const url of ['/assets/index-old.js', '/robots.txt', '/notes.bin']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('<div id="root">');
    }
  });

  it('path traversal is refused over real HTTP: nothing outside the build is ever read', async () => {
    // Real requests, not inject(): an HTTP client can send dot segments and encodings verbatim.
    await app.server.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.server.address() as { port: number }).port;
    for (const path of [
      '/../../package.json',
      '/assets/../../package.json',
      '/..%2f..%2fpackage.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/%2e%2e%2f%2e%2e%2fsrc%2fmain.ts',
      '/assets/..%5c..%5cpackage.json',
      '/assets/index-abc123.js%00.html',
      '/%E0%A4%A',
      '//etc/passwd',
    ]) {
      const res = await rawGet(port, path);
      expect([400, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain('"name"');
      expect(res.body, path).not.toContain('root:');
      expect(res.body, path).not.toContain('<div id="root">');
    }
  });

  it('/api/* stays the API: unknown API paths are JSON 404s, never the app', async () => {
    for (const url of ['/api', '/api/v1/nope', '/api/v2/invoices']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    // API responses keep the API's own strict policy (not the page policy) and are never cached.
    const session = await get('/api/v1/auth/session');
    expect(session.headers['content-security-policy']).toContain("default-src 'none'");
    expect(session.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/v1/instance: exactly the organization name and demo flag, public', async () => {
    const res = await get('/api/v1/instance');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Northwind Traders', demo: false });
    expect(ApiInstanceSchema.safeParse({ ...res.json<object>(), database: 'x' }).success).toBe(
      false,
    );
  });

  it('GET /api/v1/health shows the deployed commit, and nothing secret', async () => {
    const health = (await get('/api/v1/health')).json();
    expect(health).toEqual({
      ok: true,
      demo: false,
      version: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    });
  });
});

describe('the public website (VEYRA_SITE_ONLY): static only', () => {
  it('serves the website with the web headers and HSTS; no application routes exist', async () => {
    const site = await buildSiteServer({ web, hsts: true, release: 'abc1234' });
    const home = await site.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toBe(INDEX);
    expect(home.headers['content-security-policy']).toBe(PAGE_HEADERS['Content-Security-Policy']);
    expect(home.headers['x-frame-options']).toBe('DENY');
    expect(home.headers['strict-transport-security']).toBe('max-age=31536000');
    expect((await site.inject({ method: 'GET', url: '/api/v1/health' })).json()).toEqual({
      ok: true,
      site: true,
      version: 'abc1234',
    });
    expect((await site.inject({ method: 'GET', url: '/api/v1/health/live' })).statusCode).toBe(200);
    // No instance here: the web app shows "This Veyrafy address isn't set up." for a client
    // address that lands on the website service.
    for (const [method, url] of [
      ['GET', '/api/v1/instance'],
      ['GET', '/api/v1/auth/session'],
      ['POST', '/api/v1/auth/login'],
      ['POST', '/api/v1/auth/demo'],
      ['GET', '/api/v1/invoices'],
    ] as const) {
      const res = await site.inject({ method, url });
      expect(res.statusCode, url).toBe(404);
    }
    await site.close();
  });

  it('starts as a real process without DATABASE_URL or any application setting', async () => {
    const port = await freePort();
    const main = fileURLToPath(new URL('../main.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', main], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        VEYRA_ENV: 'production',
        VEYRA_SITE_ONLY: 'true',
        VEYRA_WEB_DIST: dist,
        VEYRA_API_HOST: '127.0.0.1',
        PORT: String(port),
        RAILWAY_GIT_COMMIT_SHA: 'deadbeef1234',
        VEYRA_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    try {
      const health = await waitFor(`http://127.0.0.1:${port}/api/v1/health`);
      expect(health).toEqual({ ok: true, site: true, version: 'deadbeef1234' });
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(await page.text()).toBe(INDEX);
      expect(output).toContain('Veyrafy website started');
      // Nothing of the application ran: no database, migrations, storage, ERP or worker.
      expect(output).not.toMatch(/database|migrat|storage|ERP|worker|Veyrafy API started/i);
    } finally {
      child.kill('SIGTERM');
    }
  }, 30_000);
});

describe('configuration', () => {
  const base = {
    NODE_ENV: 'production',
    VEYRA_ENV: 'production',
    VEYRA_DATA_DIR: '/var/lib/veyra',
    DATABASE_URL: 'postgres://veyra@db.example.com/veyra?sslmode=require',
    VEYRA_ERP: 'fake',
    VEYRA_ORGANIZATION_NAME: 'Northwind Traders',
    VEYRA_PUBLIC_ORIGIN: 'https://northwind.veyrafy.com',
  };
  const problems = (env: Record<string, string>, load = loadConfig): string[] => {
    try {
      load(env, { dataDir: '/tmp' });
      return [];
    } catch (e) {
      return (e as ConfigError).problems;
    }
  };

  it('VEYRA_WEB_DIST: absolute outside development; unset means /api only', () => {
    expect(loadConfig(base, { dataDir: '/tmp' }).web.dist).toBeNull();
    expect(
      loadConfig({ ...base, VEYRA_WEB_DIST: '/srv/veyra/apps/web/dist' }, { dataDir: '/tmp' }).web,
    ).toEqual({
      dist: '/srv/veyra/apps/web/dist',
    });
    expect(problems({ ...base, VEYRA_WEB_DIST: 'apps/web/dist' })).toContain(
      'VEYRA_WEB_DIST must be an absolute path outside development',
    );
  });

  it('VEYRA_SITE_ONLY: the application refuses to start as the website', () => {
    expect(problems({ ...base, VEYRA_SITE_ONLY: 'true' }).join()).toMatch(
      /VEYRA_SITE_ONLY is true: this service is the public website/,
    );
    expect(problems({ ...base, VEYRA_SITE_ONLY: 'false' })).toEqual([]);
  });

  it('the website needs only its build: no DATABASE_URL, ERP, organization or origin', () => {
    const site = loadSiteConfig({
      NODE_ENV: 'production',
      VEYRA_ENV: 'production',
      VEYRA_SITE_ONLY: 'true',
      VEYRA_WEB_DIST: '/srv/veyra/apps/web/dist',
      PORT: '8080',
    });
    expect(site).toMatchObject({
      environment: 'production',
      port: 8080,
      hsts: true,
      release: null,
    });
    expect(() => loadSiteConfig({ NODE_ENV: 'production', VEYRA_ENV: 'production' })).toThrow(
      /VEYRA_WEB_DIST is required/,
    );
  });

  it('the deployed commit: a plain commit hash only; anything else is unknown, never echoed', () => {
    const release = (sha: string) =>
      loadConfig({ ...base, RAILWAY_GIT_COMMIT_SHA: sha }, { dataDir: '/tmp' }).release;
    expect(release('A1B2C3D4E5F6A7B8C9D0A1B2C3D4E5F6A7B8C9D0')).toBe(
      'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    );
    expect(release('abc1234')).toBe('abc1234');
    expect(release('main; rm -rf /')).toBeNull();
    expect(release('postgres://secret@x')).toBeNull();
  });
});

/** A GET with the path sent exactly as given (no client-side normalization). */
async function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      s.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject()));
    });
  });
}

async function waitFor(url: string): Promise<unknown> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${url} did not answer`);
}
