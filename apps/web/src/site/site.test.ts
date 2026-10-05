import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { demoEntryHref } from '../access/demoAccess';
import {
  CHALLENGE_ADDRESS,
  CHALLENGE_PATH,
  DEMO_ADDRESS,
  challengeEntryHref,
  classifyHost,
  clientAddress,
  clientSlugFrom,
  isValidClientSlug,
  type HostKind,
} from './host';
import { checkInstance } from './instance';
import { sitePageOf } from './SitePages';
import { Surface } from './Surface';

/** Production setup: which address shows what (docs/RUNBOOK-RAILWAY.md). */
describe('hostname classification', () => {
  it('the website, development, client addresses and unknown names', () => {
    const kind = (h: string) => classifyHost(h);
    expect(kind('veyrafy.com')).toEqual({ kind: 'website' });
    expect(kind('www.veyrafy.com')).toEqual({ kind: 'website' });
    expect(kind('VEYRAFY.COM.')).toEqual({ kind: 'website' });
    expect(kind('localhost')).toEqual({ kind: 'development' });
    expect(kind('127.0.0.1')).toEqual({ kind: 'development' });
    expect(kind('demo.veyrafy.com')).toEqual({ kind: 'client', slug: 'demo' });
    expect(kind('toit.veyrafy.com')).toEqual({ kind: 'client', slug: 'toit' });
    // Any valid client address, with no list in the code: new clients need no website release.
    expect(kind('northwind-traders.veyrafy.com')).toEqual({
      kind: 'client',
      slug: 'northwind-traders',
    });
    // A platform address (the service's own Railway domain): confirmed by its /api/v1/instance.
    expect(kind('veyrafy-toit.up.railway.app')).toEqual({ kind: 'client', slug: null });
    // Not a valid client address: shown "not set up", never the website or an app.
    for (const h of [
      'a.b.veyrafy.com',
      'api.veyrafy.com',
      'admin.veyrafy.com',
      '-x.veyrafy.com',
      'x--y.veyrafy.com',
      'x.veyrafy.com',
    ])
      expect(kind(h), h).toEqual({ kind: 'unknown' });
  });

  it('client slugs: strict; typed addresses are reduced to the slug, never guessed', () => {
    for (const ok of ['toit', 'demo', 'ab', 'northwind-traders', 'a1b2'])
      expect(isValidClientSlug(ok), ok).toBe(true);
    for (const bad of [
      '',
      'a',
      'Toit',
      'to it',
      'to_it',
      '-toit',
      'toit-',
      'to--it',
      'www',
      'api',
      'x'.repeat(41),
    ])
      expect(isValidClientSlug(bad), bad).toBe(false);
    expect(clientSlugFrom('  Toit ')).toBe('toit');
    expect(clientSlugFrom('toit.veyrafy.com')).toBe('toit');
    expect(clientSlugFrom('https://toit.veyrafy.com/app/inbox')).toBe('toit');
    for (const bad of [
      '',
      'toit.example.com',
      'javascript:alert(1)',
      '../toit',
      'toit/../admin',
      'a b',
    ])
      expect(clientSlugFrom(bad), bad).toBeNull();
    expect(clientAddress('toit')).toBe('https://toit.veyrafy.com/');
  });

  it('"See Veyrafy in action": the demo instance, except in development', () => {
    expect(demoEntryHref('veyrafy.com')).toBe(DEMO_ADDRESS);
    expect(demoEntryHref('www.veyrafy.com')).toBe('https://demo.veyrafy.com/');
    expect(demoEntryHref('localhost')).toBe('#/app/inbox');
    // The homepage's challenge button goes straight into the challenge (it runs on the demo).
    expect(challengeEntryHref('veyrafy.com')).toBe(CHALLENGE_ADDRESS);
    expect(CHALLENGE_ADDRESS).toBe('https://demo.veyrafy.com/5-invoice-challenge');
    expect(challengeEntryHref('demo.veyrafy.com')).toBe(CHALLENGE_PATH);
    expect(challengeEntryHref('localhost')).toBe(CHALLENGE_PATH);
  });
});

