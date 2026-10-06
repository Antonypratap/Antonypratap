import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  FINDING_TYPE_LABEL,
  type ApiChallengeConfig,
  type ApiChallengeInvoice,
  type ApiChallengeStage,
  type ApiChallengeState,
} from '@veyra/shared';
import { Button, Icon, Logo } from '../design-system';
import { ApiError } from '../product/api/client';
import { EvidenceList } from '../product/components/Finding';
import { inr } from '../product/format';
import { CONTACT_PHONE, CONTACT_PHONE_HREF, WEBSITE_ADDRESS } from '../site/host';
import { LEGAL_PATHS } from '../site/legal';
import { challengeApi, takeLinkSecret } from './api';
import styles from './Challenge.module.css';

/**
 * The 5 Invoice Challenge: a prospect puts up to five real supplier invoices (and, if they have
 * them, their purchasing records) through the real Veyrafy checks. Upload first (one consent, no
 * form), then the checks, then the headline result; the full findings, evidence and report open
 * once they say who the report is for (the server sends nothing more before that). Every result
 * on these screens is what the server's engine recorded; nothing animates progress the server
 * has not reported.
 */
const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** On the website (no database): the landing only; starting goes to `elsewhere`. */
const WEBSITE_CONFIG: ApiChallengeConfig = {
  enabled: true,
  maxInvoices: 5,
  aiProvider: null,
  retentionDays: 30,
  resultsHours: 24,
  templates: [],
};
/** The server says this browser has already taken the challenge (one per browser). */
const alreadyTaken = (e: unknown) => e instanceof ApiError && e.details.used === true;

export function ChallengeApp({ elsewhere }: { elsewhere?: string } = {}) {
  const [config, setConfig] = useState<ApiChallengeConfig | null | 'off'>(
    elsewhere ? WEBSITE_CONFIG : null,
  );
  /** Whether this browser has a challenge: unknown until the server says (null). */
  const [state, setState] = useState<ApiChallengeState | null>(null);
  const [known, setKnown] = useState(Boolean(elsewhere));
  const [problem, setProblem] = useState<string | null>(null);
  const [used, setUsed] = useState(false);

  useEffect(() => {
    if (!elsewhere) challengeApi.config().then(setConfig, () => setConfig('off'));
  }, [elsewhere]);

  /** No challenge in this browser (or the link expired): a fresh start. */
  const failed = useCallback((e: unknown) => {
    if (alreadyTaken(e)) setUsed(true);
    if (e instanceof ApiError && e.status === 404) setState(null);
    else setProblem(errorText(e, 'Your challenge could not be loaded.'));
    setKnown(true);
  }, []);
  const refresh = useCallback(async () => {
    try {
      setState(await challengeApi.me());
      setProblem(null);
    } catch (e) {
      failed(e);
    }
  }, [failed]);

  useEffect(() => {
    if (elsewhere) return;
    let live = true;
    // An e-mailed results link opens the challenge in this browser; otherwise, ask the server.
    const secret = takeLinkSecret();
    (secret ? challengeApi.claim(secret) : challengeApi.me()).then(
      (s) => {
        if (!live) return;
        setState(s);
        setKnown(true);
      },
      (e: unknown) => live && failed(e),
    );
    return () => {
      live = false;
    };
  }, [elsewhere, failed]);

  // The server is asked again while it is working; nothing on screen moves on its own.
  const working =
    !!state &&
    (state.status === 'checking' ||
      state.invoices.some((i) => i.phase === 'reading' || i.phase === 'checking'));
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [working, refresh]);

  useEffect(() => {
    document.title = '5 Invoice Challenge · Veyrafy';
  }, []);

  let body: ReactNode;
  if (config === null) body = <p className={styles.muted}>Loading…</p>;
  else if (config === 'off') body = <NotOpen />;
  else if (!known)
    body = problem ? (
      <p className={styles.problem}>{problem}</p>
    ) : (
      <p className={styles.muted}>Loading…</p>
    );
  else if (used && !state) body = <AlreadyTaken />;
  else if (elsewhere && !state)
    body = <Landing config={config} onStart={() => window.location.assign(elsewhere)} />;
  else if (!state || state.status === 'collecting')
    body = <Upload state={state} config={config} onState={setState} onUsed={() => setUsed(true)} />;
  else if (state.status === 'checking') body = <Checking state={state} />;
  else if (!state.unlocked && state.status !== 'purged')
    body = <Headline state={state} onState={setState} />;
  else body = <Results state={state} onState={setState} />;

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <a href={WEBSITE_ADDRESS} className={styles.brand} aria-label="Veyrafy">
          <Logo />
        </a>
        <span className={styles.tag}>5 Invoice Challenge</span>
      </header>
      {!elsewhere && config && config !== 'off' && known && state?.status !== 'purged' && (
        <Steps state={state} />
      )}
      <main className={styles.main} id="main">
        {problem && state && <p className={styles.problem}>{problem}</p>}
        {body}
      </main>
      <footer className={styles.foot}>
        <span>
          Your invoices are confidential. They are used only for this challenge and deleted{' '}
          {config && config !== 'off' ? config.resultsHours : 24} hours after you see your results.
        </span>
        <span>Prepared by Veyrafy</span>
      </footer>
    </div>
  );
}

