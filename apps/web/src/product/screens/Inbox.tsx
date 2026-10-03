import { useState } from 'react';
import { Icon } from '../../design-system';
import type { ApiInvoiceSummary } from '@veyra/shared';
import { AddInvoices } from '../components/AddInvoices';
import { useDemo } from '../shell/DemoPanel';
import { greetingFor, inr } from '../format';
import { hrefFor } from '../router';
import { attentionQueue, useProductData } from '../state/data';
import { STATUS_LABEL } from '../state/status';
import styles from './Inbox.module.css';
import { useAllowed } from '../../access/session';

const INITIAL_VISIBLE = 5;

export function Inbox() {
  const { inbox, error } = useProductData();
  const demo = useDemo();
  const [showAll, setShowAll] = useState(false);
  const open = attentionQueue(inbox);
  const invoices = inbox?.invoices ?? [];
  const needsYou = inbox?.counts.needsYou ?? 0;
  const visible = showAll ? open : open.slice(0, INITIAL_VISIBLE);
  const processing = invoices.filter((i) => i.status === 'processing');
  const checked = invoices.filter((i) => i.status !== 'processing');
  const cleared = invoices.filter((i) => i.status === 'handled' || i.status === 'ready');
  const rejected = invoices.filter((i) => i.status === 'rejected');
  const totalValue = checked.reduce((s, i) => s + (i.totalPaise ?? 0), 0);
  const reviewValue = open.reduce((s, i) => s + (i.totalPaise ?? 0), 0);

  const canUpload = useAllowed('documents.upload');
  return (
    <div className={styles.page}>
      <header className={styles.headerRow}>
        <div className={styles.header}>
          <h1 className={styles.greeting}>{greetingFor(new Date().getHours())}</h1>
          <p className={styles.sub}>
            {error
              ? error
              : needsYou > 0
                ? 'Here’s what needs your attention.'
                : invoices.length === 0
                  ? 'Upload an invoice and Veyrafy takes it from there.'
                  : 'Nothing needs you right now.'}
          </p>
        </div>
      </header>

      {canUpload && <AddInvoices compact={invoices.length > 0} />}

      {checked.length > 0 && (
        <section className={styles.check} aria-labelledby="check-title">
          <h2 id="check-title" className={styles.checkTitle}>
            {processing.length > 0 ? 'Invoice check in progress' : 'Invoice check complete'}
          </h2>
          <dl className={styles.stats}>
            <div className={styles.stat}>
              <dt>Invoices checked</dt>
              <dd>{checked.length}</dd>
            </div>
            <div className={styles.stat}>
              <dt>Total value</dt>
              <dd>{inr(totalValue)}</dd>
            </div>
            <div className={styles.stat} data-tone="cleared">
              <dt>Cleared</dt>
              <dd>{cleared.length}</dd>
            </div>
            <div className={styles.stat} data-tone={open.length ? 'attention' : 'cleared'}>
              <dt>Need attention</dt>
              <dd>{open.length}</dd>
            </div>
            <div className={styles.stat} data-tone={open.length ? 'attention' : 'cleared'}>
              <dt>Value needing review</dt>
              <dd>{inr(reviewValue)}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className={styles.queue} aria-labelledby="queue-title">
        <div className={styles.queueHead}>
          <h2 id="queue-title" className={styles.sectionLabel}>
            Needs your attention
          </h2>
          <span className={styles.queueCount}>{open.length}</span>
        </div>

        {open.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} data-empty={invoices.length === 0}>
              <Icon name={invoices.length === 0 ? 'inbox' : 'check'} size={18} />
            </span>
            {invoices.length === 0 ? (
              <div>
                <p className={styles.emptyTitle}>No invoices yet.</p>
                <p className={styles.emptyText}>
                  Upload an invoice and Veyrafy takes it from there.
                  {demo.available && (
                    <>
                      {' '}
                      <button type="button" className={styles.demoLink} onClick={demo.open}>
                        Start a demo scenario
                      </button>
                    </>
                  )}
                </p>
              </div>
            ) : (
              <div>
                <p className={styles.emptyTitle}>You&rsquo;re all caught up.</p>
                <p className={styles.emptyText}>Veyrafy is handling everything else.</p>
              </div>
            )}
          </div>
        ) : (
          <ul className={styles.cards}>
            {visible.map((inv) => (
              <li key={inv.id}>
                <ExceptionCard inv={inv} />
              </li>
            ))}
          </ul>
        )}

        {open.length > INITIAL_VISIBLE && (
          <button type="button" className={styles.more} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show ${open.length - INITIAL_VISIBLE} more`}
          </button>
        )}
      </section>

      {processing.length > 0 && (
        <section className={styles.decided} aria-labelledby="processing-title">
          <h2 id="processing-title" className={styles.sectionLabel}>
            Veyrafy is working on
          </h2>
          <ul className={styles.quietList}>
            {processing.map((inv) => (
              <li key={inv.id} className={styles.quietRow}>
                <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.quietMain}>
                  <span className={styles.quietNumber}>
                    {inv.number ? `Invoice ${inv.number}` : inv.filename}
                  </span>
                  <span className={styles.quietSupplier}>
                    {inv.supplierName ?? (inv.source === 'Photo' ? 'Phone photo' : 'PDF')}
                  </span>
                </a>
                <span className={styles.quietStatus} data-outcome="processing">
                  {STATUS_LABEL.processing}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {cleared.length > 0 && (
        <details className={styles.cleared}>
          <summary className={styles.clearedSummary}>
            <span className={styles.clearedMark} aria-hidden="true">
              <Icon name="check" size={13} />
            </span>
            <span>
              {cleared.length} invoice{cleared.length === 1 ? '' : 's'} cleared
              <span className={styles.clearedQuiet}> · Nothing needs your attention</span>
            </span>
            <Icon name="chevronRight" size={14} className={styles.chev} />
          </summary>
          <ul className={styles.quietList}>
            {cleared.map((inv) => (
              <QuietRow key={inv.id} inv={inv} />
            ))}
          </ul>
          <a className={styles.allLink} href={hrefFor({ name: 'invoices', filter: 'handled' })}>
            See handled invoices
          </a>
        </details>
      )}

      {rejected.length > 0 && (
        <details className={styles.cleared}>
          <summary className={styles.clearedSummary}>
            <span className={styles.rejectedMark} aria-hidden="true">
              <Icon name="close" size={12} />
            </span>
            <span>
              {rejected.length} invoice{rejected.length === 1 ? '' : 's'} rejected
            </span>
            <Icon name="chevronRight" size={14} className={styles.chev} />
          </summary>
          <ul className={styles.quietList}>
            {rejected.map((inv) => (
              <QuietRow key={inv.id} inv={inv} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Three states, never more: cleared, a difference to review, or something to confirm. */
export function stateOf(inv: ApiInvoiceSummary): 'cleared' | 'review' | 'confirm' {
  if (inv.status !== 'attention') return 'cleared';
  return inv.finding?.state === 'confirm' ||
    (!inv.finding && inv.question && inv.question.kind !== 'VALIDATION_FAILURE')
    ? 'confirm'
    : 'review';
}

export const STATE_TEXT = {
  cleared: 'Cleared',
  review: 'Needs review',
  confirm: 'Needs confirmation',
} as const;

export function StateBadge({ state }: { state: 'cleared' | 'review' | 'confirm' }) {
  return (
    <span className={styles.state} data-state={state}>
      <span aria-hidden="true">{state === 'cleared' ? '✓' : state === 'review' ? '⚠' : '?'}</span>
      {STATE_TEXT[state]}
    </span>
  );
}

/** One exception: what kind, what is at stake, whose invoice, why, and the one action. */
function ExceptionCard({ inv }: { inv: ApiInvoiceSummary }) {
  const f = inv.finding;
  const state = stateOf(inv);
  const label =
    f?.label ??
    inv.question?.summary ??
    (inv.failure ? 'Couldn’t finish' : 'Differs from the ERP record');
  const impact =
    f?.impact ?? (inv.failure ? 'Needs review' : (inv.question?.evidence ?? 'Needs review'));
  const explanation =
    f?.explanation ??
    inv.failure?.reason ??
    inv.question?.headline ??
    'Open it to see every value next to the ERP’s.';
  return (
    <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.card} data-state={state}>
      <span className={styles.cardTop}>
        <StateBadge state={state} />
        {f && f.more > 0 && <span className={styles.cardMore}>+{f.more} more on this invoice</span>}
      </span>
      <span className={styles.cardTitle}>{label}</span>
      {/* A confirmation with no amount at stake says so once, in its badge. */}
      {!(state === 'confirm' && !f?.impactPaise) && (
        <span className={styles.cardImpact} data-tone={f?.impactPaise ? 'amount' : 'plain'}>
          {impact}
        </span>
      )}
      <span className={styles.cardWho}>
        {inv.supplierName ?? inv.filename}
        {inv.number ? ` · ${inv.number}` : ''}
        {inv.totalPaise !== null ? ` · ${inr(inv.totalPaise)}` : ''}
      </span>
      <span className={styles.cardWhy}>{explanation}</span>
      <span className={styles.cardAction}>
        {f?.action ?? (inv.failure ? 'Open invoice' : 'Review')}
        <Icon name="chevronRight" size={14} />
      </span>
    </a>
  );
}

function QuietRow({ inv }: { inv: ApiInvoiceSummary }) {
  return (
    <li className={styles.quietRow}>
      <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.quietMain}>
        <span className={styles.quietNumber}>
          {inv.number ? `Invoice ${inv.number}` : inv.filename}
        </span>
        <span className={styles.quietSupplier}>
          {inv.supplierName}
          {(inv.note ?? inv.decision?.result) ? ` · ${inv.note ?? inv.decision?.result}` : ''}
        </span>
      </a>
      <span className={styles.quietAmount}>
        {inv.totalPaise === null ? '' : inr(inv.totalPaise)}
      </span>
      <span className={styles.quietStatus} data-outcome={inv.status}>
        {inv.status === 'rejected' ? (
          STATUS_LABEL.rejected
        ) : (
          <>
            <Icon name="check" size={13} /> {STATUS_LABEL[inv.status]}
          </>
        )}
      </span>
    </li>
  );
}
