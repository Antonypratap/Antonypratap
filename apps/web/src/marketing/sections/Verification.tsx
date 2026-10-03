import { Container, Icon, Reveal } from '../../design-system';
import styles from './Verification.module.css';

/**
 * Where Veyrafy sits: between the invoice that arrives and the payment. One worked example read
 * left to right (top to bottom on a phone): the invoice, the checks, the records it is checked
 * against, the result, and payment only after that. Every check shown is one the product runs;
 * the outcome options are the ones it offers. Illustrative data.
 */
const CHECKS: { label: string; ok: boolean }[] = [
  { label: 'Supplier and GSTIN', ok: true },
  { label: 'Quantity vs goods received', ok: true },
  { label: 'Rate vs agreed rate', ok: false },
  { label: 'GST and totals', ok: true },
  { label: 'Not paid before', ok: true },
];

function Arrow() {
  return (
    <span className={styles.arrow} aria-hidden="true">
      <Icon name="arrowRight" size={18} />
    </span>
  );
}

export function Verification() {
  return (
    <section
      id="how-veyrafy-checks"
      className={styles.section}
      aria-labelledby="verification-title"
    >
      <Container>
        <div className={styles.head}>
          <p className={styles.eyebrow}>How Veyrafy checks</p>
          <h2 id="verification-title" className={styles.title}>
            Between the invoice and the payment.
          </h2>
          <p className={styles.lede}>
            Every invoice is compared with what your books already say. Only what matches moves on;
            anything else waits for your team.
          </p>
        </div>

        <ol className={styles.flow}>
          {/* 1. The invoice, as it arrives. */}
          <Reveal as="li" className={styles.step}>
            <p className={styles.stepLabel}>
              <span className={styles.num}>1</span> Invoice arrives
            </p>
            <div className={styles.card}>
              <p className={styles.supplier}>ABC Foods</p>
              <p className={styles.muted}>INV-18392</p>
              <dl className={styles.lines}>
                <div>
                  <dt>Basmati rice</dt>
                  <dd>1,000 kg × ₹128</dd>
                </div>
              </dl>
              <p className={styles.total}>₹1,28,000</p>
            </div>
            <Arrow />
          </Reveal>

          {/* 2–4. Veyrafy: the checks, the records, the result. */}
          <li className={styles.veyrafy}>
            <p className={styles.band}>
              <span className={styles.bandMark} aria-hidden="true" />
              Veyrafy
            </p>
            <div className={styles.inner}>
              <Reveal delay={120} className={styles.step}>
                <p className={styles.stepLabel}>
                  <span className={styles.num}>2</span> Veyrafy checks
                </p>
                <ul className={`${styles.card} ${styles.checks}`}>
                  {CHECKS.map((c) => (
                    <li key={c.label} data-ok={c.ok}>
                      <span className={styles.mark} aria-hidden="true">
                        {c.ok ? <Icon name="check" size={12} strokeWidth={2.8} /> : '!'}
                      </span>
                      {c.label}
                      <span className="visually-hidden">{c.ok ? ': matches' : ': differs'}</span>
                    </li>
                  ))}
                </ul>
                <Arrow />
              </Reveal>

              <Reveal delay={240} className={styles.step}>
                <p className={styles.stepLabel}>
                  <span className={styles.num}>3</span> Your records
                </p>
                <dl className={`${styles.card} ${styles.records}`}>
                  <div>
                    <dt>Accounting / ERP</dt>
                    <dd>ABC Foods · GSTIN on file</dd>
                  </div>
                  <div>
                    <dt>Purchase order PO-4471</dt>
                    <dd data-tone="attention">Agreed rate ₹120 / kg</dd>
                  </div>
                  <div>
                    <dt>Goods receipt GRN-2207</dt>
                    <dd>1,000 kg received</dd>
                  </div>
                </dl>
                <Arrow />
              </Reveal>

              <Reveal delay={360} className={styles.step}>
                <p className={styles.stepLabel}>
                  <span className={styles.num}>4</span> Result
                </p>
                <div className={`${styles.card} ${styles.result}`}>
                  <p className={styles.resultState}>
                    <Icon name="attention" size={15} /> Needs attention
                  </p>
                  <p className={styles.compare}>
                    Invoice rate <strong>₹128</strong> · agreed <strong>₹120</strong>
                  </p>
                  <p className={styles.difference}>₹8,000 difference, needs review</p>
                  <p className={styles.muted}>
                    1,000 kg × ₹8. Your team corrects, updates the order or rejects.
                  </p>
                </div>
                <p className={styles.alt}>
                  <Icon name="check" size={13} strokeWidth={2.6} /> When everything matches:
                  Verified
                </p>
                <Arrow />
              </Reveal>
            </div>
          </li>

          {/* 5. Payment, only after. */}
          <Reveal as="li" delay={480} className={`${styles.step} ${styles.payment}`}>
            <p className={styles.stepLabel}>
              <span className={styles.num}>5</span> Ready for payment
            </p>
            <div className={`${styles.card} ${styles.waiting}`}>
              <p className={styles.waitingTitle}>Waiting</p>
              <p className={styles.muted}>
                Moves on only when every check passes, or once your team has resolved the
                difference. Paying stays with you.
              </p>
            </div>
          </Reveal>
        </ol>

        <p className={styles.caption}>Illustrative example with sample data.</p>
      </Container>
    </section>
  );
}
