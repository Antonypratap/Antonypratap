import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  CAPABILITIES,
  capabilityDefinition,
  formatBytes,
  formatEntitlement,
  type ApiOpsCommercial,
  type ApiOpsEntitlement,
  type ApiOpsPlan,
  type CapabilityDefinition,
  type CommercialStatus,
  type EntitlementValue,
} from '@veyra/shared';
import { signOut, useSession } from '../access/session';
import { Icon, Logo, type IconName } from '../design-system';
import { notify } from '../feedback/toasts';
import { ApiError } from '../product/api/client';
import { hrefFor, type OpsSection, type Route } from '../product/router';
import { opsApi } from './api';
import styles from './Ops.module.css';

/**
 * Veyrafy Operations (Phase 8A): the Veyrafy team's control plane, separate from the customer
 * application. The server allows it to VEYRA_ADMIN only; this page only presents what the server
 * returns. Commercial changes always carry a reason and are audited by the server.
 */
type OpsRoute = Extract<Route, { name: 'ops' }>;

const NAV: { section: OpsSection; label: string; icon: IconName }[] = [
  { section: 'overview', label: 'Overview', icon: 'systems' },
  { section: 'organizations', label: 'Organizations', icon: 'person' },
  { section: 'commercial', label: 'Commercial', icon: 'rules' },
  { section: 'plans', label: 'Plans', icon: 'document' },
  { section: 'capabilities', label: 'Capabilities', icon: 'check' },
  { section: 'usage', label: 'Usage', icon: 'spark' },
  { section: 'erp', label: 'ERP Connections', icon: 'database' },
  { section: 'processing', label: 'Processing', icon: 'inbox' },
  { section: 'exceptions', label: 'Exceptions', icon: 'attention' },
  { section: 'system', label: 'System Health', icon: 'systems' },
  { section: 'security', label: 'Security', icon: 'audit' },
  { section: 'audit', label: 'Audit', icon: 'audit' },
  { section: 'settings', label: 'Settings', icon: 'menu' },
];

const href = (section: OpsSection, id: string | null = null) =>
  hrefFor({ name: 'ops', section, id });

/** Loads once per key; `reload` fetches again (after a change). */
function useLoad<T>(load: () => Promise<T>, key: string) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({
    key,
    data: null,
    error: null,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ key, data, error: null }),
      (e: unknown) =>
        live &&
        setState({
          key,
          data: null,
          error: e instanceof ApiError ? e.message : 'This could not be loaded.',
        }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key identifies the request
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return state.key === key ? { ...state, reload } : { data: null, error: null, reload };
}

export function OpsApp({ route }: { route: OpsRoute }) {
  const session = useSession();
  const me = session.status === 'signedIn' ? session.session : null;
  if (!me?.permissions.includes('ops.view'))
    return (
      <div className={styles.denied}>
        <Logo />
        <h1>Access denied</h1>
        <p>Veyrafy Operations is for the Veyrafy team. Your account is a customer account.</p>
        <a href={hrefFor({ name: 'inbox' })}>Go to your inbox</a>
      </div>
    );
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <a href={href('overview')} className={styles.brand} aria-label="Veyrafy Operations">
          <Logo />
          <span className={styles.brandTag}>Operations</span>
        </a>
        <nav aria-label="Veyrafy Operations">
          <ul className={styles.nav}>
            {NAV.map((n) => (
              <li key={n.section}>
                <a
                  href={href(n.section)}
                  className={styles.navItem}
                  aria-current={route.section === n.section ? 'page' : undefined}
                >
                  <Icon name={n.icon} size={16} />
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.foot}>
          <span className={styles.who}>{me.user.name}</span>
          <button type="button" className={styles.linkButton} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className={styles.main} key={`${route.section}/${route.id ?? ''}`}>
        <Section route={route} />
      </main>
    </div>
  );
}

function Section({ route }: { route: OpsRoute }) {
  switch (route.section) {
    case 'overview':
      return <Overview />;
    case 'organizations':
      return <Organizations />;
    case 'commercial':
      return route.id ? <OrganizationCommercial id={route.id} /> : <CommercialOverview />;
    case 'plans':
      return <Plans />;
    case 'capabilities':
      return <Capabilities />;
    case 'usage':
      return <Usage />;
    case 'erp':
      return <Loaded title="ERP Connections" load={opsApi.erp} name="erp" />;
    case 'processing':
      return <Processing />;
    case 'exceptions':
      return <Exceptions />;
    case 'system':
      return <Loaded title="System Health" load={opsApi.system} name="system" />;
    case 'security':
      return <Security />;
    case 'audit':
      return <CommercialAudit />;
    case 'settings':
      return <Loaded title="Settings" load={opsApi.settings} name="settings" />;
  }
}

function Page({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.title}>{title}</h1>
        {sub && <p className={styles.sub}>{sub}</p>}
      </header>
      {children}
    </div>
  );
}

