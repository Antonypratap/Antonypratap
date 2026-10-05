import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  CAPABILITIES,
  CHALLENGE_FOLLOW_UPS,
  COMMERCIAL_EVENTS,
  FINDING_TYPE_LABEL,
  capabilityDefinition,
  formatBytes,
  formatEntitlement,
  formatInr,
  paise,
  type ApiCommercialEvent,
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
import {
  opsApi,
  type ChallengeLead,
  type CentreUser,
  type CostBucket,
  type Paise,
  type Phase,
  type Pricing,
  type ProcessingRow,
} from './api';
import styles from './Ops.module.css';

/**
 * The Veyrafy Owner Control Centre: the platform owner's view of every customer, user, invoice,
 * cost and change, separate from the customer application. The server allows it to VEYRA_ADMIN
 * only; this page only presents what the server returns. Every change carries a reason and is
 * written to the audit log by the server. Costs are estimates from the owner's own rates and are
 * never shown to customers.
 */
type OpsRoute = Extract<Route, { name: 'ops' }>;

const NAV: { section: OpsSection; label: string; icon: IconName }[] = [
  { section: 'overview', label: 'Overview', icon: 'systems' },
  { section: 'customers', label: 'Customers', icon: 'person' },
  { section: 'users', label: 'Users', icon: 'person' },
  { section: 'processing', label: 'Invoice Processing', icon: 'inbox' },
  { section: 'cost', label: 'AI, Usage & Cost', icon: 'spark' },
  { section: 'plans', label: 'Plans & Entitlements', icon: 'document' },
  { section: 'challenges', label: '5 Invoice Challenge', icon: 'spark' },
  { section: 'config', label: 'System Configuration', icon: 'menu' },
  { section: 'audit', label: 'Audit Log', icon: 'audit' },
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
        <p>The Control Centre is for the Veyrafy team. Your account is a customer account.</p>
        <a href={hrefFor({ name: 'inbox' })}>Go to your inbox</a>
      </div>
    );
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <a href={href('overview')} className={styles.brand} aria-label="Veyrafy Control Centre">
          <Logo />
          <span className={styles.brandTag}>Control Centre</span>
        </a>
        <nav aria-label="Control Centre">
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
          <span className={styles.muted}>Platform admin · internal</span>
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
    case 'customers':
      return route.id ? <CustomerDetail id={route.id} /> : <Customers />;
    case 'users':
      return <Users />;
    case 'processing':
      return route.id ? <InvoiceDetail id={route.id} /> : <Processing />;
    case 'cost':
      return <Cost />;
    case 'plans':
      return <Plans />;
    case 'challenges':
      return <Challenges />;
    case 'config':
      return <Config />;
    case 'audit':
      return <AuditLog />;
  }
}

// ── Shared pieces ──────────────────────────────────────────────────────────

