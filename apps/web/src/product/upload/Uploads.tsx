import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from '../../design-system';
import { notify } from '../../feedback/toasts';
import { api, ApiError } from '../api/client';
import { useProductData } from '../state/data';
import { allowed } from '../../access/session';
import { ACCEPT, carriesFiles, isReceiptExport, pastedName, refusalOf } from './files';
import styles from './Uploads.module.css';

export interface UploadItem {
  key: string;
  name: string;
  state: 'uploading' | 'added' | 'refused';
  message?: string;
  invoiceId?: string;
  /** Shown before the invoice's status (an ERP receipt file: what was imported). */
  note?: string;
}

interface Uploads {
  /** May this person upload at all (the server decides again on every file). */
  enabled: boolean;
  items: UploadItem[];
  busy: boolean;
  add: (files: readonly File[]) => Promise<void>;
  chooseFiles: () => void;
  takePhoto: () => void;
  clear: () => void;
}

const UploadsContext = createContext<Uploads | null>(null);

/** Uploads for the whole product: buttons, the Inbox drop area, drag-anywhere and paste. */
export function useUploads(): Uploads {
  const value = useContext(UploadsContext);
  if (!value) throw new Error('useUploads outside UploadsProvider');
  return value;
}

const RECENT = 6;

/**
 * An ERP goods-receipt export dropped or chosen with the invoices: imported as ERP records only.
 * Uploaded invoices are checked against their record, whichever came first. The same file twice
 * changes nothing.
 */
async function importReceiptFile(file: File): Promise<Partial<UploadItem>> {
  if (!allowed('imports.manage'))
    return {
      state: 'refused',
      message: 'ERP receipt files are imported by Finance or an administrator.',
    };
  let result;
  try {
    result = await api.receipts.import(file.name, await file.text());
  } catch (e) {
    return {
      state: 'refused',
      message: e instanceof ApiError ? e.message : 'The ERP receipt file could not be imported.',
    };
  }
  // The ERP export only adds ERP records: invoices are the ones you upload, each matched to its
  // record by number and supplier. An invoice attached inside the export is never added on its
  // own (it would block uploading the actual invoice); it stays available under ERP.
  const grns = result.records.map((r) => r.grnNo).join(', ');
  const attached = result.records.some((r) => r.hasAttachment);
  const rechecked = result.rechecked;
  const note = `ERP receipt${result.records.length === 1 ? '' : 's'} GRN ${grns} imported. ${
    rechecked > 0
      ? `${rechecked === 1 ? '1 invoice' : `${rechecked} invoices`} already here checked against ${result.records.length === 1 ? 'it' : 'them'}.`
      : `Upload the invoice to check it${attached ? ', or use the copy attached in ERP › Goods receipts' : ''}.`
  }`;
  return { state: 'added', note };
}
let counter = 0;

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function UploadsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { refresh } = useProductData();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<UploadItem>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const add = useCallback(
    async (incoming: readonly File[]) => {
      if (!enabled || incoming.length === 0) return;
      const batch = incoming.map((file) => ({
        file,
        item: {
          key: `u${++counter}`,
          name: file.name,
          state: 'uploading',
        } as UploadItem,
      }));
      // The newest first; older finished ones drop off, never one of this batch.
      setItems((list) =>
        [...batch.map((b) => b.item), ...list].slice(0, Math.max(RECENT, batch.length)),
      );
      setBusy(true);
      let uploaded = 0;
      for (const { file, item } of batch) {
        const refused = refusalOf(file);
        if (refused) {
          update(item.key, { state: 'refused', message: refused });
          continue;
        }
        if (isReceiptExport(file)) {
          const done = await importReceiptFile(file);
          update(item.key, done);
          if (done.invoiceId) uploaded++;
          continue;
        }
        try {
          const { invoiceId } = await api.upload(file);
          uploaded++;
          update(item.key, { state: 'added', invoiceId });
        } catch (e) {
          update(item.key, {
            state: 'refused',
            message: e instanceof ApiError ? e.message : 'It could not be uploaded. Try again.',
          });
        }
      }
      setBusy(false);
      if (uploaded > 0) notify.uploaded(uploaded);
      await refresh();
    },
    [enabled, refresh],
  );

  // Drop files anywhere in the product.
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer?.types)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void add(Array.from(e.dataTransfer?.files ?? []));
    };
    // Paste a screenshot or a copied file (not while typing in a field).
    const paste = (e: ClipboardEvent) => {
      if (isEditable(e.target)) return;
      const pasted = Array.from(e.clipboardData?.files ?? []);
      if (pasted.length === 0) return;
      e.preventDefault();
      const now = new Date();
      void add(
        pasted.map((f) =>
          /^image\.\w+$/i.test(f.name) || f.name === ''
            ? new File([f], pastedName(f.type, now), { type: f.type })
            : f,
        ),
      );
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, [enabled, add]);

  const value = useMemo<Uploads>(
    () => ({
      enabled,
      items,
      busy,
      add,
      chooseFiles: () => files.current?.click(),
      takePhoto: () => camera.current?.click(),
      clear: () => setItems([]),
    }),
    [enabled, items, busy, add],
  );

  const picked = (input: HTMLInputElement | null) => {
    if (!input?.files) return;
    void add(Array.from(input.files));
    input.value = '';
  };

  return (
    <UploadsContext.Provider value={value}>
      {children}
      {enabled && (
        <>
          <input
            ref={files}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => picked(e.currentTarget)}
          />
          {/* On phones this opens the camera; elsewhere it chooses an image. */}
          <input
            ref={camera}
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            hidden
            onChange={(e) => picked(e.currentTarget)}
          />
          {dragging && (
            <div className={styles.overlay} role="presentation">
              <div className={styles.overlayBox}>
                <span className={styles.overlayIcon}>
                  <Icon name="upload" size={28} />
                </span>
                <p className={styles.overlayTitle}>Drop to add invoices</p>
                <p className={styles.overlayHint}>
                  PDF, JPEG or PNG · or your ERP&rsquo;s receipt file · up to 20 MB each
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </UploadsContext.Provider>
  );
}