describe('instance check (GET /api/v1/instance)', () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status });
  it('ready only with an exact, strict answer', async () => {
    expect(await checkInstance(answer(200, { name: 'Toit', demo: false }))).toEqual({
      status: 'ready',
      instance: { name: 'Toit', demo: false },
    });
    // Extra fields, wrong types or a non-JSON page are not a Veyrafy instance.
    expect(await checkInstance(answer(200, { name: 'Toit', demo: false, x: 1 }))).toEqual({
      status: 'missing',
    });
    expect(await checkInstance(answer(200, { name: 1 }))).toEqual({ status: 'missing' });
    expect(
      await checkInstance(async () => new Response('<!doctype html>', { status: 200 })),
    ).toEqual({ status: 'missing' });
  });
  it('404 is "not set up"; 5xx and network failures are "unavailable"', async () => {
    expect(await checkInstance(answer(404, {}))).toEqual({ status: 'missing' });
    expect(await checkInstance(answer(503, {}))).toEqual({ status: 'unavailable' });
    expect(
      await checkInstance(async () => {
        throw new TypeError('network');
      }),
    ).toEqual({ status: 'unavailable' });
  });
});

describe('what each address renders', () => {
  const render = (host: HostKind, hash = '') =>
    renderToStaticMarkup(createElement(Surface, { host, hash }));
  const WEBSITE: HostKind = { kind: 'website' };
  const SIGN_IN = /Sign in to Veyrafy|Open demo|id="[^"]*-pin"|type="password"/;

  it('the website: marketing, Client login, Request access, demo link', () => {
    const home = render(WEBSITE);
    expect(home).toContain('Check every invoice against your accounting records');
    expect(home).toContain('href="#/login"');
    expect(home).toContain('Client login');
    expect(home).toContain('href="#/request-access"');
    expect(home).toContain(`href="${DEMO_ADDRESS}"`);
    expect(home).not.toMatch(SIGN_IN);
  });

  it('the website never renders the application or a sign-in form, whatever the link', () => {
    for (const hash of [
      '#/app',
      '#/app/inbox',
      '#/app/invoices/01K00000000000000000000000',
      '#/ops',
    ]) {
      const html = render(WEBSITE, hash);
      expect(html, hash).toContain('Client login');
      expect(html, hash).not.toMatch(SIGN_IN);
      expect(html, hash).not.toContain('Check every invoice against your accounting records');
    }
  });

  it('Client login and Request access pages', () => {
    const login = render(WEBSITE, '#/login');
    expect(login).toContain('Your company’s Veyrafy address');
    expect(login).toContain('.veyrafy.com');
    expect(login).not.toMatch(/toit/i); // no client list is published
    const access = render(WEBSITE, '#/request-access');
    expect(access).toContain(
      'Veyrafy is invite-only while we onboard our first clients. To get started, call',
    );
    expect(access).toContain('+91 98800 00990');
    expect(access).toContain('href="tel:+919880000990"');
  });

  it('a client address never renders the marketing site', () => {
    for (const hash of ['', '#top', '#product', '#/login'])
      expect(render({ kind: 'client', slug: 'toit' }, hash), hash).not.toContain(
        'Check every invoice against your accounting records',
      );
  });

  it('an unknown address: a controlled "not set up" page, nothing else', () => {
    const html = render({ kind: 'unknown' });
    expect(html).toContain('This Veyrafy address isn’t set up.');
    expect(html).not.toContain('Check every invoice against your accounting records');
    expect(html).not.toMatch(SIGN_IN);
  });

  it('website pages by hash', () => {
    expect(sitePageOf('#/login')).toBe('login');
    expect(sitePageOf('#/login/')).toBe('login');
    expect(sitePageOf('#/request-access')).toBe('request-access');
    expect(sitePageOf('#/app/inbox')).toBeNull();
    expect(sitePageOf('')).toBeNull();
  });
});
