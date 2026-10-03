import type { CSSProperties } from 'react';
import { Container, Eyebrow, Icon, StatusPill, useInView, useSequence } from '../../design-system';
import styles from './Showcase.module.css';

const RECEIVED = 142;
/** Which of the week's invoices need a person (illustrative, spread through the week). */
const NEED_YOU = new Set([6, 19, 31, 42, 57, 66, 80, 93, 107, 121, 134]);
const HANDLED = RECEIVED - NEED_YOU.size;

const TILES = Array.from({ length: RECEIVED }, (_, i) => ({ i, needsYou: NEED_YOU.has(i) }));

export function Showcase() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.35 });
  // 1: invoices are worked through; 2: the handled ones fall away, the 11 remain.
  const phase = useSequence(2, 2600, inView, 400, 6000);

  return (
    <section id="product" className={styles.section} aria-labelledby="showcase-title">
      <Container>
        <Eyebrow>An illustrative week</Eyebrow>

        <dl className={styles.numbers}>
          <div className={styles.number}>
            <dt>Invoices received</dt>
            <dd className={styles.received}>{RECEIVED}</dd>
          </div>
          <div className={styles.number}>
            <dt>
              <span className={styles.dotHandled} /> Handled
            </dt>
            <dd className={styles.handled}>{HANDLED}</dd>
          </div>
          <div className={styles.number}>
            <dt>
              <span className={styles.dotAttention} /> Need you
            </dt>
            <dd className={styles.attention}>{NEED_YOU.size}</dd>
          </div>
        </dl>

        <div ref={ref} className={styles.field} data-phase={phase} aria-hidden="true">
          {TILES.map((t) => (
            <span
              key={t.i}
              className={styles.tile}
              data-needs-you={t.needsYou}
              style={{ '--d': `${t.i * 9}ms` } as CSSProperties}
            />
          ))}
        </div>

        <div className={styles.resolution}>
          <h2 id="showcase-title" className={styles.statement}>
            Your team sees the <span className={styles.attentionText}>11</span>.
            <br />
            Veyrafy takes care of the <span className={styles.handledText}>131</span>.
          </h2>

          <div
            className={styles.card}
            aria-label="Illustrative example of one invoice that needs a decision"
          >
            <div className={styles.cardHead}>
              <div>
                <p className={styles.cardId}>Prawns · CCS-2291</p>
                <p className={styles.cardVendor}>Coastal Catch Seafoods</p>
              </div>
              <StatusPill status="attention">Needs you</StatusPill>
            </div>
            <dl className={styles.compare}>
              <div>
                <dt>Billed</dt>
                <dd>20 kg</dd>
              </div>
              <div>
                <dt>Delivered</dt>
                <dd>18 kg</dd>
              </div>
            </dl>
            <p className={styles.difference}>
              <Icon name="attention" size={16} />
              <span>
                <strong>₹1,400</strong> billed for prawns that never arrived
              </span>
            </p>
            <div className={styles.cardFoot}>
              <span className={styles.note}>Everything else on this bill checks out.</span>
              <span className={styles.review}>Review</span>
            </div>
          </div>
        </div>

        <p className={styles.caption}>
          Illustrative example. Figures do not represent customer results.
        </p>
      </Container>
    </section>
  );
}
