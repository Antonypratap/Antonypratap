import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Layout.module.css';

export function Container({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={[styles.container, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </div>
  );
}

/** Small uppercase label above a heading. */
export function Eyebrow({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'inverse';
}) {
  return (
    <p className={`${styles.eyebrow} ${tone === 'inverse' ? styles.eyebrowInverse : ''}`}>
      {children}
    </p>
  );
}

/** Section heading block: eyebrow, title and optional lede, left or centre aligned. */
export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = 'start',
  id,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  align?: 'start' | 'center';
  id?: string;
}) {
  return (
    <div className={`${styles.heading} ${align === 'center' ? styles.center : ''}`}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 id={id} className={styles.title}>
        {title}
      </h2>
      {lede && <p className={styles.lede}>{lede}</p>}
    </div>
  );
}
