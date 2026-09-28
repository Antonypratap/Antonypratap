import { PageHeader } from '../components/PageHeader';
import { INVOICES, invoiceById } from '../data/invoices';
import { hrefFor } from '../router';
import { useDemoState } from '../state/DemoStore';
import { auditTrail } from '../state/audit';
import { STATUS_LABEL, statusOf } from '../state/demo';
import styles from './Audit.module.css';

export function Audit({ id }: { id: string | null }) {
  const state = useDemoState();
  const selected = (id && invoiceById(id)) || INVOICES[0];
  if (!selected) return null;
  const trail = auditTrail(selected, state.decisions[selected.id]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Audit"
        sub="What happened to each invoice, and who did it. Veyra does the checking; you make the decisions."
      />
      <div className={styles.grid}>
        <nav className={styles.list} aria-label="Invoices">
          {INVOICES.map((inv) => (
            <a
              key={inv.id}
              href={hrefFor({ name: 'audit', id: inv.id })}
              className={styles.listItem}
              aria-current={inv.id === selected.id ? 'page' : undefined}
            >
              <span className={styles.listNumber}>{inv.number}</span>
              <span className={styles.listMeta}>
                {inv.supplier.name} · {STATUS_LABEL[statusOf(inv, state)]}
              </span>
            </a>
          ))}
        </nav>
        <section
          className={styles.timelineWrap}
          aria-label={`History of invoice ${selected.number}`}
        >
          <div className={styles.timelineHead}>
            <p className={styles.timelineTitle}>Invoice {selected.number}</p>
            <a href={hrefFor({ name: 'invoice', id: selected.id })} className={styles.open}>
              Open invoice
            </a>
          </div>
          <ol className={styles.timeline}>
            {trail.map((e, i) => (
              <li
                key={`${e.title}-${i}`}
                className={styles.entry}
                data-tone={e.tone}
                data-by={e.by === 'You' ? 'you' : 'veyra'}
              >
                <span className={styles.dot} aria-hidden="true" />
                <div>
                  <p className={styles.entryTitle}>
                    <span className={styles.by}>{e.by}</span>
                    {e.title}
                  </p>
                  <p className={styles.entryDetail}>{e.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
