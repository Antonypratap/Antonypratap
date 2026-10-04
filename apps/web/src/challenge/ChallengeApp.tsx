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
import { WEBSITE_ADDRESS } from '../site/host';
import { challengeApi, takeLinkSecret } from './api';
import styles from './Challenge.module.css';

/**
 * The 10 Invoice Challenge: a prospect puts up to ten real supplier invoices (and, if they have
 * them, their purchasing records) through the real Veyrafy checks and gets an evidence-based
 * report. Every result on these screens is what the server's engine recorded; this page only
 * shows it. Nothing animates progress the server has not reported.
 */
const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** On the website (no database): the landing only; starting goes to `elsewhere`. */
const WEBSITE_CONFIG: ApiChallengeConfig = {
  enabled: true,
  maxInvoices: 10,
  aiProvider: null,
  retentionDays: 30,
  templates: [],
};

export function ChallengeApp({ elsewhere }: { elsewhere?: string } = {}) {
  const [config, setConfig] = useState<ApiChallengeConfig | null | 'off'>(
    elsewhere ? WEBSITE_CONFIG : null,
  );
  /** Whether this browser has a challenge: unknown until the server says (null). */
  const [state, setState] = useState<ApiChallengeState | null>(null);
  const [known, setKnown] = useState(Boolean(elsewhere));
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [collectStep, setCollectStep] = useState<'invoices' | 'records'>('invoices');

  useEffect(() => {
    if (!elsewhere) challengeApi.config().then(setConfig, () => setConfig('off'));
  }, [elsewhere]);

  /** No challenge in this browser (or the link expired): the landing page. */
  const failed = useCallback((e: unknown) => {
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
    document.title = '10 Invoice Challenge · Veyrafy';
  }, []);

  let body: ReactNode;
  if (config === null) body = <p className={styles.muted}>Loading…</p>;
  else if (config === 'off') body = <NotHere />;
  else if (!known)
    body = problem ? (
      <p className={styles.problem}>{problem}</p>
    ) : (
      <p className={styles.muted}>Loading…</p>
    );
  else if (!state)
    body = starting ? (
      <Details config={config} onBack={() => setStarting(false)} onCreated={setState} />
    ) : (
      <Landing
        config={config}
        onStart={() => (elsewhere ? window.location.assign(elsewhere) : setStarting(true))}
      />
    );
  else if (state.status === 'collecting')
    body = (
      <Collect
        state={state}
        config={config}
        onState={setState}
        step={collectStep}
        onStep={setCollectStep}
      />
    );
  else if (state.status === 'checking') body = <Checking state={state} />;
  else body = <Results state={state} onState={setState} />;

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <a href={WEBSITE_ADDRESS} className={styles.brand} aria-label="Veyrafy">
          <Logo />
        </a>
        <span className={styles.tag}>10 Invoice Challenge</span>
      </header>
      {state && state.status !== 'purged' && (
        <Steps state={state} records={collectStep === 'records'} />
      )}
      <main className={styles.main} id="main">
        {problem && state && <p className={styles.problem}>{problem}</p>}
        {body}
      </main>
      <footer className={styles.foot}>
        <span>
          Your invoices are confidential. They are used only for this challenge and deleted after{' '}
          {config && config !== 'off' ? config.retentionDays : 30} days.
        </span>
        <span>Prepared by Veyrafy</span>
      </footer>
    </div>
  );
}

function NotHere() {
  return (
    <section className={styles.narrow}>
      <h1 className={styles.h1}>The 10 Invoice Challenge isn’t available at this address.</h1>
      <p className={styles.lede}>
        <a href={WEBSITE_ADDRESS}>Go to veyrafy.com</a> to start it.
      </p>
    </section>
  );
}

// ── Steps ──────────────────────────────────────────────────────────────────

