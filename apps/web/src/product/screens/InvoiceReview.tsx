import { useState } from 'react';
import type { ApiInvoiceDetail, ApiOption, ApiQuestion } from '@veyra/shared';
import { Icon, StatusPill, Struck } from '../../design-system';
import { api, ApiError, documentInfo, documentPageUrl, documentUrl } from '../api/client';
import { AnswerForm } from '../components/AnswerForm';
import { ErpComparison } from '../components/ErpComparison';
import { InvoiceDocument } from '../components/InvoiceDocument';
import { formatDate, inr } from '../format';
import { hrefFor, navigate } from '../router';
import { attentionQueue, nextInQueue, useProductData, useResource } from '../state/data';
import { AFTER_DECISION, ASK_LABEL, completionEvidence, erpStatusText } from '../state/decision';
import { STATUS_LABEL, STATUS_TONE } from '../state/status';
import styles from './InvoiceReview.module.css';
import { allowed } from '../../access/session';
import { notify } from '../../feedback/toasts';

export function InvoiceReview({ id }: { id: string }) {
  const { data, error } = useResource(() => api.invoice(id), `invoice:${id}`);
  if (!data) {
    return (
      <div className={styles.missing}>
        <p>{error ? 'This invoice could not be found.' : 'Loading…'}</p>
        {error && <a href={hrefFor({ name: 'inbox' })}>Back to inbox</a>}
      </div>
    );
  }
  return <Review key={id} invoice={data} />;
}

const WORKING: Partial<Record<ApiInvoiceDetail['state'], string>> = {
  UPLOADED: 'Veyrafy is reading the invoice.',
  EXTRACTING: 'Veyrafy is reading the invoice.',
  MATCHING: 'Veyrafy is checking it against your records.',
  RESOLVING: 'Veyrafy is checking it against your records.',
  VALIDATING: 'Veyrafy is checking it against your records.',
  COMMITTING: 'Veyrafy is recording it in your ERP.',
};

interface LocalAnswer {
  question: ApiQuestion;
  option: ApiOption;
  /** What the user entered with the option, in words (only for an answer given on this page). */
  entered?: string;
}

/** What the user typed or chose, in words, for the "You decided" line. */
function enteredText(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'grnDate' in input) {
    const g = input as { grnDate: string; lines?: { accepted?: string }[] };
    const accepted = (g.lines ?? []).map((l) => l.accepted).filter(Boolean);
    return `received on ${formatDate(g.grnDate)}${accepted.length ? `, ${accepted.join(' + ')} accepted` : ''}`;
  }
  return undefined;
}