/** The challenge is switched off on this deployment: say so, and how to reach Veyrafy. */
function NotOpen() {
  return (
    <section className={styles.narrow}>
      <h1 className={styles.h1}>The 5 Invoice Challenge isn’t open right now.</h1>
      <p className={styles.lede}>
        Call Veyrafy on <a href={CONTACT_PHONE_HREF}>{CONTACT_PHONE}</a> and we will check your
        invoices with you, or <a href={WEBSITE_ADDRESS}>go back to veyrafy.com</a>.
      </p>
    </section>
  );
}

/** One challenge per browser: this one has taken it already. */
function AlreadyTaken() {
  return (
    <section className={styles.narrow}>
      <h1 className={styles.h1}>You’ve already taken the 5 Invoice Challenge.</h1>
      <p className={styles.lede}>
        Each company gets one challenge, and your report was e-mailed to you. To check more
        invoices, call Veyrafy on <a href={CONTACT_PHONE_HREF}>{CONTACT_PHONE}</a> and we will set
        up a walkthrough or a pilot with your own records.
      </p>
    </section>
  );
}

// ── Steps ──────────────────────────────────────────────────────────────────

function Steps({ state }: { state: ApiChallengeState | null }) {
  const at = !state || state.status === 'collecting' ? 0 : state.status === 'checking' ? 1 : 2;
  const steps = ['Upload invoices', 'Checks', 'Results'];
  return (
    <ol className={styles.steps} aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} data-state={i < at ? 'done' : i === at ? 'now' : 'next'}>
          <span className={styles.stepDot} aria-hidden="true">
            {i < at ? <Icon name="check" size={11} strokeWidth={3} /> : i + 1}
          </span>
          {s}
        </li>
      ))}
    </ol>
  );
}

// ── Landing (the website) ──────────────────────────────────────────────────

const CHECKS = [
  ['Calculations', 'Line amounts, tax and totals add up.'],
  ['GST and GSTINs', 'Valid GSTINs, the right tax type and rate, billed to you.'],
  ['Duplicates', 'The same invoice submitted twice.'],
  ['Rates', 'Invoice rate against the agreed purchase order rate.'],
  ['Quantities', 'Billed quantity against what was ordered and received.'],
  ['Receipts', 'Whether the goods were recorded as received.'],
];

