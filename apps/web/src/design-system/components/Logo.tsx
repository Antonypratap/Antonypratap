import styles from './Logo.module.css';

/** The Veyra mark: a V drawn as a check. Handled. */
export function Logo({ tone = 'ink' }: { tone?: 'ink' | 'inverse' }) {
  return (
    <span className={`${styles.logo} ${styles[tone]}`}>
      <svg className={styles.mark} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" className={styles.tile} />
        <path d="M9 11.5l6 10 8-14" className={styles.stroke} />
      </svg>
      <span className={styles.word}>Veyra</span>
    </span>
  );
}