function Review({ invoice }: { invoice: ApiInvoiceDetail }) {
  const { inbox, refresh } = useProductData();
  const [fullSize, setFullSize] = useState(false);
  // The ORIGINAL document is shown by default; "As read" is Veyrafy's reading laid out.
  const [asRead, setAsRead] = useState(false);
  const { data: doc } = useResource(
    () => documentInfo(invoice.documentId),
    `document:${invoice.documentId}`,
  );
  const pageCount = doc?.extraction?.pages ?? 1;
  const otherFields = doc?.extraction?.otherFields ?? [];
  const [local, setLocal] = useState<LocalAnswer | null>(null);
  const [pending, setPending] = useState<ApiOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const status = invoice.status;
  const open = invoice.questions.find((q) => q.status === 'open') ?? null;
  const lastAnswered = [...invoice.questions]
    .filter((q) => q.status === 'answered')
    .sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? ''))[0];
  const queue = attentionQueue(inbox);
  const position = queue.findIndex((i) => i.id === invoice.id);
  const next = nextInQueue(inbox, invoice.id);
  const working = invoice.erp.reconciling
    ? 'Veyrafy is confirming the transaction with your business system. Nothing is shown as recorded until it is confirmed.'
    : WORKING[invoice.state];

  // Show a new question as soon as it exists; otherwise the decision just made (or the last one).
  const question = open && open.id !== local?.question.id ? open : null;
  const resolved: LocalAnswer | null =
    question !== null
      ? null
      : (local ??
        (lastAnswered?.answer
          ? {
              question: lastAnswered,
              option: lastAnswered.options.find((o) => o.id === lastAnswered.answer?.optionId) ?? {
                id: '',
                label: lastAnswered.answer.label,
                emphasis: 'secondary',
                result: lastAnswered.answer.result,
                input: null,
                rejects: false,
              },
            }
          : null));

  // The decision just made counts at once: a rejection shows as rejected before the server's
  // status catches up (it is final either way; nothing is recorded in the ERP).
  const rejected = status === 'rejected' || resolved?.option.rejects === true;

  const submit = async (option: ApiOption, input: unknown) => {
    if (!question) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.answer(question.id, option.id, input);
      const entered = enteredText(input);
      setLocal({ question, option, ...(entered ? { entered } : {}) });
      setPending(null);
      // A rejection is final: say so, never "Veyrafy is continuing".
      if (option.rejects) notify.rejected();
      else notify.answered();
      await refresh();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'Your answer could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const choose = (option: ApiOption) => {
    if (option.input) setPending(option);
    else void submit(option, null);
  };

  const act = async (action: () => Promise<unknown>, done: () => void) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
      done();
      await refresh();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const title = invoice.number ?? invoice.filename;
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <a href={hrefFor({ name: 'inbox' })} className={styles.back}>
          <Icon name="chevronLeft" size={16} />
          Inbox
        </a>
        <div className={styles.titleRow}>
          <div>
            <h1 className={styles.title}>Invoice {title}</h1>
            <p className={styles.subtitle}>{invoice.supplier.name ?? 'Supplier not read yet'}</p>
          </div>
          <div className={styles.headMeta}>
            <StatusPill status={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusPill>
            {position >= 0 && (
              <span className={styles.position}>
                Question {position + 1} of {queue.length}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.grid}>
        <section className={styles.viewer} aria-label="Invoice document">
          <div className={styles.viewerBar}>
            <span className={styles.file}>
              <Icon name={invoice.source === 'Photo' ? 'photo' : 'document'} size={15} />
              <span className={styles.fileName}>
                {invoice.source === 'Photo' ? 'Phone photo' : 'PDF'} · {invoice.filename}
              </span>
            </span>
            <button
              type="button"
              className={styles.zoom}
              onClick={() => setAsRead((v) => !v)}
              aria-pressed={asRead}
            >
              {asRead ? 'Show original' : 'Show as read'}
            </button>
            <a
              className={styles.zoom}
              href={documentUrl(invoice.documentId)}
              target="_blank"
              rel="noreferrer"
            >
              Open file
            </a>
            <button
              type="button"
              className={styles.zoom}
              onClick={() => setFullSize((v) => !v)}
              aria-pressed={fullSize}
            >
              {fullSize ? 'Fit to width' : 'Zoom in'}
            </button>
          </div>
          <div className={styles.stage} data-full={fullSize}>
            {asRead ? (
              <div className={styles.sheet}>
                <InvoiceDocument invoice={invoice} />
              </div>
            ) : (
              <div className={styles.original}>
                {Array.from({ length: pageCount }, (_, i) => (
                  <img
                    key={i}
                    className={styles.page}
                    src={documentPageUrl(invoice.documentId, i + 1)}
                    alt={`Page ${i + 1} of ${pageCount} of the uploaded invoice`}
                    loading={i === 0 ? 'eager' : 'lazy'}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className={styles.panel} aria-label="Veyrafy review">
          <dl className={styles.facts}>
            <div className={styles.factWide}>
              <dt>Supplier</dt>
              <dd>
                <span className={styles.factMain}>{invoice.supplier.name ?? '—'}</span>
                <span className={styles.factSub}>
                  {invoice.supplier.gstin && !invoice.unclearPaths.includes('header.vendorGstin')
                    ? `GSTIN ${invoice.supplier.gstin}`
                    : 'GSTIN not readable'}
                </span>
              </dd>
            </div>
            <div>
              <dt>Invoice</dt>
              <dd>
                <span className={styles.factMain}>{invoice.number ?? '—'}</span>
                <span className={styles.factSub}>
                  {invoice.invoiceDate ? formatDate(invoice.invoiceDate) : ''}
                </span>
              </dd>
            </div>
            <div>
              <dt>Order</dt>
              <dd>
                <span className={styles.factMain}>{invoice.poNumber ?? 'None on invoice'}</span>
                <span className={styles.factSub}>
                  {invoice.lines.length === 1 ? '1 line' : `${invoice.lines.length} lines`}
                </span>
              </dd>
            </div>
            <div className={styles.factWide}>
              <dt>Amount</dt>
              <dd className={styles.amount}>
                {invoice.totalPaise === null ? '—' : inr(invoice.totalPaise)}
              </dd>
            </div>
          </dl>

          {otherFields.length > 0 && (
            <details className={styles.printed}>
              <summary>Also printed on the invoice ({otherFields.length})</summary>
              <dl className={styles.evidence}>
                {otherFields.map((f, i) => (
                  <div key={i}>
                    <dt>{f.label}</dt>
                    <dd>
                      {f.value}
                      {f.page !== null && pageCount > 1 ? ` · page ${f.page}` : ''}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {question && (
            <>
              <QuestionBlock question={question} resolved={false} />
              <section className={styles.decide} aria-labelledby="decide-title">
                <h2 id="decide-title" className={styles.decideTitle}>
                  What would you like to do?
                </h2>
                <div className={styles.options}>
                  {question.options.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className={styles.option}
                      data-emphasis={o.emphasis}
                      aria-pressed={pending?.id === o.id}
                      disabled={busy}
                      onClick={() => choose(o)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                {pending?.input && (
                  <AnswerForm
                    key={pending.id}
                    spec={pending.input}
                    submitLabel={pending.label}
                    busy={busy}
                    onCancel={() => setPending(null)}
                    onSubmit={(input) => void submit(pending, input)}
                  />
                )}
                {problem && (
                  <p className={styles.problem} role="alert">
                    {problem}
                  </p>
                )}
                <p className={styles.decideNote}>
                  Nothing moves until you decide. {AFTER_DECISION[question.kind]}
                </p>
              </section>
            </>
          )}

          {!question && invoice.state === 'FAILED' && invoice.failure && (
            <>
              <section className={styles.question} aria-labelledby="failed-title">
                <p className={styles.questionLabel}>Needs your attention</p>
                <h2 id="failed-title" className={styles.questionTitle}>
                  Veyrafy couldn&rsquo;t finish this invoice.
                </h2>
                <dl className={styles.compare}>
                  <div data-tone="attention">
                    <dt>Reason</dt>
                    <dd>{invoice.failure.reason}</dd>
                  </div>
                </dl>
              </section>
              <section className={styles.decide}>
                <div className={styles.options}>
                  <button
                    type="button"
                    className={styles.option}
                    data-emphasis="primary"
                    disabled={busy || !allowed('invoices.reprocess')}
                    onClick={() => void act(() => api.reprocess(invoice.id), notify.reprocessing)}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className={styles.option}
                    data-emphasis="quiet"
                    disabled={busy || !allowed('invoices.reject')}
                    onClick={() =>
                      void act(
                        () => api.reject(invoice.id, 'Rejected after it could not be read'),
                        notify.rejected,
                      )
                    }
                  >
                    Reject this invoice
                  </button>
                </div>
                {problem && (
                  <p className={styles.problem} role="alert">
                    {problem}
                  </p>
                )}
              </section>
            </>
          )}

          {!question && resolved && (
            <>
              <QuestionBlock question={resolved.question} resolved />
              <section
                className={styles.done}
                data-outcome={rejected ? 'rejected' : 'ready'}
                aria-live="polite"
              >
                <div className={styles.doneHead}>
                  <span className={styles.doneIcon}>
                    <Icon name={rejected ? 'undo' : 'person'} size={16} />
                  </span>
                  <div>
                    <p className={styles.doneTitle}>You decided</p>
                    <p className={styles.doneText}>
                      {resolved.option.label}
                      {resolved.entered ? `: ${resolved.entered}` : ''}
                    </p>
                  </div>
                </div>
                {/* What happens next is the workflow's real state, never assumed. */}
                {rejected ? (
                  <p className={styles.doneState}>Invoice rejected. Nothing was recorded.</p>
                ) : working ? (
                  <p className={styles.doneState} data-working="true">
                    <span className={styles.pulse} aria-hidden="true" />
                    Veyrafy is re-checking the invoice. {working}
                  </p>
                ) : null}
                <div className={styles.doneActions}>
                  {next ? (
                    <button
                      type="button"
                      className={styles.nextButton}
                      onClick={() => navigate({ name: 'invoice', id: next.id })}
                    >
                      Next question
                      <Icon name="chevronRight" size={16} />
                    </button>
                  ) : (
                    <a className={styles.nextButton} href={hrefFor({ name: 'inbox' })}>
                      {status === 'ready' || rejected
                        ? 'All caught up. Back to inbox'
                        : 'Back to inbox'}
                    </a>
                  )}
                </div>
              </section>
            </>
          )}

          {!question && !resolved && working && (
            <section className={styles.neutral} aria-live="polite">
              <p className={styles.doneState} data-working="true">
                <span className={styles.pulse} aria-hidden="true" />
                {STATUS_LABEL.processing}
              </p>
              <p className={styles.handledNote}>{working}</p>
            </section>
          )}

          {(status === 'handled' || status === 'ready') && <Ready invoice={invoice} />}

          {status === 'rejected' && !resolved && (
            <section className={styles.neutral}>
              <p className={styles.handledTitle}>{STATUS_LABEL.rejected}</p>
              <p className={styles.handledNote}>{invoice.note}</p>
            </section>
          )}

          {status !== 'handled' && status !== 'ready' && (
            <a className={styles.auditLink} href={hrefFor({ name: 'audit', id: invoice.id })}>
              See what happened to this invoice
            </a>
          )}
        </aside>
      </div>

      {invoice.comparison && (
        <ErpComparison
          comparison={invoice.comparison}
          busy={busy}
          {...(allowed('invoices.reject') &&
          status !== 'rejected' &&
          status !== 'handled' &&
          status !== 'ready'
            ? {
                onReject: (reason: string) =>
                  void act(() => api.reject(invoice.id, reason), notify.rejected),
              }
            : {})}
        />
      )}
    </div>
  );
}

function QuestionBlock({ question, resolved }: { question: ApiQuestion; resolved: boolean }) {
  return (
    <section className={styles.question} data-resolved={resolved} aria-labelledby="question-title">
      <p className={styles.questionLabel}>{resolved ? 'Resolved' : ASK_LABEL[question.kind]}</p>
      <h2 id="question-title" className={styles.questionTitle}>
        <Struck struck={resolved}>{question.headline}</Struck>
      </h2>
      {!resolved && <p className={styles.found}>{question.evidence}</p>}
      {question.facts.length > 0 && (
        <dl className={styles.compare}>
          {question.facts.map((f) => (
            <div key={`${f.label}-${f.value}`} data-tone={f.tone}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {resolved ? (
        <details className={styles.why}>
          <summary>Why Veyrafy asked</summary>
          <ul>
            {question.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      ) : (
        <div className={styles.whyOpen}>
          <h3 className={styles.whyTitle}>Why Veyrafy needs you</h3>
          <ul>
            {question.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * The "handled" moment: shown only when the server says the invoice is verified. Every line of
 * evidence comes from the invoice's own checks and ERP records.
 */
function Ready({ invoice }: { invoice: ApiInvoiceDetail }) {
  const derived = invoice.checks.some((c) => c.naReason === 'PO_DERIVED_FROM_INVOICE');
  const t = invoice.totals;
  const evidence = completionEvidence(invoice);
  const recorded = invoice.erp.purchaseInvoice;
  return (
    <section className={styles.handled} aria-labelledby="ready-title" aria-live="polite">
      <p id="ready-title" className={styles.readyTitle}>
        <span className={styles.readyIcon}>
          <Icon name="check" size={16} />
        </span>
        Invoice ready
      </p>
      <p className={styles.readyText}>
        {invoice.status === 'handled'
          ? 'Veyrafy resolved this invoice and recorded the transaction. No action required.'
          : 'Veyrafy checked the invoice again after your decision and recorded the transaction.'}
      </p>
      {evidence.length > 0 && (
        <dl className={styles.evidence}>
          {evidence.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className={styles.readyStatus}>
        {recorded ? erpStatusText(recorded.status) : 'Verified, pending payment'}. Payment remains
        with your team.
      </p>
      {t && t.roundOffPaise !== null && t.invoicePaise !== null && (
        <p className={styles.handledNote}>
          Calculated {inr(t.calculatedPaise)} → round-off {inr(t.roundOffPaise)} → invoice{' '}
          {inr(t.invoicePaise)}.
        </p>
      )}
      {derived && (
        <p className={styles.handledNote}>
          Price and quantity comparisons with the order don&rsquo;t apply: the order was created
          from this invoice.
        </p>
      )}
      <div className={styles.readyLinks}>
        <a href={hrefFor({ name: 'erp', tab: 'invoices' })}>Open the ERP record</a>
        <a href={hrefFor({ name: 'audit', id: invoice.id })}>See what happened</a>
      </div>
    </section>
  );
}