function Landing({ config, onStart }: { config: ApiChallengeConfig; onStart: () => void }) {
  return (
    <>
      <section className={styles.hero} aria-labelledby="challenge-title">
        <p className={styles.eyebrow}>5 Invoice Challenge</p>
        <h1 id="challenge-title" className={styles.display}>
          Put 10 real invoices through Veyrafy.
        </h1>
        <p className={styles.lede}>
          See what gets caught before you pay. Drop in your supplier invoices and the record your
          accounting or ERP system holds for them: Veyrafy compares the two, line by line.
        </p>
        <div className={styles.ctaRow}>
          <Button size="lg" arrow onClick={onStart}>
            Check my invoices
          </Button>
        </div>
        <p className={styles.reassure}>
          Free · No sign-up · Up to {config.maxInvoices} invoices · Results in minutes
        </p>
      </section>

      <section className={styles.band} aria-labelledby="how-title">
        <h2 id="how-title" className={styles.h2}>
          How it works
        </h2>
        <ol className={styles.how}>
          <li>
            <span className={styles.howNum}>1</span>
            <strong>Drop in up to {config.maxInvoices} supplier invoices</strong>
            <span>PDF, JPG or PNG. Scans and phone photos are fine. No form to fill in first.</span>
          </li>
          <li>
            <span className={styles.howNum}>2</span>
            <strong>Compare with your system</strong>
            <span>
              Add your system’s record of them: a JSON, Excel or CSV export from Tally, Zoho Books,
              SAP or any ERP.
            </span>
          </li>
          <li>
            <span className={styles.howNum}>3</span>
            <strong>See what was caught</strong>
            <span>What cleared, what needs attention, and the evidence for each finding.</span>
          </li>
        </ol>
      </section>

      <section className={styles.band} aria-labelledby="checks-title">
        <h2 id="checks-title" className={styles.h2}>
          What Veyrafy checks
        </h2>
        <dl className={styles.checkGrid}>
          {CHECKS.map(([t, d]) => (
            <div key={t}>
              <dt>{t}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.note}>
          Rates, quantities and amounts are compared with your system’s record. Without it, Veyrafy
          verifies each invoice on its own (calculations, GST, GSTINs, duplicates), and the results
          say so.
        </p>
      </section>
    </>
  );
}

// ── Upload: invoices, and (optional) records and GSTIN, on one screen ──────

/** What a business's own record of its invoices can come as (all read by Veyrafy today). */
const FORMATS = [
  { badge: 'JSON', tone: 'json', label: 'JSON', note: 'ERP or API export' },
  { badge: 'XLSX', tone: 'xlsx', label: 'Excel', note: 'Purchase register or bills' },
  { badge: 'CSV', tone: 'csv', label: 'CSV', note: 'Any register export' },
] as const;
/** Systems businesses commonly export from (exports are read; no live connection here). */
const SYSTEMS = [
  'Tally Prime',
  'Zoho Books',
  'Busy',
  'Marg ERP',
  'SAP Business One',
  'Microsoft Dynamics 365',
  'Oracle NetSuite',
  'QuickBooks',
  'ERPNext',
];
const monogram = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
const REGISTER_XLSX = 'Veyrafy-Invoice-Register.xlsx';
const REGISTER_CSV = 'Veyrafy-Invoice-Register.csv';

/** A file-type icon: a page with a folded corner and the format on a coloured band. */
function FileBadge({ label, tone }: { label: string; tone: 'json' | 'xlsx' | 'csv' }) {
  return (
    <svg className={styles.fileBadge} data-tone={tone} viewBox="0 0 40 48" aria-hidden="true">
      <path
        d="M6 2h20l10 10v32a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
        className={styles.badgePage}
      />
      <path d="M26 2v8a2 2 0 0 0 2 2h8" className={styles.badgeFold} />
      <rect x="0" y="26" width="34" height="13" rx="2.5" className={styles.badgeBand} />
      <text x="17" y="35.5" textAnchor="middle" className={styles.badgeText}>
        {label}
      </text>
    </svg>
  );
}

function Upload({
  state,
  config,
  onState,
  onUsed,
}: {
  state: ApiChallengeState | null;
  config: ApiChallengeConfig;
  onState: (s: ApiChallengeState) => void;
  onUsed: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ name: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [gstinEdit, setGstinEdit] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const records = useRef<HTMLInputElement>(null);
  const invoices = state?.invoices ?? [];
  const max = state?.maxInvoices ?? config.maxInvoices;
  const room = max - invoices.length;
  const agreed = Boolean(state) || consent;

  const add = async (files: File[]) => {
    if (!agreed) {
      setProblem('Tick the box above first, so Veyrafy may read your invoices.');
      return;
    }
    setProblem(null);
    const take = files.slice(0, Math.max(0, room));
    const over = files.slice(take.length);
    setErrors(
      over.map((f) => ({
        name: f.name,
        message: `Not added: the challenge takes ${max} invoices.`,
      })),
    );
    setUploading(take.map((f) => f.name));
    // The challenge starts with the first file (on the consent just given).
    if (!state && take.length > 0) {
      try {
        onState(await challengeApi.create());
      } catch (e) {
        setUploading([]);
        if (alreadyTaken(e)) onUsed();
        else setProblem(errorText(e, 'The challenge could not be started.'));
        return;
      }
    }
    for (const f of take) {
      try {
        onState(await challengeApi.uploadInvoice(f));
      } catch (e) {
        setErrors((x) => [...x, { name: f.name, message: errorText(e, 'Could not be uploaded.') }]);
      }
      setUploading((u) => u.filter((n) => n !== f.name));
    }
  };
  const act = async (fn: () => Promise<ApiChallengeState>) => {
    try {
      onState(await fn());
    } catch (e) {
      setErrors((x) => [...x, { name: 'Invoice', message: errorText(e, 'That did not work.') }]);
    }
  };
  const addRecords = async (f: File) => {
    setBusy(true);
    setProblem(null);
    try {
      onState(await challengeApi.addRecords(f));
    } catch (e) {
      setProblem(errorText(e, 'This file could not be used.'));
    } finally {
      setBusy(false);
    }
  };
  const top = state?.gstinCandidates[0];
  const gstin = gstinEdit ?? state?.gstin ?? top?.gstin ?? '';
  const reading = invoices.filter((i) => i.phase === 'reading').length + uploading.length;
  const usable = invoices.filter((i) => i.phase !== 'failed').length;
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onState(await challengeApi.start(gstin));
    } catch (e) {
      setProblem(errorText(e, 'The checks could not be started.'));
      setBusy(false);
    }
  };
  const all = config.templates.find((t) => t.file === 'Veyrafy-Master-Data-Import.xlsx');
  const fileCount = state?.records.files.length ?? 0;

  return (
    <section aria-labelledby="upload-title">
      <h1 id="upload-title" className={styles.h1}>
        Drop in up to {max} supplier invoices
      </h1>
      <p className={styles.lede}>
        PDF, JPG or PNG, one invoice per file. Scans and phone photos are fine. Veyrafy starts
        reading them as soon as they arrive.
      </p>
      {!state && (
        <label className={styles.consent}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked);
              setProblem(null);
            }}
          />
          <span>
            I’m authorised by my company to share these invoices, and I agree that Veyrafy reads
            them to check them
            {config.aiProvider ? `, using ${config.aiProvider}` : ''}. They stay confidential and
            are deleted {config.resultsHours} hours after I see the results. One challenge per
            company. See the{' '}
            <a href={LEGAL_PATHS.privacy} target="_blank" rel="noopener">
              privacy notice
            </a>{' '}
            and{' '}
            <a href={LEGAL_PATHS.terms} target="_blank" rel="noopener">
              terms
            </a>
            .
          </span>
        </label>
      )}
      <div
        className={styles.drop}
        data-full={room <= 0}
        data-off={!agreed}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void add([...e.dataTransfer.files]);
        }}
      >
        <Icon name="upload" size={22} />
        <p>
          <strong>{room > 0 ? 'Drop invoices here' : `All ${max} invoices added`}</strong>
          {room > 0 && <span> or </span>}
          {room > 0 && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() =>
                agreed
                  ? input.current?.click()
                  : setProblem('Tick the box above first, so Veyrafy may read your invoices.')
              }
            >
              choose files
            </button>
          )}
        </p>
        <p className={styles.muted}>
          {invoices.length} of {max} added
        </p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          multiple
          hidden
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      <ul className={styles.fileList} aria-live="polite">
        {invoices.map((i) => (
          <InvoiceRow
            key={i.id}
            invoice={i}
            onRemove={() => void act(() => challengeApi.removeInvoice(i.id))}
            onRetry={() => void act(() => challengeApi.retryInvoice(i.id))}
          />
        ))}
        {uploading.map((n) => (
          <li key={`u-${n}`} className={styles.fileRow} data-state="working">
            <span className={styles.fileMark}>
              <Spinner />
            </span>
            <span className={styles.fileMain}>
              <span className={styles.fileName}>{n}</span>
              <span className={styles.fileMeta}>Uploading…</span>
            </span>
          </li>
        ))}
        {errors.map((e, k) => (
          <li key={`e-${k}`} className={styles.fileRow} data-state="failed">
            <span className={styles.fileMark}>!</span>
            <span className={styles.fileMain}>
              <span className={styles.fileName}>{e.name}</span>
              <span className={styles.fileMeta}>{e.message}</span>
            </span>
          </li>
        ))}
      </ul>

      {state && invoices.length > 0 && (
        <>
          <section className={styles.system} aria-labelledby="system-title">
            <div className={styles.systemHead}>
              <h2 id="system-title" className={styles.h3}>
                Compare with your system
              </h2>
              <span className={styles.recommended}>Recommended</span>
            </div>
            <p className={styles.systemLede}>
              Upload the record your accounting or ERP system already holds for these invoices.
              Veyrafy compares each invoice with it, line by line: item, quantity, rate, amount, GST
              and total.
            </p>
            <div className={styles.formatGrid}>
              {FORMATS.map((f) => (
                <button
                  key={f.label}
                  type="button"
                  className={styles.formatTile}
                  disabled={busy || fileCount >= 6}
                  onClick={() => records.current?.click()}
                >
                  <FileBadge label={f.badge} tone={f.tone} />
                  <span className={styles.formatName}>{f.label}</span>
                  <span className={styles.formatNote}>{f.note}</span>
                </button>
              ))}
            </div>
            <input
              ref={records}
              type="file"
              hidden
              accept=".xlsx,.csv,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addRecords(f);
                e.target.value = '';
              }}
            />
            <p className={styles.formatHelp}>
              One row per invoice line, with the invoice number, supplier and item, and the
              quantity, rate, amount, GST and total where you have them. Column names such as “Bill
              No”, “Party”, “Qty” and “Taxable Value” are recognised. Template:{' '}
              <a href={challengeApi.templateUrl(REGISTER_XLSX)} download>
                Excel
              </a>{' '}
              ·{' '}
              <a href={challengeApi.templateUrl(REGISTER_CSV)} download>
                CSV
              </a>
              {all && (
                <>
                  {' '}
                  · purchase orders and goods receipts:{' '}
                  <a href={challengeApi.templateUrl(all.file)} download>
                    records template
                  </a>
                </>
              )}
            </p>
            {fileCount > 0 && (
              <ul className={styles.fileList}>
                {state.records.files.map((f, k) => (
                  <li key={k} className={styles.fileRow} data-state="done">
                    <span className={styles.fileMark}>
                      <Icon name="check" size={13} strokeWidth={2.8} />
                    </span>
                    <span className={styles.fileMain}>
                      <span className={styles.fileName}>{f.name}</span>
                      <span className={styles.fileMeta}>{f.summary}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className={styles.systems}>
              <p className={styles.systemsLabel}>
                Using one of these? Export your purchase register or bills and upload the file.
              </p>
              <ul className={styles.systemList}>
                {SYSTEMS.map((name) => (
                  <li key={name}>
                    <span className={styles.monogram} aria-hidden="true">
                      {monogram(name)}
                    </span>
                    {name}
                  </li>
                ))}
              </ul>
              <p className={styles.formatNote}>
                Want a live connection instead of a file? Ask us about a pilot.
              </p>
            </div>
          </section>

          <div className={styles.panel}>
            <h2 className={styles.h3}>Your GSTIN</h2>
            <p className={styles.muted}>
              Veyrafy checks every invoice is billed to you.
              {top
                ? ` ${top.invoices} of your invoices are billed to ${top.gstin}.`
                : reading > 0
                  ? ' It is read from your invoices as they arrive.'
                  : ''}
            </p>
            <label className={styles.field}>
              <span className={styles.label}>GSTIN</span>
              <input
                className={styles.input}
                value={gstin}
                onChange={(e) => setGstinEdit(e.target.value.toUpperCase())}
                maxLength={15}
                spellCheck={false}
              />
            </label>
          </div>
        </>
      )}

      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      {state && invoices.length > 0 && (
        <div className={styles.actions}>
          <Button
            size="lg"
            arrow
            disabled={busy || reading > 0 || usable === 0 || gstin.length !== 15}
            onClick={() => void start()}
          >
            Check my {usable} invoice{usable === 1 ? '' : 's'}
          </Button>
          {reading > 0 ? (
            <span className={styles.muted}>
              Reading {reading} invoice{reading === 1 ? '' : 's'}…
            </span>
          ) : gstin.length !== 15 ? (
            <span className={styles.muted}>Enter your GSTIN to start.</span>
          ) : null}
        </div>
      )}
      {state && usable > 0 && fileCount === 0 && (
        <p className={styles.nudge} role="note">
          <strong>Your system’s record is not added.</strong> Without it, each invoice is checked on
          its own (calculations, GST, duplicates). Add it under “Compare with your system” to
          compare items, quantities, rates and amounts.
        </p>
      )}
    </section>
  );
}

function Input({
  label,
  optional,
  hint,
  ...input
}: {
  label: string;
  optional?: boolean;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles.field}>
      <span className={styles.label}>
        {label}
        {optional && <em> optional</em>}
      </span>
      <input className={styles.input} {...input} />
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}

function InvoiceRow({
  invoice: i,
  onRemove,
  onRetry,
}: {
  invoice: ApiChallengeInvoice;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const failed = i.phase === 'failed';
  const working = i.phase === 'reading';
  return (
    <li className={styles.fileRow} data-state={failed ? 'failed' : working ? 'working' : 'done'}>
      <span className={styles.fileMark}>
        {working ? <Spinner /> : failed ? '!' : <Icon name="check" size={13} strokeWidth={2.8} />}
      </span>
      <span className={styles.fileMain}>
        <span className={styles.fileName}>
          {failed || working || !i.supplier
            ? i.filename
            : `${i.supplier}${i.number ? ` · ${i.number}` : ''}`}
        </span>
        <span className={styles.fileMeta}>
          {working
            ? 'Reading invoice details…'
            : failed
              ? (i.failure?.reason ?? 'Could not be processed.')
              : `${i.filename}${i.totalPaise !== null ? ` · ${inr(i.totalPaise)}` : ''}`}
        </span>
      </span>
      <span className={styles.fileActions}>
        {i.canRetry && (
          <button type="button" className={styles.linkButton} onClick={onRetry}>
            Try again
          </button>
        )}
        {i.canRemove && (
          <button type="button" className={styles.linkButton} onClick={onRemove}>
            Remove
          </button>
        )}
      </span>
    </li>
  );
}

// ── Checking ───────────────────────────────────────────────────────────────

const STAGE_ICON: Record<ApiChallengeStage['status'], ReactNode> = {
  done: <Icon name="check" size={12} strokeWidth={3} />,
  running: <Spinner />,
  waiting: <span className={styles.dotIdle} />,
  skipped: <span className={styles.dash}>–</span>,
  failed: <span>!</span>,
};

function Checking({ state }: { state: ApiChallengeState }) {
  const done = state.invoices.filter((i) => i.outcome !== 'processing').length;
  return (
    <section aria-labelledby="checking-title">
      <h1 id="checking-title" className={styles.h1}>
        Checking your invoices
      </h1>
      <p className={styles.lede} aria-live="polite">
        {done} of {state.invoices.length} checked. Each step is marked complete only when Veyrafy
        has finished it. This usually takes a minute or two; your results will wait here.
      </p>
      <ul className={styles.checkList}>
        {state.invoices.map((i) => (
          <li key={i.id} className={styles.checkItem}>
            <p className={styles.checkTitle}>
              {i.supplier ?? i.filename}
              {i.number && <span className={styles.muted}> · {i.number}</span>}
            </p>
            <ol className={styles.stages}>
              {i.stages.map((s) => (
                <li key={s.key} data-status={s.status} title={s.note ?? undefined}>
                  <span className={styles.stageMark}>{STAGE_ICON[s.status]}</span>
                  {s.label}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── The headline result, then who the report is for ───────────────────────

/**
 * What the checks found, in numbers and kinds of finding (the server sends no more than this
 * yet), and the details that open everything: each finding with its evidence, and the report.
 */
function Headline({
  state,
  onState,
}: {
  state: ApiChallengeState;
  onState: (s: ApiChallengeState) => void;
}) {
  const s = state.summary;
  const [f, setF] = useState({ email: '', companyName: '', contactName: '', phone: '' });
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!s) return null;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const kinds = Object.entries(s.byType)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    challengeApi
      .details({
        email: f.email.trim(),
        companyName: f.companyName.trim(),
        ...(f.contactName.trim() ? { contactName: f.contactName.trim() } : {}),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
      })
      .then(onState)
      .catch((err: unknown) =>
        setProblem(
          err instanceof ApiError && err.code === 'VALIDATION'
            ? 'Check the details: a valid work email and your company name are needed.'
            : errorText(err, 'That did not go through. Please try again.'),
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      <section className={styles.resultHero} aria-labelledby="headline-title">
        <p className={styles.eyebrow}>Your invoices are checked</p>
        <h1 id="headline-title" className={styles.h1}>
          {s.attention > 0
            ? `Veyrafy found ${s.attention} invoice${s.attention === 1 ? '' : 's'} to look at before you pay`
            : `All ${s.checked} invoices passed Veyrafy’s checks`}
        </h1>
        <dl className={styles.kpis}>
          <div>
            <dt>Invoices checked</dt>
            <dd>{s.checked}</dd>
          </div>
          <div>
            <dt>Invoice value</dt>
            <dd data-wide="">{inr(s.totalPaise)}</dd>
          </div>
          <div>
            <dt>Cleared</dt>
            <dd data-tone="good">{s.cleared}</dd>
          </div>
          <div>
            <dt>Need attention</dt>
            <dd data-tone={s.attention ? 'attention' : undefined}>{s.attention}</dd>
          </div>
        </dl>
        {s.attention > 0 && (
          <p className={styles.review}>
            <strong>{inr(s.reviewValuePaise)}</strong> of invoice value to review before payment
          </p>
        )}
        {kinds.length > 0 && (
          <ul className={styles.kinds}>
            {kinds.map(([type, n]) => (
              <li key={type}>
                <strong>{n}</strong> {FINDING_TYPE_LABEL[type as never] ?? 'Other finding'}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.gate} aria-labelledby="gate-title">
        <h2 id="gate-title" className={styles.h2}>
          {s.attention > 0
            ? 'See each finding, with the evidence from your invoice'
            : 'Get your verification report'}
        </h2>
        <p className={styles.lede}>
          Tell us who the report is for. You see the full results at once, and we e-mail you the PDF
          report.
        </p>
        <form className={styles.form} onSubmit={submit}>
          <div className={styles.pair}>
            <Input
              label="Work email"
              type="email"
              value={f.email}
              onChange={set('email')}
              required
              autoComplete="email"
            />
            <Input
              label="Company name"
              value={f.companyName}
              onChange={set('companyName')}
              required
              autoComplete="organization"
            />
          </div>
          {more ? (
            <div className={styles.pair}>
              <Input
                label="Your name"
                optional
                value={f.contactName}
                onChange={set('contactName')}
                autoComplete="name"
              />
              <Input
                label="Phone"
                optional
                type="tel"
                value={f.phone}
                onChange={set('phone')}
                autoComplete="tel"
              />
            </div>
          ) : (
            <button type="button" className={styles.linkButton} onClick={() => setMore(true)}>
              Add your name and phone (optional)
            </button>
          )}
          {problem && (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          )}
          <div className={styles.actions}>
            <Button type="submit" size="lg" arrow disabled={busy}>
              {busy ? 'Opening…' : 'Show my results'}
            </Button>
          </div>
          <p className={styles.muted}>
            Used only to send you this report and to follow up about it. Never shared.
          </p>
        </form>
      </section>
    </>
  );
}

// ── Results ────────────────────────────────────────────────────────────────

function Results({
  state,
  onState,
}: {
  state: ApiChallengeState;
  onState: (s: ApiChallengeState) => void;
}) {
  const s = state.summary;
  const [open, setOpen] = useState<ApiChallengeInvoice | null>(null);
  const [showCleared, setShowCleared] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const attention = state.invoices.filter((i) => i.outcome === 'review' || i.outcome === 'confirm');
  const cleared = state.invoices.filter((i) => i.outcome === 'cleared');
  const failed = state.invoices.filter((i) => i.outcome === 'failed');
  if (state.status === 'purged')
    return (
      <>
        <section className={styles.narrow}>
          <h1 className={styles.h1}>Your 5 Invoice Challenge is complete</h1>
          <p className={styles.lede}>
            {s
              ? `${s.checked} invoice${s.checked === 1 ? ' was' : 's were'} checked; ${s.attention} needed attention. `
              : ''}
            Your invoices have been deleted, as agreed.
            {state.unlocked ? ' Your report was e-mailed to you as a PDF.' : ''}
          </p>
        </section>
        {state.unlocked && <NextStep state={state} onState={onState} />}
      </>
    );
  if (!s) return null;
  const download = async () => {
    setDownloading(true);
    setProblem(null);
    try {
      await challengeApi.downloadReport(state.companyName ?? 'Report');
    } catch (e) {
      setProblem(errorText(e, 'The report could not be prepared.'));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <>
      <section className={styles.resultHero} aria-labelledby="results-title">
        {state.companyName && <p className={styles.eyebrow}>{state.companyName}</p>}
        <h1 id="results-title" className={styles.h1}>
          Invoice check complete
        </h1>
        <dl className={styles.kpis}>
          <div>
            <dt>Invoices checked</dt>
            <dd>{s.checked}</dd>
          </div>
          <div>
            <dt>Invoice value</dt>
            <dd data-wide="">{inr(s.totalPaise)}</dd>
          </div>
          <div>
            <dt>Cleared</dt>
            <dd data-tone="good">{s.cleared}</dd>
          </div>
          <div>
            <dt>Need attention</dt>
            <dd data-tone={s.attention ? 'attention' : undefined}>{s.attention}</dd>
          </div>
        </dl>
        {s.attention > 0 ? (
          <p className={styles.review}>
            <strong>{inr(s.reviewValuePaise)}</strong> of invoice value requires review
          </p>
        ) : (
          <p className={styles.reviewClear}>Nothing needs your attention.</p>
        )}
        <p className={styles.basis}>
          {state.records.files.length
            ? `Checked against your records (${state.records.files.map((f) => f.summary).join('; ')}).`
            : 'No records were provided: each invoice was verified on its own. Rates, quantities and receipts were not compared.'}
          {s.totalUnread
            ? ` ${s.totalUnread} invoice total${s.totalUnread === 1 ? '' : 's'} could not be read and ${s.totalUnread === 1 ? 'is' : 'are'} not included in the amounts.`
            : ''}
        </p>
        <div className={styles.actions}>
          <Button arrow onClick={() => void download()} disabled={downloading}>
            {downloading ? 'Preparing the report…' : 'Download the report (PDF)'}
          </Button>
          {state.emailStatus === 'sent' && (
            <span className={styles.muted}>Also sent to {state.email}.</span>
          )}
        </div>
        <p className={styles.muted}>
          Your invoices are deleted on{' '}
          {new Date(state.expiresAt).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
          , as agreed. The numbers and your report stay yours.
        </p>
        {problem && <p className={styles.problem}>{problem}</p>}
      </section>

      {attention.length > 0 && (
        <section aria-labelledby="exceptions-title">
          <h2 id="exceptions-title" className={styles.h2}>
            What needs attention
          </h2>
          <ul className={styles.cards}>
            {attention.map((i) => (
              <ExceptionCard key={i.id} invoice={i} onEvidence={() => setOpen(i)} />
            ))}
          </ul>
        </section>
      )}

      {cleared.length > 0 && (
        <section className={styles.clearedBox} aria-labelledby="cleared-title">
          <button
            type="button"
            className={styles.clearedToggle}
            aria-expanded={showCleared}
            onClick={() => setShowCleared((x) => !x)}
          >
            <span className={styles.clearedMark}>
              <Icon name="check" size={14} strokeWidth={2.8} />
            </span>
            <span id="cleared-title">
              <strong>
                {cleared.length} invoice{cleared.length === 1 ? '' : 's'} cleared
              </strong>
              <span className={styles.muted}> · Nothing needs your attention</span>
            </span>
            <Icon name={showCleared ? 'chevronLeft' : 'chevronRight'} size={16} />
          </button>
          {showCleared && (
            <ul className={styles.clearedList}>
              {cleared.map((i) => (
                <li key={i.id}>
                  <span>
                    {i.supplier ?? i.filename}
                    {i.number ? ` · ${i.number}` : ''}
                  </span>
                  <span>{i.totalPaise !== null ? inr(i.totalPaise) : '—'}</span>
                  <span className={styles.muted}>
                    {i.basis === 'records' ? 'Checked against your records' : 'Invoice checks only'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {failed.length > 0 && (
        <section aria-labelledby="failed-title">
          <h2 id="failed-title" className={styles.h3}>
            Not processed
          </h2>
          <ul className={styles.fileList}>
            {failed.map((i) => (
              <li key={i.id} className={styles.fileRow} data-state="failed">
                <span className={styles.fileMark}>!</span>
                <span className={styles.fileMain}>
                  <span className={styles.fileName}>{i.filename}</span>
                  <span className={styles.fileMeta}>{i.failure?.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <NextStep state={state} onState={onState} />
      {open && <Evidence invoice={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ExceptionCard({
  invoice: i,
  onEvidence,
}: {
  invoice: ApiChallengeInvoice;
  onEvidence: () => void;
}) {
  const f = i.finding;
  const type = FINDING_TYPE_LABEL[f?.type ?? 'other'] ?? 'Finding';
  const invoiceSide = f?.compare.filter((c) => c.tone === 'attention') ?? [];
  const agreed = f?.compare.filter((c) => c.tone !== 'attention') ?? [];
  return (
    <li className={styles.card} data-state={i.outcome}>
      <p className={styles.cardType}>
        <span aria-hidden="true">{i.outcome === 'review' ? '⚠' : '?'}</span> {type}
        <span className={styles.cardState}>
          {i.outcome === 'review' ? 'Needs review' : 'Needs confirmation'}
        </span>
      </p>
      <p className={styles.cardWho}>
        {i.supplier ?? 'Supplier not read'}
        {i.number ? ` · ${i.number}` : ''}
        {i.totalPaise !== null ? ` · ${inr(i.totalPaise)}` : ''}
      </p>
      {f && (
        <>
          <p className={styles.cardLabel}>{f.label}</p>
          {(agreed.length > 0 || invoiceSide.length > 0) && (
            <dl className={styles.compare}>
              {[...invoiceSide, ...agreed].map((c) => (
                <div
                  key={`${c.label}-${c.value}`}
                  data-side={c.tone === 'attention' ? 'invoice' : 'records'}
                >
                  <dt>{c.label}</dt>
                  <dd>{c.value}</dd>
                </div>
              ))}
              {f.difference && (
                <div data-side="difference">
                  <dt>Difference</dt>
                  <dd>{f.difference}</dd>
                </div>
              )}
            </dl>
          )}
          <p className={styles.cardExplain}>{f.explanation}</p>
        </>
      )}
      {i.more.length > 0 && (
        <p className={styles.muted}>Also on this invoice: {i.more.join(' · ')}</p>
      )}
      <div className={styles.cardActions}>
        <Button size="sm" onClick={onEvidence}>
          {f?.action ?? 'Review'}
        </Button>
        <button type="button" className={styles.linkButton} onClick={onEvidence}>
          View evidence
        </button>
      </div>
    </li>
  );
}

/** The finding with its evidence: the values cut from the uploaded page, and the whole page. */
function Evidence({ invoice: i, onClose }: { invoice: ApiChallengeInvoice; onClose: () => void }) {
  const f = i.finding;
  const [page, setPage] = useState(1);
  const [missing, setMissing] = useState<number | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    dialog.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pageUrl = (p: number) => challengeApi.pageUrl(i.documentId, p);
  return (
    <div className={styles.overlay} role="presentation" onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-title"
        tabIndex={-1}
        ref={dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.dialogHead}>
          <div>
            <p className={styles.cardType}>{FINDING_TYPE_LABEL[f?.type ?? 'other'] ?? 'Finding'}</p>
            <h2 id="evidence-title" className={styles.h3}>
              Why Veyrafy flagged this
            </h2>
            <p className={styles.muted}>
              {i.supplier ?? 'Supplier not read'}
              {i.number ? ` · ${i.number}` : ''} · {i.filename}
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className={styles.dialogBody}>
          <div className={styles.evidenceSide}>
            {f && (
              <>
                <p className={styles.cardLabel}>{f.label}</p>
                <p className={styles.cardExplain}>{f.explanation}</p>
                {f.calculation && <p className={styles.muted}>{f.calculation}</p>}
                <EvidenceList
                  evidence={f.evidence}
                  documentId={i.documentId}
                  isPdf={i.isPdf}
                  original
                  pageUrl={pageUrl}
                  recordsLabel="Compared with"
                />
                <p className={styles.actionHint}>
                  Recommended: {f.action}. Hold payment until it is resolved.
                </p>
              </>
            )}
          </div>
          <div className={styles.pageSide}>
            <div className={styles.pageNav}>
              <span>The uploaded invoice · page {page}</span>
              <span>
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>{' '}
                <button
                  type="button"
                  className={styles.linkButton}
                  disabled={missing !== null && page + 1 >= missing}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </span>
            </div>
            {missing === page ? (
              <p className={styles.muted}>This document has no more pages.</p>
            ) : (
              <img
                key={page}
                className={styles.pageImage}
                src={pageUrl(page)}
                alt={`Page ${page} of the uploaded invoice`}
                onError={() => {
                  if (page > 1) {
                    setMissing(page);
                    setPage((p) => p - 1);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NextStep({
  state,
  onState,
}: {
  state: ApiChallengeState;
  onState: (s: ApiChallengeState) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const ask = async (kind: 'walkthrough' | 'pilot') => {
    setProblem(null);
    // Opened first (in the click), so a pop-up blocker does not stop it.
    const tab =
      kind === 'walkthrough' && state.bookingUrl
        ? window.open(state.bookingUrl, '_blank', 'noopener')
        : null;
    try {
      onState(await challengeApi.interest(kind));
    } catch (e) {
      tab?.close();
      setProblem(errorText(e, 'That did not go through. Please try again.'));
    }
  };
  const done = state.interest !== 'none';
  return (
    <section className={styles.next} aria-labelledby="next-title">
      <h2 id="next-title" className={styles.h2}>
        Want Veyrafy to check every invoice before payment?
      </h2>
      <p className={styles.lede}>
        The 5 Invoice Challenge showed what Veyrafy can find in your current invoices. Run the same
        verification process continuously across your supplier invoices.
      </p>
      {done ? (
        <p className={styles.thanks} role="status">
          <Icon name="check" size={16} strokeWidth={2.6} /> Thank you. Veyrafy will contact you at{' '}
          {state.email} to{' '}
          {state.interest === 'pilot' ? 'set up a pilot' : 'arrange your walkthrough'}.
        </p>
      ) : (
        <div className={styles.actions}>
          <Button size="lg" arrow onClick={() => void ask('walkthrough')}>
            Book a 15-minute walkthrough
          </Button>
          <Button size="lg" variant="secondary" onClick={() => void ask('pilot')}>
            Start a pilot
          </Button>
        </div>
      )}
      {problem && <p className={styles.problem}>{problem}</p>}
    </section>
  );
}

function Spinner() {
  return <span className={styles.spinner} aria-label="In progress" />;
}
