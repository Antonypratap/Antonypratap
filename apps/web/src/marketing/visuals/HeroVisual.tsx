import { Icon, Panel, StatusPill, useSequence } from '../../design-system';
import { HERO_STEPS, heroStateAt, type Stage } from './heroTimeline';
import styles from './HeroVisual.module.css';

const STAGES: {
  key: Stage;
  label: string;
  count: (c: ReturnType<typeof heroStateAt>['counts']) => number;
}[] = [
  { key: 'arrive', label: 'Arrived', count: (c) => c.arrived },
  { key: 'handle', label: 'Handled', count: (c) => c.handled },
  { key: 'people', label: 'With your team', count: (c) => c.people },
  { key: 'ready', label: 'Ready', count: (c) => c.ready },
];

/**
 * Hero product preview. Plays once: invoices arrive, work gets handled, the one that needs a
 * decision reaches people, the rest is ready. Illustrative data only.
 */
export function HeroVisual() {
  const step = useSequence(HERO_STEPS, 520, true, 700);
  const state = heroStateAt(step);
  const stageIndex = state.stage ? STAGES.findIndex((s) => s.key === state.stage) : -1;

  return (
    <figure
      className={styles.figure}
      aria-label="Illustration: invoices arriving, being handled, one reaching the finance team, the rest ready."
    >
      <Panel
        className={styles.panel}
        title={
          <>
            <Icon name="inbox" size={15} />
            Accounts payable
            <span className={styles.today}>Today</span>
          </>
        }
        meta="Illustrative"
        flush
      >
        <ol className={styles.stages} aria-hidden="true">
          {STAGES.map((s, i) => (
            <li
              key={s.key}
              className={styles.stage}
              data-state={i < stageIndex ? 'done' : i === stageIndex ? 'active' : 'idle'}
            >
              <span className={styles.stageCount}>{s.count(state.counts)}</span>
              <span className={styles.stageLabel}>{s.label}</span>
            </li>
          ))}
        </ol>

        <ul className={styles.rows} aria-hidden="true">
          {state.rows.map(({ invoice, visible, status }) => (
            <li key={invoice.id} className={styles.row} data-visible={visible} data-status={status}>
              <span className={styles.docIcon}>
                <Icon name="document" size={16} />
              </span>
              <span className={styles.vendor}>
                <span className={styles.vendorName}>{invoice.vendor}</span>
                <span className={styles.number}>{invoice.number}</span>
              </span>
              <span className={styles.amount}>{invoice.amount}</span>
              <span className={styles.status}>
                <StatusPill status={status}>
                  {status === 'attention' ? 'Your team' : undefined}
                </StatusPill>
              </span>
            </li>
          ))}
        </ul>

        <div className={styles.footer} data-visible={state.showReady} aria-hidden="true">
          <span className={styles.footerIcon}>
            <Icon name="check" size={14} />
          </span>
          <span>
            <strong>4 invoices</strong> ready to move forward
          </span>
        </div>
      </Panel>

      <div className={styles.callout} data-visible={state.showCallout} aria-hidden="true">
        <div className={styles.calloutHead}>
          <span className={styles.calloutIcon}>
            <Icon name="attention" size={15} />
          </span>
          <span className={styles.calloutTitle}>Invoice #4821 needs a decision</span>
        </div>
        <p className={styles.calloutText}>Quantity billed is higher than quantity received.</p>
        <div className={styles.calloutActions}>
          <span className={styles.assignee}>
            <span className={styles.avatar}>FT</span>
            Finance team
          </span>
          <span className={styles.review}>Review</span>
        </div>
      </div>
    </figure>
  );
}
