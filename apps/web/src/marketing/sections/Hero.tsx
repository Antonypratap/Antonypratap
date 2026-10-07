import { ButtonLink, Container, Icon } from '../../design-system';
import { demoEntryHref } from '../../access/demoAccess';
import { ControlFlow } from '../visuals/ControlFlow';
import { challengeEntryHref } from '../../site/host';
import styles from './Hero.module.css';

const PRINCIPLES = ['Never pays anything', 'Never guesses', 'Every step on record'];

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <Container className={styles.grid}>
        <div className={styles.copy}>
          <p className={styles.kicker}>
            <span className={styles.dot} aria-hidden="true" />
            Supplier invoice control, before payment
          </p>
          <h1 id="hero-title" className={styles.title}>
            Before you pay the invoice,{' '}
            <span className={styles.accent}>verify what you ordered and received.</span>
          </h1>
          <p className={styles.lede}>
            Veyrafy checks supplier invoices against your purchase orders, goods received and
            reference records — so discrepancies are caught before money leaves.
          </p>
          <div className={styles.ctas}>
            <ButtonLink href="#/request-access" size="lg" arrow>
              Book a Demo
            </ButtonLink>
            <ButtonLink href="#how-it-works" size="lg" variant="secondary">
              See How It Works
            </ButtonLink>
          </div>
          <p className={styles.challenge}>
            Want to see it on your own bills?{' '}
            <a href={challengeEntryHref()}>
              Check 5 of your invoices free
              <Icon name="arrowRight" size={14} />
            </a>{' '}
            or{' '}
            <a href={demoEntryHref()}>
              try the demo with sample invoices
              <Icon name="arrowRight" size={14} />
            </a>
          </p>
          <ul className={styles.principles}>
            {PRINCIPLES.map((p) => (
              <li key={p}>
                <Icon name="check" size={16} strokeWidth={2.4} />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.visual}>
          <ControlFlow />
        </div>
      </Container>
    </section>
  );
}
