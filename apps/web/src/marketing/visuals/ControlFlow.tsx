import { Icon } from '../../design-system';
import styles from './ControlFlow.module.css';

/**
 * The hero's picture of where Veyrafy sits: the supplier's invoice and the buyer's own records
 * (the purchase order, and the goods receipt the store recorded) meet in Veyrafy before payment.
 * A match moves on to approval and payment by your team; a difference is held until it is
 * resolved and checked again. Static and text-only: no sample business, no product claim beyond
 * what the checks do.
 */
export function ControlFlow() {
  return (
    <figure className={styles.flow} aria-labelledby="control-flow-caption">
      <figcaption id="control-flow-caption" className="visually-hidden">
        The supplier invoice is checked against the purchase order and the goods receipt (GRN) in
        Veyrafy. A match goes on to approval and payment. A difference is held, resolved and checked
        again.
      </figcaption>

      <div className={styles.source}>
        <p className={styles.who}>From the supplier, to finance</p>
        <p className={styles.doc}>
          <Icon name="document" size={16} /> Supplier invoice
        </p>
        <p className={styles.what}>What you are asked to pay</p>
      </div>

      <span className={styles.down} aria-hidden="true" />

      <div className={styles.records}>
        <div className={styles.source}>
          <p className={styles.who}>Purchasing</p>
          <p className={styles.doc}>Purchase order</p>
          <p className={styles.what}>What you agreed to buy</p>
        </div>
        <span className={styles.plus} aria-hidden="true">
          +
        </span>
        <div className={styles.source}>
          <p className={styles.who}>Store / facility</p>
          <p className={styles.doc}>GRN</p>
          <p className={styles.what}>What actually arrived</p>
        </div>
      </div>

      <span className={styles.down} aria-hidden="true" />

      <div className={styles.veyrafy}>
        <span className={styles.mark} aria-hidden="true" />
        <span>
          <strong>Veyrafy</strong>
          <span className={styles.veyrafySub}>Quantity, rate, tax and totals, line by line</span>
        </span>
      </div>

      <div className={styles.outcomes}>
        <div className={styles.outcome} data-tone="match">
          <p className={styles.result}>
            <Icon name="check" size={14} strokeWidth={2.8} /> Match
          </p>
          <p className={styles.path}>Approve / pay</p>
          <p className={styles.note}>Payment is released by your team.</p>
        </div>
        <div className={styles.outcome} data-tone="difference">
          <p className={styles.result}>
            <Icon name="attention" size={14} /> Difference
          </p>
          <p className={styles.path}>
            <span className={styles.step}>
              Hold <span aria-hidden="true">→</span>
            </span>{' '}
            <span className={styles.step}>
              Resolve <span aria-hidden="true">→</span>
            </span>{' '}
            <span className={styles.step}>Re&#8209;check</span>
          </p>
          <p className={styles.note}>Shown with the evidence, until it is settled.</p>
        </div>
      </div>
    </figure>
  );
}