function Steps({ state, records }: { state: ApiChallengeState; records: boolean }) {
  const at =
    state.status === 'collecting'
      ? records && state.invoices.length > 0
        ? 2
        : 1
      : state.status === 'checking'
        ? 3
        : 4;
  const steps = ['Details', 'Invoices', 'Records', 'Checks', 'Results'];
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

// ── Landing ────────────────────────────────────────────────────────────────

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
        <p className={styles.eyebrow}>10 Invoice Challenge</p>
        <h1 id="challenge-title" className={styles.display}>
          Put 10 real invoices through Veyrafy.
        </h1>
        <p className={styles.lede}>
          See what gets caught before you pay. Veyrafy checks supplier invoices against your
          purchasing and accounting records and highlights discrepancies that need attention.
        </p>
        <div className={styles.ctaRow}>
          <Button size="lg" arrow onClick={onStart}>
            Start the challenge
          </Button>
        </div>
        <p className={styles.reassure}>
          Free · {config.maxInvoices} invoices · No integration required
        </p>
      </section>

      <section className={styles.band} aria-labelledby="how-title">
        <h2 id="how-title" className={styles.h2}>
          How it works
        </h2>
        <ol className={styles.how}>
          <li>
            <span className={styles.howNum}>1</span>
            <strong>Upload {config.maxInvoices} recent supplier invoices</strong>
            <span>PDF, JPG or PNG. Scans and phone photos are fine.</span>
          </li>
          <li>
            <span className={styles.howNum}>2</span>
            <strong>Add the records to check against</strong>
            <span>
              Purchase orders, goods receipts, supplier list: optional, strongly recommended.
            </span>
          </li>
          <li>
            <span className={styles.howNum}>3</span>
            <strong>Get your verification report</strong>
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
          Rates, quantities and receipts can only be checked against records you provide. Without
          them, Veyrafy verifies each invoice on its own, and the report says so.
        </p>
      </section>
    </>
  );
}

// ── Details ────────────────────────────────────────────────────────────────

