import { ErpAuthenticationError, ErpConfigurationError } from '@veyra/erp-connector';
import type { Secret } from '../secret';
import type { HttpRequest, ResilientHttp } from './http';
import { getPath, mapRecord, type MapResult } from './mapping';
import { AUTH_SECRET, type Entity, type EntityConfig, type Profile } from './profile';

/**
 * Reads one ERP's records over its REST/JSON API, page by page, through a connection profile.
 * Generic: everything ERP-specific is in the profile (paths, paging, field mapping) and the
 * stored credentials. Requests go through ResilientHttp (retries, pacing, address safety).
 */

/** The ERP's answer is not shaped the way the profile says (its API changed, or a wrong path). */
export class ResponseShapeError extends Error {
  constructor(
    readonly entity: Entity,
    readonly problem: 'not_json' | 'no_list' | 'bad_next_link',
  ) {
    super(
      problem === 'not_json'
        ? 'The ERP did not answer with JSON.'
        : problem === 'no_list'
          ? 'The ERP’s answer no longer has the list of records where the mapping expects it.'
          : 'The ERP’s next-page link points somewhere else.',
    );
    this.name = 'ResponseShapeError';
  }
}

export interface PageRequest {
  /** Where to continue: null for the first page; otherwise what the previous page returned. */
  cursor: string | null;
  /** Only records changed since this time (ISO), when the entity is set up for it. */
  since: string | null;
}

export interface Page {
  results: MapResult[];
  /** How many records the ERP returned on this page (mapped or not). */
  received: number;
  /** Where the next page starts; null when this was the last page. */
  next: string | null;
}

/** Secrets by key (apiKey, password, token, clientSecret); null when not stored. */
export type SecretLookup = (key: string) => Secret | null;

export class GenericApiSource {
  #token: { value: string; until: number } | null = null;

  constructor(
    readonly profile: Profile,
    private readonly secrets: SecretLookup,
    private readonly http: ResilientHttp,
    private readonly now: () => number = Date.now,
  ) {}

  entityConfig(entity: Entity): EntityConfig {
    const c = this.profile.entities[entity];
    if (!c) throw new ErpConfigurationError();
    return c;
  }

  /** Whether this record type is set up to read only what changed. */
  incremental(entity: Entity): boolean {
    return this.profile.entities[entity]?.incremental !== undefined;
  }

  async fetchPage(entity: Entity, req: PageRequest, signal?: AbortSignal): Promise<Page> {
    const config = this.entityConfig(entity);
    const url = this.#pageUrl(entity, config, req);
    const body = await this.#getJson(url, entity, signal);
    const list = getPath(body, config.listPath || undefined);
    if (!Array.isArray(list)) throw new ResponseShapeError(entity, 'no_list');
    const results = list.map((raw) => mapRecord(entity, raw, config, this.profile.scope));
    return {
      results,
      received: list.length,
      next: this.#next(entity, config, req, body, list.length),
    };
  }

