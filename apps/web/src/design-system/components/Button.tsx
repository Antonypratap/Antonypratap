import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'inverse';
type Size = 'sm' | 'md' | 'lg';

interface Common {
  variant?: Variant;
  size?: Size;
  /** Adds a trailing arrow that nudges on hover. */
  arrow?: boolean;
  children: ReactNode;
}

const cx = (variant: Variant, size: Size, extra?: string): string =>
  [styles.button, styles[variant], styles[size], extra].filter(Boolean).join(' ');

function Content({ children, arrow }: { children: ReactNode; arrow: boolean }) {
  return (
    <>
      <span>{children}</span>
      {arrow && (
        <svg className={styles.arrow} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  arrow = false,
  className,
  children,
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cx(variant, size, className)} {...rest}>
      <Content arrow={arrow}>{children}</Content>
    </button>
  );
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  arrow = false,
  className,
  children,
  ...rest
}: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={cx(variant, size, className)} {...rest}>
      <Content arrow={arrow}>{children}</Content>
    </a>
  );
}
