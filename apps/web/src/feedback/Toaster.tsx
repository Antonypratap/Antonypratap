import { Icon, type IconName } from '../design-system';
import { dismiss, hold, release, useToasts, type Toast, type ToastKind } from './toasts';
import styles from './Toaster.module.css';

const ICON: Record<ToastKind, IconName> = {
  success: 'check',
  info: 'spark',
  attention: 'attention',
  error: 'attention',
};

const LABEL: Record<ToastKind, string> = {
  success: 'Done',
  info: 'Note',
  attention: 'Needs attention',
  error: 'Error',
};

function Item({ toast }: { toast: Toast }) {
  return (
    <div
      className={styles.toast}
      data-kind={toast.kind}
      onMouseEnter={() => hold(toast.id)}
      onMouseLeave={() => release(toast.id)}
      onFocus={() => hold(toast.id)}
      onBlur={() => release(toast.id)}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon name={ICON[toast.kind]} size={16} />
      </span>
      <p className={styles.message}>
        <span className="visually-hidden">{LABEL[toast.kind]}: </span>
        {toast.message}
      </p>
      <button
        type="button"
        className={styles.close}
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/**
 * Where toasts appear. Two live regions that always exist (screen readers only announce changes to
 * a region already on the page): polite for success and information, assertive for attention and
 * errors.
 */
export function Toaster() {
  const toasts = useToasts();
  const polite = toasts.filter((t) => t.kind === 'success' || t.kind === 'info');
  const urgent = toasts.filter((t) => t.kind === 'attention' || t.kind === 'error');
  return (
    <div className={styles.region} aria-label="Notifications">
      <div className={styles.list} role="status" aria-live="polite">
        {polite.map((t) => (
          <Item key={t.id} toast={t} />
        ))}
      </div>
      <div className={styles.list} role="alert" aria-live="assertive">
        {urgent.map((t) => (
          <Item key={t.id} toast={t} />
        ))}
      </div>
    </div>
  );
}