function State({ error }: { error: string | null }) {
  return error ? (
    <p className={styles.problem} role="alert">
      {error}
    </p>
  ) : (
    <p className={styles.muted}>Loading…</p>
  );
}

function Tile({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {note && <span className={styles.muted}>{note}</span>}
    </div>
  );
}

const def = (key: string): CapabilityDefinition =>
  capabilityDefinition(key) ?? {
    key,
    name: key,
    description: '',
    category: 'account',
    type: 'BOOLEAN',
    customerVisible: false,
    version: 1,
  };
const fmt = (key: string, v: EntitlementValue | null) => formatEntitlement(def(key), v);
const at = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

// ── Overview and commercial overview ───────────────────────────────────────

function Overview() {
  const { data, error } = useLoad(opsApi.overview, 'overview');
  if (!data)
    return (
      <Page title="Overview">
        <State error={error} />
      </Page>
    );
  const o = data as {
    organizations: number;
    byPlan: Record<string, number>;
    trial: number;
    activeOverrides: number;
    expiringWithin30Days: number;
    nearOrOverLimit: { capability: string; used: number; limit: number }[];
    health: { status: string } | null;
    environment: string;
  };
  return (
    <Page title="Overview" sub={`Environment: ${o.environment}. One organization per deployment.`}>
      <div className={styles.tiles}>
        <Tile label="Organizations" value={o.organizations} />
        {Object.entries(o.byPlan).map(([plan, n]) => (
          <Tile key={plan} label={`On ${plan}`} value={n} />
        ))}
        <Tile label="Trial" value={o.trial} />
        <Tile label="Active overrides" value={o.activeOverrides} />
        <Tile label="Overrides expiring in 30 days" value={o.expiringWithin30Days} />
        <Tile
          label="Near or over a limit"
          value={o.nearOrOverLimit.length}
          note="80% or more used"
        />
        <Tile label="System health" value={o.health?.status ?? '—'} />
        <Tile label="Billing" value="Not configured" />
      </div>
    </Page>
  );
}

function CommercialOverview() {
  const { data, error } = useLoad(opsApi.organizations, 'orgs');
  return (
    <Page
      title="Commercial"
      sub="Plans, entitlements and overrides per organization. Billing: Not configured."
    >
      <CommercialTiles />
      {data ? <OrganizationTable rows={data} /> : <State error={error} />}
    </Page>
  );
}

function CommercialTiles() {
  const { data } = useLoad(opsApi.overview, 'overview');
  if (!data) return null;
  const o = data as {
    organizations: number;
    byPlan: Record<string, number>;
    trial: number;
    activeOverrides: number;
    expiringWithin30Days: number;
    nearOrOverLimit: unknown[];
  };
  return (
    <div className={styles.tiles}>
      <Tile label="Organizations" value={o.organizations} />
      {Object.entries(o.byPlan).map(([plan, n]) => (
        <Tile key={plan} label={`On ${plan}`} value={n} />
      ))}
      <Tile label="Trial" value={o.trial} />
      <Tile
        label="Overrides"
        value={o.activeOverrides}
        note={`${o.expiringWithin30Days} expiring this month`}
      />
      <Tile label="Near or over a limit" value={o.nearOrOverLimit.length} />
    </div>
  );
}

function Organizations() {
  const { data, error } = useLoad(opsApi.organizations, 'orgs');
  return (
    <Page title="Organizations" sub="The customer organizations this deployment serves.">
      {data ? <OrganizationTable rows={data} /> : <State error={error} />}
    </Page>
  );
}

