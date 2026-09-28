import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { hrefFor } from '../router';
import { useProductData, useResource } from '../state/data';
import { STATUS_LABEL } from '../state/status';
import styles from './Audit.module.css';

export function Audit({ id }: { id: string | null }) {
  const { inbox } = useProductData();
  const invoices = inbox?.invoices ?? [];
  const selected = invoices.find((i) => i.id === id) ?? invoices[0] ?? null;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Audit"
        sub="What happened to each invoice, and who did it. Veyra does the checking; you make the decisions."
      />
      {selected === null ? (
        <p className={styles.empty}>Nothing has happened yet. Upload an invoice from the Inbox.</p>
      ) : (
        <div className={styles.grid}>
          <nav className={styles.list} aria-label="Invoices">
            {invoices.map((inv) => (
              <a
                key={inv.id}
                href={hrefFor({ name: 'audit', id: inv.id })}
                className={styles.listItem}
                aria-current={inv.id === selected.id ? 'page' : undefined}
              >
                <span className={styles.listNumber}>{inv.number ?? inv.filename}</span>
                <span className={styles.listMeta}>
                  {inv.supplierName ?? inv.source} · {STATUS_LABEL[inv.status]}
                </span>
              </a>
            ))}
          </nav>
          <Timeline invoiceId={selected.id} title={selected.number ?? selected.filename} />
        </div>
      )}
    </div>
  );
}

function Timeline({ invoiceId, title }: { invoiceId: string; title: string }) {
  const { data: trail } = useResource(() => api.audit(invoiceId), `audit:${invoiceId}`);
  return (
    <section className={styles.timelineWrap} aria-label={`History of invoice ${title}`}>
      <div className={styles.timelineHead}>
        <p className={styles.timelineTitle}>Invoice {title}</p>
        <a href={hrefFor({ name: 'invoice', id: invoiceId })} className={styles.open}>
          Open invoice
        </a>
      </div>
      <ol className={styles.timeline}>
        {(trail ?? []).map((e) => (
          <li
            key={e.id}
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
  );
}
