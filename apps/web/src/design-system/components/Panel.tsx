import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Panel.module.css';

/**
 * A product surface: the frame every piece of Veyrafy UI sits in, on the site and in the app.
 * `title`/`meta` render a quiet header bar.
 */
export function Panel({
  title,
  meta,
  children,
  className,
  flush = false,
  ...rest
}: {
  title?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  flush?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={[styles.panel, className].filter(Boolean).join(' ')} {...rest}>
      {(title ?? meta) !== undefined && (
        <div className={styles.header}>
          <div className={styles.title}>{title}</div>
          {meta !== undefined && <div className={styles.meta}>{meta}</div>}
        </div>
      )}
      <div className={flush ? undefined : styles.body}>{children}</div>
    </div>
  );
}
