import { useSyncExternalStore } from 'react';

/**
 * Toasts (Phase 7 UX): short, transient feedback for completed actions and background status
 * changes. Decisions, validation failures and consequential workflow state stay on the page, never
 * in a toast (they must not disappear).
 *
 * Rules enforced here:
 * - Messages come from the `notify` catalogue below: fixed wording with counts at most, never
 *   invoice or document data (no supplier, number, amount, GSTIN, file name).
 * - One toast per key: a repeated action or a repeated background change replaces its toast
 *   instead of stacking a duplicate.
 * - Success and info dismiss themselves; attention after longer; errors stay until dismissed.
 */
export type ToastKind = 'success' | 'info' | 'attention' | 'error';

export interface Toast {
  id: number;
  key: string;
  kind: ToastKind;
  message: string;
  /** Milliseconds before it dismisses itself; null: stays until dismissed. */
  timeoutMs: number | null;
}

export const TIMEOUTS: Record<ToastKind, number | null> = {
  success: 5000,
  info: 5000,
  attention: 9000,
  error: null,
};

/** At most this many at once (oldest go first): the screen stays usable. */
const MAX = 4;

let toasts: readonly Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(next: readonly Toast[]): void {
  toasts = next;
  for (const l of listeners) l();
}

export function dismiss(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  emit(toasts.filter((x) => x.id !== id));
}

/** Stops the timer (hover or focus): a toast being read does not vanish. */
export function hold(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

export function release(id: number): void {
  const toast = toasts.find((x) => x.id === id);
  if (toast?.timeoutMs && !timers.has(id))
    timers.set(
      id,
      setTimeout(() => dismiss(id), toast.timeoutMs),
    );
}

function show(key: string, kind: ToastKind, message: string): number {
  const existing = toasts.find((x) => x.key === key);
  if (existing) dismiss(existing.id);
  const toast: Toast = { id: nextId++, key, kind, message, timeoutMs: TIMEOUTS[kind] };
  const kept = toasts.filter((x) => x.key !== key);
  const over = kept.length + 1 - MAX;
  for (const old of kept.slice(0, Math.max(0, over))) dismiss(old.id);
  emit([...toasts.filter((x) => x.key !== key), toast]);
  release(toast.id);
  return toast.id;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** Every message the product can show in a toast (fixed text; counts only). */
export const notify = {
  uploaded: (n: number) =>
    show(
      'upload',
      'success',
      `${plural(n, 'Invoice', 'invoices')} uploaded. Veyrafy is reading ${n === 1 ? 'it' : 'them'}.`,
    ),
  answered: () => show('answer', 'success', 'Decision recorded. Veyrafy is continuing.'),
  rejected: () => show('reject', 'info', 'Invoice rejected. Nothing was recorded in your ERP.'),
  reprocessing: () => show('reprocess', 'info', 'Veyrafy is reading the invoice again.'),
  importChecked: (ok: boolean) =>
    ok
      ? show('import', 'success', 'File checked. Review the preview, then confirm the import.')
      : show('import', 'attention', 'The file has problems. See the list below.'),
  imported: () => show('import', 'success', 'Business records imported into your ERP.'),
  receiptsImported: (n: number) =>
    n === 0
      ? show('import', 'info', 'Already imported: nothing new in this file.')
      : show(
          'import',
          'success',
          `${plural(n, 'ERP receipt', 'ERP receipts')} imported. Matching invoices are checked against ${n === 1 ? 'it' : 'them'}.`,
        ),
  passwordChanged: () =>
    show('account', 'success', 'Password changed. You were signed out everywhere else.'),
  teamUpdated: () => show('team', 'success', 'Team updated.'),
  retentionSaved: () => show('retention', 'success', 'Document retention saved.'),
  documentDeleted: () =>
    show(
      'document',
      'info',
      'Original invoice document deleted. Its processing record and audit history remain.',
    ),
  signedIn: () => show('session', 'success', 'Signed in.'),
  signedOut: () => show('session', 'info', 'You have signed out.'),
  offline: () =>
    show('network', 'error', 'Veyrafy cannot be reached. It will keep trying; your work is saved.'),
  online: () => show('network', 'success', 'Connection restored.'),
  processed: (ready: number, attention: number) => {
    if (ready > 0 && attention > 0)
      return show(
        'background',
        'attention',
        `${plural(ready, 'An invoice is', 'invoices are')} ready; ${plural(attention, 'one needs', 'need')} your decision.`,
      );
    if (attention > 0)
      return show(
        'background',
        'attention',
        `${plural(attention, 'An invoice needs', 'invoices need')} your decision.`,
      );
    return show(
      'background',
      'success',
      `${plural(ready, 'An invoice was', 'invoices were')} verified and recorded in your ERP.`,
    );
  },
  demoReset: () => show('demo', 'info', 'Demo reset. The sample business is back to the start.'),
  commercialSaved: () =>
    show('commercial', 'success', 'Change saved and recorded in the commercial audit trail.'),
  opsSaved: () => show('commercial', 'success', 'Change saved and recorded in the audit log.'),
} as const;

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
    () => toasts,
  );
}

/** Tests only. */
export function clearToasts(): void {
  for (const t of toasts) dismiss(t.id);
}