function Details({
  config,
  onBack,
  onCreated,
}: {
  config: ApiChallengeConfig;
  onBack: () => void;
  onCreated: (state: ApiChallengeState) => void;
}) {
  const [f, setF] = useState({
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    outlets: '',
    erpSystem: '',
  });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    challengeApi
      .create({
        companyName: f.companyName.trim(),
        email: f.email.trim(),
        consent: true,
        ...(f.contactName.trim() ? { contactName: f.contactName.trim() } : {}),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.outlets.trim() ? { outlets: Number(f.outlets) } : {}),
        ...(f.erpSystem.trim() ? { erpSystem: f.erpSystem.trim() } : {}),
      })
      .then(onCreated)
      .catch((err: unknown) =>
        setProblem(
          err instanceof ApiError && err.code === 'VALIDATION'
            ? 'Check the details: a company name and a valid work email are needed.'
            : errorText(err, 'The challenge could not be started.'),
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <section className={styles.narrow} aria-labelledby="details-title">
      <p className={styles.eyebrow}>Step 1 of 4</p>
      <h1 id="details-title" className={styles.h1}>
        Who is the report for?
      </h1>
      <p className={styles.lede}>We need only this to prepare and send your report.</p>
      <form className={styles.form} onSubmit={submit}>
        <Input
          label="Company name"
          value={f.companyName}
          onChange={set('companyName')}
          required
          autoComplete="organization"
        />
        <Input
          label="Work email"
          type="email"
          value={f.email}
          onChange={set('email')}
          required
          autoComplete="email"
          hint="Your report is sent here."
        />
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
        <div className={styles.pair}>
          <Input
            label="Outlets / locations"
            optional
            type="number"
            min={1}
            value={f.outlets}
            onChange={set('outlets')}
          />
          <Input
            label="Accounting / ERP system"
            optional
            value={f.erpSystem}
            onChange={set('erpSystem')}
            placeholder="Tally, Zoho Books, SAP…"
          />
        </div>
        <label className={styles.consent}>
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            required
          />
          <span>
            I agree that Veyrafy processes these invoices and records to prepare this report
            {config.aiProvider ? `, using ${config.aiProvider} to read the documents` : ''}. They
            are kept confidential, never shown to anyone else, and deleted after{' '}
            {config.retentionDays} days.
          </span>
        </label>
        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" size="lg" arrow disabled={busy || !consent}>
            Continue
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
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

// ── Collecting: invoices, then records ─────────────────────────────────────

function Collect({
  state,
  config,
  onState,
  step,
  onStep: setStep,
}: {
  state: ApiChallengeState;
  config: ApiChallengeConfig;
  onState: (s: ApiChallengeState) => void;
  step: 'invoices' | 'records';
  onStep: (s: 'invoices' | 'records') => void;
}) {
  return step === 'invoices' || state.invoices.length === 0 ? (
    <Invoices state={state} onState={onState} onNext={() => setStep('records')} />
  ) : (
    <Records state={state} config={config} onState={onState} onBack={() => setStep('invoices')} />
  );
}

function Invoices({
  state,
  onState,
  onNext,
}: {
  state: ApiChallengeState;
  onState: (s: ApiChallengeState) => void;
  onNext: () => void;
}) {
  const [uploading, setUploading] = useState<string[]>([]);
  const [errors, setErrors] = useState<{ name: string; message: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const room = state.maxInvoices - state.invoices.length;
  const add = async (files: File[]) => {
    const take = files.slice(0, Math.max(0, room));
    const over = files.slice(take.length);
    setErrors(
      over.map((f) => ({
        name: f.name,
        message: `Not added: the challenge takes ${state.maxInvoices} invoices.`,
      })),
    );
    setUploading(take.map((f) => f.name));
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
  const reading = state.invoices.some((i) => i.phase === 'reading') || uploading.length > 0;
  return (
    <section aria-labelledby="upload-title">
      <p className={styles.eyebrow}>Step 2 of 4</p>
      <h1 id="upload-title" className={styles.h1}>
        Upload {state.maxInvoices} recent supplier invoices
      </h1>
      <p className={styles.lede}>
        PDF, JPG or PNG. Each file should hold one invoice. Veyrafy reads them as they arrive.
      </p>
      <div
        className={styles.drop}
        data-full={room <= 0}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void add([...e.dataTransfer.files]);
        }}
      >
        <Icon name="upload" size={22} />
        <p>
          <strong>{room > 0 ? 'Drop invoices here' : 'All 10 invoices added'}</strong>
          {room > 0 && <span> or </span>}
          {room > 0 && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => input.current?.click()}
            >
              choose files
            </button>
          )}
        </p>
        <p className={styles.muted}>
          {state.invoices.length} of {state.maxInvoices} added
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
        {state.invoices.map((i) => (
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
      <div className={styles.actions}>
        <Button
          size="lg"
          arrow
          disabled={state.invoices.length === 0 || uploading.length > 0}
          onClick={onNext}
        >
          Continue to records
        </Button>
        {reading && <span className={styles.muted}>Reading continues in the background.</span>}
      </div>
    </section>
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

function Records({
  state,
  config,
  onState,
  onBack,
}: {
  state: ApiChallengeState;
  config: ApiChallengeConfig;
  onState: (s: ApiChallengeState) => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [gstin, setGstin] = useState(state.gstin ?? state.gstinCandidates[0]?.gstin ?? '');
  const input = useRef<HTMLInputElement>(null);
  const reading = state.invoices.filter((i) => i.phase === 'reading').length;
  const usable = state.invoices.filter((i) => i.phase !== 'failed').length;
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
  const top = state.gstinCandidates[0];
  const all = config.templates.find((t) => t.file === 'Veyrafy-Master-Data-Import.xlsx');
  return (
    <section aria-labelledby="records-title">
      <p className={styles.eyebrow}>Step 3 of 4</p>
      <h1 id="records-title" className={styles.h1}>
        Add the records Veyrafy should check against
      </h1>
      <p className={styles.lede}>
        Veyrafy can only compare an invoice against records that you provide or that are connected
        to your system. Add your purchase orders, goods receipts and supplier list to check rates,
        quantities and receipts.
      </p>
      <div className={styles.twoCol}>
        <div className={styles.panel}>
          <h2 className={styles.h3}>
            Your records <em className={styles.optional}>optional, strongly recommended</em>
          </h2>
          <ul className={styles.formats}>
            <li>
              <strong>Excel or CSV</strong> in Veyrafy’s template columns: suppliers, items,
              purchase orders and goods receipts.{' '}
              {all && (
                <a href={challengeApi.templateUrl(all.file)} download>
                  Download the template
                </a>
              )}
            </li>
            <li>
              <strong>ERP goods-receipt export</strong> (JSON), as exported from your ERP.
            </li>
          </ul>
          <p className={styles.muted}>
            PDF purchase orders and receipts aren’t read as records. Export them from your
            accounting system instead.
          </p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={busy || state.records.files.length >= 6}
              onClick={() => input.current?.click()}
            >
              Add a records file
            </Button>
            <input
              ref={input}
              type="file"
              hidden
              accept=".xlsx,.csv,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void addRecords(f);
                e.target.value = '';
              }}
            />
          </div>
          {state.records.files.length > 0 && (
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
        </div>
        <div className={styles.panel}>
          <h2 className={styles.h3}>Your GSTIN</h2>
          <p className={styles.muted}>
            Veyrafy checks every invoice is billed to you.
            {top ? ` ${top.invoices} of your invoices are billed to ${top.gstin}.` : ''} Confirm
            it’s yours.
          </p>
          <label className={styles.field}>
            <span className={styles.label}>GSTIN</span>
            <input
              className={styles.input}
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              maxLength={15}
              spellCheck={false}
            />
          </label>
          {state.gstinCandidates.length > 1 && (
            <p className={styles.muted}>
              Also read:{' '}
              {state.gstinCandidates
                .slice(1)
                .map((c) => `${c.gstin} (${c.invoices})`)
                .join(', ')}
            </p>
          )}
        </div>
      </div>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      <div className={styles.actions}>
        <Button
          size="lg"
          arrow
          disabled={busy || reading > 0 || usable === 0 || gstin.length !== 15}
          onClick={() => void start()}
        >
          {state.records.files.length ? 'Run the checks' : 'Run the checks without records'}
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back to invoices
        </Button>
        {reading > 0 && (
          <span className={styles.muted}>
            Waiting for {reading} invoice{reading === 1 ? '' : 's'} to be read…
          </span>
        )}
      </div>
      {state.records.files.length === 0 && (
        <p className={styles.note}>
          Without records, each invoice is verified on its own (calculations, GST, GSTINs,
          duplicates). The report will say clearly that it was not compared with purchase orders or
          receipts.
        </p>
      )}
    </section>
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
      <p className={styles.eyebrow}>Step 4 of 4</p>
      <h1 id="checking-title" className={styles.h1}>
        Checking your invoices
      </h1>
      <p className={styles.lede} aria-live="polite">
        {done} of {state.invoices.length} checked. Each step is marked complete only when Veyrafy
        has finished it. You can leave this page; your results will wait here and arrive by email.
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
      <section className={styles.narrow}>
        <h1 className={styles.h1}>This challenge has ended</h1>
        <p className={styles.lede}>
          Its invoices were deleted after the retention period, as agreed.
          {s ? ` ${s.checked} invoices were checked; ${s.attention} needed attention.` : ''}
        </p>
      </section>
    );
  if (!s) return null;
  const download = async () => {
    setDownloading(true);
    setProblem(null);
    try {
      await challengeApi.downloadReport(state.companyName);
    } catch (e) {
      setProblem(errorText(e, 'The report could not be prepared.'));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <>
      <section className={styles.resultHero} aria-labelledby="results-title">
        <p className={styles.eyebrow}>{state.companyName}</p>
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
        The 10 Invoice Challenge showed what Veyrafy can find in your current invoices. Run the same
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
