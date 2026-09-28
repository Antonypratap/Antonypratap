import { Icon } from '../../design-system';
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
  return (
    <div className={styles.page}>
      <PageHeader
        title="Questions"
        sub={
          open.length
            ? 'A few decisions need you. Everything else is handled.'
            : 'No decisions are waiting for you.'
        }
        aside={<span className={styles.waiting}>{open.length} waiting</span>}
      />
      <ul className={styles.list}>
        {open.map((inv) => (
          <li key={inv.id}>
            <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.card}>
              <span className={styles.who}>
                <span className={styles.supplier}>{inv.supplier.name}</span>
                <span className={styles.number}>Invoice {inv.number}</span>
              </span>
              <span className={styles.ask}>
                <span className={styles.summary}>{inv.question?.summary}</span>
                <span className={styles.headline}>{inv.question?.headline}</span>
              </span>
              <span className={styles.side}>
                <span className={styles.amount}>{inr(inv.totalPaise)}</span>
                <span className={styles.age}>
                  <Icon name="audit" size={13} /> {inv.question?.waiting}
                </span>
              </span>
              <span className={styles.review}>Review</span>
            </a>
          </li>
        ))}
      </ul>
      {answered.length > 0 && (
        <section className={styles.answered}>
          <h2 className={styles.label}>Answered</h2>
          <ul>
            {answered.map(({ invoice, decision }) => (
              <li key={invoice.id} className={styles.answeredRow}>
                <a href={hrefFor({ name: 'invoice', id: invoice.id })}>
                  {invoice.supplier.name} · {invoice.question?.summary}
                </a>
                <span>
                  {decision.label} · {STATUS_LABEL[decision.outcome]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
