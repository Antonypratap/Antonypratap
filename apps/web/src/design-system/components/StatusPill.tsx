import type { ReactNode } from 'react';
import styles from './StatusPill.module.css';

export type Status = 'handled' | 'attention' | 'ready' | 'received' | 'neutral';

const DEFAULT_LABEL: Record<Status, string> = {
  handled: 'Handled',
  attention: 'Needs attention',
  ready: 'Ready',
  received: 'Received',
  neutral: '',
};

/** Compact status indicator used across the product and the site. */
export function StatusPill({ status, children }: { status: Status; children?: ReactNode }) {
  return (
    <span className={`${styles.pill} ${styles[status]}`}>
      <span className={styles.dot} aria-hidden="true" />
      {children ?? DEFAULT_LABEL[status]}
    </span>
  );
}
