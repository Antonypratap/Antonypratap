import { Icon, Struck } from '../../design-system';
import { PageHeader } from '../components/PageHeader';
import { inr } from '../format';
import { hrefFor } from '../router';
import { useDemoState } from '../state/DemoStore';
import { STATUS_LABEL, answeredQuestions, openQuestions } from '../state/demo';
import styles from './Questions.module.css';

export function Questions() {
  const state = useDemoState();
  const open = openQuestions(state);
  const answered = answeredQuestions(state);
  const n = open.length;

  return (
    <div className={styles.page}>
      {n > 0 ? (
        <PageHeader
          title={`${n} ${n === 1 ? 'decision needs' : 'decisions need'} you.`}
          sub="Everything else is handled by Veyra."
        />
      ) : (
        <PageHeader title="Nothing needs your decision." sub="Veyra is taking care of the rest." />
      )}

      {n > 0 && (
        <ul className={styles.list} aria-label="Decisions waiting for you">
          {open.map((inv) => (
            <li key={inv.id}>
              <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.row}>
                <span className={styles.who}>
                  <span className={styles.supplier}>{inv.supplier.name}</span>
                  <span className={styles.number}>Invoice {inv.number}</span>
                </span>
                <span className={styles.what}>
                  <span className={styles.summary}>{inv.question?.summary}</span>
                  <span className={styles.evidence}>{inv.question?.evidence}</span>
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

      {answered.length > 0 && (
        <section className={styles.history} aria-labelledby="history-title">
          <h2 id="history-title" className={styles.label}>
            Recently decided
          </h2>
          <ul>
            {answered.map(({ invoice, decision }) => (
              <li key={invoice.id}>
                <a
                  href={hrefFor({ name: 'invoice', id: invoice.id })}
                  className={styles.historyRow}
                >
                  <span className={styles.historyMain}>
                    <Struck struck>{invoice.question?.summary}</Struck>
                    <span className={styles.historyWho}>
                      {invoice.supplier.name} · You chose “{decision.label}”
                    </span>
                  </span>
                  <span className={styles.status} data-status={decision.outcome}>
                    {STATUS_LABEL[decision.outcome]}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
