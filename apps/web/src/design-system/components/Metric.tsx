import type { ReactNode } from 'react';
import styles from './Metric.module.css';

export function Metric({
  value,
  label,
  tone = 'default',
}: {
  value: ReactNode;
  label: ReactNode;
  tone?: 'default' | 'handled' | 'attention';
}) {
  return (
    <div className={`${styles.metric} ${styles[tone]}`}>
      <div className={styles.value}>{value}</div>
      <div className={styles.label}>{label}</div>
    </div>
  );
}
