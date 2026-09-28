import { useState } from 'react';
import { Icon, StatusPill } from '../../design-system';
import { PageHeader } from '../components/PageHeader';
import { INVOICES, WEEK } from '../data/invoices';
import { formatDate, inr } from '../format';
import { INVOICE_FILTERS, hrefFor, type InvoiceFilter } from '../router';
import { useDemoState } from '../state/DemoStore';
import { STATUS_LABEL, statusOf } from '../state/demo';
import styles from './Invoices.module.css';

const FILTER_LABEL: Record<InvoiceFilter, string> = {
  all: 'All',
  attention: 'Needs attention',
  handled: 'Handled',
};

export function Invoices({ filter }: { filter: InvoiceFilter }) {
  const state = useDemoState();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = INVOICES.map((inv) => ({ inv, status: statusOf(inv, state) }))
    .filter(({ status }) =>
      filter === 'all'
        ? true
        : filter === 'attention'
          ? status === 'attention'
          : status !== 'attention',
    )
    .filter(
      ({ inv }) =>
        !q || inv.number.toLowerCase().includes(q) || inv.supplier.name.toLowerCase().includes(q),
    );

  return (
    <div className={styles.page}>
      <PageHeader title="Invoices" sub="Every invoice from this week, with where it stands." />
      <div className={styles.tools}>
        <div className={styles.filters} role="tablist" aria-label="Filter invoices">
          {INVOICE_FILTERS.map((f) => (
            <a
              key={f}
              role="tab"
              aria-selected={f === filter}
              href={hrefFor({ name: 'invoices', filter: f })}
              className={styles.filter}
            >
              {FILTER_LABEL[f]}
            </a>
          ))}
        </div>
        <label className={styles.search}>
          <Icon name="search" size={15} />
          <span className="visually-hidden">Search invoices</span>
          <input
            type="search"
            placeholder="Invoice number or supplier"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>

      <div className={styles.table} role="table" aria-label="Invoices">
        <div className={styles.headRow} role="row">
          <span role="columnheader">Invoice</span>
          <span role="columnheader">Supplier</span>
          <span role="columnheader">Date</span>
          <span role="columnheader" className={styles.right}>
            Amount
          </span>
          <span role="columnheader">Status</span>
        </div>
        {rows.map(({ inv, status }) => (
          <a
            key={inv.id}
            role="row"
            href={hrefFor({ name: 'invoice', id: inv.id })}
            className={styles.row}
            data-status={status}
          >
            <span role="cell" className={styles.number}>
              {inv.number}
            </span>
            <span role="cell" className={styles.supplier}>
              {inv.supplier.name}
            </span>
            <span role="cell" className={styles.date}>
              {formatDate(inv.date)}
            </span>
            <span role="cell" className={`${styles.right} ${styles.amount}`}>
              {inr(inv.totalPaise)}
            </span>
            <span role="cell">
              <StatusPill
                status={
                  status === 'attention'
                    ? 'attention'
                    : status === 'rejected'
                      ? 'neutral'
                      : status === 'processing'
                        ? 'received'
                        : 'handled'
                }
              >
                {STATUS_LABEL[status]}
              </StatusPill>
            </span>
          </a>
        ))}
        {rows.length === 0 && <p className={styles.empty}>No invoices match.</p>}
      </div>
      <p className={styles.note}>
        This demo shows {INVOICES.length} of the week&rsquo;s {WEEK.received} invoices. The rest
        were handled without anyone needing to look.
      </p>
    </div>
  );
}
