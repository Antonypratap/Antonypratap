import type { HTMLAttributes, ReactNode } from 'react';
import styles from './Card.module.css';

/** A quiet bordered container. `interactive` adds a restrained hover lift. */
export function Card({
  children,
  interactive = false,
  className,
  ...rest
}: { children: ReactNode; interactive?: boolean } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={[styles.card, interactive && styles.interactive, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
