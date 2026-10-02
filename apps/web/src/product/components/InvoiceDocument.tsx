import type { ReactNode } from 'react';
import {
  formatInr,
  formatQty,
  formatRate,
  milliQty,
  paise,
  rateBp,
  type ApiInvoiceDetail,
} from '@veyra/shared';
import { formatDate } from '../format';
import styles from './InvoiceDocument.module.css';

/** Plain rupee figure as printed on Indian invoices: 1,13,870.00 */
const amt = (p: number | null): string =>
  p === null ? '—' : formatInr(paise(p), { symbol: false });

/** Where on the document a value sits, for marking what a question is about. */
export type DocField =
  'supplier' | 'gstin' | 'number' | 'date' | 'po' | 'pos' | 'qty' | 'rate' | 'tax' | 'total';

function docField(path: string): DocField | null {
  const key = path.replace(/^header\./, '').replace(/^lines\[\d+\]\./, 'line.');
  const map: Record<string, DocField> = {
    vendorName: 'supplier',
    vendorAddress: 'supplier',
    vendorGstin: 'gstin',
    invoiceNumber: 'number',
    invoiceDate: 'date',
    poNumber: 'po',
    placeOfSupply: 'pos',
    cgstPaise: 'tax',
    sgstPaise: 'tax',
    igstPaise: 'tax',
    roundOffPaise: 'total',
    taxablePaise: 'total',
    totalPaise: 'total',
    'line.qtyMilli': 'qty',
    'line.uom': 'qty',
    'line.unitPricePaise': 'rate',
    'line.taxablePaise': 'rate',
    'line.cgstPaise': 'tax',
    'line.sgstPaise': 'tax',
    'line.igstPaise': 'tax',
  };
  return map[key] ?? null;
}

const fieldsOf = (paths: readonly string[]): DocField[] =>
  paths.map(docField).filter((f): f is DocField => f !== null);

/** A value on the document, marked where a question refers to it or blurred where a photo is unreadable. */
function MarkedField({
  field,
  marked,
  unreadable,
  children,
}: {
  field: DocField;
  marked: readonly DocField[];
  unreadable: readonly DocField[];
  children: ReactNode;
}) {
  return (
    <span
      className={styles.field}
      data-marked={marked.includes(field)}
      data-unreadable={unreadable.includes(field)}
    >
      {children}
    </span>
  );
}

/**
 * The invoice as Veyrafy read it, drawn in HTML: every value here comes from the stored reading of
 * the uploaded document, and nothing else (no names from the ERP, no computed wording, no standard
 * footer). Values a question is about are marked; unclear ones are blurred. The original document
 * is shown separately; this is never presented as it.
 */
