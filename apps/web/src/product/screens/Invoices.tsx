import { useState } from 'react';
import { Icon, StatusPill } from '../../design-system';
import { ExportLink, PageHeader } from '../components/PageHeader';
import { exportUrl } from '../api/client';
import { formatDate, inr } from '../format';
import { INVOICE_FILTERS, hrefFor, type InvoiceFilter } from '../router';
import { useProductData } from '../state/data';
import { STATUS_LABEL, STATUS_TONE } from '../state/status';
import { hasCapability, useCapabilities } from '../state/capabilities';
import styles from './Invoices.module.css';
import { useAllowed } from '../../access/session';

const FILTER_LABEL: Record<InvoiceFilter, string> = {
  all: 'All',
  attention: 'Needs your attention',
  handled: 'Handled',
};

export function Invoices({ filter }: { filter: InvoiceFilter }) {
  const { inbox } = useProductData();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const rows = (inbox?.invoices ?? [])
    .map((inv) => ({ inv, status: inv.status }))
    .filter(({ status }) =>
      filter === 'all'
        ? true
        : filter === 'attention'
          ? status === 'attention'
          : status === 'handled',
    )
    .filter(
      ({ inv }) =>
        !q ||
        (inv.number ?? '').toLowerCase().includes(q) ||
        (inv.supplierName ?? '').toLowerCase().includes(q) ||
        inv.filename.toLowerCase().includes(q),
    );

  // Role (who may) and commercial capability (what the organization has): both are needed.
  const caps = useCapabilities();
  const canExport = useAllowed('exports.download') && hasCapability(caps, 'reports.exports');
  return (
    <div className={styles.page}>
      <PageHeader
        title="Invoices"
        sub="Every invoice received, with where it stands."
        aside={canExport ? <ExportLink href={exportUrl('invoices.xlsx')} /> : undefined}
      />
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
              {inv.number ?? inv.filename}
            </span>
            <span role="cell" className={styles.supplier}>
              {inv.supplierName ?? '—'}
            </span>
            <span role="cell" className={styles.date}>
              {inv.invoiceDate ? formatDate(inv.invoiceDate) : '—'}
            </span>
            <span role="cell" className={`${styles.right} ${styles.amount}`}>
              {inv.totalPaise === null ? '—' : inr(inv.totalPaise)}
            </span>
            <span role="cell">
              <StatusPill status={STATUS_TONE[status]}>{STATUS_LABEL[status]}</StatusPill>
            </span>
          </a>
        ))}
        {rows.length === 0 && (
          <p className={styles.empty}>
            {inbox?.invoices.length
              ? 'No invoices match.'
              : 'No invoices yet. Upload one from the Inbox.'}
          </p>
        )}
      </div>
    </div>
  );
}
