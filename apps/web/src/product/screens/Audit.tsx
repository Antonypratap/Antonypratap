import { ExportLink, PageHeader } from '../components/PageHeader';
import { api, exportUrl } from '../api/client';
import type { ApiAuditEntry } from '@veyra/shared';
import { hrefFor } from '../router';
import { useProductData, useResource } from '../state/data';
import { STATUS_LABEL } from '../state/status';
import styles from './Audit.module.css';
import { useAllowed } from '../../access/session';

export function Audit({ id }: { id: string | null }) {
  const { inbox } = useProductData();
  const invoices = inbox?.invoices ?? [];
  const { data: records } = useResource(() => api.recordsAudit(), 'records-audit');
  const hasRecords = (records?.length ?? 0) > 0;
  const showRecords = hasRecords && (id === 'records' || invoices.length === 0);
  const selected = showRecords ? null : (invoices.find((i) => i.id === id) ?? invoices[0] ?? null);

  const canExport = useAllowed('exports.download');
  return (
    <div className={styles.page}>
      <PageHeader
        title="Audit"
        sub="What happened to each invoice, and who did it. Veyra does the checking; you make the decisions."
        aside={canExport ? <ExportLink href={exportUrl('audit.xlsx')} /> : undefined}
      />
      {selected === null && !showRecords ? (
        <p className={styles.empty}>Nothing has happened yet. Upload an invoice from the Inbox.</p>
      ) : (
        <div className={styles.grid}>
          <nav className={styles.list} aria-label="Invoices">
            {hasRecords && (
              <a
                href={hrefFor({ name: 'audit', id: 'records' })}
                className={styles.listItem}
                aria-current={showRecords ? 'page' : undefined}
              >
                <span className={styles.listNumber}>Business records</span>
                <span className={styles.listMeta}>Imports</span>
              </a>
            )}
            {invoices.map((inv) => (
              <a
                key={inv.id}
                href={hrefFor({ name: 'audit', id: inv.id })}
                className={styles.listItem}
                aria-current={inv.id === selected?.id ? 'page' : undefined}
              >
                <span className={styles.listNumber}>{inv.number ?? inv.filename}</span>
                <span className={styles.listMeta}>
                  {inv.supplierName ?? inv.source} · {STATUS_LABEL[inv.status]}
                </span>
              </a>
            ))}
          </nav>
          {showRecords ? (
            <RecordsTimeline entries={records ?? []} />
          ) : (
            selected && (
              <Timeline invoiceId={selected.id} title={selected.number ?? selected.filename} />
            )
          )}
        </div>
      )}
    </div>
  );
}

function RecordsTimeline({ entries }: { entries: ApiAuditEntry[] }) {
  return (
    <section className={styles.timelineWrap} aria-label="History of business records">
      <div className={styles.timelineHead}>
        <p className={styles.timelineTitle}>Business records</p>
        <a href={hrefFor({ name: 'erp', tab: 'data' })} className={styles.open}>
          Import and export
        </a>
      </div>
      <Entries entries={entries} />
    </section>
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
      <Entries entries={trail ?? []} />
    </section>
  );
}

function Entries({ entries }: { entries: ApiAuditEntry[] }) {
  return (
    <ol className={styles.timeline}>
      {entries.map((e) => (
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
  );
}
