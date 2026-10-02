import { useState, type FormEvent } from 'react';
import type { ApiUser } from '@veyra/shared';
import { changePassword, useAllowed, useSession } from '../../access/session';
import { notify } from '../../feedback/toasts';
import { PageHeader } from '../components/PageHeader';
import { api, ApiError, retention, type RetentionPolicy } from '../api/client';
import { SETTINGS_TABS, hrefFor, type SettingsTab } from '../router';
import { useCapabilities } from '../state/capabilities';
import { useResource } from '../state/data';
import { ROLE_TEXT } from '../state/roles';
import styles from './Settings.module.css';

const TAB_LABEL: Record<SettingsTab, string> = {
  account: 'Your account',
  team: 'Team',
  retention: 'Data retention',
  plan: 'Plan and usage',
};

const CUSTOMER_ROLES = ['ADMIN', 'FINANCE', 'REVIEWER'] as const;

const problemText = (e: unknown, fallback: string) =>
  e instanceof ApiError ? e.message : e instanceof Error && e.message ? e.message : fallback;

export function Settings({ tab }: { tab: SettingsTab }) {
  const canManage = useAllowed('users.manage');
  const tabs = SETTINGS_TABS.filter((t) => t !== 'team' || canManage);
  const shown = tabs.includes(tab) ? tab : 'account';
  return (
    <div className={styles.page}>
      <PageHeader title="Settings" sub="Your account, your team and your Veyrafy plan." />
      <nav className={styles.tabs} aria-label="Settings">
        {tabs.map((t) => (
          <a
            key={t}
            href={hrefFor({ name: 'settings', tab: t })}
            className={styles.tab}
            aria-current={t === shown ? 'page' : undefined}
          >
            {TAB_LABEL[t]}
          </a>
        ))}
      </nav>
      {shown === 'account' && <Account />}
      {shown === 'team' && <Team />}
      {shown === 'retention' && <Retention />}
      {shown === 'plan' && <Plan />}
    </div>
  );
}

