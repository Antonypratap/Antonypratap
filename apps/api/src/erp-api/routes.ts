import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ApiErpConnectionStateSchema,
  ApiErpInspectSchema,
  ApiErpTestSchema,
  can,
  type ApiErpConnectionState,
  type Permission,
} from '@veyra/shared';
import { VeyraError, type Veyra } from '../workflow/veyra';
import { inspectAnswer, previewRecords, proposeFields } from './inspect';
import { PRESETS } from './presets';
import {
  ENTITIES,
  EntityConfigSchema,
  ProfileSchema,
  missingRequired,
  type Entity,
  type Profile,
} from './profile';
import { SAMPLE_BASE_URL } from './sample/api';
import { SAMPLE_INVOICES } from './sample/data';
import { ErpApi, ErpSwitchBusyError, connectionErrorText } from './service';
import { SecretsKeyError } from './secrets';

/**
 * Routes for the ERP API connection (docs/ERP-API.md). Seeing it needs erp.view; changing it
 * (profile, credentials, sync, use for checks) needs erp.manage (admins) and the plan's
 * `erp.api_connection`. Credentials go in and never come out. Every change is audited.
 */

const DOCS = new URL('../../../../fixtures/documents/', import.meta.url);

export function registerErpApiRoutes(
  app: FastifyInstance,
  deps: {
    veyra: Veyra;
    api: ErpApi;
    sampleErp: boolean;
    may: (p: Permission) => { config: { access: Permission } };
    actorOf: (req: FastifyRequest) => string;
  },
): void {
  const { veyra, api, may, actorOf } = deps;
  const MANAGE = may('erp.manage');

  const available = () =>
    veyra.entitlements
      .require(veyra.organizationId, 'erp.api_connection')
      .then(() => true)
      .catch(() => false);
  const requireAvailable = async () => {
    if (!(await available()))
      throw new VeyraError('FORBIDDEN', 'Connecting your ERP is not included in your plan.');
  };
  const checkProfile = (profile: Profile) => {
    if (profile.baseUrl === SAMPLE_BASE_URL) {
      if (!deps.sampleErp)
        throw new VeyraError('INVALID_INPUT', 'The Example ERP is not available on this Veyrafy.');
      return;
    }
    let url: URL;
    try {
      url = new URL(profile.baseUrl);
    } catch {
      throw new VeyraError(
        'INVALID_INPUT',
        'Enter the address of your ERP’s API, starting with https://',
      );
    }
    if (url.username || url.password || url.search || url.hash)
      throw new VeyraError(
        'INVALID_INPUT',
        'Enter only the address (no login details, ? or # in it). Credentials go in their own field.',
      );
  };
  const userError = (e: unknown): never => {
    if (e instanceof VeyraError) throw e;
    if (e instanceof SecretsKeyError) throw new VeyraError('INVALID_INPUT', e.message);
    if (e instanceof z.ZodError) throw e;
    const { message } = connectionErrorText(e);
    throw new VeyraError('INVALID_INPUT', message);
  };

  const state = async (req: FastifyRequest): Promise<ApiErpConnectionState> => {
    const current = await api.profile();
    const runs = await api.lastRuns(5);
    return ApiErpConnectionStateSchema.parse({
      available: await available(),
      canManage: req.auth ? can(req.auth.user.role, 'erp.manage') : false,
      canStoreSecrets: api.canStoreSecrets,
      sampleErp: deps.sampleErp,
      presets: PRESETS.filter((p) => !p.sampleOnly || deps.sampleErp).map(({ id, name }) => ({
        id,
        name,
      })),
      connection: current,
      secret: await api.secretStatus(),
      freshness: await api.freshness(),
      syncing: api.syncing,
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        counts: JSON.parse(r.countsJson) as unknown,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
      })),
      records: current ? await api.recordCounts() : {},
      issues: current ? (await api.issues()).slice(0, 200) : [],
    });
  };

  app.get('/api/v1/erp/api-connection', may('erp.view'), async (req) => state(req));

  app.get('/api/v1/erp/api-connection/presets/:id', MANAGE, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const preset = PRESETS.find((p) => p.id === id && (!p.sampleOnly || deps.sampleErp));
    if (!preset) throw new VeyraError('NOT_FOUND', 'There is no such preset.');
    return preset.profile;
  });

  app.put('/api/v1/erp/api-connection', MANAGE, async (req) => {
    await requireAvailable();
    const profile = ProfileSchema.parse(req.body ?? {});
    checkProfile(profile);
    const saved = await api.saveProfile(profile, actorOf(req));
    // Pointed at another ERP or company: checks use the built-in records again, so invoices held
    // for the ERP's records are checked now.
    if (saved.reset && saved.wasActive) await veyra.releaseHeld();
    return state(req);
  });

  app.put('/api/v1/erp/api-connection/secret', MANAGE, async (req) => {
    await requireAvailable();
    const { value } = z.object({ value: z.string().min(1).max(4096) }).parse(req.body ?? {});
    await api.saveSecret(value, actorOf(req)).catch(userError);
    return state(req);
  });

  /** One record type's first answer: where the list is, its fields, a proposed mapping, a preview. */
  app.post('/api/v1/erp/api-connection/inspect', MANAGE, async (req) => {
    await requireAvailable();
    const body = z
      .object({
        entity: z.enum(ENTITIES),
        config: EntityConfigSchema.partial({ fields: true, lineFields: true, paging: true }),
      })
      .parse(req.body ?? {});
    const current = (await api.profile())?.profile;
    if (!current) throw new VeyraError('INVALID_INPUT', 'Save the address and login first.');
    const source = await api.source(current).catch(userError);
    let answer: unknown;
    try {
      const url =
        body.config.path +
        (Object.keys(body.config.query).length
          ? `?${new URLSearchParams(body.config.query).toString()}`
          : '');
      answer = await source.probe(url);
    } catch (e) {
      return userError(e);
    }
    const found = inspectAnswer(
      answer,
      body.config.listPath === undefined ? undefined : body.config.listPath || '',
    );
    const entity: Entity = body.entity;
    const fields =
      body.config.fields && Object.keys(body.config.fields).length
        ? body.config.fields
        : proposeFields(entity, found.fields, 'header');
    const lineFields =
      body.config.lineFields && Object.keys(body.config.lineFields).length
        ? body.config.lineFields
        : proposeFields(entity, found.lineFields, 'line');
    const config = EntityConfigSchema.parse({
      paging: { style: 'none' },
      ...body.config,
      listPath: found.listPath ?? '',
      linesPath: body.config.linesPath || found.linesPath || '',
      fields,
      lineFields,
    });
    return ApiErpInspectSchema.parse({
      entity,
      ...found,
      proposed: {
        fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { path: v.path }])),
        lineFields: Object.fromEntries(
          Object.entries(lineFields).map(([k, v]) => [k, { path: v.path }]),
        ),
      },
      preview: previewRecords(entity, answer, config, current.scope),
    });
  });

  /** Reads the first page of every set-up record type through the saved mapping. */
  app.post('/api/v1/erp/api-connection/check', MANAGE, async () => {
    await requireAvailable();
    const current = (await api.profile())?.profile;
    if (!current) throw new VeyraError('INVALID_INPUT', 'Save the address and login first.');
    const source = await api.source(current).catch(userError);
    const entities = [];
    for (const entity of ENTITIES) {
      const config = current.entities[entity];
      if (!config) continue;
      const missing = missingRequired(entity, config);
      try {
        const page = await source.fetchPage(entity, { cursor: null, since: null });
        const mapped = page.results.filter((r) => r.ok === true).length;
        entities.push({
          entity,
          ok:
            missing.length === 0 &&
            page.received > 0 &&
            mapped === page.results.filter((r) => r.ok !== 'out_of_scope').length,
          received: page.received,
          mapped,
          invalid: page.results.filter((r) => r.ok === false).length,
          missing,
          error: null,
        });
      } catch (e) {
        entities.push({
          entity,
          ok: false,
          received: 0,
          mapped: 0,
          invalid: 0,
          missing,
          error: connectionErrorText(e),
        });
      }
    }
    return ApiErpTestSchema.parse({
      ok: entities.length > 0 && entities.every((e) => e.ok),
      entities,
    });
  });

  /** Sync now. Answers when done, or after a few seconds while it continues (the screen polls). */
  app.post('/api/v1/erp/sync', MANAGE, async (req, reply) => {
    await requireAvailable();
    if (!(await api.profile()))
      throw new VeyraError('INVALID_INPUT', 'Set up the connection first.');
    const run = api.sync('manual', actorOf(req));
    const done = await Promise.race([
      run.then(
        () => true,
        (e: unknown) => {
          if (ErpApi.isBusy(e)) throw new VeyraError('CONFLICT', 'A sync is already running.');
          return true;
        },
      ),
      new Promise<false>((r) => setTimeout(() => r(false), 4000)),
    ]);
    run.catch(() => undefined);
    return reply.status(done ? 200 : 202).send(await state(req));
  });

  app.post('/api/v1/erp/api-connection/activate', MANAGE, async (req) => {
    await requireAvailable();
    try {
      await api.activate(actorOf(req));
    } catch (e) {
      if (e instanceof ErpSwitchBusyError) throw new VeyraError('CONFLICT', e.message);
      throw new VeyraError(
        'INVALID_STATE',
        'Sync every record type completely first: invoices are checked only against up-to-date records.',
      );
    }
    // Invoices waiting to be checked are checked against the ERP's records now.
    await veyra.recheckAfterErpSync(true);
    return state(req);
  });

  app.post('/api/v1/erp/api-connection/deactivate', MANAGE, async (req) => {
    await api.deactivate(actorOf(req)).catch((e: unknown) => {
      if (e instanceof ErpSwitchBusyError) throw new VeyraError('CONFLICT', e.message);
      throw e;
    });
    await veyra.releaseHeld();
    return state(req);
  });

  // ── The Sample ERP's invoices (for showing the whole story; only where it is on) ──
  if (deps.sampleErp) {
    app.get('/api/v1/erp/sample-invoices', may('erp.view'), async () =>
      SAMPLE_INVOICES.map(({ key, title }) => ({ key, title })),
    );
    app.post('/api/v1/erp/sample-invoices/:key', may('documents.upload'), async (req, reply) => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      const sample = SAMPLE_INVOICES.find((s) => s.key === key);
      if (!sample) throw new VeyraError('NOT_FOUND', 'There is no such sample invoice.');
      const active = (await api.profile())?.profile.baseUrl === SAMPLE_BASE_URL && api.isActive();
      if (!active)
        throw new VeyraError(
          'INVALID_STATE',
          'Connect the Example ERP and use it for checks first.',
        );
      const bytes = new Uint8Array(readFileSync(new URL(sample.file, DOCS)));
      try {
        const r = await veyra.upload({ filename: sample.file, bytes }, actorOf(req));
        return reply.status(201).send({ invoiceId: r.invoiceId, existing: false });
      } catch (error) {
        const invoiceId = error instanceof VeyraError ? error.details.invoiceId : null;
        if (
          error instanceof VeyraError &&
          error.code === 'DUPLICATE_UPLOAD' &&
          typeof invoiceId === 'string'
        )
          return reply.status(200).send({ invoiceId, existing: true });
        throw error;
      }
    });
  }
}
