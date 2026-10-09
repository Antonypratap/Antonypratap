import { useEffect, useRef, useState } from 'react';
import { Icon, usePrefersReducedMotion, useSequence } from '../../design-system';
import { CORRECTION, SCRIPT, STAGES, type Stage, type Step } from './controlFlowScript';
import styles from './ControlFlow.module.css';

/**
 * The hero's picture of the whole purchase, with Veyrafy as the check before payment:
 * procurement orders, the supplier delivers with an invoice and delivery challan, the warehouse
 * confirms what arrived, Veyrafy checks the invoice against the PO and GRN, and the team approves
 * and pays, or the difference is put right first. Every stage is always on screen (complete at
 * rest); the animation only lights them in turn. With reduced motion it stays still.
 */

const NODES: {
  stage: Exclude<Stage, 'veyrafy' | 'match' | 'difference'>;
  who: string;
  what: string;
}[] = [
  { stage: 'procurement', who: 'Procurement', what: 'Raises the purchase order' },
  { stage: 'supplier', who: 'Supplier', what: 'Delivers goods with invoice and delivery challan' },
  { stage: 'warehouse', who: 'Warehouse', what: 'Scans the documents, confirms what arrived' },
];

type State = 'rest' | 'upcoming' | 'active' | 'done' | 'off';

/** While visible on screen (unlike useInView, it turns off again, so the loop pauses). */
function useVisible<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => setVisible(e.some((x) => x.isIntersecting)), {
      threshold: 0.3,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible] as const;
}

function stateOf(stage: Stage, step: Step | null, index: number): State {
  if (!step) return 'rest';
  if (stage === 'match' || stage === 'difference') {
    if (stage !== step.path) return 'off';
    return step.stage === stage || (stage === 'difference' && step.correction !== undefined)
      ? 'active'
      : 'upcoming';
  }
  if (step.stage === stage) return 'active';
  // Stages before the current one in this purchase are done; later ones are still to come.
  const order = STAGES.indexOf(stage);
  const pathStart = SCRIPT.findIndex((s) => s.path === step.path);
  const reached = SCRIPT.slice(pathStart, index + 1).some((s) => STAGES.indexOf(s.stage) >= order);
  return reached ? 'done' : 'upcoming';
}

export function ControlFlow() {
  const reduced = usePrefersReducedMotion();
  const [ref, visible] = useVisible<HTMLElement>();
  // Step 0 is the still frame; 1..n play the script, then it holds and starts again.
  const at = useSequence(SCRIPT.length, 1400, visible && !reduced, 900, 2600);
  const index = reduced || at === 0 ? -1 : at - 1;
  const step = index >= 0 ? (SCRIPT[index] ?? null) : null;
  const sendingFrom = step?.sends ? step.stage : null;

  return (
    <figure ref={ref} className={styles.flow} aria-labelledby="control-flow-caption">
      <figcaption id="control-flow-caption" className="visually-hidden">
        Procurement raises a purchase order. The supplier delivers the goods with an invoice and a
        delivery challan. The warehouse confirms what arrived. Veyrafy checks the invoice against
        the purchase order and the goods receipt in your accounting records. When they match, the
        manager approves and your team releases payment. When they differ, payment is held, the
        difference is reported, the supplier corrects the invoice, Veyrafy checks it again, and then
        it is approved and paid.
      </figcaption>

      <div aria-hidden="true" className={styles.stack}>
        {NODES.map((n) => {
          const state = stateOf(n.stage, step, index);
          return (
            <div key={n.stage} className={styles.group}>
              <div
                className={styles.node}
                data-state={state}
                data-revisit={state === 'active' && step?.revisit === true}
              >
                <div className={styles.nodeText}>
                  <p className={styles.who}>{n.who}</p>
                  <p className={styles.what}>{n.what}</p>
                </div>
                <span className={styles.mark}>
                  {state === 'done' ? <Icon name="check" size={13} strokeWidth={2.8} /> : null}
                </span>
              </div>
              <div className={styles.link}>
                {sendingFrom === n.stage && (
                  <span key={index} className={styles.docs}>
                    {(step?.revisit ? ['Corrected invoice'] : (step?.sends ?? [])).map((d) => (
                      <span key={d} className={styles.doc}>
                        <Icon name="document" size={11} /> {d}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        <div className={styles.veyrafy} data-state={stateOf('veyrafy', step, index)}>
          <span className={styles.pulse} />
          <span>
            <strong>Veyrafy</strong>
            <span className={styles.veyrafySub}>
              Checks the invoice against PO + GRN in your accounting records
            </span>
          </span>
        </div>

        <div className={styles.outcomes}>
          <div
            className={styles.outcome}
            data-tone="match"
            data-state={stateOf('match', step, index)}
          >
            <p className={styles.result}>
              <Icon name="check" size={14} strokeWidth={2.8} /> Match
            </p>
            <p className={styles.path}>
              <span data-on={step?.path === 'match' && (step.approval ?? -1) >= 0}>
                Manager approves
              </span>
              <span className={styles.arrow}>→</span>
              <span data-on={step?.path === 'match' && step.approval === 1}>Payment released</span>
            </p>
          </div>
          <div
            className={styles.outcome}
            data-tone="difference"
            data-state={stateOf('difference', step, index)}
          >
            <p className={styles.result}>
              <Icon name="attention" size={14} /> Difference
            </p>
            <ol className={styles.correction}>
              {CORRECTION.map((c, i) => (
                <li key={c} data-on={step?.path === 'difference' && (step.correction ?? -1) >= i}>
                  {c}
                </li>
              ))}
            </ol>
          </div>
        </div>

        <p className={styles.caption}>
          {step
            ? step.caption
            : 'From purchase order to payment, with Veyrafy as the check in between.'}
        </p>
      </div>
    </figure>
  );
}
