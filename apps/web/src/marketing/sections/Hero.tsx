import { ButtonLink, Container, Icon } from '../../design-system';
import { demoEntryHref } from '../../access/demoAccess';
import { InvoiceStory } from '../visuals/InvoiceStory';
import { CHALLENGE_PATH } from '../../site/host';
import styles from './Hero.module.css';

const PRINCIPLES = ['Never pays anything', 'Never guesses', 'Every step on record'];

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <Container className={styles.grid}>
        <div className={styles.copy}>
          <p className={styles.kicker}>
            <span className={styles.dot} aria-hidden="true" />
            Invoice verification before payment
          </p>
          <h1 id="hero-title" className={styles.title}>
            Check every invoice against your accounting records{' '}
            <span className={styles.accent}>before you pay.</span>
          </h1>
          <p className={styles.lede}>
            Veyrafy reads each supplier invoice, checks it against your accounting and purchasing
            records (the order, the goods received, the agreed rates and GST) and puts every
            difference in front of your team before it becomes a payment problem.
          </p>
          <div className={styles.ctas}>
            <ButtonLink href={demoEntryHref()} size="lg" arrow>
              Check an invoice
            </ButtonLink>
            <ButtonLink href="#how-veyrafy-checks" size="lg" variant="secondary">
              See how it works
            </ButtonLink>
          </div>
          <p className={styles.challenge}>
            <a href={CHALLENGE_PATH}>
              Take the 10 Invoice Challenge: see what gets caught in your own invoices
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
          <InvoiceStory />
        </div>
      </Container>
    </section>
  );
}