function OrganizationTable({ rows }: { rows: Awaited<ReturnType<typeof opsApi.organizations>> }) {
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Organization</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Plan since</th>
            <th>Billing</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td>{o.name}</td>
              <td>{o.plan?.name ?? '—'}</td>
              <td>{o.commercialStatus}</td>
              <td>{at(o.planAssignedAt)}</td>
              <td>Not configured</td>
              <td>
                <a className={styles.link} href={href('commercial', o.id)}>
                  Commercial
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── One organization's commercial state: the "why" ─────────────────────────

function OrganizationCommercial({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => opsApi.commercial(id), `commercial:${id}`);
  const plans = useLoad(opsApi.plans, 'plans').data;
  const [editing, setEditing] = useState<string | null>(null);
  if (!data)
    return (
      <Page title="Commercial">
        <State error={error} />
      </Page>
    );
  const o = data.organization;
  return (
    <Page
      title={o.name}
      sub={`Plan: ${o.plan?.name ?? 'none'} · Status: ${o.commercialStatus} · Billing: Not configured`}
    >
      <AssignPlan org={data} plans={plans ?? []} onDone={reload} />
      <section aria-labelledby="effective-title">
        <h2 id="effective-title" className={styles.h2}>
          Effective capabilities
        </h2>
        <p className={styles.muted}>
          Precedence: an active organization override, else the plan, else unavailable. Safety rules
          (validation, security, the ERP&rsquo;s own capabilities) always apply.
        </p>
        <div className={styles.scroll}>
          <table className={styles.table} data-testid="effective">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Plan default</th>
                <th>Organization override</th>
                <th>Effective</th>
                <th>Usage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.entitlements.map((e) => (
                <EntitlementRow
                  key={e.capability}
                  e={e}
                  orgId={o.id}
                  editing={editing === e.capability}
                  onEdit={() => setEditing(editing === e.capability ? null : e.capability)}
                  onDone={() => {
                    setEditing(null);
                    reload();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="history-title">
        <h2 id="history-title" className={styles.h2}>
          Commercial history
        </h2>
        <EventTable organizationId={o.id} key={JSON.stringify(data.entitlements)} />
      </section>
    </Page>
  );
}

function EntitlementRow({
  e,
  orgId,
  editing,
  onEdit,
  onDone,
}: {
  e: ApiOpsEntitlement;
  orgId: string;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const override = e.override;
  return (
    <>
      <tr data-capability={e.capability}>
        <td>
          <span className={styles.strong}>{e.name}</span>
          <span className={styles.key}>{e.capability}</span>
        </td>
        <td>{fmt(e.capability, e.plan)}</td>
        <td>
          {override ? (
            <>
              {fmt(e.capability, override.value)}
              <span className={styles.muted}>
                {override.expired
                  ? ` · expired ${at(override.expiresAt)}`
                  : override.expiresAt
                    ? ` · until ${at(override.expiresAt)}`
                    : ''}
                {` · ${override.reason}`}
              </span>
            </>
          ) : (
            '—'
          )}
        </td>
        <td>
          <span className={styles.effective} data-source={e.source}>
            {fmt(e.capability, e.effective)}
          </span>
          <span className={styles.muted}> ({e.source === 'none' ? 'not entitled' : e.source})</span>
        </td>
        <td>
          {e.used === null
            ? '—'
            : e.unit === 'bytes'
              ? formatBytes(e.used)
              : e.used.toLocaleString('en-IN')}
        </td>
        <td>
          <button type="button" className={styles.linkButton} onClick={onEdit}>
            {editing ? 'Close' : 'Change'}
          </button>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={6}>
            <OverrideForm e={e} orgId={orgId} onDone={onDone} />
          </td>
        </tr>
      )}
    </>
  );
}

/** A value input of the capability's type: on/off, or a quota (with "unlimited"). */
function ValueInput({
  capability,
  value,
  onChange,
}: {
  capability: string;
  value: EntitlementValue;
  onChange: (v: EntitlementValue) => void;
}) {
  const d = def(capability);
  if (d.type === 'BOOLEAN')
    return (
      <select
        aria-label="Value"
        value={'enabled' in value && value.enabled ? 'on' : 'off'}
        onChange={(ev) => onChange({ enabled: ev.target.value === 'on' })}
      >
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    );
  const limit = 'limit' in value ? value.limit : 0;
  const GB = 1024 ** 3;
  return (
    <span className={styles.inline}>
      <input
        aria-label={d.unit === 'bytes' ? 'Limit in GB' : 'Limit'}
        type="number"
        min={0}
        step={d.unit === 'bytes' ? 0.5 : 1}
        disabled={limit === null}
        value={limit === null ? '' : d.unit === 'bytes' ? limit / GB : limit}
        onChange={(ev) => {
          const n = Math.max(0, Number(ev.target.value));
          onChange({ limit: d.unit === 'bytes' ? Math.round(n * GB) : Math.round(n) });
        }}
      />
      {d.unit === 'bytes' && 'GB'}
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={limit === null}
          onChange={(ev) => onChange({ limit: ev.target.checked ? null : 0 })}
        />
        Unlimited
      </label>
    </span>
  );
}

function OverrideForm({
  e,
  orgId,
  onDone,
}: {
  e: ApiOpsEntitlement;
  orgId: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState<EntitlementValue>(e.override?.value ?? e.effective);
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
      notify.commercialSaved();
      onDone();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'The change could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.form}
      aria-label={`Override ${e.name}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        void run(() =>
          opsApi.setOverride(orgId, e.capability, {
            value,
            reason,
            expiresAt: expiry ? new Date(`${expiry}T23:59:59.999Z`).toISOString() : null,
          }),
        );
      }}
    >
      <p className={styles.muted}>
        An override applies to this organization only; the plan stays unchanged. Current effective
        value: {fmt(e.capability, e.effective)}.
      </p>
      <label className={styles.field}>
        <span>New value</span>
        <ValueInput capability={e.capability} value={value} onChange={setValue} />
      </label>
      <label className={styles.field}>
        <span>Reason (required, recorded)</span>
        <input
          value={reason}
          onChange={(ev) => setReason(ev.target.value)}
          maxLength={500}
          required
        />
      </label>
      <label className={styles.field}>
        <span>Expires (optional; the plan applies again after this day, UTC)</span>
        <input type="date" value={expiry} onChange={(ev) => setExpiry(ev.target.value)} />
      </label>
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={busy || !reason.trim()}>
          Save override
        </button>
        {e.override && (
          <button
            type="button"
            className={styles.quiet}
            disabled={busy || !reason.trim()}
            onClick={() => void run(() => opsApi.removeOverride(orgId, e.capability, reason))}
          >
            Remove override
          </button>
        )}
      </div>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

function AssignPlan({
  org,
  plans,
  onDone,
}: {
  org: ApiOpsCommercial;
  plans: ApiOpsPlan[];
  onDone: () => void;
}) {
  const current = org.organization;
  const [planKey, setPlanKey] = useState(current.plan?.key ?? '');
  const [status, setStatus] = useState<CommercialStatus>(current.commercialStatus);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className={styles.form}
      aria-label="Assign plan"
      onSubmit={(ev) => {
        ev.preventDefault();
        setBusy(true);
        setProblem(null);
        opsApi
          .assignPlan(current.id, { planKey, reason, commercialStatus: status })
          .then(() => {
            notify.commercialSaved();
            setReason('');
            onDone();
          })
          .catch((err: unknown) =>
            setProblem(err instanceof ApiError ? err.message : 'The plan could not be changed.'),
          )
          .finally(() => setBusy(false));
      }}
    >
      <div className={styles.inline}>
        <label className={styles.field}>
          <span>Plan</span>
          <select value={planKey} onChange={(ev) => setPlanKey(ev.target.value)}>
            {plans
              .filter((p) => p.status === 'active')
              .map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Status</span>
          <select value={status} onChange={(ev) => setStatus(ev.target.value as CommercialStatus)}>
            <option value="active">Active</option>
            <option value="trial">Trial</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>Reason</span>
          <input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} />
        </label>
        <button type="submit" className={styles.button} disabled={busy || !reason.trim()}>
          Assign plan
        </button>
      </div>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

// ── Plans and the catalogue ────────────────────────────────────────────────

function Plans() {
  const { data, error, reload } = useLoad(opsApi.plans, 'plans');
  const [edit, setEdit] = useState<{ plan: string; capability: string } | null>(null);
  if (!data)
    return (
      <Page title="Plans">
        <State error={error} />
      </Page>
    );
  return (
    <Page
      title="Plans"
      sub="What each plan includes. A change applies to every organization on the plan; for one customer, use an override instead. No prices here: billing is not configured."
    >
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Capability</th>
              {data.map((p) => (
                <th key={p.key}>
                  {p.name} ({p.organizations})
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAPABILITIES.map((c) => (
              <tr key={c.key}>
                <td>
                  <span className={styles.strong}>{c.name}</span>
                  <span className={styles.key}>{c.key}</span>
                </td>
                {data.map((p) => (
                  <td key={p.key}>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setEdit({ plan: p.key, capability: c.key })}
                    >
                      {fmt(
                        c.key,
                        p.entitlements.find((e) => e.capability === c.key)?.value ?? null,
                      )}
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <PlanEntitlementForm
          plan={data.find((p) => p.key === edit.plan)}
          capability={edit.capability}
          onDone={() => {
            setEdit(null);
            reload();
          }}
        />
      )}
    </Page>
  );
}

function PlanEntitlementForm({
  plan,
  capability,
  onDone,
}: {
  plan: ApiOpsPlan | undefined;
  capability: string;
  onDone: () => void;
}) {
  const current = plan?.entitlements.find((e) => e.capability === capability)?.value ?? null;
  const [value, setValue] = useState<EntitlementValue>(
    current ?? (def(capability).type === 'BOOLEAN' ? { enabled: false } : { limit: 0 }),
  );
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  if (!plan) return null;
  return (
    <form
      className={styles.form}
      aria-label="Change plan entitlement"
      onSubmit={(ev) => {
        ev.preventDefault();
        opsApi
          .setPlanEntitlement(plan.key, capability, value, reason)
          .then(() => {
            notify.commercialSaved();
            onDone();
          })
          .catch((err: unknown) =>
            setProblem(err instanceof ApiError ? err.message : 'The change could not be saved.'),
          );
      }}
    >
      <p className={styles.strong}>
        {plan.name}: {def(capability).name} (now {fmt(capability, current)}) · affects{' '}
        {plan.organizations} organization(s)
      </p>
      <ValueInput capability={capability} value={value} onChange={setValue} />
      <label className={styles.field}>
        <span>Reason</span>
        <input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} />
      </label>
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={!reason.trim()}>
          Change the plan
        </button>
        <button type="button" className={styles.quiet} onClick={onDone}>
          Cancel
        </button>
      </div>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

function Capabilities() {
  return (
    <Page
      title="Capabilities"
      sub="The capability catalogue: stable keys the product checks. Validation, security and audit are not capabilities and cannot be switched off."
    >
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Key</th>
              <th>Name</th>
              <th>Type</th>
              <th>Category</th>
              <th>Customer-visible</th>
              <th>Needs ERP capability</th>
            </tr>
          </thead>
          <tbody>
            {(CAPABILITIES as readonly CapabilityDefinition[]).map((c) => (
              <tr key={c.key}>
                <td className={styles.key}>{c.key}</td>
                <td>
                  <span className={styles.strong}>{c.name}</span>
                  <span className={styles.muted}>{c.description}</span>
                </td>
                <td>{c.type}</td>
                <td>{c.category}</td>
                <td>{c.customerVisible ? 'Yes' : 'No'}</td>
                <td>{c.erpCapability ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

// ── Usage, processing, exceptions, security, audit ─────────────────────────

function Usage() {
  const orgs = useLoad(opsApi.organizations, 'orgs').data;
  const first = orgs?.[0]?.id ?? null;
  const { data, error } = useLoad(
    () => (first ? opsApi.commercial(first) : Promise.resolve(null)),
    `usage:${first ?? ''}`,
  );
  if (!data)
    return (
      <Page title="Usage">
        <State error={error} />
      </Page>
    );
  const u = data.usage;
  return (
    <Page title="Usage" sub={`${data.organization.name} · counted from the product's own records`}>
      <div className={styles.tiles}>
        <Tile label="Invoices this month" value={u.invoicesThisMonth} />
        <Tile label="Invoices, all time" value={u.invoicesTotal} />
        <Tile label="Verified" value={u.invoicesByOutcome.verified} />
        <Tile label="Need a decision" value={u.invoicesByOutcome.needsDecision} />
        <Tile label="Rejected" value={u.invoicesByOutcome.rejected} />
        <Tile label="Failed" value={u.invoicesByOutcome.failed} />
        <Tile label="Read with OCR this month" value={u.ocrThisMonth} />
        <Tile label="ERP writes this month" value={u.erpWritesThisMonth} />
        <Tile label="Storage" value={formatBytes(u.storageBytes)} />
        <Tile label="Active users" value={u.activeUsers} />
      </div>
      <h2 className={styles.h2}>Usage against limits</h2>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Used</th>
              <th>Effective limit</th>
            </tr>
          </thead>
          <tbody>
            {data.entitlements
              .filter((e) => e.type === 'LIMIT')
              .map((e) => (
                <tr key={e.capability}>
                  <td>{e.name}</td>
                  <td>
                    {e.used === null ? '—' : e.unit === 'bytes' ? formatBytes(e.used) : e.used}
                  </td>
                  <td>{fmt(e.capability, e.effective)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

function Processing() {
  const { data, error } = useLoad(opsApi.processing, 'processing');
  if (!data)
    return (
      <Page title="Processing">
        <State error={error} />
      </Page>
    );
  const p = data as { jobs: Record<string, number>; invoices: Record<string, number> };
  return (
    <Page title="Processing" sub="Jobs and invoice outcomes (counts only).">
      <div className={styles.tiles}>
        {Object.entries(p.jobs).map(([k, n]) => (
          <Tile key={`j${k}`} label={`Jobs ${k}`} value={n} />
        ))}
        {Object.entries(p.invoices).map(([k, n]) => (
          <Tile key={`i${k}`} label={`Invoices: ${k}`} value={n} />
        ))}
      </div>
    </Page>
  );
}

function Exceptions() {
  const { data, error } = useLoad(opsApi.processing, 'processing');
  if (!data)
    return (
      <Page title="Exceptions">
        <State error={error} />
      </Page>
    );
  const failed = (data as { failed: { id: string; stage: string | null; updatedAt: string }[] })
    .failed;
  return (
    <Page title="Exceptions" sub="Invoices that failed, by stage (no invoice contents).">
      {failed.length === 0 ? (
        <p className={styles.muted}>No failed invoices.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Invoice id</th>
                <th>Stage</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {failed.map((f) => (
                <tr key={f.id}>
                  <td className={styles.key}>{f.id}</td>
                  <td>{f.stage ?? '—'}</td>
                  <td>{at(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function Security() {
  const { data, error } = useLoad(opsApi.security, 'security');
  if (!data)
    return (
      <Page title="Security">
        <State error={error} />
      </Page>
    );
  const rows = data as { id: string; at: string; event: string; userId: string | null }[];
  return (
    <Page
      title="Security"
      sub="The latest security events (sign-ins, access denied, user changes)."
    >
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>User id</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{at(r.at)}</td>
                <td>{r.event}</td>
                <td className={styles.key}>{r.userId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

function CommercialAudit() {
  return (
    <Page
      title="Audit"
      sub="Every commercial change: who, when, why, the value before and after. Never deleted."
    >
      <EventTable />
    </Page>
  );
}

function EventTable({ organizationId }: { organizationId?: string }) {
  const { data, error } = useLoad(
    () => opsApi.events(organizationId),
    `events:${organizationId ?? ''}`,
  );
  if (!data) return <State error={error} />;
  if (data.length === 0) return <p className={styles.muted}>No commercial changes yet.</p>;
  const show = (e: (typeof data)[number], v: unknown) =>
    e.capability ? fmt(e.capability, v as EntitlementValue | null) : JSON.stringify(v);
  return (
    <div className={styles.scroll}>
      <table className={styles.table} data-testid="commercial-events">
        <thead>
          <tr>
            <th>When</th>
            <th>Change</th>
            <th>Capability / plan</th>
            <th>Before → after</th>
            <th>Reason</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e) => (
            <tr key={e.id}>
              <td>{at(e.at)}</td>
              <td>{e.event}</td>
              <td className={styles.key}>{e.capability ?? e.planKey ?? '—'}</td>
              <td>
                {show(e, e.oldValue)} → {show(e, e.newValue)}
                {e.expiresAt && <span className={styles.muted}> until {at(e.expiresAt)}</span>}
              </td>
              <td>{e.reason}</td>
              <td>{e.actor ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Loaded({
  title,
  load,
  name,
}: {
  title: string;
  load: () => Promise<unknown>;
  name: string;
}) {
  const { data, error } = useLoad(load, name);
  return (
    <Page title={title}>
      {data ? (
        <pre className={styles.pre}>{JSON.stringify(data, null, 2)}</pre>
      ) : (
        <State error={error} />
      )}
    </Page>
  );
}