function Page({
  title,
  sub,
  back,
  children,
}: {
  title: string;
  sub?: string;
  back?: { label: string; to: string };
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header>
        {back && (
          <a className={styles.back} href={back.to}>
            <Icon name="chevronLeft" size={14} /> {back.label}
          </a>
        )}
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

function Tile({
  label,
  value,
  note,
  tone,
  to,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  tone?: 'bad' | 'warn' | 'good' | undefined;
  to?: string;
}) {
  const body = (
    <>
      <span className={styles.tileLabel}>{label}</span>
      <span
        className={styles.tileValue}
        // Words ("Rate not set", "ready") read better smaller than figures.
        data-words={typeof value === 'string' && /[a-z]{3}/.test(value) ? '' : undefined}
      >
        {value}
      </span>
      {note && <span className={styles.muted}>{note}</span>}
    </>
  );
  return to ? (
    <a className={styles.tile} data-tone={tone} href={to}>
      {body}
    </a>
  ) : (
    <div className={styles.tile} data-tone={tone}>
      {body}
    </div>
  );
}

function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className={styles.badge} data-tone={tone}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: 'good',
  trial: 'info',
  suspended: 'bad',
  FAILED: 'bad',
  NEEDS_INPUT: 'warn',
  REJECTED: 'neutral',
  VERIFIED_PENDING_PAYMENT: 'good',
};
const PHASE_TONE: Record<Phase, string> = {
  waiting: 'neutral',
  running: 'info',
  done: 'good',
  needs_input: 'warn',
  failed: 'bad',
  rejected: 'neutral',
  'n/a': 'neutral',
};
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const PhaseBadge = ({ p }: { p: Phase }) => <Badge tone={PHASE_TONE[p]}>{label(p)}</Badge>;

function Empty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

function Problem({ text }: { text: string | null }) {
  return text ? (
    <p className={styles.problem} role="alert">
      {text}
    </p>
  ) : null;
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/** A change with a required reason: one line, one button. */
function ReasonAction({
  action,
  danger,
  confirm,
  onRun,
}: {
  action: string;
  danger?: boolean;
  confirm?: string;
  onRun: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className={styles.reasonAction}
      aria-label={action}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        setProblem(null);
        onRun(reason.trim())
          .then(() => {
            notify.opsSaved();
            setReason('');
          })
          .catch((err: unknown) => setProblem(errorText(err, 'The change could not be saved.')))
          .finally(() => setBusy(false));
      }}
    >
      <input
        aria-label={`Reason: ${action}`}
        placeholder="Reason (required, recorded)"
        value={reason}
        onChange={(ev) => setReason(ev.target.value)}
        maxLength={500}
      />
      <button
        type="submit"
        className={danger ? styles.danger : styles.button}
        disabled={busy || !reason.trim()}
      >
        {action}
      </button>
      <Problem text={problem} />
    </form>
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
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};
/** Money from paise; null means the rate or price is not set (never shown as ₹0). */
const inr = (v: Paise, missing = 'Rate not set') => (v === null ? missing : formatInr(paise(v)));
const num = (v: number) => v.toLocaleString('en-IN');
const ms = (v: number | null) =>
  v === null ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`;
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function Filters({ children }: { children: ReactNode }) {
  return (
    <div className={styles.filters} role="search">
      {children}
    </div>
  );
}

// ── Overview ───────────────────────────────────────────────────────────────

function Overview() {
  const { data, error } = useLoad(opsApi.centreOverview, 'centre-overview');
  if (!data)
    return (
      <Page title="Overview">
        <State error={error} />
      </Page>
    );
  const o = data;
  const problems = o.failedInvoices + o.stuckInvoices + o.jobs.failed;
  return (
    <Page
      title="Overview"
      sub={`Platform health and business at a glance · ${o.environment} · ${new Date(o.cost.month.from).toLocaleString('en-IN', { month: 'long', year: 'numeric' })}`}
    >
      <div className={styles.tiles}>
        <Tile label="Customers" value={num(o.customers)} to={href('customers')} />
        <Tile
          label="Active customers"
          value={num(o.activeCustomers)}
          note="Not suspended, used in last 30 days"
        />
        <Tile
          label="Users"
          value={num(o.users.customer)}
          note={`${o.users.active} active · ${o.users.platform} platform`}
          to={href('users')}
        />
        <Tile
          label="Invoices this month"
          value={num(o.invoicesThisMonth)}
          to={href('processing')}
        />
        <Tile
          label="Processing now"
          value={num(o.processingNow)}
          note={`${o.needsInput} waiting for the customer`}
          to={href('processing')}
        />
        <Tile
          label="Failed / stuck"
          value={`${o.failedInvoices} / ${o.stuckInvoices}`}
          note={`${o.jobs.failed} failed jobs`}
          tone={problems ? 'bad' : 'good'}
          to={`${href('processing')}`}
        />
        <Tile
          label="AI cost this month"
          value={inr(o.cost.aiPaise)}
          note="Estimate · internal only"
          to={href('cost')}
        />
        <Tile
          label="Avg cost per invoice"
          value={inr(o.cost.perInvoicePaise)}
          note={`${o.cost.invoices} invoices read`}
          to={href('cost')}
        />
        <Tile
          label="Monthly recurring revenue"
          value={
            o.mrr.status === 'price_not_set' ? 'Price not set' : inr(o.mrr.paise, 'Price not set')
          }
          note={
            o.mrr.status === 'no_paying_customers'
              ? 'No active paying customers'
              : 'Plan prices of active customers'
          }
          to={href('plans')}
        />
        <Tile
          label="System health"
          value={o.health?.status ?? '—'}
          tone={o.health && o.health.status !== 'ready' ? 'bad' : undefined}
          to={href('config')}
        />
      </div>
      <section aria-labelledby="alerts-title">
        <h2 id="alerts-title" className={styles.h2}>
          Platform alerts
        </h2>
        {o.alerts.length === 0 ? (
          <Empty>No alerts. Everything is running.</Empty>
        ) : (
          <ul className={styles.alerts}>
            {o.alerts.map((a, i) => (
              <li key={i} className={styles.alert} data-level={a.level}>
                <span className={styles.alertLevel}>{a.level}</span>
                <span>
                  <span className={styles.strong}>{a.title}</span>
                  <span className={styles.muted}>{a.detail}</span>
                </span>
                <a className={styles.link} href={href(a.section as OpsSection)}>
                  Open
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}

// ── Customers ──────────────────────────────────────────────────────────────

function Customers() {
  const [search, setSearch] = useState('');
  const { data, error } = useLoad(() => opsApi.customers(search), `customers:${search}`);
  return (
    <Page
      title="Customers"
      sub="Every customer organization, its plan, usage and activity. This deployment serves one customer organization."
    >
      <Filters>
        <label className={styles.searchBox}>
          <Icon name="search" size={14} />
          <input
            aria-label="Search customers"
            placeholder="Search by name or id"
            value={search}
            onChange={(ev) => setSearch(ev.target.value)}
          />
        </label>
      </Filters>
      {!data ? (
        <State error={error} />
      ) : data.length === 0 ? (
        <Empty>No customers match.</Empty>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table} data-testid="customers">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Status</th>
                <th>Plan</th>
                <th className={styles.num}>Allowance</th>
                <th className={styles.num}>This month</th>
                <th>Usage</th>
                <th className={styles.num}>Users</th>
                <th className={styles.num}>Cost this month</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a className={styles.strongLink} href={href('customers', c.id)}>
                      {c.name}
                    </a>
                    <span className={styles.key}>{c.id}</span>
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                  </td>
                  <td>{c.plan?.name ?? '—'}</td>
                  <td className={styles.num}>
                    {c.invoiceAllowance === null ? 'Unlimited' : num(c.invoiceAllowance)}
                  </td>
                  <td className={styles.num}>{num(c.invoicesThisMonth)}</td>
                  <td>
                    <UsageBar percent={c.usagePercent} />
                  </td>
                  <td className={styles.num}>
                    {c.activeUsers}/{c.users}
                  </td>
                  <td className={styles.num}>{inr(c.costThisMonth.totalPaise)}</td>
                  <td>{ago(c.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function UsageBar({ percent }: { percent: number | null }) {
  if (percent === null) return <span className={styles.muted}>No limit</span>;
  return (
    <span className={styles.usage} data-tone={percent >= 100 ? 'bad' : percent >= 80 ? 'warn' : ''}>
      <span className={styles.usageTrack}>
        <span className={styles.usageFill} style={{ width: `${Math.min(percent, 100)}%` }} />
      </span>
      {percent}%
    </span>
  );
}

function CustomerDetail({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => opsApi.customer(id), `customer:${id}`);
  const plans = useLoad(opsApi.plans, 'plans').data;
  const [editing, setEditing] = useState<string | null>(null);
  const back = { label: 'Customers', to: href('customers') };
  if (!data)
    return (
      <Page title="Customer" back={back}>
        <State error={error} />
      </Page>
    );
  const c = data.summary;
  const o = data.commercial.organization;
  const suspended = o.commercialStatus === 'suspended';
  return (
    <Page
      title={o.name}
      back={back}
      sub={`Customer since ${at(o.createdAt)} · Plan ${o.plan?.name ?? 'none'} · Billing: not configured`}
    >
      <div className={styles.tiles}>
        <Tile
          label="Status"
          value={
            <Badge tone={STATUS_TONE[o.commercialStatus] ?? 'neutral'}>{o.commercialStatus}</Badge>
          }
        />
        <Tile
          label="Invoices this month"
          value={c ? num(c.invoicesThisMonth) : '—'}
          note={
            c?.invoiceAllowance === null || !c
              ? 'No monthly limit'
              : `of ${num(c.invoiceAllowance)} allowed`
          }
        />
        <Tile label="Usage" value={pct(c?.usagePercent ?? null)} />
        <Tile label="Invoices, all time" value={c ? num(c.invoicesTotal) : '—'} />
        <Tile label="Users" value={c ? `${c.activeUsers} active / ${c.users}` : '—'} />
        <Tile label="Storage" value={c ? formatBytes(c.storageBytes) : '—'} />
        <Tile label="Cost this month" value={inr(c?.costThisMonth.totalPaise ?? null)} />
        <Tile label="Last activity" value={ago(c?.lastActivityAt ?? null)} />
      </div>

      <section className={styles.panel} aria-labelledby="account-title">
        <h2 id="account-title" className={styles.h2}>
          Account actions
        </h2>
        <div className={styles.actionGrid}>
          <div>
            <p className={styles.strong}>
              {suspended ? 'Reactivate customer' : 'Suspend customer'}
            </p>
            <p className={styles.muted}>
              {suspended
                ? 'Restores access with the status it had before (trial or active).'
                : 'Its users are refused at once (they can still sign out). Nothing is deleted.'}
            </p>
            <ReasonAction
              action={suspended ? 'Reactivate' : 'Suspend'}
              danger={!suspended}
              {...(suspended
                ? {}
                : { confirm: `Suspend ${o.name}? Its users lose access immediately.` })}
              onRun={(reason) => opsApi.setSuspended(o.id, !suspended, reason).then(reload)}
            />
          </div>
          <div>
            <p className={styles.strong}>Change plan</p>
            <AssignPlan org={data.commercial} plans={plans ?? []} onDone={reload} />
          </div>
        </div>
      </section>

      <section aria-labelledby="effective-title">
        <h2 id="effective-title" className={styles.h2}>
          Entitlements and allowance
        </h2>
        <p className={styles.muted}>
          To adjust the invoice allowance for this customer only, change &ldquo;Invoices per
          month&rdquo; (an override; the plan stays the same). Precedence: override, else plan.
        </p>
        <div className={styles.scroll}>
          <table className={styles.table} data-testid="effective">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Plan default</th>
                <th>Customer override</th>
                <th>Effective</th>
                <th>Usage</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.commercial.entitlements.map((e) => (
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

      <section aria-labelledby="cust-users-title">
        <h2 id="cust-users-title" className={styles.h2}>
          Users
        </h2>
        <UserTable rows={data.users} onChange={reload} />
      </section>

      <section aria-labelledby="cust-invoices-title">
        <h2 id="cust-invoices-title" className={styles.h2}>
          Recent invoices
        </h2>
        <ProcessingTable rows={data.recentInvoices} />
      </section>

      <section aria-labelledby="history-title">
        <h2 id="history-title" className={styles.h2}>
          Recent activity (audit)
        </h2>
        <EventTable rows={data.events} />
      </section>
    </Page>
  );
}

// ── Users ──────────────────────────────────────────────────────────────────

function Users() {
  const [f, setF] = useState({ q: '', organizationId: '', role: '', active: '' });
  const customers = useLoad(() => opsApi.customers(), 'customers:').data;
  const key = JSON.stringify(f);
  const { data, error, reload } = useLoad(() => opsApi.users(f), `users:${key}`);
  return (
    <Page
      title="Users"
      sub="Every account, customer and platform. Passwords, sessions and tokens are never shown."
    >
      <Filters>
        <label className={styles.searchBox}>
          <Icon name="search" size={14} />
          <input
            aria-label="Search users"
            placeholder="Name or email"
            value={f.q}
            onChange={(ev) => setF({ ...f, q: ev.target.value })}
          />
        </label>
        <select
          aria-label="Customer"
          value={f.organizationId}
          onChange={(ev) => setF({ ...f, organizationId: ev.target.value })}
        >
          <option value="">All organizations</option>
          {(customers ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value="00000000000000000000000000">Veyrafy (platform)</option>
        </select>
        <select
          aria-label="Role"
          value={f.role}
          onChange={(ev) => setF({ ...f, role: ev.target.value })}
        >
          <option value="">All roles</option>
          {['ADMIN', 'FINANCE', 'REVIEWER', 'VEYRA_ADMIN'].map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={f.active}
          onChange={(ev) => setF({ ...f, active: ev.target.value })}
        >
          <option value="">Any status</option>
          <option value="true">Enabled</option>
          <option value="false">Disabled</option>
        </select>
      </Filters>
      {data ? <UserTable rows={data} onChange={reload} /> : <State error={error} />}
    </Page>
  );
}

function UserTable({ rows, onChange }: { rows: CentreUser[]; onChange: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <Empty>No users match.</Empty>;
  return (
    <div className={styles.scroll}>
      <table className={styles.table} data-testid="users">
        <thead>
          <tr>
            <th>User</th>
            <th>Organization</th>
            <th>Role</th>
            <th>Status</th>
            <th>Last login</th>
            <th>Last activity</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <UserRow
              key={u.id}
              u={u}
              open={open === u.id}
              onToggle={() => setOpen(open === u.id ? null : u.id)}
              onDone={() => {
                setOpen(null);
                onChange();
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({
  u,
  open,
  onToggle,
  onDone,
}: {
  u: CentreUser;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <span className={styles.strong}>{u.name}</span>
          <span className={styles.muted}>{u.email}</span>
        </td>
        <td>{u.platform ? 'Veyrafy (platform)' : (u.organization ?? u.organizationId)}</td>
        <td>{u.role}</td>
        <td>
          <Badge tone={u.active ? 'good' : 'neutral'}>{u.active ? 'enabled' : 'disabled'}</Badge>
        </td>
        <td>{at(u.lastLoginAt)}</td>
        <td>{ago(u.lastSeenAt)}</td>
        <td>
          {u.platform ? (
            <span className={styles.muted}>Managed by CLI</span>
          ) : (
            <button type="button" className={styles.linkButton} onClick={onToggle}>
              {open ? 'Close' : u.active ? 'Disable' : 'Enable'}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            <p className={styles.muted}>
              {u.active
                ? `Disabling ${u.name} ends every session at once. The customer’s last administrator cannot be disabled.`
                : `Enabling ${u.name} counts against the customer’s user limit.`}
            </p>
            <ReasonAction
              action={u.active ? 'Disable user' : 'Enable user'}
              danger={u.active}
              onRun={(reason) => opsApi.setUserActive(u.id, !u.active, reason).then(onDone)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Invoice processing ─────────────────────────────────────────────────────

const STATES = [
  'UPLOADED',
  'EXTRACTING',
  'MATCHING',
  'RESOLVING',
  'VALIDATING',
  'NEEDS_INPUT',
  'COMMITTING',
  'VERIFIED_PENDING_PAYMENT',
  'REJECTED',
  'FAILED',
];

function Processing() {
  const [f, setF] = useState({ q: '', state: '', problem: '' });
  const key = JSON.stringify(f);
  const { data, error } = useLoad(() => opsApi.processingList(f), `processing:${key}`);
  return (
    <Page
      title="Invoice Processing"
      sub="Every invoice’s progress through reading, checking and resolution. Ids, states and times only: no invoice contents."
    >
      <Filters>
        <label className={styles.searchBox}>
          <Icon name="search" size={14} />
          <input
            aria-label="Search invoice id"
            placeholder="Invoice id"
            value={f.q}
            onChange={(ev) => setF({ ...f, q: ev.target.value })}
          />
        </label>
        <select
          aria-label="State"
          value={f.state}
          onChange={(ev) => setF({ ...f, state: ev.target.value })}
        >
          <option value="">All states</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Problems"
          value={f.problem}
          onChange={(ev) => setF({ ...f, problem: ev.target.value })}
        >
          <option value="">All invoices</option>
          <option value="failed">Failed only</option>
          <option value="stuck">Stuck only</option>
        </select>
      </Filters>
      {!data ? (
        <State error={error} />
      ) : (
        <>
          {data.failures.length > 0 && (
            <section aria-labelledby="failures-title">
              <h2 id="failures-title" className={styles.h2}>
                Recurring failures
              </h2>
              <div className={styles.scroll}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Reason</th>
                      <th className={styles.num}>Invoices</th>
                      <th>Latest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.failures.map((g, i) => (
                      <tr key={i}>
                        <td>{g.stage ? label(g.stage) : '—'}</td>
                        <td>{g.reason ?? '—'}</td>
                        <td className={styles.num}>{g.count}</td>
                        <td>{at(g.lastAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <ProcessingTable rows={data.invoices} />
        </>
      )}
    </Page>
  );
}

function ProcessingTable({ rows }: { rows: ProcessingRow[] }) {
  if (rows.length === 0) return <Empty>No invoices match.</Empty>;
  return (
    <div className={styles.scroll}>
      <table className={styles.table} data-testid="processing">
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Customer</th>
            <th>State</th>
            <th>Uploaded</th>
            <th className={styles.num}>Processing</th>
            <th>Extraction</th>
            <th>Verification</th>
            <th>Resolution</th>
            <th className={styles.num}>Retries</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-problem={r.failed ? 'failed' : r.stuck ? 'stuck' : undefined}>
              <td>
                <a className={styles.mono} href={href('processing', r.id)}>
                  {r.id}
                </a>
              </td>
              <td>{r.customer.name}</td>
              <td>
                <Badge tone={r.stuck ? 'bad' : (STATUS_TONE[r.state] ?? 'info')}>
                  {r.stuck ? 'stuck' : label(r.state)}
                </Badge>
              </td>
              <td>{at(r.uploadedAt)}</td>
              <td className={styles.num}>{ms(r.processingMs)}</td>
              <td>
                <PhaseBadge p={r.extraction} />
              </td>
              <td>
                <PhaseBadge p={r.verification} />
              </td>
              <td>
                <PhaseBadge p={r.resolution} />
              </td>
              <td className={styles.num}>{r.retryCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoiceDetail({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => opsApi.processingDetail(id), `invoice:${id}`);
  const back = { label: 'Invoice Processing', to: href('processing') };
  if (!data)
    return (
      <Page title="Invoice" back={back}>
        <State error={error} />
      </Page>
    );
  const s = data.summary;
  return (
    <Page
      title={`Invoice ${s.id}`}
      back={back}
      sub={`${s.customer.name} · uploaded ${at(s.uploadedAt)}`}
    >
      <div className={styles.tiles}>
        <Tile
          label="State"
          value={<Badge tone={STATUS_TONE[s.state] ?? 'info'}>{label(s.state)}</Badge>}
          {...(s.stuck ? { note: 'Stuck: no progress for over 15 minutes' } : {})}
        />
        <Tile label="Extraction" value={<PhaseBadge p={s.extraction} />} />
        <Tile label="Verification" value={<PhaseBadge p={s.verification} />} />
        <Tile label="Resolution" value={<PhaseBadge p={s.resolution} />} />
        <Tile
          label="Processing time"
          value={ms(s.processingMs)}
          note={`${s.readings} reading(s)`}
        />
        <Tile label="Retries" value={s.retryCount} note={`${s.failedJobs} failed job(s)`} />
      </div>
      {s.failed && (
        <section className={styles.panel} aria-labelledby="retry-title">
          <h2 id="retry-title" className={styles.h2}>
            Failed{s.failedStage ? ` at ${label(s.failedStage)}` : ''}
          </h2>
          {s.failureReason && <p className={styles.sub}>{s.failureReason}</p>}
          {s.retryable ? (
            <>
              <p className={styles.muted}>
                Retry resumes from where it is safe: checking again when the reading is kept,
                reading again otherwise. Nothing is deleted.
              </p>
              <ReasonAction
                action="Retry processing"
                onRun={(r) => opsApi.retry(s.id, r).then(reload)}
              />
            </>
          ) : (
            <p className={styles.muted}>Cannot be retried: the original document was deleted.</p>
          )}
        </section>
      )}
      <section aria-labelledby="events-title">
        <h2 id="events-title" className={styles.h2}>
          Processing events
        </h2>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>From → to</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e, i) => (
                <tr key={i}>
                  <td>{at(e.at)}</td>
                  <td>{e.event}</td>
                  <td>
                    {e.fromState ? label(e.fromState) : '—'} → {e.toState ? label(e.toState) : '—'}
                  </td>
                  <td>{e.actorType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="jobs-title">
        <h2 id="jobs-title" className={styles.h2}>
          Background jobs
        </h2>
        {data.jobs.length === 0 ? (
          <Empty>No jobs.</Empty>
        ) : (
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Status</th>
                  <th className={styles.num}>Attempts</th>
                  <th>Last error</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>{j.type}</td>
                    <td>
                      <Badge
                        tone={
                          j.status === 'failed' ? 'bad' : j.status === 'succeeded' ? 'good' : 'info'
                        }
                      >
                        {j.status}
                      </Badge>
                    </td>
                    <td className={styles.num}>{j.attempts}</td>
                    <td>{j.lastError ?? '—'}</td>
                    <td>{at(j.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section aria-labelledby="usage-title">
        <h2 id="usage-title" className={styles.h2}>
          Usage and cost (internal)
        </h2>
        <ReadingTable rows={data.usage} />
      </section>
    </Page>
  );
}

function ReadingTable({
  rows,
}: {
  rows: (Parameters<typeof readingCells>[0] & { invoiceId?: string })[];
}) {
  if (rows.length === 0) return <Empty>No readings recorded yet.</Empty>;
  const withInvoice = rows.some((r) => r.invoiceId);
  return (
    <div className={styles.scroll}>
      <table className={styles.table} data-testid="readings">
        <thead>
          <tr>
            <th>When</th>
            {withInvoice && <th>Invoice</th>}
            <th>Method</th>
            <th className={styles.num}>Pages</th>
            <th>Gemini model</th>
            <th className={styles.num}>Calls</th>
            <th className={styles.num}>Input tokens</th>
            <th className={styles.num}>Output tokens</th>
            <th className={styles.num}>Duration</th>
            <th className={styles.num}>Size</th>
            <th className={styles.num}>AI cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{at(r.at)}</td>
              {withInvoice && (
                <td>
                  {r.invoiceId && (
                    <a className={styles.mono} href={href('processing', r.invoiceId)}>
                      {r.invoiceId}
                    </a>
                  )}
                </td>
              )}
              {readingCells(r)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function readingCells(r: {
  id: string;
  at: string;
  method: string;
  pages: number;
  aiModel: string | null;
  aiCalls: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  durationMs: number | null;
  documentBytes: number;
  aiPaise: Paise;
}) {
  return (
    <>
      <td>{r.method}</td>
      <td className={styles.num}>{r.pages}</td>
      <td>{r.aiModel ?? '—'}</td>
      <td className={styles.num}>{r.aiCalls}</td>
      <td className={styles.num}>{num(r.aiInputTokens)}</td>
      <td className={styles.num}>{num(r.aiOutputTokens)}</td>
      <td className={styles.num}>{ms(r.durationMs)}</td>
      <td className={styles.num}>{formatBytes(r.documentBytes)}</td>
      <td className={styles.num}>{inr(r.aiPaise)}</td>
    </>
  );
}

// ── AI, usage and cost ─────────────────────────────────────────────────────

const thisMonth = () => new Date().toISOString().slice(0, 7);

function Cost() {
  const [month, setMonth] = useState(thisMonth());
  const { data, error, reload } = useLoad(() => opsApi.cost(month), `cost:${month}`);
  return (
    <Page
      title="AI, Usage & Cost"
      sub="Estimated provider and infrastructure cost, from the rates you set. Internal only: never shown to customers."
    >
      <Filters>
        <label className={styles.inlineField}>
          Month
          <input
            type="month"
            aria-label="Month"
            value={month}
            max={thisMonth()}
            onChange={(ev) => ev.target.value && setMonth(ev.target.value)}
          />
        </label>
      </Filters>
      {!data ? (
        <State error={error} />
      ) : (
        <>
          {data.totals.unpricedReadings > 0 && (
            <p className={styles.notice} role="status">
              {data.totals.unpricedReadings} reading(s) used AI with no rate set: AI cost is shown
              as &ldquo;Rate not set&rdquo; until you set provider rates below.
            </p>
          )}
          <div className={styles.tiles}>
            <Tile label="AI cost (Gemini)" value={inr(data.geminiPaise)} />
            <Tile
              label="Document AI cost"
              value={inr(data.documentAi.paise)}
              note="Not used by this version"
            />
            <Tile label="Infrastructure estimate" value={inr(data.totals.infrastructurePaise)} />
            <Tile label="Total estimated cost" value={inr(data.totals.totalPaise)} />
            <Tile label="Average per invoice" value={inr(data.totals.perInvoicePaise)} />
            <Tile
              label="Invoices read"
              value={num(data.totals.invoices)}
              note={`${data.totals.readings} readings · ${num(data.totals.pages)} pages`}
            />
            <Tile
              label="Gemini usage"
              value={pct(data.geminiUsagePercent)}
              note="Readings that called Gemini"
            />
            <Tile
              label="Gemini tokens"
              value={num(data.totals.aiInputTokens + data.totals.aiOutputTokens)}
              note={`${num(data.totals.aiInputTokens)} in · ${num(data.totals.aiOutputTokens)} out · ${data.totals.aiCalls} calls`}
            />
          </div>
          <CostTable title="Cost by customer" rows={data.byCustomer} first="Customer" />
          <CostTable title="Cost by processing method" rows={data.byMethod} first="Method" />
          <CostTable title="Gemini usage by model" rows={data.byModel} first="Model" />
          <PricingForm
            pricing={data.pricing}
            models={data.byModel.map((m) => m.key)}
            onDone={reload}
          />
          <section aria-labelledby="ledger-title">
            <h2 id="ledger-title" className={styles.h2}>
              Latest readings (per invoice)
            </h2>
            <p className={styles.muted}>
              One row per reading. A retried job never adds a row; reading an invoice again is real
              extra usage and is shown as its own row.
            </p>
            <ReadingTable rows={data.ledger} />
          </section>
        </>
      )}
    </Page>
  );
}

function CostTable({ title, rows, first }: { title: string; rows: CostBucket[]; first: string }) {
  return (
    <section aria-label={title}>
      <h2 className={styles.h2}>{title}</h2>
      {rows.length === 0 ? (
        <Empty>Nothing this month.</Empty>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{first}</th>
                <th className={styles.num}>Invoices</th>
                <th className={styles.num}>Readings</th>
                <th className={styles.num}>Pages</th>
                <th className={styles.num}>Tokens in / out</th>
                <th className={styles.num}>AI cost</th>
                <th className={styles.num}>Infrastructure</th>
                <th className={styles.num}>Total</th>
                <th className={styles.num}>Per invoice</th>
                <th className={styles.num}>Avg time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <span className={styles.strong}>{r.name ?? r.key}</span>
                  </td>
                  <td className={styles.num}>{num(r.invoices)}</td>
                  <td className={styles.num}>{num(r.readings)}</td>
                  <td className={styles.num}>{num(r.pages)}</td>
                  <td className={styles.num}>
                    {num(r.aiInputTokens)} / {num(r.aiOutputTokens)}
                  </td>
                  <td className={styles.num}>{inr(r.aiPaise)}</td>
                  <td className={styles.num}>{inr(r.infrastructurePaise)}</td>
                  <td className={styles.num}>{inr(r.totalPaise)}</td>
                  <td className={styles.num}>{inr(r.perInvoicePaise)}</td>
                  <td className={styles.num}>{ms(r.avgDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Rupees typed, paise stored. Empty means "not set". */
const toPaise = (text: string): Paise | undefined => {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
};
const toRupees = (v: Paise) => (v === null ? '' : (v / 100).toFixed(2));

function PricingForm({
  pricing,
  models,
  onDone,
}: {
  pricing: Pricing;
  models: string[];
  onDone: () => void;
}) {
  const allModels = [...new Set([...Object.keys(pricing.models), ...models])];
  const [v, setV] = useState({
    aiIn: toRupees(pricing.aiInputPer1MPaise),
    aiOut: toRupees(pricing.aiOutputPer1MPaise),
    infra: toRupees(pricing.infrastructurePerInvoicePaise),
    models: Object.fromEntries(
      allModels.map((m) => [
        m,
        {
          in: toRupees(pricing.models[m]?.inputPer1MPaise ?? null),
          out: toRupees(pricing.models[m]?.outputPer1MPaise ?? null),
        },
      ]),
    ) as Record<string, { in: string; out: string }>,
  });
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (lbl: string, value: string, set: (s: string) => void, unit: string) => (
    <label className={styles.field}>
      <span>{lbl}</span>
      <span className={styles.money}>
        ₹
        <input
          inputMode="decimal"
          placeholder="Not set"
          value={value}
          onChange={(ev) => set(ev.target.value)}
        />
        <span className={styles.muted}>{unit}</span>
      </span>
    </label>
  );
  return (
    <form
      className={styles.form}
      aria-label="Provider rates"
      onSubmit={(ev) => {
        ev.preventDefault();
        const parsed = {
          aiInputPer1MPaise: toPaise(v.aiIn),
          aiOutputPer1MPaise: toPaise(v.aiOut),
          infrastructurePerInvoicePaise: toPaise(v.infra),
        };
        const modelRates = Object.entries(v.models)
          .map(([m, r]) => [m, toPaise(r.in), toPaise(r.out)] as const)
          .filter(([, i, o]) => i !== null || o !== null);
        if (
          Object.values(parsed).some((x) => x === undefined) ||
          modelRates.some(([, i, o]) => i === undefined || o === undefined)
        ) {
          setProblem('Enter rupee amounts with at most two decimals, or leave a rate empty.');
          return;
        }
        const next: Pricing = {
          aiInputPer1MPaise: parsed.aiInputPer1MPaise ?? null,
          aiOutputPer1MPaise: parsed.aiOutputPer1MPaise ?? null,
          infrastructurePerInvoicePaise: parsed.infrastructurePerInvoicePaise ?? null,
          models: Object.fromEntries(
            modelRates.map(([m, i, o]) => [
              m,
              { inputPer1MPaise: i ?? null, outputPer1MPaise: o ?? null },
            ]),
          ),
        };
        setBusy(true);
        setProblem(null);
        opsApi
          .setPricing(next, reason)
          .then(() => {
            notify.opsSaved();
            setReason('');
            onDone();
          })
          .catch((err: unknown) => setProblem(errorText(err, 'The rates could not be saved.')))
          .finally(() => setBusy(false));
      }}
    >
      <h2 className={styles.h2}>Provider rates</h2>
      <p className={styles.muted}>
        Enter your current rates from the provider&rsquo;s price list, in rupees. Nothing is
        assumed: a rate left empty shows cost as &ldquo;Rate not set&rdquo;. Changes are recorded in
        the audit log.
      </p>
      <div className={styles.inline}>
        {field('Gemini input', v.aiIn, (s) => setV({ ...v, aiIn: s }), 'per 1M tokens')}
        {field('Gemini output', v.aiOut, (s) => setV({ ...v, aiOut: s }), 'per 1M tokens')}
        {field('Infrastructure', v.infra, (s) => setV({ ...v, infra: s }), 'per invoice')}
      </div>
      {allModels.length > 0 && (
        <>
          <p className={styles.muted}>Per model (optional; overrides the rates above):</p>
          {allModels.map((m) => (
            <div key={m} className={styles.inline}>
              <span className={styles.mono}>{m}</span>
              {field(
                'Input',
                v.models[m]?.in ?? '',
                (s) =>
                  setV({
                    ...v,
                    models: { ...v.models, [m]: { in: s, out: v.models[m]?.out ?? '' } },
                  }),
                'per 1M',
              )}
              {field(
                'Output',
                v.models[m]?.out ?? '',
                (s) =>
                  setV({
                    ...v,
                    models: { ...v.models, [m]: { in: v.models[m]?.in ?? '', out: s } },
                  }),
                'per 1M',
              )}
            </div>
          ))}
        </>
      )}
      <div className={styles.inline}>
        <label className={styles.field}>
          <span>Reason (required, recorded)</span>
          <input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} />
        </label>
        <button type="submit" className={styles.button} disabled={busy || !reason.trim()}>
          Save rates
        </button>
      </div>
      <Problem text={problem} />
    </form>
  );
}

// ── Plans and entitlements ─────────────────────────────────────────────────

function Plans() {
  const { data, error, reload } = useLoad(opsApi.plans, 'plans');
  const [edit, setEdit] = useState<{ plan: string; capability: string } | null>(null);
  const [pricing, setPricing] = useState<string | null>(null);
  if (!data)
    return (
      <Page title="Plans & Entitlements">
        <State error={error} />
      </Page>
    );
  const limitOf = (p: ApiOpsPlan, key: string) =>
    fmt(key, p.entitlements.find((e) => e.capability === key)?.value ?? null);
  const features = (p: ApiOpsPlan) =>
    p.entitlements.filter((e) => e.value && 'enabled' in e.value && e.value.enabled).length;
  return (
    <Page
      title="Plans & Entitlements"
      sub="What each plan includes and costs. Price is used for revenue figures only: there is no billing or payment processing."
    >
      <div className={styles.scroll}>
        <table className={styles.table} data-testid="plans">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Status</th>
              <th className={styles.num}>Price / month</th>
              <th className={styles.num}>Invoice allowance</th>
              <th className={styles.num}>Features on</th>
              <th className={styles.num}>Customers</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <PlanRow
                key={p.key}
                p={p}
                allowance={limitOf(p, 'invoice.monthly_limit')}
                features={`${features(p)} of ${CAPABILITIES.filter((c) => c.type === 'BOOLEAN').length}`}
                open={pricing === p.key}
                onToggle={() => setPricing(pricing === p.key ? null : p.key)}
                onDone={() => {
                  setPricing(null);
                  reload();
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      <h2 className={styles.h2}>Entitlements per plan</h2>
      <p className={styles.muted}>
        A change applies to every customer on the plan; for one customer, use an override on the
        customer&rsquo;s page.
      </p>
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

function PlanRow({
  p,
  allowance,
  features,
  open,
  onToggle,
  onDone,
}: {
  p: ApiOpsPlan;
  allowance: string;
  features: string;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const [price, setPrice] = useState(toRupees(p.priceMonthlyPaise));
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <tr>
        <td>
          <span className={styles.strong}>{p.name}</span>
          <span className={styles.muted}>{p.description}</span>
        </td>
        <td>
          <Badge tone={p.status === 'active' ? 'good' : 'neutral'}>{p.status}</Badge>
        </td>
        <td className={styles.num}>{inr(p.priceMonthlyPaise, 'Not set')}</td>
        <td className={styles.num}>{allowance}</td>
        <td className={styles.num}>{features}</td>
        <td className={styles.num}>{p.organizations}</td>
        <td>
          <button type="button" className={styles.linkButton} onClick={onToggle}>
            {open ? 'Close' : 'Set price'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}>
            <label className={styles.field}>
              <span>Monthly price in rupees (empty: not set)</span>
              <span className={styles.money}>
                ₹
                <input
                  inputMode="decimal"
                  aria-label={`${p.name} monthly price`}
                  value={price}
                  onChange={(ev) => setPrice(ev.target.value)}
                />
              </span>
            </label>
            <ReasonAction
              action="Save price"
              onRun={async (reason) => {
                const v = toPaise(price);
                if (v === undefined) {
                  setProblem('Enter a rupee amount with at most two decimals.');
                  throw new Error('invalid');
                }
                setProblem(null);
                await opsApi.setPlanPrice(p.key, v, reason);
                onDone();
              }}
            />
            <Problem text={problem} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── 5 Invoice Challenge ───────────────────────────────────────────────────

const LEAD_TONE: Record<ChallengeLead['status'], string> = {
  collecting: 'info',
  checking: 'info',
  complete: 'good',
  purged: 'neutral',
};

function Challenges() {
  const { data, error, reload } = useLoad(opsApi.challenges, 'challenges');
  const [open, setOpen] = useState<string | null>(null);
  if (!data)
    return (
      <Page title="5 Invoice Challenge">
        <State error={error} />
      </Page>
    );
  const rows = data.challenges;
  const n = (p: (c: ChallengeLead) => boolean) => rows.filter(p).length;
  const sum = (p: (c: ChallengeLead) => number) => rows.reduce((s, c) => s + p(c), 0);
  return (
    <Page
      title="5 Invoice Challenge"
      sub={
        data.enabled
          ? "Prospects' challenges: their results (counts and amounts) and follow-up. Documents stay in each challenge's own workspace and are never shown here."
          : 'The challenge is not enabled on this deployment (VEYRA_CHALLENGE).'
      }
    >
      <div className={styles.tiles}>
        <Tile label="Challenges started" value={num(rows.length)} />
        <Tile label="Completed" value={num(n((c) => c.completedAt !== null))} />
        <Tile
          label="Invoices submitted"
          value={num(sum((c) => c.invoicesSubmitted))}
          note={`${num(sum((c) => c.invoicesProcessed))} processed · ${num(sum((c) => c.invoicesFailed))} failed`}
        />
        <Tile
          label="Findings"
          value={num(sum((c) => c.attention))}
          note="Invoices needing attention"
        />
        <Tile
          label="Value requiring review"
          value={inr(
            sum((c) => c.reviewValuePaise ?? 0),
            '₹0.00',
          )}
        />
        <Tile label="Report downloads" value={num(sum((c) => c.reportDownloads))} />
        <Tile
          label="Walkthrough / pilot requests"
          value={`${n((c) => c.interest === 'walkthrough')} / ${n((c) => c.interest === 'pilot')}`}
          tone={n((c) => c.interest !== 'none' && c.followUp === 'new') ? 'warn' : undefined}
          note={`${n((c) => c.interest !== 'none' && c.followUp === 'new')} not yet contacted`}
        />
      </div>
      {rows.length === 0 ? (
        <Empty>No challenges yet.</Empty>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table} data-testid="challenges">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th className={styles.num}>Invoices</th>
                <th className={styles.num}>Records</th>
                <th className={styles.num}>Cleared / attention</th>
                <th className={styles.num}>Value requiring review</th>
                <th>Report</th>
                <th>Asked for</th>
                <th>Follow-up</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <ChallengeRow
                  key={c.id}
                  c={c}
                  open={open === c.id}
                  onToggle={() => setOpen(open === c.id ? null : c.id)}
                  onDone={() => {
                    setOpen(null);
                    reload();
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function ChallengeRow({
  c,
  open,
  onToggle,
  onDone,
}: {
  c: ChallengeLead;
  open: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const [next, setNext] = useState(c.followUp);
  const types = Object.entries(c.findings)
    .map(([k, v]) => `${FINDING_TYPE_LABEL[k] ?? k}: ${v}`)
    .join(' · ');
  return (
    <>
      <tr>
        <td>
          <span className={styles.strong}>{c.companyName || 'Details not given yet'}</span>
          <span className={styles.line}>
            {[c.contactName, c.email, c.phone].filter(Boolean).join(' · ')}
          </span>
          {(c.outlets !== null || c.erpSystem) && (
            <span className={styles.line}>
              {[c.outlets !== null ? `${c.outlets} outlet(s)` : null, c.erpSystem]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </td>
        <td>
          <Badge tone={LEAD_TONE[c.status]}>{c.status}</Badge>
        </td>
        <td className={styles.num}>
          {c.invoicesSubmitted}
          {c.invoicesFailed ? (
            <span className={styles.line}> ({c.invoicesFailed} failed)</span>
          ) : null}
        </td>
        <td className={styles.num}>{c.recordFiles}</td>
        <td className={styles.num}>
          {c.completedAt ? `${c.cleared} / ${c.attention}` : '—'}
          {types && <span className={styles.line}>{types}</span>}
        </td>
        <td className={styles.num}>{c.completedAt ? inr(c.reviewValuePaise, '—') : '—'}</td>
        <td>
          {c.reportDownloads
            ? `${c.reportDownloads}× · ${ago(c.reportDownloadedAt)}`
            : 'Not downloaded'}
          <span className={styles.line}>Email: {c.emailStatus.replace('_', ' ')}</span>
        </td>
        <td>
          {c.interest === 'none' ? '—' : <Badge tone="warn">{c.interest}</Badge>}
          {c.interestAt && <span className={styles.line}>{ago(c.interestAt)}</span>}
        </td>
        <td>
          <button type="button" className={styles.linkButton} onClick={onToggle}>
            {label(c.followUp)}
          </button>
        </td>
        <td>{at(c.createdAt)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={10}>
            <label className={styles.field}>
              <span>Follow-up status</span>
              <select value={next} onChange={(e) => setNext(e.target.value)}>
                {CHALLENGE_FOLLOW_UPS.map((f) => (
                  <option key={f} value={f}>
                    {label(f)}
                  </option>
                ))}
              </select>
            </label>
            <ReasonAction
              action="Save follow-up"
              onRun={(reason) => opsApi.setFollowUp(c.id, next, reason).then(onDone)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── System configuration ───────────────────────────────────────────────────

function Config() {
  const { data, error, reload } = useLoad(opsApi.config, 'config');
  const [bp, setBp] = useState<string | null>(null);
  if (!data)
    return (
      <Page title="System Configuration">
        <State error={error} />
      </Page>
    );
  const c = data;
  const value = bp ?? String(c.confidenceMinBp / 100);
  return (
    <Page
      title="System Configuration"
      sub={`Environment: ${c.environment}. Keys and secrets are never shown here; they are set in the deployment's environment.`}
    >
      <div className={styles.configGrid}>
        <section className={styles.panel} aria-labelledby="ai-title">
          <h2 id="ai-title" className={styles.h2}>
            AI reading
          </h2>
          <dl className={styles.dl}>
            <dt>Provider</dt>
            <dd>{c.ai.provider ?? 'None configured'}</dd>
            <dt>Model</dt>
            <dd className={styles.mono}>{c.ai.model ?? '—'}</dd>
            <dt>Backup models</dt>
            <dd className={styles.mono}>{c.ai.backupModels.join(', ') || '—'}</dd>
            <dt>API key</dt>
            <dd>
              <Badge tone={c.ai.configured ? 'good' : 'neutral'}>
                {c.ai.configured ? 'configured' : 'not configured'}
              </Badge>
            </dd>
            <dt>Local OCR fallback</dt>
            <dd>{c.ai.localOcr ? 'On' : 'Off'}</dd>
            <dt>Document AI</dt>
            <dd>Not used by this version</dd>
            <dt>Reader setting</dt>
            <dd className={styles.mono}>{c.ai.reader}</dd>
          </dl>
        </section>
        <section className={styles.panel} aria-labelledby="conf-title">
          <h2 id="conf-title" className={styles.h2}>
            Confidence threshold
          </h2>
          <p className={styles.muted}>
            A value read with less confidence than this is asked about instead of used. Between{' '}
            {c.confidenceRange.min / 100}% and {c.confidenceRange.max / 100}%.
          </p>
          <label className={styles.field}>
            <span>Threshold (%)</span>
            <input
              type="number"
              min={c.confidenceRange.min / 100}
              max={c.confidenceRange.max / 100}
              step={1}
              value={value}
              onChange={(ev) => setBp(ev.target.value)}
            />
          </label>
          <ReasonAction
            action="Save threshold"
            onRun={(reason) =>
              opsApi.setConfidence(Math.round(Number(value) * 100), reason).then(() => {
                setBp(null);
                reload();
              })
            }
          />
        </section>
        <section className={styles.panel} aria-labelledby="ret-title">
          <h2 id="ret-title" className={styles.h2}>
            Document retention
          </h2>
          <dl className={styles.dl}>
            <dt>Policy</dt>
            <dd>
              {c.retention.mode === 'KEEP'
                ? 'Keep documents'
                : c.retention.mode === 'DELETE_AFTER_DAYS'
                  ? `Delete ${c.retention.days} days after upload`
                  : 'Delete after the invoice is verified'}
            </dd>
          </dl>
          <p className={styles.muted}>Chosen by the customer in their settings.</p>
        </section>
        <section className={styles.panel} aria-labelledby="email-title">
          <h2 id="email-title" className={styles.h2}>
            Email
          </h2>
          <p>
            <Badge tone="neutral">not configured</Badge>
          </p>
          <p className={styles.muted}>{c.email.note}</p>
        </section>
        <section className={styles.panel} aria-labelledby="limits-title">
          <h2 id="limits-title" className={styles.h2}>
            Processing limits
          </h2>
          <dl className={styles.dl}>
            <dt>Largest upload</dt>
            <dd>{formatBytes(c.limits.maxUploadBytes)}</dd>
            {Object.entries(c.limits.rateLimitsPerMinute).map(([k, n]) => (
              <span key={k} className={styles.dlRow}>
                <dt>Rate limit: {k}</dt>
                <dd>{n} per minute</dd>
              </span>
            ))}
            <dt>Reported stuck after</dt>
            <dd>{c.limits.stuckAfterMinutes} minutes</dd>
            <dt>Automatic purchase orders</dt>
            <dd>
              {c.autoCreatePo.enabled
                ? `On, below ${formatInr(paise(c.autoCreatePo.belowPaise))}`
                : 'Off'}
            </dd>
            <dt>Organizations per deployment</dt>
            <dd>{c.organizationsPerDeployment}</dd>
          </dl>
        </section>
        <section className={styles.panel} aria-labelledby="health-title">
          <h2 id="health-title" className={styles.h2}>
            Health
          </h2>
          <p>
            <Badge tone={c.health?.status === 'ready' ? 'good' : 'bad'}>
              {c.health?.status ?? 'unknown'}
            </Badge>
          </p>
          {c.health?.checks !== undefined && (
            <pre className={styles.pre}>{JSON.stringify(c.health.checks, null, 2)}</pre>
          )}
        </section>
      </div>
    </Page>
  );
}

