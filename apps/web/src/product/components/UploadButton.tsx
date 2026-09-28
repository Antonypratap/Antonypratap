import { useRef, useState } from 'react';
import { Icon } from '../../design-system';
import { api, ApiError } from '../api/client';
import { useProductData } from '../state/data';
import styles from './UploadButton.module.css';

/**
 * Upload one or more invoices (PDF, JPEG or PNG). The server checks the file and reads it (PDF text,
 * or OCR for scans and photos); this only sends it.
 */
export function UploadButton({ label = 'Upload invoice' }: { label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { refresh } = useProductData();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const send = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setMessage(null);
    const problems: string[] = [];
    for (const file of Array.from(files)) {
      try {
        await api.upload(file);
      } catch (e) {
        problems.push(
          `${file.name}: ${e instanceof ApiError ? e.message : 'could not be uploaded.'}`,
        );
      }
    }
    setBusy(false);
    setMessage(problems.length ? problems.join(' ') : null);
    if (input.current) input.current.value = '';
    await refresh();
  };

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Icon name="document" size={15} />
        {busy ? 'Uploading…' : label}
      </button>
      <input
        ref={input}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        multiple
        hidden
        onChange={(e) => void send(e.target.files)}
      />
      {message && (
        <p className={styles.message} role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
