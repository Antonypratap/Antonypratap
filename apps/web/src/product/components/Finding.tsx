import { useEffect, useState, type ReactNode } from 'react';
import type { ApiEvidence, ApiFinding } from '@veyra/shared';
import { documentPageUrl } from '../api/client';
import { inr } from '../format';
import styles from './Finding.module.css';

/**
 * One exception as a conclusion: DECISION (what it is and what is at stake) → EXPLANATION (the
 * comparison and why) → the actions. Evidence and the original document stay one click away.
 */
export function Finding({
  finding,
  supplier,
  number,
  totalPaise,
  actions,
  evidence,
}: {
  finding: ApiFinding;
  supplier: string | null;
  number: string | null;
  totalPaise: number | null;
  actions: ReactNode;
  evidence: ReactNode;
}) {
  const invoiceSide = finding.compare.filter((c) => c.tone === 'attention');
  const agreedSide = finding.compare.filter((c) => c.tone !== 'attention');
  return (
    <section className={styles.finding} data-state={finding.state} aria-labelledby="finding-title">
      <p className={styles.state} data-state={finding.state}>
        <span aria-hidden="true">{finding.state === 'review' ? '⚠' : '?'}</span>
        {finding.state === 'review' ? 'Needs review' : 'Needs confirmation'}
      </p>
      <h2 id="finding-title" className={styles.label}>
        {finding.label}
      </h2>
      {!(finding.state === 'confirm' && finding.impactPaise === null) && (
        <p className={styles.impact} data-amount={finding.impactPaise !== null}>
          {finding.impact}
        </p>
      )}
      <p className={styles.who}>
        {supplier ?? 'Supplier not read'}
        {number ? ` · Invoice ${number}` : ''}
        {totalPaise !== null ? ` · ${inr(totalPaise)}` : ''}
      </p>

      {finding.compare.length > 0 && (
        <div className={styles.compare}>
          {agreedSide.length > 0 && (
            <dl className={styles.side}>
              {agreedSide.map((c) => (
                <div key={`${c.label}-${c.value}`}>
                  <dt>{c.label}</dt>
                  <dd>{c.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {invoiceSide.length > 0 && (
            <dl className={styles.side} data-side="invoice">
              {invoiceSide.map((c) => (
                <div key={`${c.label}-${c.value}`}>
                  <dt>{c.label}</dt>
                  <dd>{c.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {finding.difference && (
            <dl className={styles.side} data-side="difference">
              <div>
                <dt>Difference</dt>
                <dd>{finding.difference}</dd>
              </div>
            </dl>
          )}
        </div>
      )}
      {finding.calculation && <p className={styles.calculation}>{finding.calculation}</p>}
      <p className={styles.explanation}>{finding.explanation}</p>
      {finding.more > 0 && (
        <p className={styles.more}>
          {finding.more === 1
            ? 'One more thing on this invoice after this.'
            : `${finding.more} more things on this invoice after this.`}
        </p>
      )}

      <div className={styles.actions}>{actions}</div>
      {evidence}
    </section>
  );
}

/**
 * The evidence: the invoice's own values cut from the uploaded page (the value outlined), and the
 * ERP's values as recorded. Never a reconstruction: a crop is the actual upload, and a value with
 * no place on the page is shown as text with the page it was read on.
 */
export function EvidenceList({
  evidence,
  documentId,
  isPdf,
  original,
  pageUrl,
  recordsLabel = 'Your ERP',
}: {
  evidence: ApiEvidence[];
  documentId: string;
  isPdf: boolean;
  /** Whether the original document can be shown (not deleted, not missing). */
  original: boolean;
  /** Where a page image comes from, when not the product's document route (the challenge). */
  pageUrl?: (page: number) => string | null;
  /** What the records side is called ("Your ERP", "Your records"). */
  recordsLabel?: string;
}) {
  if (evidence.length === 0)
    return <p className={styles.noEvidence}>The full invoice below shows every value as read.</p>;
  return (
    <ul className={styles.evidence}>
      {evidence.map((e, i) => (
        <li key={`${e.label}-${i}`} className={styles.evidenceItem} data-source={e.source}>
          <p className={styles.evidenceLabel}>
            <span className={styles.evidenceSource}>
              {e.source === 'invoice' ? 'Invoice' : recordsLabel}
            </span>
            {e.label.replace(/^Invoice · /, '')}
            {e.page !== null && e.source === 'invoice' ? ` · page ${e.page}` : ''}
          </p>
          {e.source === 'invoice' &&
          original &&
          e.page !== null &&
          e.bbox &&
          (pageUrl ? pageUrl(e.page) : true) ? (
            <Crop
              url={pageUrl?.(e.page) ?? documentPageUrl(documentId, e.page)}
              bbox={e.bbox}
              scale={isPdf ? 150 / 72 : 1}
              value={e.value}
            />
          ) : null}
          <p className={styles.evidenceValue}>{e.value}</p>
        </li>
      ))}
    </ul>
  );
}

/** A tight cut of the uploaded page around one value, with the value outlined. */
function Crop({
  url,
  bbox,
  scale,
  value,
}: {
  url: string;
  bbox: [number, number, number, number];
  /** Page image pixels per evidence unit (PDF pages are drawn at 150 dpi; photos are 1:1). */
  scale: number;
  value: string;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setFailed(true);
    img.src = url;
  }, [url]);
  if (failed || !size) return null;
  const [bx, by, bw, bh] = bbox.map((v) => v * scale) as [number, number, number, number];
  // Enough of the row around the value to recognise it (its column and neighbours).
  const padX = Math.max(320, bw * 2);
  const padY = Math.max(60, bh * 2);
  const x = Math.max(0, bx - padX);
  const y = Math.max(0, by - padY);
  const w = Math.min(size.w, bx + bw + padX) - x;
  const h = Math.min(size.h, by + bh + padY) - y;
  if (w <= 0 || h <= 0) return null;
  return (
    <svg
      className={styles.crop}
      viewBox={`${x} ${y} ${w} ${h}`}
      role="img"
      aria-label={`The uploaded invoice where it reads ${value}`}
    >
      <image href={url} x={0} y={0} width={size.w} height={size.h} />
      <rect
        className={styles.mark}
        x={bx - 4}
        y={by - 4}
        width={bw + 8}
        height={bh + 8}
        rx={4}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
