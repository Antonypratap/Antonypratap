import { useEffect, useState } from 'react';
import type { ApiErpConnectionState, ApiErpInspect, ApiErpIssue, ApiErpTest } from '@veyra/shared';
import {
  AUTH_LABEL,
  AUTH_SECRET,
  AUTH_TYPES,
  ENTITIES,
  ENTITY_LABEL,
  FIELDS,
  SAMPLE_ERP,
  type AuthType,
  type Entity,
  type EntityConfig,
  type Paging,
  type Profile,
} from '@veyra/shared/erp-profile';
import { StatusPill } from '../../design-system';
import { api, ApiError } from '../api/client';
import { formatDateTime, formatRelative } from '../format';
import { navigate } from '../router';
import { useProductData } from '../state/data';
import base from './ErpData.module.css';
import styles from './ErpConnection.module.css';

/**
 * Connecting the business's own ERP over its API (docs/ERP-API.md): its address and login, which
 * of its fields hold what (the server proposes, the admin confirms), a check, a sync, and the
 * choice to check invoices against it. Read-only: Veyrafy never writes to the ERP and never pays.
 * Credentials are typed in and never shown again.
 */

const message = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;

const ISSUE_TEXT: Record<ApiErpIssue['kind'], string> = {
  invalid: 'Left out: fields missing or unreadable',
  incomplete: 'Not usable for checks yet: missing',
  orphan: 'Points to a record that is not in the ERP',
  conflict: 'Same number or GSTIN as another record',
  shape_changed: "The ERP's answer no longer looks as mapped",
};

const STATUS_TEXT: Record<string, string> = {
  complete: 'Complete',
  untrusted: 'Too many unreadable records',
  shape_changed: 'Answer changed shape',
  failed: 'Failed',
  pending: 'Not read',
};

const PAGING_LABEL: Record<Paging['style'], string> = {
  none: 'One answer holds everything',
  page: 'Page number and page size',
  offset: 'Offset and limit',
  cursor: 'A cursor for the next page',
  link: 'A link to the next page',
};

function emptyProfile(): Profile {
  return {
    version: 1,
    name: 'Our ERP',
    baseUrl: 'https://',
    auth: { type: 'api_key', headerName: 'X-Api-Key' },
    scope: { query: {} },
    entities: {},
  };
}

function authOf(type: AuthType, prev: Profile['auth']): Profile['auth'] {
  switch (type) {
    case 'none':
      return { type };
    case 'api_key':
      return { type, headerName: prev.type === 'api_key' ? prev.headerName : 'X-Api-Key' };
    case 'basic':
      return { type, username: prev.type === 'basic' ? prev.username : '' };
    case 'bearer':
      return { type };
    case 'oauth2_client_credentials':
      return prev.type === type ? prev : { type, tokenUrl: 'https://', clientId: '' };
  }
}

function pagingOf(style: Paging['style']): Paging {
  switch (style) {
    case 'none':
      return { style };
    case 'page':
      return { style, pageParam: 'page', sizeParam: 'per_page', size: 100, firstPage: 1 };
    case 'offset':
      return { style, offsetParam: 'offset', limitParam: 'limit', limit: 100 };
    case 'cursor':
      return {
        style,
        cursorParam: 'cursor',
        nextCursorPath: 'next_cursor',
        sizeParam: 'limit',
        size: 100,
      };
    case 'link':
      return { style, nextLinkPath: 'next' };
  }
}

const fieldLabel = (entity: Entity, key: string) => {
  const [part, k] = key.startsWith('lines.')
    ? ['line', key.split('.').pop() ?? key]
    : ['header', key];
  const spec = FIELDS[entity][part as 'header' | 'line'].find((f) => f.key === k);
  return spec?.label ?? (k === 'linesPath' ? 'where the lines are' : k);
};