function Account() {
  const session = useSession();
  const me = session.status === 'signedIn' ? session.session : null;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!me) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      notify.passwordChanged();
    } catch (err) {
      setProblem(problemText(err, 'The password could not be changed.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-labelledby="me-title">
        <h2 id="me-title" className={styles.cardTitle}>
          {me.user.name}
        </h2>
        <dl className={styles.facts}>
          <div>
            <dt>Email</dt>
            <dd>{me.user.email}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>
              {ROLE_TEXT[me.user.role]?.label ?? me.user.role}
              <span className={styles.sub}>{ROLE_TEXT[me.user.role]?.can}</span>
            </dd>
          </div>
          <div>
            <dt>Organization</dt>
            <dd>{me.organization.name}</dd>
          </div>
        </dl>
      </section>
      {me.demoSignIn ? (
        <p className={styles.note}>
          You signed in to the demo with its PIN, so there is no password to change here.
        </p>
      ) : (
        <form className={styles.card} onSubmit={(e) => void submit(e)}>
          <h2 className={styles.cardTitle}>Change your password</h2>
          <label className={styles.field}>
            <span>Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.currentTarget.value)}
              required
            />
          </label>
          <label className={styles.field}>
            <span>New password (at least 12 characters)</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={next}
              onChange={(e) => setNext(e.currentTarget.value)}
              required
            />
          </label>
          {problem && (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          )}
          <div>
            <button type="submit" className={styles.primary} disabled={busy}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Team() {
  const session = useSession();
  const myId = session.status === 'signedIn' ? session.session.user.id : null;
  const [version, setVersion] = useState(0);
  const { data: users, error } = useResource(() => api.users.list(), `users:${version}`);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', role: 'FINANCE', password: '' });

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
      notify.teamUpdated();
      setVersion((v) => v + 1);
      return true;
    } catch (e) {
      setProblem(problemText(e, 'That did not work.'));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.users.invite(form)))
      setForm({ name: '', email: '', role: 'FINANCE', password: '' });
  };

  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-labelledby="team-title">
        <h2 id="team-title" className={styles.cardTitle}>
          People who can use Veyrafy
        </h2>
        {!users ? (
          <p className={styles.note}>{error ? 'The team could not be loaded.' : 'Loading…'}</p>
        ) : (
          <ul className={styles.people}>
            {users.map((u: ApiUser) => (
              <li key={u.id} className={styles.person} data-active={u.active}>
                <span className={styles.personWho}>
                  <span className={styles.personName}>
                    {u.name}
                    {u.id === myId ? ' (you)' : ''}
                  </span>
                  <span className={styles.sub}>
                    {u.email}
                    {u.active ? '' : ' · access removed'}
                  </span>
                </span>
                <select
                  aria-label={`Role of ${u.name}`}
                  value={u.role}
                  disabled={busy || u.id === myId}
                  onChange={(e) => {
                    const role = e.currentTarget.value;
                    void run(() => api.users.update(u.id, { role }));
                  }}
                >
                  {CUSTOMER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_TEXT[r]?.label}
                    </option>
                  ))}
                </select>
                {u.id !== myId && (
                  <button
                    type="button"
                    className={styles.quiet}
                    disabled={busy}
                    onClick={() => void run(() => api.users.update(u.id, { active: !u.active }))}
                  >
                    {u.active ? 'Remove access' : 'Restore access'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form className={styles.card} onSubmit={(e) => void invite(e)}>
        <h2 className={styles.cardTitle}>Add someone</h2>
        <p className={styles.note}>
          Give them a temporary password privately (not by the same email as the address). They can
          change it under Settings once they have signed in.
        </p>
        <div className={styles.grid}>
          <label className={styles.field}>
            <span>Name</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
              required
              maxLength={120}
            />
          </label>
          <label className={styles.field}>
            <span>Work email</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.currentTarget.value })}
              required
            />
          </label>
          <label className={styles.field}>
            <span>Role</span>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.currentTarget.value })}
            >
              {CUSTOMER_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_TEXT[r]?.label}
                </option>
              ))}
            </select>
            <span className={styles.sub}>{ROLE_TEXT[form.role]?.can}</span>
          </label>
          <label className={styles.field}>
            <span>Temporary password (at least 12 characters)</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
              required
            />
          </label>
        </div>
        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
        <div>
          <button type="submit" className={styles.primary} disabled={busy}>
            Add to the team
          </button>
        </div>
      </form>
    </div>
  );
}

const DAYS_MIN = 1;
const DAYS_MAX = 3650;
const MODES: { mode: RetentionPolicy['mode']; label: string; hint: string }[] = [
  {
    mode: 'KEEP',
    label: 'Keep documents',
    hint: 'Original invoice documents stay in Veyrafy until someone deletes them.',
  },
  {
    mode: 'DELETE_AFTER_SUCCESS',
    label: 'Delete after successful processing',
    hint: 'Delete the original invoice after successful processing and delivery. An invoice that is waiting for you, failed, or could not be delivered keeps its document.',
  },
  {
    mode: 'DELETE_AFTER_DAYS',
    label: 'Delete after a number of days',
    hint: 'Keep the original for a set number of days after upload, then delete it, once the invoice has been processed and delivered successfully.',
  },
];

