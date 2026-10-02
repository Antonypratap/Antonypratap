import { Button, Icon } from '../../design-system';
import { useAllowed } from '../../access/session';
import { hrefFor } from '../router';
import { useDemo } from '../shell/DemoPanel';
import { useProductData } from '../state/data';
import type { UiStatus } from '@veyra/shared';
import { useUploads } from '../upload/Uploads';
import styles from './AddInvoices.module.css';

/**
 * The Inbox's way in for invoices: drop files here (or anywhere in the product), choose files,
 * take a photo on a phone, paste a screenshot, or bring business records from Excel. Large when
 * the workspace is empty, a slim bar once invoices are flowing.
 */
/** What an uploaded file's row says, from the invoice's real status (never a fixed "reading"). */
const AFTER_UPLOAD: Record<UiStatus, string> = {
  processing: 'Added · Veyrafy is reading it',
  attention: 'Read · needs your decision',
  ready: 'Read and checked · ready',
  handled: 'Read and checked · handled',
  rejected: 'Rejected',
};

export function AddInvoices({ compact }: { compact: boolean }) {
  const uploads = useUploads();
  const { inbox } = useProductData();
  const statusOf = (invoiceId: string | undefined): UiStatus =>
    inbox?.invoices.find((i) => i.id === invoiceId)?.status ?? 'processing';
  const demo = useDemo();
  const canImport = useAllowed('imports.manage');
  if (!uploads.enabled) return null;

  return (
    <section className={styles.panel} data-compact={compact} aria-labelledby="add-invoices-title">
      <div className={styles.zone}>
        <span className={styles.icon} aria-hidden="true">
          <Icon name="upload" size={compact ? 20 : 26} />
        </span>
        <div className={styles.copy}>
          <h2 id="add-invoices-title" className={styles.title}>
            {uploads.busy ? 'Adding invoices…' : 'Add invoices'}
          </h2>
          <p className={`${styles.hint} ${styles.desktopOnly}`}>
            Drag PDFs, scans or photos anywhere on this page, or paste a screenshot.
          </p>
          <p className={`${styles.hint} ${styles.phoneOnly}`}>
            Take a photo of a paper invoice, or choose PDFs and images from your phone.
          </p>
        </div>
        <div className={styles.actions}>
          <Button size={compact ? 'sm' : 'md'} onClick={uploads.chooseFiles}>
            <Icon name="document" size={15} />
            Choose files
          </Button>
          <Button
            size={compact ? 'sm' : 'md'}
            variant="secondary"
            className={styles.phoneOnly}
            onClick={uploads.takePhoto}
          >
            <Icon name="camera" size={15} />
            Take a photo
          </Button>
        </div>
      </div>

      {(canImport || demo.available) && (
        <p className={styles.sources}>
          <span className={styles.sourcesLabel}>Other ways in:</span>
          {canImport && (
            <a href={hrefFor({ name: 'erp', tab: 'data' })} className={styles.source}>
              <Icon name="spreadsheet" size={14} />
              Import business records from Excel
            </a>
          )}
          {demo.available && (
            <button type="button" className={styles.source} onClick={demo.open}>
              <Icon name="spark" size={14} />
              Try a sample invoice
            </button>
          )}
        </p>
      )}

      {uploads.items.length > 0 && (
        <ul className={styles.items} aria-live="polite">
          {uploads.items.map((item) => (
            <li key={item.key} className={styles.item} data-state={item.state}>
              <span className={styles.itemMark} aria-hidden="true">
                {item.state === 'added' && <Icon name="check" size={13} strokeWidth={2.4} />}
                {item.state === 'refused' && <Icon name="attention" size={13} />}
              </span>
              <span className={styles.itemName}>{item.name}</span>
              <span className={styles.itemState}>
                {item.state === 'uploading' && 'Uploading…'}
                {item.state === 'added' &&
                  (item.invoiceId ? (
                    <a href={hrefFor({ name: 'invoice', id: item.invoiceId })}>
                      {AFTER_UPLOAD[statusOf(item.invoiceId)]}
                    </a>
                  ) : (
                    AFTER_UPLOAD.processing
                  ))}
                {item.state === 'refused' && item.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
