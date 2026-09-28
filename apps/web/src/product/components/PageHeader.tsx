import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

export function PageHeader({
  title,
  sub,
  aside,
}: {
  title: string;
  sub?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.title}>{title}</h1>
        {sub && <p className={styles.sub}>{sub}</p>}
      </div>
      {aside && <div className={styles.aside}>{aside}</div>}
    </header>
  );
}

/** A quiet download link for a page header ("Export"). */
export function ExportLink({ href, label = 'Export' }: { href: string; label?: string }) {
  return (
    <a className={styles.export} href={href} download>
      {label}
    </a>
  );
}
