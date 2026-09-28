import { Icon, StatusPill, Struck, useSequence } from '../../design-system';
import { HERO_STEPS, heroStateAt } from './heroTimeline';
import styles from './HeroVisual.module.css';

/**
 * Hero: one invoice arrives with the work attached to it. Veyra takes the work away,
 * line by line. What is left is the one decision that belongs to a person. Plays once.
 */
export function HeroVisual() {
  const step = useSequence(HERO_STEPS, 560, true, 900);
  const s = heroStateAt(step);

  return (
    <figure
      className={styles.figure}
      data-arrived={s.arrived}
      aria-label="Illustration: an invoice arrives with six tasks attached. Veyra removes five of them. One decision is left for the finance team."
    >
      <div className={styles.stack} aria-hidden="true">
        <span className={styles.stackSheet} />
        <span className={styles.stackSheet} />
        <span className={styles.stackLabel}>1 of 142 today</span>
      </div>

      <div className={styles.sheet} aria-hidden="true">
        <div className={styles.head}>
          <span className={styles.doc}>
            <Icon name="document" size={17} />
          </span>
          <span className={styles.identity}>
            <span className={styles.vendor}>Brightwater Supplies</span>
            <span className={styles.meta}>Invoice #4821 · ₹2,04,300.00</span>
          </span>
          <StatusPill status={s.showDecision ? 'attention' : 'received'}>
            {s.showDecision ? 'Needs you' : 'Received'}
          </StatusPill>
        </div>

        <div className={styles.workHead}>
          <span>Work on this invoice</span>
          <span className={styles.counter} data-settled={s.settled}>
            {s.settled ? '1 decision left' : `${s.remaining} to do`}
          </span>
        </div>

        <ul className={styles.tasks}>
          {s.tasks.map(({ task, status }) => (
            <li key={task.id} className={styles.task} data-status={status}>
              <span className={styles.mark}>
                {status === 'done' && <Icon name="check" size={12} strokeWidth={2.2} />}
                {status === 'decision' && <span className={styles.bang}>!</span>}
              </span>
              <span className={styles.label}>
                <Struck struck={status === 'done'}>{task.label}</Struck>
              </span>
              {status === 'decision' && <span className={styles.flag}>10 units short</span>}
            </li>
          ))}
        </ul>

        <div className={styles.decisionWrap} data-visible={s.showDecision}>
          <div className={styles.decision}>
            <p className={styles.decisionLabel}>For your team</p>
            <p className={styles.decisionText}>
              90 of 100 units were received. How should this invoice go forward?
            </p>
            <div className={styles.decisionActions}>
              <span className={styles.primary}>Accept 90 units</span>
              <span className={styles.secondary}>Ask the supplier</span>
            </div>
          </div>
        </div>
      </div>

      <figcaption className={styles.caption} data-visible={s.settled}>
        <Icon name="check" size={14} />
        <span>
          <strong>5 tasks</strong> taken off your team&rsquo;s plate. <strong>1 decision</strong>{' '}
          left.
        </span>
      </figcaption>
    </figure>
  );
}
