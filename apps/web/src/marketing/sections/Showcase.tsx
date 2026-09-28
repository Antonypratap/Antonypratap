import {
  Container,
  Icon,
  Metric,
  Panel,
  StatusPill,
  useInView,
  useSequence,
} from '../../design-system';
import styles from './Showcase.module.css';

const RECEIVED = 142;
const HANDLED = 131;
const ATTENTION = 11;

const QUEUE = [
  { id: '#4821', vendor: 'Brightwater Supplies', issue: 'Quantity differs', selected: true },
  { id: '#4817', vendor: 'Harbor Freight Lines', issue: 'Missing details', selected: false },
  { id: '#4809', vendor: 'Quill & Co.', issue: 'Looks like a duplicate', selected: false },
  { id: '#4796', vendor: 'Altura Components', issue: 'Price differs', selected: false },
];

/** Counts up to `target` as `progress` goes 0 → 1. */
const upTo = (target: number, progress: number): number => Math.round(target * progress);

export function Showcase() {
  const [ref, inView] = useInView<HTMLDivElement>({ threshold: 0.3 });
  const STEPS = 24;
  const step = useSequence(STEPS, 28, inView, 150);
  const p = step / STEPS;

  return (
    <section id="product" className={styles.section} aria-labelledby="showcase-title">
      <Container>
        <div className={styles.head}>
          <h2 id="showcase-title" className={styles.title}>
            Your team sees what matters.
            <span className={styles.titleMuted}> Veyra takes care of the rest.</span>
          </h2>
        </div>

        <div ref={ref} className={styles.frame}>
          <Panel
            title={
              <>
                <Icon name="inbox" size={15} />
                Invoices · This week
              </>
            }
            meta="Illustrative example"
            flush
          >
            <div className={styles.metrics}>
              <Metric value={upTo(RECEIVED, p)} label="Invoices received" />
              <Metric value={upTo(HANDLED, p)} label="Handled" tone="handled" />
              <Metric value={upTo(ATTENTION, p)} label="Need attention" tone="attention" />
              <div className={styles.bar} aria-hidden="true">
                <span
                  className={styles.barHandled}
                  style={{ width: `${(HANDLED / RECEIVED) * 100 * p}%` }}
                />
                <span
                  className={styles.barAttention}
                  style={{ width: `${(ATTENTION / RECEIVED) * 100 * p}%` }}
                />
              </div>
            </div>

            <div className={styles.body}>
              <div className={styles.queue}>
                <p className={styles.queueTitle}>Needs your attention</p>
                <ul>
                  {QUEUE.map((q) => (
                    <li key={q.id} className={styles.queueItem} data-selected={q.selected}>
                      <span className={styles.queueMain}>
                        <span className={styles.queueId}>Invoice {q.id}</span>
                        <span className={styles.queueVendor}>{q.vendor}</span>
                      </span>
                      <span className={styles.queueIssue}>{q.issue}</span>
                    </li>
                  ))}
                  <li className={styles.queueMore}>+ 7 more</li>
                </ul>
              </div>

              <div className={styles.detail} data-visible={step >= STEPS}>
                <div className={styles.detailHead}>
                  <div>
                    <p className={styles.detailId}>Invoice #4821</p>
                    <p className={styles.detailVendor}>Brightwater Supplies</p>
                  </div>
                  <StatusPill status="attention" />
                </div>
                <dl className={styles.compare}>
                  <div>
                    <dt>Invoice quantity</dt>
                    <dd>100</dd>
                  </div>
                  <div>
                    <dt>Received</dt>
                    <dd>90</dd>
                  </div>
                </dl>
                <div className={styles.difference}>
                  <Icon name="attention" size={16} />
                  <span>
                    <strong>10 units</strong> need your attention
                  </span>
                </div>
                <div className={styles.detailFoot}>
                  <span className={styles.note}>Everything else on this invoice checks out.</span>
                  <span className={styles.review}>Review</span>
                </div>
              </div>
            </div>
          </Panel>
          <p className={styles.caption}>
            Illustrative example. Figures do not represent customer results.
          </p>
        </div>
      </Container>
    </section>
  );
}
