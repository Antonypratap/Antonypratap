import { useState } from 'react';
import { Icon, Struck } from '../../design-system';
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
  const counts = inbox?.counts;
  const needsYou = counts?.needsYou ?? 0;
  const handledByVeyra = counts?.handled ?? 0;
  const decidedByYou = counts?.decidedByYou ?? 0;
  const visible = showAll ? open : open.slice(0, INITIAL_VISIBLE);
  const processing = invoices.filter((i) => i.status === 'processing');
  const decided = invoices
    .filter((i) => i.decision && i.status !== 'attention')
    .sort((a, b) => (b.decision?.at ?? '').localeCompare(a.decision?.at ?? ''));
  const handled = invoices.filter((i) => i.status === 'handled').slice(0, 5);

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

      <section className={styles.week} aria-label="Invoices">
        <div className={styles.needs} data-zero={needsYou === 0}>
          <span className={styles.needsNumber}>{needsYou}</span>
          <span className={styles.needsLabel}>{needsYou === 1 ? 'needs you' : 'need you'}</span>
        </div>
        <div className={styles.rest}>
          <p className={styles.restLine}>
            <span className={styles.handledNumber}>{handledByVeyra}</span> handled by Veyrafy
            {decidedByYou > 0 && (
              <span className={styles.decidedByYou}> · {decidedByYou} decided by you</span>
            )}
            <span className={styles.of}>
              {' '}
              · {counts?.received ?? 0} invoice{counts?.received === 1 ? '' : 's'} received
            </span>
          </p>
          <div className={styles.bar} aria-hidden="true">
            <span className={styles.barHandled} style={{ flexGrow: handledByVeyra }} />
            {decidedByYou > 0 && (
              <span className={styles.barDecided} style={{ flexGrow: decidedByYou }} />
            )}
            {needsYou > 0 && <span className={styles.barNeeds} style={{ flexGrow: needsYou }} />}
          </div>
        </div>
      </section>

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
          <ul className={styles.items}>
            {visible.map((inv) => (
              <li key={inv.id}>
                <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.item}>
                  <span className={styles.issue}>
                    <span className={styles.issueTitle}>
                      {inv.question?.summary ??
                        (inv.failure ? 'Couldn’t finish' : 'Differs from the ERP record')}
                    </span>
                    <span className={styles.evidence}>
                      {inv.question?.evidence ??
                        inv.failure?.reason ??
                        'Open it to see every value next to the ERP’s'}
                    </span>
                  </span>
                  <span className={styles.who}>
                    <span className={styles.supplier}>{inv.supplierName ?? inv.filename}</span>
                    <span className={styles.number}>
                      {inv.number ? `Invoice ${inv.number}` : inv.source}
                    </span>
                  </span>
                  <span className={styles.amount}>
                    {inv.totalPaise === null ? '' : inr(inv.totalPaise)}
                  </span>
                  <span className={styles.review}>
                    Review
                    <Icon name="chevronRight" size={14} />
                  </span>
                </a>
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

      {decided.length > 0 && (
        <section className={styles.decided} aria-labelledby="decided-title">
          <h2 id="decided-title" className={styles.sectionLabel}>
            Decided by you
          </h2>
          <ul className={styles.quietList}>
            {decided.map((inv) => (
              <li key={inv.id} className={styles.quietRow}>
                <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.quietMain}>
                  <Struck struck>{inv.decision?.summary}</Struck>
                  <span className={styles.quietSupplier}>
                    {inv.supplierName} ·{' '}
                    {inv.status === 'processing'
                      ? inv.decision?.result
                      : (inv.note ?? inv.decision?.result)}
                  </span>
                </a>
                <span className={styles.quietStatus} data-outcome={inv.status}>
                  {STATUS_LABEL[inv.status]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {handled.length > 0 && (
        <section className={styles.handled} aria-labelledby="handled-title">
          <h2 id="handled-title" className={styles.sectionLabel}>
            Recently handled
          </h2>
          <ul className={styles.quietList}>
            {handled.map((inv) => (
              <li key={inv.id} className={styles.quietRow}>
                <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.quietMain}>
                  <span className={styles.quietNumber}>Invoice {inv.number}</span>
                  <span className={styles.quietSupplier}>
                    {inv.supplierName} · {inv.note}
                  </span>
                </a>
                <span className={styles.quietAmount}>
                  {inv.totalPaise === null ? '' : inr(inv.totalPaise)}
                </span>
                <span className={styles.quietStatus} data-outcome="handled">
                  <Icon name="check" size={13} /> Handled
                </span>
              </li>
            ))}
          </ul>
          <a className={styles.allLink} href={hrefFor({ name: 'invoices', filter: 'handled' })}>
            See handled invoices
          </a>
        </section>
      )}
    </div>
  );
}
