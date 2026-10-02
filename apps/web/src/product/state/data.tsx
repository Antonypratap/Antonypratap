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
import { notify } from '../../feedback/toasts';

/**
 * One source of truth for the product: the Veyrafy API. Inbox counts, the question queue, invoice
 * statuses and history all come from the same responses, so they always agree. While anything is
 * processing the data refreshes every second; otherwise every few seconds, and not at all while
 * the tab is hidden. A timed refresh that finds nothing changed changes nothing: no re-render and
 * no refetch of the open screen's own data (Phase 7). An explicit refresh (after an action)
 * always tells the screens to reload.
 */
export interface ProductData {
  inbox: ApiInbox | null;
  answered: ApiQuestion[];
  error: string | null;
  /** Bumped when the data changed (or on an explicit refresh), so detail views refetch in step. */
  version: number;
  /** `force` (default): tell the screens to reload even if the lists did not change. */
  refresh: (force?: boolean) => Promise<void>;
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
  const last = useRef<string | null>(null);
  const offline = useRef(false);
  const previous = useRef<ApiInbox | null>(null);

  const refresh = useCallback(async (force = true) => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const [nextInbox, nextAnswered] = await Promise.all([
          api.inbox(),
          api.questions('answered'),
        ]);
        setError(null);
        if (offline.current) {
          offline.current = false;
          notify.online();
        }
        const snapshot = JSON.stringify([nextInbox, nextAnswered]);
        if (!force && snapshot === last.current) return;
        // The first load: the open screen fetched its own data at the same time; no reload.
        const first = last.current === null;
        last.current = snapshot;
        // Background completion: invoices that were processing and have now settled.
        const finished = settledSince(previous.current, nextInbox);
        previous.current = nextInbox;
        if (!first && (finished.ready > 0 || finished.attention > 0))
          notify.processed(finished.ready, finished.attention);
        setInbox(nextInbox);
        setAnswered(nextAnswered);
        if (!first) setVersion((v) => v + 1);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Veyrafy could not be reached.');
        // One toast for the outage (not one per poll), and one when it is back.
        if (e instanceof ApiError && e.code === 'OFFLINE' && !offline.current) {
          offline.current = true;
          notify.offline();
        }
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, []);

  const busy = (inbox?.counts.processing ?? 0) > 0;
  useEffect(() => {
    void refresh(false);
    const tick = () => {
      if (!document.hidden) void refresh(false);
    };
    const timer = window.setInterval(tick, busy ? 1000 : 4000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh, busy]);

  const value = useMemo(
    () => ({ inbox, answered, error, version, refresh }),
    [inbox, answered, error, version, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useProductData = (): ProductData => useContext(Ctx);

/** How many invoices left processing between two inbox snapshots, by where they landed. */
export function settledSince(
  before: ApiInbox | null,
  after: ApiInbox,
): { ready: number; attention: number } {
  if (!before) return { ready: 0, attention: 0 };
  const was = new Map(before.invoices.map((i) => [i.id, i.status]));
  let ready = 0;
  let attention = 0;
  for (const i of after.invoices) {
    if (was.get(i.id) !== 'processing') continue;
    if (i.status === 'ready' || i.status === 'handled') ready++;
    else if (i.status === 'attention') attention++;
  }
  return { ready, attention };
}

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
 * The invoice to go to after this one: the next that needs a decision, else the next in the
 * invoice list (wrapping around); null when this is the only invoice.
 */
export function nextInvoice(inbox: ApiInbox | null, currentId: string): ApiInvoiceSummary | null {
  const needed = nextInQueue(inbox, currentId);
  if (needed) return needed;
  const all = inbox?.invoices ?? [];
  const at = all.findIndex((i) => i.id === currentId);
  const others = [...all.slice(at + 1), ...all.slice(0, Math.max(at, 0))].filter(
    (i) => i.id !== currentId,
  );
  return others[0] ?? null;
}

/**
 * Loads one resource and reloads it whenever the shared data refreshes. `null` while loading;
 * errors are kept separately so a transient failure does not blank the screen.
 */
export function useResource<T>(
  load: () => Promise<T>,
  key: string,
  /** `static`: data that does not change while the page is open (loaded once per key). */
  options: { static?: boolean } = {},
): { data: T | null; error: string | null } {
  const { version: shared } = useProductData();
  const version = options.static ? 0 : shared;
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
