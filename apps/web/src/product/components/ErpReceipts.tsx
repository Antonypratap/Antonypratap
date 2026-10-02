import { useRef, useState } from 'react';
import { Icon } from '../../design-system';
import { useAllowed } from '../../access/session';
import { notify } from '../../feedback/toasts';
import { api, ApiError } from '../api/client';
import { formatDate } from '../format';
import { navigate } from '../router';
import { useProductData, useResource } from '../state/data';
import styles from './ErpReceipts.module.css';

/**
 * Goods-receipt records from the business's own ERP (its JSON export). An invoice whose number and
 * supplier match one is checked against it value by value, automatically, when it is read.
 */
export function ErpReceipts() {
  const { refresh } = useProductData();
  const canImport = useAllowed('imports.manage');
  const canUpload = useAllowed('documents.upload');
  const input = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: records } = useResource(() => api.receipts.list(), `receipts:${key}`);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('import');
    setProblem(null);
    try {
      let total = 0;
      for (const f of Array.from(files))
        total += (await api.receipts.import(f.name, await f.text())).imported;
      notify.receiptsImported(total);
      setKey((k) => k + 1);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The file could not be imported.');
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  };

  const check = async (id: string) => {
    setBusy(id);
    setProblem(null);
    try {
      const { invoiceId } = await api.receipts.checkAttached(id);
      notify.uploaded(1);
      await refresh();
      navigate({ name: 'invoice', id: invoiceId });
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The attached invoice could not be checked.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="erp-receipts-title">
      <div className={styles.head}>
        <div>
          <h2 id="erp-receipts-title" className={styles.title}>
            Goods receipts from your ERP
          </h2>
          <p className={styles.hint}>
            Import the goods-receipt file your ERP exports. Every invoice whose number and supplier
            match a receipt is checked against it, value by value, as soon as it is read.
          </p>
        </div>
        {canImport && (
          <>
            <button
              type="button"
              className={styles.primary}
              disabled={busy !== null}
              onClick={() => input.current?.click()}
            >
              <Icon name="upload" size={15} />
              {busy === 'import' ? 'Importing…' : 'Import from your ERP'}
            </button>
            <input
              ref={input}
              type="file"
              accept=".json,.txt,application/json,text/plain"
              multiple
              hidden
              onChange={(e) => void importFiles(e.currentTarget.files)}
            />
          </>
        )}
      </div>
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
      {records && records.length > 0 ? (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Receipt</th>
                <th scope="col">Supplier</th>
                <th scope="col">Supplier invoice</th>
                <th scope="col">Lines</th>
                <th scope="col">Attached invoice</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td>
                    GRN {r.grnNo}
                    {r.grnDate && <span className={styles.sub}>{formatDate(r.grnDate)}</span>}
                  </td>
                  <td>{r.vendorName}</td>
                  <td>{r.invoiceNo}</td>
                  <td>{r.lines}</td>
                  <td>
                    {r.attachment && canUpload ? (
                      <button
                        type="button"
                        className={styles.check}
                        disabled={busy !== null}
                        onClick={() => void check(r.id)}
                      >
                        {busy === r.id ? 'Checking…' : 'Check attached invoice'}
                      </button>
                    ) : (
                      (r.attachment ?? '—')
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        records && <p className={styles.empty}>No ERP receipts imported yet.</p>
      )}
    </section>
  );
}
