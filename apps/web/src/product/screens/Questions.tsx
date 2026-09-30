import { Icon, Struck } from '../../design-system';
import { PageHeader } from '../components/PageHeader';
import { inr } from '../format';
import { hrefFor } from '../router';
import { attentionQueue, useProductData } from '../state/data';
import { ASK_LABEL } from '../state/decision';
import { STATUS_LABEL } from '../state/status';
import styles from './Questions.module.css';

export function Questions() {
  const { inbox, answered } = useProductData();
  const open = attentionQueue(inbox);
  const statusOf = (invoiceId: string) => inbox?.invoices.find((i) => i.id === invoiceId)?.status;
  const n = open.length;

  return (
    <div className={styles.page}>
      {n > 0 ? (
        <PageHeader
          title={`${n} ${n === 1 ? 'decision needs' : 'decisions need'} you.`}
          sub="Everything else is handled by Veyrafy."
        />
      ) : (
        <PageHeader
          title="Nothing needs your decision."
          sub="Veyrafy is taking care of the rest."
        />
      )}

      {n > 0 && (
        <ul className={styles.list} aria-label="Decisions waiting for you">
          {open.map((inv) => (
            <li key={inv.id}>
              <a href={hrefFor({ name: 'invoice', id: inv.id })} className={styles.row}>
                <span className={styles.who}>
                  <span className={styles.supplier}>{inv.supplierName ?? inv.filename}</span>
                  <span className={styles.number}>
                    {inv.number ? `Invoice ${inv.number}` : inv.source}
                  </span>
                </span>
                <span className={styles.what}>
                  <span className={styles.kind}>
                    {inv.question ? ASK_LABEL[inv.question.kind] : 'Veyrafy couldn’t finish'}
                  </span>
                  <span className={styles.summary}>
                    {inv.question?.headline ?? 'Check the file and try again, or reject it.'}
                  </span>
                  <span className={styles.evidence}>
                    {inv.question?.evidence ?? inv.failure?.reason}
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

      {answered.length > 0 && (
        <section className={styles.history} aria-labelledby="history-title">
          <h2 id="history-title" className={styles.label}>
            Recently decided
          </h2>
          <ul>
            {answered.map((q) => {
              const status = statusOf(q.invoiceId);
              return (
                <li key={q.id}>
                  <a
                    href={hrefFor({ name: 'invoice', id: q.invoiceId })}
                    className={styles.historyRow}
                  >
                    <span className={styles.historyMain}>
                      <Struck struck>{q.summary}</Struck>
                      <span className={styles.historyWho}>
                        {q.invoice.supplierName} · You chose “{q.answer?.label}”
                      </span>
                    </span>
                    {status && (
                      <span className={styles.status} data-status={status}>
                        {STATUS_LABEL[status]}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
