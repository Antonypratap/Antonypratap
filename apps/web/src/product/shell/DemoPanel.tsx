import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ApiDemoScenario } from '@veyra/shared';
import { Icon } from '../../design-system';
import { api, ApiError } from '../api/client';
import { navigate } from '../router';
import { useProductData, useResource } from '../state/data';
import styles from './DemoPanel.module.css';

/**
 * Demo scenarios and reset (Phase 3E). Demo only: the list comes from the API's demo routes, so
 * outside a demo build there is nothing to show. Starting a scenario uploads its sample invoice
 * through the normal path; what follows on screen is the real workflow, never a simulation.
 */

interface DemoControls {
  available: boolean;
  open: () => void;
}
const DemoContext = createContext<DemoControls>({ available: false, open: () => undefined });
export const useDemo = (): DemoControls => useContext(DemoContext);

const EXPECT: Record<ApiDemoScenario['expect'], { text: string; tone: 'handled' | 'attention' }> = {
  handled: { text: 'Handled by Veyra', tone: 'handled' },
  decision: { text: 'Veyra asks you', tone: 'attention' },
  stopped: { text: 'Veyra stops', tone: 'attention' },
};

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const { data: scenarios } = useResource(() => api.demo.scenarios(), 'demo-scenarios');
  const [isOpen, setOpen] = useState(false);
  const available = (scenarios?.length ?? 0) > 0;
  return (
    <DemoContext.Provider value={{ available, open: () => setOpen(true) }}>
      {children}
      {isOpen && scenarios && <DemoPanel scenarios={scenarios} onClose={() => setOpen(false)} />}
    </DemoContext.Provider>
  );
}

/** The small, secondary entry point in the top bar. */
export function DemoTrigger({ className }: { className?: string | undefined }) {
  const { available, open } = useDemo();
  if (!available) return null;
  return (
    <button type="button" className={className} onClick={open} aria-haspopup="dialog">
      Demo scenarios
    </button>
  );
}

function DemoPanel({
  scenarios,
  onClose,
}: {
  scenarios: readonly ApiDemoScenario[];
  onClose: () => void;
}) {
  const { refresh } = useProductData();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus();
    };
  }, [onClose]);

  const start = async (key: string) => {
    setBusy(key);
    setProblem(null);
    try {
      const { invoiceId } = await api.demo.start(key);
      await refresh();
      onClose();
      navigate({ name: 'invoice', id: invoiceId });
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The scenario could not be started.');
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy('reset');
    setProblem(null);
    try {
      await api.resetDemo();
      await refresh();
      onClose();
      navigate({ name: 'inbox' });
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : 'The demo could not be reset.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={panel}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.head}>
          <div>
            <h2 id={titleId} className={styles.title}>
              Demo scenarios
            </h2>
            <p className={styles.sub}>
              Each one uploads a sample invoice. Everything after that is Veyra&rsquo;s real
              workflow.
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <ul className={styles.list}>
          {scenarios.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                className={styles.scenario}
                disabled={busy !== null}
                onClick={() => void start(s.key)}
              >
                <span className={styles.scenarioText}>
                  <span className={styles.scenarioTitle}>{s.title}</span>
                  <span className={styles.story}>{s.story}</span>
                </span>
                <span className={styles.expect} data-tone={EXPECT[s.expect].tone}>
                  {busy === s.key ? 'Starting…' : EXPECT[s.expect].text}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {problem && (
          <p className={styles.problem} role="alert">
            {problem}
          </p>
        )}

        <div className={styles.foot}>
          {confirmReset ? (
            <>
              <p className={styles.note}>
                Clear every invoice, question and decision, and restore the sample ERP?
              </p>
              <div className={styles.footActions}>
                <button
                  type="button"
                  className={styles.reset}
                  disabled={busy !== null}
                  onClick={() => void reset()}
                >
                  {busy === 'reset' ? 'Resetting…' : 'Yes, reset the demo'}
                </button>
                <button
                  type="button"
                  className={styles.quiet}
                  onClick={() => setConfirmReset(false)}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className={styles.note}>Sample data only. No payments are made.</p>
              <button
                type="button"
                className={styles.quiet}
                disabled={busy !== null}
                onClick={() => setConfirmReset(true)}
              >
                <Icon name="undo" size={14} />
                Reset demo
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
