import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** True when the visitor asked the OS for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/** Becomes true once the element has scrolled into view (and stays true). */
export function useInView<T extends Element>(
  options: { threshold?: number; rootMargin?: string } = {},
): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  // Without IntersectionObserver there is nothing to wait for: show content immediately.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');
  const { threshold = 0.2, rootMargin = '0px 0px -10% 0px' } = options;
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView, threshold, rootMargin]);
  return [ref, inView];
}

/**
 * Advances a step counter from 0 to `steps` once `active` is true, one step per `intervalMs`.
 * With reduced motion it jumps straight to the final step. It never loops.
 */
export function useSequence(
  steps: number,
  intervalMs: number,
  active: boolean,
  startDelayMs = 0,
): number {
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active || reduced) return;
    let current = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      current += 1;
      setStep(current);
      if (current < steps) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, startDelayMs);
    return () => clearTimeout(timer);
  }, [active, reduced, steps, intervalMs, startDelayMs]);
  return reduced && active ? steps : step;
}
