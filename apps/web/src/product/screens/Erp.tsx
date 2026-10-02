import { formatRate, rateBp } from '@veyra/shared';
import { useState, type ReactNode } from 'react';
import { StatusPill } from '../../design-system';
import { PageHeader } from '../components/PageHeader';
import { api } from '../api/client';
import { formatDate, inr } from '../format';
import { ERP_TABS, hrefFor, type ErpTab } from '../router';
import { useProductData, useResource } from '../state/data';
import { useAllowed } from '../../access/session';
import { ErpData } from './ErpData';
import { ErpReceipts } from '../components/ErpReceipts';
import { erpStatusText } from '../state/decision';
import {
  capabilityList,
  connectionIdentity,
  connectionStatusText,
  systemName,
  type ErpConnectionView,
} from '../state/connection';
import styles from './Erp.module.css';

const TAB_LABEL: Record<ErpTab, string> = {
  vendors: 'Vendors',
  items: 'Items',
  orders: 'Purchase orders',
  receipts: 'Goods receipts',
  invoices: 'Purchase invoices',
  data: 'Import and export',
  connection: 'Business system',
};

function Table({
  head,
  rows,
  numeric = [],
}: {
  head: string[];
  rows: ReactNode[][];
  numeric?: number[];
}) {
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={numeric.includes(i) ? styles.num : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={numeric.includes(j) ? styles.num : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ORIGIN: Record<string, string> = {
  seed: 'Existing',
  imported: 'Imported by you',
  created_by_veyra: 'Added by Veyrafy',
  auto_created_from_invoice: 'Created from invoice (automatic)',
  created_from_invoice_on_approval: 'Created from invoice (your approval)',
  user_confirmed_via_veyra: 'Confirmed by you',
};
const origin = (o: string): ReactNode =>
  o === 'seed' ? ORIGIN.seed : <span className={styles.origin}>{ORIGIN[o] ?? o}</span>;

function useTab(tab: ErpTab) {
  return useResource<ReactNode[][]>(async () => {
    switch (tab) {
      case 'vendors':
        return (await api.erp.vendors()).map((v) => [
          v.code,
          v.name,
          <span className={styles.mono}>{v.gstin}</span>,
          v.state,
          v.status === 'active' ? 'Active' : <StatusPill status="attention">Inactive</StatusPill>,
          origin(v.origin),
        ]);
      case 'items':
        return (await api.erp.items()).map((i) => [
          i.code,
          i.name,
          i.hsnSac,
          i.uom,
          formatRate(rateBp(i.gstRateBp)),
          origin(i.origin),
        ]);
      case 'orders':
        return (await api.erp.purchaseOrders()).map((po) => [
          po.poNumber,
          po.vendor,
          formatDate(po.poDate),
          po.lines,
          po.status === 'open' ? 'Open' : 'Closed',
          origin(po.origin),
        ]);
      case 'receipts':
        return (await api.erp.grns()).map((g) => [
          g.grnNumber,
          g.poNumber,
          formatDate(g.grnDate),
          g.accepted,
          origin(g.origin),
        ]);
      case 'data':
      case 'connection':
        return [];
      case 'invoices':
        return (await api.erp.purchaseInvoices()).map((i) => [
          i.id,
          i.vendorInvoiceNo,
          i.vendor,
          i.poNumber ?? '—',
          formatDate(i.invoiceDate),
          i.lines,
          inr(i.totalPaise),
          erpStatusText(i.status),
        ]);
    }
  }, `erp:${tab}`);
}

const HEAD: Record<ErpTab, { head: string[]; numeric?: number[] }> = {
  vendors: { head: ['Code', 'Vendor', 'GSTIN', 'State', 'Status', 'Source'] },
  items: { head: ['Code', 'Item', 'HSN', 'Unit', 'GST', 'Source'], numeric: [4] },
  orders: { head: ['Order', 'Vendor', 'Date', 'Lines', 'Status', 'Source'] },
  receipts: { head: ['Receipt', 'Order', 'Date', 'Accepted', 'Source'] },
  invoices: {
    head: ['Record', 'Invoice', 'Vendor', 'Order', 'Date', 'Lines', 'Total', 'Status'],
    numeric: [5, 6],
  },
  data: { head: [] },
  connection: { head: [] },
};

/**
 * The business system Veyrafy works with (Phase 4): reference only. There is nothing to connect,
 * no credentials and no settings here; the connection is configured where Veyrafy is deployed.
 */
function Connection({ connection }: { connection: ErpConnectionView | null }) {
  if (!connection) return <p className={styles.none}>Loading…</p>;
  const connected = connection.status === 'CONNECTED';
  return (
    <section className={styles.system} aria-label="Your business system">
      <p className={styles.eyebrow}>Your business system</p>
      <div className={styles.systemHead}>
        <div>
          <h2 className={styles.systemName}>{systemName(connection)}</h2>
          <p className={styles.company}>{connection.company?.name ?? 'Company not available'}</p>
        </div>
        <StatusPill status={connected ? 'handled' : 'attention'}>
          {connectionStatusText(connection.status)}
        </StatusPill>
      </div>
      <p className={styles.eyebrow}>What Veyrafy can do in it</p>
      <ul className={styles.capabilities}>
        {capabilityList(connection).map((c) => (
          <li key={c.label} className={c.supported ? undefined : styles.unsupported}>
            <span aria-hidden="true">{c.supported ? '✓' : '–'}</span>
            {c.label}
            {c.supported ? null : <span className={styles.sr}> (not supported)</span>}
          </li>
        ))}
      </ul>
      <ReaderTest />
    </section>
  );
}

/** Checks in one click that the main reader (the one that reads invoices) answers. */
function ReaderTest() {
  const canTest = useAllowed('imports.manage');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; plain: string; technical: string } | null>(
    null,
  );
  if (!canTest) return null;
  const run = () => {
    setBusy(true);
    setResult(null);
    api
      .testReader()
      .then((r) => setResult(r))
      .catch(() =>
        setResult({
          ok: false,
          plain: "Veyrafy couldn't run the check just now. Try again in a moment.",
          technical: 'the request did not complete',
        }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.reader}>
      <p className={styles.eyebrow}>The invoice reader</p>
      <p className={styles.readerText}>
        Check that the reader Veyrafy uses to read invoices is answering.
      </p>
      <div>
        <button type="button" className={styles.action} disabled={busy} onClick={run}>
          {busy ? 'Checking…' : 'Test the reader'}
        </button>
      </div>
      {result && (
        <div className={styles.readerResult} data-ok={result.ok} role="status">
          <p>
            <span aria-hidden="true">{result.ok ? '✓ ' : '✗ '}</span>
            {result.plain}
          </p>
          <details>
            <summary>Details for your technical team</summary>
            <code>{result.technical}</code>
          </details>
        </div>
      )}
    </div>
  );
}

export function Erp({ tab }: { tab: ErpTab }) {
  const { data, error } = useTab(tab);
  const { refresh } = useProductData();
  // Demo only: the same reset as the sidebar's (the sample ERP and every invoice together, so no
  // invoice is left pointing at records that no longer exist).
  const canReset = useAllowed('demo.manage');
  const resetErp = (erp: 'demo' | 'empty') => {
    if (
      window.confirm(
        erp === 'empty'
          ? 'Empty the ERP? Every supplier, item, order and receipt is removed (only your company stays), and every invoice is cleared.'
          : 'Restore the sample ERP? Its original records come back and every invoice is cleared.',
      )
    )
      void api.resetDemo(erp).then(() => refresh());
  };
  const { data: connection } = useResource(() => api.erp.connection(), 'erp:connection');
  const spec = HEAD[tab];
  const body: ReactNode =
    tab === 'connection' ? (
      <Connection connection={connection} />
    ) : tab === 'data' ? (
      <>
        <ErpReceipts />
        <ErpData />
      </>
    ) : data === null ? (
      <p className={styles.none}>{error ?? 'Loading…'}</p>
    ) : data.length === 0 ? (
      <p className={styles.none}>
        {tab === 'invoices' ? 'No purchase invoices recorded yet.' : 'Nothing here yet.'}
      </p>
    ) : (
      <Table head={spec.head} rows={data} numeric={spec.numeric ?? []} />
    );

  return (
    <div className={styles.page}>
      <PageHeader
        title="ERP"
        sub={
          <>
            The records every invoice is checked against.
            {connection && (
              <>
                {' '}
                <a className={styles.identity} href={hrefFor({ name: 'erp', tab: 'connection' })}>
                  {connectionIdentity(connection)}
                </a>
              </>
            )}
          </>
        }
        aside={
          tab === 'data' || tab === 'connection' ? undefined : (
            <>
              {canReset && (
                <>
                  <button type="button" className={styles.action} onClick={() => resetErp('empty')}>
                    Empty the ERP
                  </button>
                  <button type="button" className={styles.action} onClick={() => resetErp('demo')}>
                    Restore sample ERP
                  </button>
                </>
              )}
              <a className={styles.action} href={hrefFor({ name: 'erp', tab: 'data' })}>
                Import business records
              </a>
            </>
          )
        }
      />
      <nav className={styles.tabs} aria-label="ERP records">
        {ERP_TABS.map((t) => (
          <a
            key={t}
            href={hrefFor({ name: 'erp', tab: t })}
            className={styles.tab}
            aria-current={t === tab ? 'page' : undefined}
          >
            {TAB_LABEL[t]}
          </a>
        ))}
      </nav>
      {body}
    </div>
  );
}
