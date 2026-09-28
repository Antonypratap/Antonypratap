import {
  createContext,
  useCallback,
  useContext,
  useEffectEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ApiInbox, ApiInvoiceSummary, ApiQuestion } from '@veyra/shared';
import { api, ApiError } from '../api/client';

/**
 * One source of truth for the product: the Veyra API. Inbox counts, the question queue, invoice
 * statuses and history all come from the same responses, so they always agree. While anything is
 * processing the data refreshes every second; otherwise every few seconds.
 */
export interface ProductData {
  inbox: ApiInbox | null;
  answered: ApiQuestion[];
  error: string | null;
  /** Bumped after every refresh, so detail views can refetch in step with the lists. */
  version: number;
  refresh: () => Promise<void>;
}

const Ctx = createContext<ProductData>({
  inbox: null,
  answered: [],
  error: null,
  version: 0,
  refresh: async () => undefined,
});

export function ProductDataProvider({ children }: { children: ReactNode }) {
  const [inbox, setInbox] = useState<ApiInbox | null>(null);
  const [answered, setAnswered] = useState<ApiQuestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const [nextInbox, nextAnswered] = await Promise.all([
          api.inbox(),
          api.questions('answered'),
        ]);
        setInbox(nextInbox);
        setAnswered(nextAnswered);
        setError(null);
        setVersion((v) => v + 1);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Veyra could not be reached.');
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, []);

  const busy = (inbox?.counts.processing ?? 0) > 0;
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), busy ? 1000 : 4000);
    return () => window.clearInterval(timer);
  }, [refresh, busy]);

  const value = useMemo(
    () => ({ inbox, answered, error, version, refresh }),
    [inbox, answered, error, version, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useProductData = (): ProductData => useContext(Ctx);

/** Invoices that need a decision, oldest first: the work queue. */
export function attentionQueue(inbox: ApiInbox | null): ApiInvoiceSummary[] {
  return (inbox?.invoices ?? [])
    .filter((i) => i.status === 'attention')
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
}

/** The next invoice needing a decision after `currentId`, wrapping around; null when none. */
export function nextInQueue(inbox: ApiInbox | null, currentId: string): ApiInvoiceSummary | null {
  const queue = attentionQueue(inbox);
  const others = queue.filter((i) => i.id !== currentId);
  if (others.length === 0) return null;
  const at = queue.findIndex((i) => i.id === currentId);
  return (
    (at >= 0 ? queue.slice(at + 1).find((i) => i.id !== currentId) : undefined) ?? others[0] ?? null
  );
}

/**
 * Loads one resource and reloads it whenever the shared data refreshes. `null` while loading;
 * errors are kept separately so a transient failure does not blank the screen.
 */
export function useResource<T>(
  load: () => Promise<T>,
  key: string,
): { data: T | null; error: string | null } {
  const { version } = useProductData();
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({
    key,
    data: null,
    error: null,
  });
  const fetchNow = useEffectEvent(() => load());
  useEffect(() => {
    let live = true;
    fetchNow()
      .then((data) => live && setState({ key, data, error: null }))
      .catch(
        (e: unknown) =>
          live &&
          setState((s) => ({
            key,
            data: s.key === key ? s.data : null,
            error: e instanceof Error ? e.message : 'Could not load.',
          })),
      );
    return () => {
      live = false;
    };
  }, [key, version]);
  return state.key === key ? { data: state.data, error: state.error } : { data: null, error: null };
}