function Retention() {
  const canManage = useAllowed('settings.manage');
  const { data: current, error } = useResource(() => retention.get(), 'retention');
  const [draft, setDraft] = useState<RetentionPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!current) return <p className={styles.note}>{error ? 'Not available.' : 'Loading…'}</p>;
  const value = draft ?? current;
  const days = value.days ?? 30;
  const daysValid = Number.isInteger(days) && days >= DAYS_MIN && days <= DAYS_MAX;
  const changed =
    value.mode !== current.mode || (value.mode === 'DELETE_AFTER_DAYS' && days !== current.days);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await retention.set({
        mode: value.mode,
        days: value.mode === 'DELETE_AFTER_DAYS' ? days : null,
      });
      setDraft(null);
      notify.retentionSaved();
    } catch (err) {
      setProblem(problemText(err, 'The setting could not be saved.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={styles.card} onSubmit={(e) => void save(e)}>
      <p className={styles.eyebrow}>Data retention</p>
      <h2 className={styles.cardTitle}>Original invoice documents</h2>
      <p className={styles.note}>
        Choose how long Veyrafy keeps original invoice documents. Processing records and audit
        history are managed separately.
      </p>
      <p className={styles.note}>
        Veyrafy processes your invoices and lets you control how long original invoice documents are
        retained. A change applies to invoices uploaded from then on.
      </p>
      <fieldset className={styles.choices} disabled={!canManage || busy}>
        <legend className="visually-hidden">Retention</legend>
        {MODES.map((m) => (
          <label key={m.mode} className={styles.choice} data-checked={value.mode === m.mode}>
            <input
              type="radio"
              name="retention"
              value={m.mode}
              checked={value.mode === m.mode}
              onChange={() =>
                setDraft({ mode: m.mode, days: m.mode === 'DELETE_AFTER_DAYS' ? days : null })
              }
            />
            <span>
              <span className={styles.choiceLabel}>{m.label}</span>
              <span className={styles.sub}>{m.hint}</span>
              {m.mode === 'DELETE_AFTER_DAYS' && value.mode === 'DELETE_AFTER_DAYS' && (
                <span className={styles.days}>
                  Delete after
                  <input
                    type="number"
                    min={DAYS_MIN}
                    max={DAYS_MAX}
                    step={1}
                    value={days}
                    aria-label="Days after upload"
                    onChange={(e) =>
                      setDraft({ mode: 'DELETE_AFTER_DAYS', days: Number(e.currentTarget.value) })
                    }
                  />
                  days
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {!daysValid && value.mode === 'DELETE_AFTER_DAYS' && (
        <p className={styles.problem} role="alert">
          Choose between {DAYS_MIN} and {DAYS_MAX} days.
        </p>
      )}
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      {canManage ? (
        <div>
          <button
            type="submit"
            className={styles.primary}
            disabled={busy || !changed || (value.mode === 'DELETE_AFTER_DAYS' && !daysValid)}
          >
            Save
          </button>
        </div>
      ) : (
        <p className={styles.note}>Only an administrator can change this.</p>
      )}
    </form>
  );
}

function Plan() {
  const caps = useCapabilities();
  if (!caps) return <p className={styles.note}>Loading…</p>;
  const limits = caps.capabilities.filter((c) => c.type === 'LIMIT');
  const features = caps.capabilities.filter((c) => c.type === 'BOOLEAN');
  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-labelledby="plan-title">
        <h2 id="plan-title" className={styles.cardTitle}>
          Your Veyrafy plan
        </h2>
        <p className={styles.note}>
          What your plan includes and how much of it you have used. To change your plan, contact
          Veyrafy.
        </p>
      </section>
      {limits.length > 0 && (
        <section className={styles.card} aria-labelledby="usage-title">
          <h2 id="usage-title" className={styles.cardTitle}>
            Usage
          </h2>
          <ul className={styles.meters}>
            {limits.map((c) => {
              const used = c.used ?? null;
              const limit = c.limit ?? null;
              const pct = used !== null && limit ? Math.min(100, (used / limit) * 100) : 0;
              return (
                <li key={c.key}>
                  <span className={styles.meterLabel}>
                    {c.name}
                    <span>
                      {used ?? '—'}
                      {limit === null ? ' · no limit' : ` of ${limit}`}
                    </span>
                  </span>
                  {limit !== null && limit > 0 && (
                    <span className={styles.meter} aria-hidden="true">
                      <span style={{ width: `${pct}%` }} data-full={pct >= 90} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {features.length > 0 && (
        <section className={styles.card} aria-labelledby="features-title">
          <h2 id="features-title" className={styles.cardTitle}>
            Included
          </h2>
          <ul className={styles.features}>
            {features.map((c) => (
              <li key={c.key} data-on={c.available}>
                <span aria-hidden="true">{c.available ? '✓' : '–'}</span>
                {c.name}
                {!c.available && <span className={styles.sub}> (not in your plan)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