export function InvoiceDocument({ invoice }: { invoice: ApiInvoiceDetail }) {
  const open = invoice.questions.find((q) => q.status === 'open');
  const markedFields = fieldsOf(open?.paths ?? []);
  const unreadableFields = fieldsOf(invoice.unclearPaths);
  const firstRate = invoice.lines[0]?.gstRateBp ?? 0;
  const halfRate = (bp: number): string => formatRate(rateBp(bp / 2));

  return (
    <article
      className={styles.paper}
      data-photo={invoice.source === 'Photo'}
      aria-label={`Invoice ${invoice.number ?? ''} as read by Veyrafy`}
    >
      <span className={styles.sample}>As read</span>

      <header className={styles.top}>
        <div>
          <p className={styles.supplierName}>
            <MarkedField field="supplier" marked={markedFields} unreadable={unreadableFields}>
              {invoice.supplier.name}
            </MarkedField>
          </p>
          <p className={styles.small}>{invoice.supplier.address}</p>
          <p className={styles.small}>
            GSTIN:{' '}
            <MarkedField field="gstin" marked={markedFields} unreadable={unreadableFields}>
              {invoice.supplier.gstin ?? '—'}
            </MarkedField>
          </p>
          {invoice.supplier.state && (
            <p className={styles.small}>
              State: {invoice.supplier.state} ({invoice.supplier.stateCode})
            </p>
          )}
        </div>
        <div className={styles.titleBlock}>
          <p className={styles.docTitle}>Tax Invoice</p>
          <dl className={styles.meta}>
            <div>
              <dt>Invoice No.</dt>
              <dd>
                <MarkedField field="number" marked={markedFields} unreadable={unreadableFields}>
                  {invoice.number}
                </MarkedField>
              </dd>
            </div>
            <div>
              <dt>Invoice Date</dt>
              <dd>
                <MarkedField field="date" marked={markedFields} unreadable={unreadableFields}>
                  {invoice.invoiceDate ? formatDate(invoice.invoiceDate) : '—'}
                </MarkedField>
              </dd>
            </div>
            <div>
              <dt>PO Reference</dt>
              <dd>
                <MarkedField field="po" marked={markedFields} unreadable={unreadableFields}>
                  {invoice.poNumber ?? '—'}
                </MarkedField>
              </dd>
            </div>
            <div>
              <dt>Place of Supply</dt>
              <dd>
                <MarkedField field="pos" marked={markedFields} unreadable={unreadableFields}>
                  {invoice.placeOfSupply ?? '—'}
                </MarkedField>
              </dd>
            </div>
          </dl>
        </div>
      </header>

      <section className={styles.parties}>
        <div>
          <p className={styles.label}>Bill to</p>
          <p className={styles.small}>GSTIN: {invoice.buyer.gstin ?? '—'}</p>
        </div>
        <div>
          <p className={styles.label}>Source</p>
          <p className={styles.strong}>{invoice.filename}</p>
          <p className={styles.small}>{invoice.source === 'Photo' ? 'Phone photo' : 'PDF'}</p>
        </div>
      </section>

      <table className={styles.lines}>
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            <th>HSN</th>
            <th className={styles.num}>Qty</th>
            <th className={styles.num}>Rate</th>
            <th className={styles.num}>Taxable</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.lineNo}>
              <td>{l.lineNo}</td>
              <td>{l.description ?? '—'}</td>
              <td>{l.hsnSac ?? '—'}</td>
              <td className={styles.num}>
                <MarkedField field="qty" marked={markedFields} unreadable={unreadableFields}>
                  {l.qtyMilli === null ? '—' : formatQty(milliQty(l.qtyMilli))} {l.uom}
                </MarkedField>
              </td>
              <td className={styles.num}>
                <MarkedField field="rate" marked={markedFields} unreadable={unreadableFields}>
                  {amt(l.unitPricePaise)}
                </MarkedField>
              </td>
              <td className={styles.num}>{amt(l.taxablePaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className={styles.bottom}>
        <div className={styles.words} />
        <dl className={styles.totals}>
          <div>
            <dt>Taxable value</dt>
            <dd>{amt(invoice.taxablePaise)}</dd>
          </div>
          {(
            [
              ['CGST', invoice.cgstPaise, firstRate ? halfRate(firstRate) : null],
              ['SGST', invoice.sgstPaise, firstRate ? halfRate(firstRate) : null],
              ['IGST', invoice.igstPaise, firstRate ? formatRate(rateBp(firstRate)) : null],
            ] as const
          )
            .filter(([, value]) => value !== null)
            .map(([head, value, rate]) => (
              <div key={head}>
                <dt>{rate ? `${head} @ ${rate}` : head}</dt>
                <dd>
                  <MarkedField field="tax" marked={markedFields} unreadable={unreadableFields}>
                    {amt(value)}
                  </MarkedField>
                </dd>
              </div>
            ))}
          {invoice.roundOffPaise !== null && (
            <div>
              <dt>Round off</dt>
              <dd>{amt(invoice.roundOffPaise)}</dd>
            </div>
          )}
          <div className={styles.grand}>
            <dt>Total</dt>
            <dd>
              <MarkedField field="total" marked={markedFields} unreadable={unreadableFields}>
                ₹ {amt(invoice.readTotalPaise)}
              </MarkedField>
            </dd>
          </div>
        </dl>
      </section>
    </article>
  );
}
