import type { ReactNode } from 'react';
import { formatInr, formatQty, formatRate, milliQty, paise, rateBp } from '@veyra/shared';
import { lineTaxableAmount } from '@veyra/india-tax';
import { BUYER, DOCUMENT_MARKS, type DemoInvoice, type DocField } from '../data/invoices';
import { amountInWords, formatDate } from '../format';
import styles from './InvoiceDocument.module.css';

/** Plain rupee figure as printed on Indian invoices: 1,13,870.00 */
const amt = (p: number): string => formatInr(paise(p), { symbol: false });

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

/** A sample Indian GST tax invoice, drawn in HTML. Clearly marked as a sample. */
export function InvoiceDocument({ invoice }: { invoice: DemoInvoice }) {
  const marks = DOCUMENT_MARKS[invoice.id];
  const markedFields = marks?.marked ?? [];
  const unreadableFields = marks?.unreadable ?? [];
  const intra = invoice.supply === 'intra_state';
  const halfRate = (bp: number): string => formatRate(rateBp(bp / 2));

  return (
    <article
      className={styles.paper}
      data-photo={invoice.source === 'Photo'}
      aria-label={`Sample invoice ${invoice.number}`}
    >
      <span className={styles.sample}>Sample</span>

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
              {invoice.supplier.gstin ?? '29AA?CV1??4F1Z?'}
            </MarkedField>
          </p>
          <p className={styles.small}>
            State: {invoice.supplier.state} ({invoice.supplier.stateCode})
          </p>
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
              <dd>{formatDate(invoice.date)}</dd>
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
              <dd>Karnataka (29)</dd>
            </div>
          </dl>
        </div>
      </header>

      <section className={styles.parties}>
        <div>
          <p className={styles.label}>Bill to</p>
          <p className={styles.strong}>{BUYER.name}</p>
          <p className={styles.small}>Plot 14, KIADB Industrial Area, Bengaluru 562114</p>
          <p className={styles.small}>GSTIN: {BUYER.gstin}</p>
        </div>
        <div>
          <p className={styles.label}>Ship to</p>
          <p className={styles.strong}>{BUYER.name}</p>
          <p className={styles.small}>Stores, Plot 14, KIADB Industrial Area, Bengaluru</p>
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
          {invoice.lines.map((l, i) => (
            <tr key={l.description}>
              <td>{i + 1}</td>
              <td>{l.description}</td>
              <td>{l.hsn}</td>
              <td className={styles.num}>
                <MarkedField field="qty" marked={markedFields} unreadable={unreadableFields}>
                  {formatQty(milliQty(l.qtyMilli))} {l.uom}
                </MarkedField>
              </td>
              <td className={styles.num}>
                <MarkedField field="rate" marked={markedFields} unreadable={unreadableFields}>
                  {amt(l.unitPricePaise)}
                </MarkedField>
              </td>
              <td className={styles.num}>
                {amt(lineTaxableAmount(milliQty(l.qtyMilli), paise(l.unitPricePaise)))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className={styles.bottom}>
        <div className={styles.words}>
          <p className={styles.label}>Amount in words</p>
          <p>{amountInWords(invoice.totalPaise)}</p>
          <p className={styles.bank}>
            Bank: State Bank of India · A/c 3021 4478 9910 · IFSC SBIN0004212
          </p>
        </div>
        <dl className={styles.totals}>
          <div>
            <dt>Taxable value</dt>
            <dd>{amt(invoice.taxablePaise)}</dd>
          </div>
          {intra ? (
            <>
              <div>
                <dt>CGST @ {halfRate(invoice.lines[0]?.rateBp ?? 0)}</dt>
                <dd>
                  <MarkedField field="tax" marked={markedFields} unreadable={unreadableFields}>
                    {amt(invoice.cgstPaise)}
                  </MarkedField>
                </dd>
              </div>
              <div>
                <dt>SGST @ {halfRate(invoice.lines[0]?.rateBp ?? 0)}</dt>
                <dd>
                  <MarkedField field="tax" marked={markedFields} unreadable={unreadableFields}>
                    {amt(invoice.sgstPaise)}
                  </MarkedField>
                </dd>
              </div>
            </>
          ) : (
            <div>
              <dt>IGST @ {formatRate(rateBp(invoice.lines[0]?.rateBp ?? 0))}</dt>
              <dd>
                <MarkedField field="tax" marked={markedFields} unreadable={unreadableFields}>
                  {amt(invoice.igstPaise)}
                </MarkedField>
              </dd>
            </div>
          )}
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
                ₹ {amt(invoice.totalPaise)}
              </MarkedField>
            </dd>
          </div>
        </dl>
      </section>

      <footer className={styles.sign}>
        <p className={styles.small}>
          Goods once sold will not be taken back. Subject to Bengaluru jurisdiction.
        </p>
        <p className={styles.signature}>
          For {invoice.supplier.name}
          <span>Authorised Signatory</span>
        </p>
      </footer>
    </article>
  );
}
