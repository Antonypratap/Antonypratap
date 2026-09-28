import { useState } from 'react';
import { Icon, StatusPill, Struck } from '../../design-system';
import { InvoiceDocument } from '../components/InvoiceDocument';
import { invoiceById, type DemoInvoice, type DemoOption } from '../data/invoices';
import { formatDate, inr } from '../format';
import { hrefFor, navigate } from '../router';
import { useDemoDispatch, useDemoState } from '../state/DemoStore';
import {
  STATUS_LABEL,
  nextQuestion,
  openQuestions,
  statusOf,
  type InvoiceStatus,
} from '../state/demo';
import styles from './InvoiceReview.module.css';

const PILL: Record<InvoiceStatus, 'attention' | 'handled' | 'ready' | 'received' | 'neutral'> = {
  attention: 'attention',
  handled: 'handled',
  ready: 'handled',
  processing: 'received',
  rejected: 'neutral',
};

export function InvoiceReview({ id }: { id: string }) {
  const invoice = invoiceById(id);
  if (!invoice) {
    return (
      <div className={styles.missing}>
        <p>This invoice isn&rsquo;t in the demo.</p>
        <a href={hrefFor({ name: 'inbox' })}>Back to inbox</a>
      </div>
    );
  }
  return <Review invoice={invoice} />;
}

function Review({ invoice }: { invoice: DemoInvoice }) {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const [fullSize, setFullSize] = useState(false);
  const status = statusOf(invoice, state);
  const decision = state.decisions[invoice.id];
  const q = invoice.question;
  const open = openQuestions(state);
  const position = open.findIndex((i) => i.id === invoice.id);
  const next = nextQuestion(state, invoice.id);

  const decide = (option: DemoOption): void =>
    dispatch({ type: 'decide', invoiceId: invoice.id, optionId: option.id });

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <a href={hrefFor({ name: 'inbox' })} className={styles.back}>
          <Icon name="chevronLeft" size={16} />
          Inbox
        </a>
        <div className={styles.titleRow}>
          <div>
            <h1 className={styles.title}>Invoice {invoice.number}</h1>
            <p className={styles.subtitle}>{invoice.supplier.name}</p>
          </div>
          <div className={styles.headMeta}>
            <StatusPill status={PILL[status]}>{STATUS_LABEL[status]}</StatusPill>
            {position >= 0 && (
              <span className={styles.position}>
                Question {position + 1} of {open.length}
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
              {invoice.source === 'Photo' ? 'Phone photo' : 'PDF'} · 1 page
            </span>
            <span className={styles.received}>Received {invoice.receivedLabel}</span>
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
                <span className={styles.factMain}>{invoice.supplier.name}</span>
                <span className={styles.factSub}>
                  {invoice.supplier.gstin
                    ? `GSTIN ${invoice.supplier.gstin}`
                    : 'GSTIN not readable'}
                </span>
              </dd>
            </div>
            <div>
              <dt>Invoice</dt>
              <dd>
                <span className={styles.factMain}>{invoice.number}</span>
                <span className={styles.factSub}>{formatDate(invoice.date)}</span>
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
              <dd className={styles.amount}>{inr(invoice.totalPaise)}</dd>
            </div>
          </dl>

          {q && (
            <section
              className={styles.question}
              data-resolved={Boolean(decision)}
              aria-labelledby="question-title"
            >
              <p className={styles.questionLabel}>
                {decision ? 'Resolved' : 'Needs your attention'}
              </p>
              <h2 id="question-title" className={styles.questionTitle}>
                <Struck struck={Boolean(decision)}>{q.headline}</Struck>
              </h2>
              <dl className={styles.compare}>
                {q.facts.map((f) => (
                  <div key={f.label} data-tone={f.tone}>
                    <dt>{f.label}</dt>
                    <dd>{f.value}</dd>
                  </div>
                ))}
              </dl>
              <details className={styles.why}>
                <summary>Why is this flagged?</summary>
                <ul>
                  {q.why.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </details>
            </section>
          )}

          {q && !decision && (
            <section className={styles.decide} aria-labelledby="decide-title">
              <h2 id="decide-title" className={styles.decideTitle}>
                What would you like to do?
              </h2>
              <div className={styles.options}>
                {q.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={styles.option}
                    data-emphasis={o.emphasis}
                    onClick={() => decide(o)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className={styles.decideNote}>
                Nothing moves until you decide. This demo keeps your choice in this browser tab
                only.
              </p>
            </section>
          )}

          {q && decision && (
            <section className={styles.done} data-outcome={decision.outcome} aria-live="polite">
              <div className={styles.doneHead}>
                <span className={styles.doneIcon}>
                  <Icon name={decision.outcome === 'rejected' ? 'undo' : 'check'} size={16} />
                </span>
                <div>
                  <p className={styles.doneTitle}>Decision recorded</p>
                  <p className={styles.doneText}>{decision.result}</p>
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
                <button
                  type="button"
                  className={styles.undo}
                  onClick={() => dispatch({ type: 'undo', invoiceId: invoice.id })}
                >
                  Undo
                </button>
              </div>
            </section>
          )}

          {!q && (
            <section className={styles.handled}>
              <p className={styles.handledTitle}>
                <Icon name="check" size={16} /> Handled by Veyra
              </p>
              <ul className={styles.checks}>
                <li>Supplier identified</li>
                <li>
                  {invoice.poNumber
                    ? `Matched to ${invoice.poNumber}`
                    : (invoice.handledNote ?? 'Order confirmed')}
                </li>
                <li>Quantities match what was received</li>
                <li>Prices, tax and totals add up</li>
                <li>Ready for payment</li>
              </ul>
              {invoice.handledNote && <p className={styles.handledNote}>{invoice.handledNote}.</p>}
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