// ── Audit log ──────────────────────────────────────────────────────────────

function AuditLog() {
  const [f, setF] = useState({ q: '', event: '' });
  const { data, error } = useLoad(() => opsApi.audit(f), `audit:${JSON.stringify(f)}`);
  return (
    <Page
      title="Audit Log"
      sub="Every administrative change: when, who, what, on which entity, the value before and after, and why. Append-only."
    >
      <Filters>
        <label className={styles.searchBox}>
          <Icon name="search" size={14} />
          <input
            aria-label="Search audit log"
            placeholder="Entity, actor or reason"
            value={f.q}
            onChange={(ev) => setF({ ...f, q: ev.target.value })}
          />
        </label>
        <select
          aria-label="Action"
          value={f.event}
          onChange={(ev) => setF({ ...f, event: ev.target.value })}
        >
          <option value="">All actions</option>
          {COMMERCIAL_EVENTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </Filters>
      {data ? <EventTable rows={data} /> : <State error={error} />}
    </Page>
  );
}

const entityOf = (e: ApiCommercialEvent) =>
  e.subject ??
  (e.capability
    ? `${e.organizationId ? 'customer' : `plan:${e.planKey ?? ''}`} · ${e.capability}`
    : e.planKey
      ? `plan:${e.planKey}`
      : e.organizationId
        ? `customer:${e.organizationId}`
        : '—');

function EventTable({ rows }: { rows: ApiCommercialEvent[] }) {
  if (rows.length === 0) return <Empty>No changes recorded yet.</Empty>;
  const show = (e: ApiCommercialEvent, v: unknown) => {
    if (v === null || v === undefined) return '—';
    if (e.capability) return fmt(e.capability, v as EntitlementValue | null);
    if (e.event === 'plan.price_changed' && typeof v === 'number') return inr(v);
    if (typeof v === 'object' && v && 'status' in v)
      return String((v as { status: unknown }).status);
    if (typeof v === 'object' && v && 'active' in v)
      return (v as { active: boolean }).active ? 'enabled' : 'disabled';
    if (typeof v === 'object' && v && 'state' in v)
      return label(String((v as { state: unknown }).state));
    return JSON.stringify(v);
  };
  return (
    <div className={styles.scroll}>
      <table className={styles.table} data-testid="audit-log">
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Before → after</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{at(e.at)}</td>
              <td>{e.actor ?? '—'}</td>
              <td>
                <Badge tone="neutral">{e.event}</Badge>
              </td>
              <td className={styles.mono}>{entityOf(e)}</td>
              <td className={styles.change}>
                {show(e, e.oldValue)} → {show(e, e.newValue)}
                {e.expiresAt && <span className={styles.muted}> until {at(e.expiresAt)}</span>}
              </td>
              <td>{e.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── One customer's entitlements (reused from the commercial console) ───────

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
