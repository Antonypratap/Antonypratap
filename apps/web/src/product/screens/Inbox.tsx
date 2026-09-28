import { useState } from 'react';
import { Icon, Struck } from '../../design-system';
import { INVOICES } from '../data/invoices';
import { greetingFor, inr } from '../format';
import { hrefFor } from '../router';
import { useDemoDispatch, useDemoState } from '../state/DemoStore';
import { answeredQuestions, openQuestions, weekSummary, STATUS_LABEL } from '../state/demo';
import styles from './Inbox.module.css';

const INITIAL_VISIBLE = 5;

export function Inbox() {
  const state = useDemoState();
  const dispatch = useDemoDispatch();
  const [showAll, setShowAll] = useState(false);
  const open = openQuestions(state);
  const answered = answeredQuestions(state);
  const week = weekSummary(state);
  const visible = showAll ? open : open.slice(0, INITIAL_VISIBLE);
  const handled = INVOICES.filter((i) => i.initialStatus === 'handled');

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.greeting}>{greetingFor(new Date().getHours())}</h1>
        <p className={styles.sub}>
          {week.needsYou > 0 ? 'Here’s what needs your attention.' : 'Nothing needs you right now.'}
        </p>
      </header>

      <section className={styles.week} aria-label="This week">
        <div className={styles.needs} data-zero={week.needsYou === 0}>
          <span className={styles.needsNumber}>{week.needsYou}</span>
          <span className={styles.needsLabel}>
            {week.needsYou === 1 ? 'needs you' : 'need you'}
          </span>
        </div>
        <div className={styles.rest}>
          <p className={styles.restLine}>
            <span className={styles.handledNumber}>{week.handled}</span> handled by Veyra
            {week.decidedByYou > 0 && (
              <span className={styles.decidedByYou}> · {week.decidedByYou} decided by you</span>
            )}
            <span className={styles.of}> · {week.received} invoices this week</span>
          </p>
          <div className={styles.bar} aria-hidden="true">
            <span className={styles.barHandled} style={{ flexGrow: week.handled }} />
            {week.decidedByYou > 0 && (
              <span className={styles.barDecided} style={{ flexGrow: week.decidedByYou }} />
            )}
            {week.needsYou > 0 && (
              <span className={styles.barNeeds} style={{ flexGrow: week.needsYou }} />
            )}
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
            <span className={styles.emptyIcon}>
              <Icon name="check" size={18} />
            </span>
            <div>
              <p className={styles.emptyTitle}>You&rsquo;re all caught up.</p>
              <p className={styles.emptyText}>Veyra is handling everything else.</p>
            </div>
          </div>
        ) : (
          <ul className={styles.items}>
            {visible.map((inv) => (
              <li key={inv.id}>
                <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.item}>
                  <span className={styles.issue}>
                    <span className={styles.issueTitle}>{inv.question?.summary}</span>
                    <span className={styles.evidence}>{inv.question?.evidence}</span>
                  </span>
                  <span className={styles.who}>
                    <span className={styles.supplier}>{inv.supplier.name}</span>
                    <span className={styles.number}>Invoice {inv.number}</span>
                  </span>
                  <span className={styles.amount}>{inr(inv.totalPaise)}</span>
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

      {answered.length > 0 && (
        <section className={styles.decided} aria-labelledby="decided-title">
          <h2 id="decided-title" className={styles.sectionLabel}>
            Decided just now
          </h2>
          <ul className={styles.quietList}>
            {answered.map(({ invoice, decision }) => (
              <li key={invoice.id} className={styles.quietRow}>
                <a href={hrefFor({ name: 'invoice', id: invoice.id })} className={styles.quietMain}>
                  <Struck struck>{invoice.question?.summary}</Struck>
                  <span className={styles.quietSupplier}>
                    {invoice.supplier.name} · {decision.result}
                  </span>
                </a>
                <span className={styles.quietStatus} data-outcome={decision.outcome}>
                  {STATUS_LABEL[decision.outcome]}
                </span>
                <button
                  type="button"
                  className={styles.undo}
                  onClick={() => dispatch({ type: 'undo', invoiceId: invoice.id })}
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
                  {inv.supplier.name} · {inv.handledNote}
                </span>
              </a>
              <span className={styles.quietAmount}>{inr(inv.totalPaise)}</span>
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
    </div>
  );
}
