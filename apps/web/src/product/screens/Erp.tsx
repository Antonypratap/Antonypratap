import { formatQty, formatRate, milliQty, rateBp } from '@veyra/shared';
import type { ReactNode } from 'react';
import { StatusPill } from '../../design-system';
import { PageHeader } from '../components/PageHeader';
import { ITEMS, PURCHASE_ORDERS, VENDORS, itemByCode, vendorByCode } from '../data/erp';
import { INVOICES } from '../data/invoices';
import { formatDate, inr } from '../format';
import { ERP_TABS, hrefFor, type ErpTab } from '../router';
import { useDemoState } from '../state/DemoStore';
import { statusOf } from '../state/demo';
import styles from './Erp.module.css';

const TAB_LABEL: Record<ErpTab, string> = {
  vendors: 'Vendors',
  items: 'Items',
  orders: 'Purchase orders',
  receipts: 'Goods receipts',
  invoices: 'Purchase invoices',
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

const qty = (m: number, uom: string): string => `${formatQty(milliQty(m))} ${uom}`;

export function Erp({ tab }: { tab: ErpTab }) {
  const state = useDemoState();
  let body: ReactNode;
  switch (tab) {
    case 'vendors':
      body = (
        <Table
          head={['Code', 'Vendor', 'GSTIN', 'State', 'Status']}
          rows={VENDORS.map((v) => [
            v.code,
            v.name,
            <span className={styles.mono}>{v.gstin}</span>,
            v.state,
            v.status === 'active' ? 'Active' : <StatusPill status="attention">Inactive</StatusPill>,
          ])}
        />
      );
      break;
    case 'items':
      body = (
        <Table
          head={['Code', 'Item', 'HSN', 'Unit', 'GST']}
          numeric={[4]}
          rows={ITEMS.map((i) => [i.code, i.name, i.hsn, i.uom, formatRate(rateBp(i.gstRateBp))])}
        />
      );
      break;
    case 'orders':
      body = (
        <Table
          head={['Order', 'Vendor', 'Date', 'Lines', 'Status']}
          rows={PURCHASE_ORDERS.map((po) => [
            po.number,
            vendorByCode(po.vendorCode)?.name ?? po.vendorCode,
            formatDate(po.date),
            po.lines
              .map((l) => {
                const item = itemByCode(l.itemCode);
                return `${item?.name ?? l.itemCode} × ${qty(l.qtyMilli, item?.uom ?? '')} @ ${inr(l.unitPricePaise)}`;
              })
              .join('; '),
            po.status === 'open' ? 'Open' : 'Closed',
          ])}
        />
      );
      break;
    case 'receipts':
      body = (
        <Table
          head={['Receipt', 'Order', 'Date', 'Accepted']}
          rows={PURCHASE_ORDERS.map((po) => [
            po.grn?.number ?? <span className={styles.none}>None recorded</span>,
            po.number,
            po.grn ? formatDate(po.date) : '—',
            po.grn
              ? po.lines
                  .map((l, i) =>
                    qty(po.grn?.acceptedQtyMilli[i] ?? 0, itemByCode(l.itemCode)?.uom ?? ''),
                  )
                  .join('; ')
              : '—',
          ])}
        />
      );
      break;
    case 'invoices': {
      const recorded = INVOICES.filter((i) => {
        const s = statusOf(i, state);
        return s === 'handled' || s === 'ready';
      });
      body = (
        <Table
          head={['Invoice', 'Vendor', 'Date', 'Total', 'Status']}
          numeric={[3]}
          rows={recorded.map((i) => [
            i.number,
            i.supplier.name,
            formatDate(i.date),
            inr(i.totalPaise),
            'Verified, pending payment',
          ])}
        />
      );
      break;
    }
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="ERP"
        sub="The demo company’s records that Veyra checks invoices against. Read-only."
        aside={<span className={styles.badge}>Demo ERP</span>}
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
