import styles from './Logo.module.css';

/**
 * The Veyrafy mark: three strokes fanning into a check (many invoices in, one verified result).
 * Drawn as vector strokes so it stays sharp at every size; `inverse` lightens the dark strokes for
 * dark backgrounds.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className ?? styles.mark} viewBox="0 0 32 32" aria-hidden="true">
      <g fill="none" strokeLinecap="round">
        <path d="M3.6 11.1L14.1 24.6" strokeWidth="3.1" className={styles.s1} />
        <path d="M7.8 10.9L14.1 24" strokeWidth="3.1" className={styles.s2} />
        <path d="M12.1 10.7L14.8 23" strokeWidth="3.1" className={styles.s3} />
        <path d="M15.6 24.6L27.7 6.9" strokeWidth="4.5" className={styles.check} />
      </g>
    </svg>
  );
}

export function Logo({ tone = 'ink' }: { tone?: 'ink' | 'inverse' }) {
  return (
    <span className={`${styles.logo} ${styles[tone]}`}>
      <LogoMark />
      <span className={styles.word}>Veyrafy</span>
    </span>
  );
}