export function ErpConnection() {
  const { refresh } = useProductData();
  const [state, setState] = useState<ApiErpConnectionState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [test, setTest] = useState<ApiErpTest | null>(null);
  const [entity, setEntity] = useState<Entity>('vendors');
  const [inspect, setInspect] = useState<ApiErpInspect | null>(null);
  const [samples, setSamples] = useState<{ key: string; title: string }[]>([]);

  const load = () =>
    api.erpApi
      .state()
      .then((s) => {
        setState(s);
        setDraft((d) => d ?? (s.connection?.profile as Profile | undefined) ?? null);
      })
      .catch((e: unknown) => setLoadError(message(e, 'The connection could not be loaded.')));

  useEffect(() => {
    void load();
  }, []);
  // While a sync runs, follow it.
  useEffect(() => {
    if (!state?.syncing) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [state?.syncing]);
  const sampleActive =
    state?.sampleErp === true &&
    state.connection?.active === true &&
    (state.connection.profile as Profile | undefined)?.baseUrl === SAMPLE_ERP.baseUrl;
  useEffect(() => {
    if (sampleActive)
      void api.erpApi
        .sampleInvoices()
        .then(setSamples)
        .catch(() => setSamples([]));
  }, [sampleActive]);

  const run = async (what: string, job: () => Promise<void>) => {
    setBusy(what);
    setProblem(null);
    try {
      await job();
    } catch (e) {
      setProblem(message(e, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <p className={base.problem}>{loadError}</p>;
  if (!state) return <p className={base.note}>Loading…</p>;
  if (!state.available && !state.connection)
    return (
      <section className={base.section}>
        <h2 className={base.title}>Connect your ERP</h2>
        <p className={base.note}>Connecting your ERP is not included in your plan.</p>
      </section>
    );

  const saved = (state.connection?.profile as Profile | undefined) ?? null;
  const active = state.connection?.active === true;
  const lastRun = state.runs[0] ?? null;
  const p = draft ?? emptyProfile();
  const setP = (next: Profile) => setDraft(next);
  const secretSpec = AUTH_SECRET[p.auth.type];

  const saveConnection = () =>
    run('save', async () => {
      let s = await api.erpApi.saveProfile(p);
      if (secret) s = await api.erpApi.saveSecret(secret);
      setSecret('');
      setState(s);
    });

  const connectSample = () =>
    run('sample', async () => {
      const preset = (await api.erpApi.preset('sample')) as Profile;
      setDraft(preset);
      await api.erpApi.saveProfile(preset);
      const s = await api.erpApi.saveSecret(SAMPLE_ERP.apiKey);
      setSecret('');
      setState(s);
    });

  const config: EntityConfig =
    p.entities[entity] ??
    ({
      path: '/',
      query: {},
      listPath: '',
      paging: { style: 'none' },
      fields: {},
      lineFields: {},
    } as EntityConfig);
  const setConfig = (c: EntityConfig) => setP({ ...p, entities: { ...p.entities, [entity]: c } });

  const look = () =>
    run('inspect', async () => {
      const r = await api.erpApi.inspect(entity, config);
      setInspect(r);
      setConfig({
        ...config,
        listPath: r.listPath ?? '',
        linesPath: config.linesPath || r.linesPath || '',
        fields: Object.keys(config.fields).length ? config.fields : r.proposed.fields,
        lineFields: Object.keys(config.lineFields).length
          ? config.lineFields
          : r.proposed.lineFields,
      });
    });

  return (
    <div className={styles.wrap}>
      {/* Where things stand */}
      <section className={styles.status} aria-label="Your ERP connection">
        <div className={styles.statusHead}>
          <div>
            <p className={styles.eyebrow}>Your ERP</p>
            <h2 className={styles.name}>{saved ? saved.name : 'Not connected'}</h2>
          </div>
          <StatusPill status={active && state.freshness.fresh ? 'handled' : 'attention'}>
            {!saved
              ? 'Not connected'
              : active
                ? state.freshness.fresh
                  ? 'Used for invoice checks'
                  : 'Records out of date'
                : 'Not used for checks yet'}
          </StatusPill>
        </div>
        {saved && (
          <p className={base.note}>
            {state.freshness.syncedAt ? (
              <>
                Records synced{' '}
                <time
                  dateTime={state.freshness.syncedAt}
                  title={formatDateTime(state.freshness.syncedAt)}
                >
                  {formatRelative(state.freshness.syncedAt, new Date())}
                </time>
                {': '}
                {Object.entries(state.records)
                  .filter(([, n]) => n > 0)
                  .map(([e, n]) => `${String(n)} ${ENTITY_LABEL[e as Entity].toLowerCase()}`)
                  .join(', ')}
                .
              </>
            ) : (
              'Not synced yet.'
            )}{' '}
            Veyrafy reads your ERP and never changes it. It never makes payments.
          </p>
        )}
        {active && !state.freshness.fresh && (
          <p className={base.problem}>
            New invoices wait until the records are up to date. Sync now, or check the issues below.
          </p>
        )}
      </section>

      {problem && (
        <p className={base.problem} role="alert">
          {problem}
        </p>
      )}

      {state.canManage && (
        <section className={base.section} aria-labelledby="erp-connect">
          <h2 id="erp-connect" className={base.title}>
            1. Address and login
          </h2>
          {state.sampleErp && (
            <div className={styles.sample}>
              <p>
                <strong>Try it with the Example ERP.</strong> A made-up business behind its own API,
                built into Veyrafy. Its demo key ({SAMPLE_ERP.apiKey}) opens only made-up records.
              </p>
              <button
                type="button"
                className={base.button}
                disabled={busy !== null}
                onClick={() => void connectSample()}
              >
                {busy === 'sample' ? 'Connecting…' : 'Use the Example ERP'}
              </button>
            </div>
          )}
          <div className={styles.form}>
            <label className={styles.field}>
              <span>Name</span>
              <input
                className={styles.input}
                value={p.name}
                onChange={(e) => setP({ ...p, name: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>Address of its API</span>
              <input
                className={styles.input}
                value={p.baseUrl}
                placeholder="https://erp.example.com/api"
                onChange={(e) => setP({ ...p, baseUrl: e.target.value.trim() })}
              />
            </label>
            <label className={styles.field}>
              <span>Login method</span>
              <select
                className={styles.input}
                value={p.auth.type}
                onChange={(e) => setP({ ...p, auth: authOf(e.target.value as AuthType, p.auth) })}
              >
                {AUTH_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {AUTH_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            {p.auth.type === 'api_key' && (
              <label className={styles.field}>
                <span>Header name</span>
                <input
                  className={styles.input}
                  value={p.auth.headerName}
                  onChange={(e) =>
                    setP({ ...p, auth: { type: 'api_key', headerName: e.target.value.trim() } })
                  }
                />
              </label>
            )}
            {p.auth.type === 'basic' && (
              <label className={styles.field}>
                <span>Username</span>
                <input
                  className={styles.input}
                  autoComplete="off"
                  value={p.auth.username}
                  onChange={(e) =>
                    setP({ ...p, auth: { type: 'basic', username: e.target.value } })
                  }
                />
              </label>
            )}
            {p.auth.type === 'oauth2_client_credentials' && (
              <>
                <label className={styles.field}>
                  <span>Token address</span>
                  <input
                    className={styles.input}
                    value={p.auth.tokenUrl}
                    onChange={(e) =>
                      setP({
                        ...p,
                        auth: {
                          ...(p.auth as Extract<
                            Profile['auth'],
                            { type: 'oauth2_client_credentials' }
                          >),
                          tokenUrl: e.target.value.trim(),
                        },
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  <span>Client ID</span>
                  <input
                    className={styles.input}
                    autoComplete="off"
                    value={p.auth.clientId}
                    onChange={(e) =>
                      setP({
                        ...p,
                        auth: {
                          ...(p.auth as Extract<
                            Profile['auth'],
                            { type: 'oauth2_client_credentials' }
                          >),
                          clientId: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
            {secretSpec && (
              <label className={styles.field}>
                <span>
                  {secretSpec.label}
                  {state.secret?.savedAt
                    ? ` (saved ${formatDateTime(state.secret.savedAt)}; type to replace)`
                    : ''}
                </span>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  placeholder={state.secret?.savedAt ? '••••••••' : ''}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
            )}
          </div>
          {!state.canStoreSecrets && (
            <p className={base.note}>
              Credentials cannot be saved on this Veyrafy yet (its secrets key is not set). Ask
              whoever set up Veyrafy.
            </p>
          )}
          <p className={base.note}>
            Use a read-only login made for Veyrafy in your ERP. Credentials are stored encrypted and
            never shown again.
          </p>
          <div className={base.actions}>
            <button
              type="button"
              className={base.button}
              disabled={busy !== null}
              onClick={() => void saveConnection()}
            >
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </section>
      )}

      {state.canManage && saved && (
        <section className={base.section} aria-labelledby="erp-map">
          <h2 id="erp-map" className={base.title}>
            2. Which fields hold what
          </h2>
          <div className={styles.tabs} role="tablist" aria-label="Record types">
            {ENTITIES.map((e) => (
              <button
                key={e}
                type="button"
                role="tab"
                aria-selected={e === entity}
                className={styles.tab}
                data-set={p.entities[e] ? 'true' : 'false'}
                onClick={() => {
                  setEntity(e);
                  setInspect(null);
                }}
              >
                {ENTITY_LABEL[e]}
              </button>
            ))}
          </div>
          <div className={styles.form}>
            <label className={styles.field}>
              <span>Path</span>
              <input
                className={styles.input}
                value={config.path}
                placeholder="/api/v1/suppliers"
                onChange={(e) => setConfig({ ...config, path: e.target.value.trim() || '/' })}
              />
            </label>
            <label className={styles.field}>
              <span>Pages</span>
              <select
                className={styles.input}
                value={config.paging.style}
                onChange={(e) =>
                  setConfig({ ...config, paging: pagingOf(e.target.value as Paging['style']) })
                }
              >
                {(Object.keys(PAGING_LABEL) as Paging['style'][]).map((s) => (
                  <option key={s} value={s}>
                    {PAGING_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={base.actions}>
            <button
              type="button"
              className={base.quiet}
              disabled={busy !== null}
              onClick={() => void look()}
            >
              {busy === 'inspect' ? 'Reading…' : 'Read the first page'}
            </button>
          </div>
          {inspect && (
            <>
              <p className={base.note}>
                {inspect.listPath === null
                  ? 'No list of records was found in the answer. Check the path.'
                  : `${String(inspect.received)} records on the first page${inspect.listPath ? ` (under "${inspect.listPath}")` : ''}.`}
              </p>
              <MappingTable
                entity={entity}
                part="header"
                found={inspect.fields}
                mapping={config.fields}
                onChange={(fields) => setConfig({ ...config, fields })}
              />
              {FIELDS[entity].line.length > 0 && (
                <>
                  <p className={base.stepTitle}>
                    Lines{inspect.linesPath ? ` (under "${inspect.linesPath}")` : ''}
                  </p>
                  <MappingTable
                    entity={entity}
                    part="line"
                    found={inspect.lineFields}
                    mapping={config.lineFields}
                    onChange={(lineFields) => setConfig({ ...config, lineFields })}
                  />
                </>
              )}
              <Preview entity={entity} preview={inspect.preview} />
            </>
          )}
          <div className={base.actions}>
            <button
              type="button"
              className={base.button}
              disabled={busy !== null || !p.entities[entity]}
              onClick={() =>
                void run('map', async () => {
                  setState(await api.erpApi.saveProfile(p));
                })
              }
            >
              {busy === 'map' ? 'Saving…' : `Save ${ENTITY_LABEL[entity].toLowerCase()}`}
            </button>
          </div>
        </section>
      )}

      {saved && (
        <section className={base.section} aria-labelledby="erp-sync">
          <h2 id="erp-sync" className={base.title}>
            {state.canManage ? '3. Check and sync' : 'Sync'}
          </h2>
          {state.canManage && (
            <div className={base.actions}>
              <button
                type="button"
                className={base.quiet}
                disabled={busy !== null}
                onClick={() => void run('check', async () => setTest(await api.erpApi.check()))}
              >
                {busy === 'check' ? 'Checking…' : 'Test the connection'}
              </button>
              <button
                type="button"
                className={base.button}
                disabled={busy !== null || state.syncing}
                onClick={() =>
                  void run('sync', async () => {
                    setState(await api.erpApi.sync());
                    refresh();
                  })
                }
              >
                {busy === 'sync' || state.syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          )}
          {test && (
            <ul className={styles.results} aria-label="Connection test">
              {test.entities.map((e) => (
                <li key={e.entity} data-ok={e.ok}>
                  <span aria-hidden="true">{e.ok ? '✓' : '✗'}</span> {ENTITY_LABEL[e.entity]}:{' '}
                  {e.error
                    ? e.error.message
                    : e.missing.length
                      ? `still to map: ${e.missing.map((m) => fieldLabel(e.entity, m)).join(', ')}`
                      : `${String(e.received)} read, ${String(e.mapped)} usable${e.invalid ? `, ${String(e.invalid)} unreadable` : ''}`}
                </li>
              ))}
            </ul>
          )}
          {lastRun && (
            <>
              <p className={base.note}>
                Last sync{' '}
                <time dateTime={lastRun.startedAt} title={formatDateTime(lastRun.startedAt)}>
                  {formatRelative(lastRun.startedAt, new Date())}
                </time>
                : {lastRun.status === 'succeeded' ? 'complete' : lastRun.status}
                {lastRun.errorMessage ? `. ${lastRun.errorMessage}` : '.'}
              </p>
              <div className={base.scroll}>
                <table className={base.table}>
                  <thead>
                    <tr>
                      <th>Records</th>
                      <th className={base.num}>Read</th>
                      <th className={base.num}>Changed</th>
                      <th className={base.num}>Unreadable</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(lastRun.counts).map(([e, c]) => (
                      <tr key={e}>
                        <td>{ENTITY_LABEL[e as Entity]}</td>
                        <td className={base.num}>{c.received}</td>
                        <td className={base.num}>{c.changed}</td>
                        <td className={base.num}>{c.invalid}</td>
                        <td>{STATUS_TEXT[c.status] ?? c.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {state.issues.length > 0 && (
            <details className={styles.issues}>
              <summary>
                {state.issues.length} record{state.issues.length === 1 ? '' : 's'} Veyrafy will not
                rely on
              </summary>
              <ul>
                {state.issues.slice(0, 50).map((i, n) => (
                  <li key={n}>
                    {ENTITY_LABEL[i.entity]} {i.erpId ?? ''}: {ISSUE_TEXT[i.kind]}
                    {i.kind === 'invalid' || i.kind === 'incomplete'
                      ? ` (${i.detail.map((d) => fieldLabel(i.entity, d)).join(', ')})`
                      : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {state.canManage && saved && (
        <section className={base.section} aria-labelledby="erp-use">
          <h2 id="erp-use" className={base.title}>
            4. Use for invoice checks
          </h2>
          <p className={base.note}>
            {active
              ? 'Invoices are checked against these records. Switching back uses the built-in records again; nothing is lost either way.'
              : 'When the records are synced completely, invoices can be checked against them. Nothing missing is ever treated as found.'}
          </p>
          <div className={base.actions}>
            {active ? (
              <button
                type="button"
                className={base.quiet}
                disabled={busy !== null}
                onClick={() => void run('use', async () => setState(await api.erpApi.deactivate()))}
              >
                Switch back to built-in records
              </button>
            ) : (
              <button
                type="button"
                className={base.button}
                disabled={busy !== null || !state.freshness.fresh}
                onClick={() => void run('use', async () => setState(await api.erpApi.activate()))}
              >
                Use for invoice checks
              </button>
            )}
          </div>
        </section>
      )}

      {sampleActive && samples.length > 0 && (
        <section className={base.section} aria-labelledby="erp-samples">
          <h2 id="erp-samples" className={base.title}>
            Try a sample invoice
          </h2>
          <p className={base.note}>
            Made-up invoices addressed to the Example ERP's business, checked against its records.
          </p>
          <div className={styles.samples}>
            {samples.map((s) => (
              <button
                key={s.key}
                type="button"
                className={base.quiet}
                disabled={busy !== null}
                onClick={() =>
                  void run(`sample:${s.key}`, async () => {
                    const r = await api.erpApi.trySample(s.key);
                    refresh();
                    navigate({ name: 'invoice', id: r.invoiceId });
                  })
                }
              >
                {s.title}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MappingTable({
  entity,
  part,
  found,
  mapping,
  onChange,
}: {
  entity: Entity;
  part: 'header' | 'line';
  found: ApiErpInspect['fields'];
  mapping: Record<string, { path: string; convert?: never } | { path: string }>;
  onChange: (m: Record<string, { path: string }>) => void;
}) {
  return (
    <div className={base.scroll}>
      <table className={`${base.table} ${styles.mapping}`}>
        <thead>
          <tr>
            <th>In Veyrafy</th>
            <th>Field in your ERP</th>
          </tr>
        </thead>
        <tbody>
          {FIELDS[entity][part].map((spec) => {
            const current = mapping[spec.key]?.path ?? '';
            return (
              <tr key={spec.key} data-missing={spec.required && !current ? 'true' : 'false'}>
                <td>
                  {spec.label}
                  {spec.required ? <span className={styles.required}> (needed)</span> : null}
                </td>
                <td>
                  <select
                    className={styles.input}
                    aria-label={spec.label}
                    value={current}
                    onChange={(e) => {
                      const next: Record<string, { path: string }> = {};
                      for (const [k, v] of Object.entries(mapping))
                        if (k !== spec.key) next[k] = { path: v.path };
                      if (e.target.value) next[spec.key] = { path: e.target.value };
                      onChange(next);
                    }}
                  >
                    <option value="">Not in the ERP</option>
                    {found.map((f) => (
                      <option key={f.path} value={f.path}>
                        {f.path}
                        {f.samples[0] ? ` (e.g. ${f.samples[0]})` : ''}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Preview({ entity, preview }: { entity: Entity; preview: ApiErpInspect['preview'] }) {
  if (preview.length === 0) return null;
  const ok = preview.filter((r) => r.ok).length;
  return (
    <div className={base.preview} data-state={ok === preview.length ? 'ok' : 'errors'}>
      <p className={base.previewTitle}>
        {ok} of {preview.length} sample records read completely
      </p>
      <ul className={styles.results}>
        {preview.map((r, i) => (
          <li key={i} data-ok={r.ok}>
            <span aria-hidden="true">{r.ok ? '✓' : '✗'}</span> {r.erpId ?? 'A record'}
            {r.ok ? '' : `: ${(r.fields ?? []).map((f) => fieldLabel(entity, f)).join(', ')}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
