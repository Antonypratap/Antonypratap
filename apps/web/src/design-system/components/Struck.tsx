import type { CSSProperties, ReactNode } from 'react';
import styles from './Struck.module.css';

/**
 * Veyrafy's signature device: a piece of work, struck through as it is taken away.
 * The line draws left to right, then the text recedes.
 */
export function Struck({
  children,
  struck,
  delay = 0,
  tone = 'default',
}: {
  children: ReactNode;
  struck: boolean;
  delay?: number;
  tone?: 'default' | 'inverse';
}) {
  return (
    <span
      className={`${styles.struck} ${tone === 'inverse' ? styles.inverse : ''}`}
      data-struck={struck}
      style={{ '--strike-delay': `${delay}ms` } as CSSProperties}
    >
      {children}
    </span>
  );
}