  /** The first page of a record type, raw, for the mapping screen (never stored). */
  async sample(entity: Entity, signal?: AbortSignal): Promise<unknown[]> {
    const config = this.entityConfig(entity);
    const body = await this.#getJson(
      this.#pageUrl(entity, config, { cursor: null, since: null }),
      entity,
      signal,
    );
    const list = getPath(body, config.listPath || undefined);
    if (!Array.isArray(list)) throw new ResponseShapeError(entity, 'no_list');
    return list.slice(0, 20);
  }

  /** The raw first answer, for finding where the list is before a mapping exists. */
  async probe(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = this.#join(path);
    for (const [k, v] of Object.entries(this.profile.scope.query)) url.searchParams.set(k, v);
    return this.#getJson(url, 'vendors', signal);
  }

  #join(path: string): URL {
    const base = this.profile.baseUrl.replace(/\/+$/, '');
    return new URL(base + path);
  }

  #pageUrl(entity: Entity, config: EntityConfig, req: PageRequest): URL {
    const p = config.paging;
    if (p.style === 'link' && req.cursor) {
      const next = new URL(req.cursor, this.#join(config.path));
      // A next link may only stay on the ERP's own address.
      if (next.origin !== this.#join(config.path).origin)
        throw new ResponseShapeError(entity, 'bad_next_link');
      return next;
    }
    const url = this.#join(config.path);
    for (const [k, v] of Object.entries(this.profile.scope.query)) url.searchParams.set(k, v);
    for (const [k, v] of Object.entries(config.query)) url.searchParams.set(k, v);
    if (config.incremental && req.since) {
      const t = new Date(req.since);
      const value =
        config.incremental.format === 'iso'
          ? t.toISOString()
          : config.incremental.format === 'date'
            ? t.toISOString().slice(0, 10)
            : String(Math.floor(t.getTime() / 1000));
      url.searchParams.set(config.incremental.param, value);
    }
    switch (p.style) {
      case 'page':
        url.searchParams.set(p.pageParam, req.cursor ?? String(p.firstPage));
        url.searchParams.set(p.sizeParam, String(p.size));
        break;
      case 'offset':
        url.searchParams.set(p.offsetParam, req.cursor ?? '0');
        url.searchParams.set(p.limitParam, String(p.limit));
        break;
      case 'cursor':
        if (req.cursor) url.searchParams.set(p.cursorParam, req.cursor);
        if (p.sizeParam && p.size) url.searchParams.set(p.sizeParam, String(p.size));
        break;
      default:
        break;
    }
    return url;
  }

  #next(
    entity: Entity,
    config: EntityConfig,
    req: PageRequest,
    body: unknown,
    received: number,
  ): string | null {
    const p = config.paging;
    switch (p.style) {
      case 'none':
        return null;
      case 'page':
        return received < p.size ? null : String(Number(req.cursor ?? p.firstPage) + 1);
      case 'offset':
        return received < p.limit ? null : String(Number(req.cursor ?? 0) + received);
      case 'cursor': {
        const next = getPath(body, p.nextCursorPath);
        const s = typeof next === 'number' ? String(next) : typeof next === 'string' ? next : '';
        return s && s !== req.cursor ? s : null;
      }
      case 'link': {
        const next = getPath(body, p.nextLinkPath);
        if (typeof next !== 'string' || next === '') return null;
        const url = new URL(next, this.#join(config.path));
        if (url.origin !== this.#join(config.path).origin)
          throw new ResponseShapeError(entity, 'bad_next_link');
        return url.href === req.cursor ? null : url.href;
      }
    }
  }

  async #getJson(url: URL, entity: Entity, signal?: AbortSignal): Promise<unknown> {
    const send = async () =>
      this.http.send({ method: 'GET', url, headers: await this.#authHeaders(signal) }, signal);
    let res;
    try {
      res = await send();
    } catch (e) {
      // An OAuth token can expire early: fetch a new one once, then give up.
      if (
        !(e instanceof ErpAuthenticationError) ||
        this.profile.auth.type !== 'oauth2_client_credentials'
      )
        throw e;
      this.#token = null;
      res = await send();
    }
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new ResponseShapeError(entity, 'not_json');
    }
  }

  #secret(): string {
    const spec = AUTH_SECRET[this.profile.auth.type];
    if (!spec) return '';
    const s = this.secrets(spec.key);
    // No stored secret: the connection cannot log in until someone saves it.
    if (!s) throw new ErpAuthenticationError();
    return s.reveal();
  }

  async #authHeaders(signal?: AbortSignal): Promise<Record<string, string>> {
    const a = this.profile.auth;
    switch (a.type) {
      case 'none':
        return {};
      case 'api_key':
        return { [a.headerName]: this.#secret() };
      case 'basic':
        return {
          authorization: `Basic ${Buffer.from(`${a.username}:${this.#secret()}`).toString('base64')}`,
        };
      case 'bearer':
        return { authorization: `Bearer ${this.#secret()}` };
      case 'oauth2_client_credentials':
        return { authorization: `Bearer ${await this.#oauthToken(signal)}` };
    }
  }

  async #oauthToken(signal?: AbortSignal): Promise<string> {
    const a = this.profile.auth;
    if (a.type !== 'oauth2_client_credentials') throw new ErpConfigurationError();
    if (this.#token && this.#token.until > this.now()) return this.#token.value;
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: a.clientId,
      client_secret: this.#secret(),
    });
    if (a.scope) form.set('scope', a.scope);
    const req: HttpRequest = {
      method: 'POST',
      url: new URL(a.tokenUrl),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    };
    const res = await this.http.send(req, signal);
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = JSON.parse(res.body) as typeof body;
    } catch {
      throw new ErpAuthenticationError();
    }
    if (typeof body.access_token !== 'string' || body.access_token === '')
      throw new ErpAuthenticationError();
    const life = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 300;
    // Renew a minute early so a token never expires mid-sync.
    this.#token = { value: body.access_token, until: this.now() + Math.max(30, life - 60) * 1000 };
    return body.access_token;
  }
}
