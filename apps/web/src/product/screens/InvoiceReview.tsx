import { useState } from 'react';
import type { ApiInvoiceDetail, ApiOption, ApiQuestion } from '@veyra/shared';
import { Icon, StatusPill, Struck } from '../../design-system';
import { api, ApiError, documentUrl } from '../api/client';
import { AnswerForm } from '../components/AnswerForm';
import { InvoiceDocument } from '../components/InvoiceDocument';
import { formatDate, inr } from '../format';
import { hrefFor, navigate } from '../router';
import { attentionQueue, nextInQueue, useProductData, useResource } from '../state/data';
import { STATUS_LABEL, STATUS_TONE } from '../state/status';
import styles from './InvoiceReview.module.css';

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
  UPLOADED: 'Veyra is reading the invoice.',
  EXTRACTING: 'Veyra is reading the invoice.',
  MATCHING: 'Veyra is checking it against your records.',
  RESOLVING: 'Veyra is checking it against your records.',
  VALIDATING: 'Veyra is checking it against your records.',
  COMMITTING: 'Veyra is recording it in your ERP.',
};

interface LocalAnswer {
  question: ApiQuestion;
  option: ApiOption;
}

function Review({ invoice }: { invoice: ApiInvoiceDetail }) {
  const { inbox, refresh } = useProductData();
  const [fullSize, setFullSize] = useState(false);
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
  const working = WORKING[invoice.state];

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

  const submit = async (option: ApiOption, input: unknown) => {
    if (!question) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.answer(question.id, option.id, input);
      setLocal({ question, option });
      setPending(null);
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

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await action();
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
            <a
              className={styles.zoom}
              href={documentUrl(invoice.documentId)}
              target="_blank"
              rel="noreferrer"
            >
              Original
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
            <div className={styles.sheet}>
              <InvoiceDocument invoice={invoice} />
            </div>
          </div>
        </section>

        <aside className={styles.panel} aria-label="Veyra review">
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
                  Nothing moves until you decide. Veyra records your decision and checks the invoice
                  again.
                </p>
              </section>
            </>
          )}

          {!question && invoice.state === 'FAILED' && invoice.failure && (
            <>
              <section className={styles.question} aria-labelledby="failed-title">
                <p className={styles.questionLabel}>Needs your attention</p>
                <h2 id="failed-title" className={styles.questionTitle}>
                  Veyra couldn&rsquo;t finish this invoice.
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
                    disabled={busy}
                    onClick={() => void act(() => api.reprocess(invoice.id))}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className={styles.option}
                    data-emphasis="quiet"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.reject(invoice.id, 'Rejected after it could not be read'))
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
                data-outcome={status === 'rejected' ? 'rejected' : 'ready'}
                aria-live="polite"
              >
                <div className={styles.doneHead}>
                  <span className={styles.doneIcon}>
                    <Icon name={status === 'rejected' ? 'undo' : 'check'} size={16} />
                  </span>
                  <div>
                    <p className={styles.doneTitle}>Decision recorded</p>
                    <p className={styles.doneText}>
                      {status === 'rejected' ? 'Invoice rejected.' : resolved.option.result}
                      {working ? ` ${working}` : ''}
                    </p>
                  </div>
                </div>
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
                      All caught up. Back to inbox
                    </a>
                  )}
                </div>
              </section>
            </>
          )}

          {!question && !resolved && working && (
            <section className={styles.handled} aria-live="polite">
              <p className={styles.handledTitle}>{STATUS_LABEL.processing}</p>
              <p className={styles.handledNote}>{working}</p>
            </section>
          )}

          {(status === 'handled' || status === 'ready') && <Handled invoice={invoice} />}

          {status === 'rejected' && !resolved && (
            <section className={styles.handled}>
              <p className={styles.handledTitle}>{STATUS_LABEL.rejected}</p>
              <p className={styles.handledNote}>{invoice.note}</p>
            </section>
          )}

          <a className={styles.auditLink} href={hrefFor({ name: 'audit', id: invoice.id })}>
            See what happened to this invoice
          </a>
        </aside>
      </div>
    </div>
  );
}

function QuestionBlock({ question, resolved }: { question: ApiQuestion; resolved: boolean }) {
  return (
    <section className={styles.question} data-resolved={resolved} aria-labelledby="question-title">
      <p className={styles.questionLabel}>{resolved ? 'Resolved' : 'Needs your attention'}</p>
      <h2 id="question-title" className={styles.questionTitle}>
        <Struck struck={resolved}>{question.headline}</Struck>
      </h2>
      <dl className={styles.compare}>
        {question.facts.map((f) => (
          <div key={`${f.label}-${f.value}`} data-tone={f.tone}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      <details className={styles.why}>
        <summary>Why is this flagged?</summary>
        <ul>
          {question.why.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function Handled({ invoice }: { invoice: ApiInvoiceDetail }) {
  const derived = invoice.checks.some((c) => c.naReason === 'PO_DERIVED_FROM_INVOICE');
  const t = invoice.totals;
  return (
    <section className={styles.handled}>
      <p className={styles.handledTitle}>
        <Icon name="check" size={16} />{' '}
        {invoice.status === 'ready' ? 'Checked and recorded' : 'Handled by Veyra'}
      </p>
      <ul className={styles.checks}>
        <li>Supplier identified{invoice.erp.vendor ? `: ${invoice.erp.vendor}` : ''}</li>
        <li>
          {derived
            ? `Order ${invoice.erp.poNumber ?? ''} created from the invoice`
            : `Matched to ${invoice.erp.poNumber ?? invoice.poNumber ?? 'the order'}`}
        </li>
        <li>Quantities match what was received</li>
        <li>Prices, tax and totals add up</li>
        <li>Recorded in your ERP. Ready for payment</li>
      </ul>
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
      {invoice.note && <p className={styles.handledNote}>{invoice.note}.</p>}
    </section>
  );
}
