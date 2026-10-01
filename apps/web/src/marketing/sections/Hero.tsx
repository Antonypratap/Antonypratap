import { ButtonLink, Container, Icon } from '../../design-system';
import { demoEntryHref } from '../../access/demoAccess';
import { CONTACT_PHONE_HREF } from '../../site/host';
import { InvoiceStory } from '../visuals/InvoiceStory';
import styles from './Hero.module.css';

const PRINCIPLES = ['Never pays anything', 'Never guesses', 'Every step on record'];

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <Container className={styles.grid}>
        <div className={styles.copy}>
          <p className={styles.kicker}>
            <span className={styles.dot} aria-hidden="true" />
            Accounts payable for Indian businesses
          </p>
          <h1 id="hero-title" className={styles.title}>
            Every invoice checked <span className={styles.accent}>before you pay.</span>
          </h1>
          <p className={styles.lede}>
            Veyrafy reads each supplier invoice, matches it to the purchase order, the goods receipt
            and GST, then records it in your ERP. Your team only sees the decisions.
          </p>
          <div className={styles.ctas}>
            <ButtonLink href={demoEntryHref()} size="lg" arrow className={styles.primary}>
              See Veyrafy in action
            </ButtonLink>
            <ButtonLink href={CONTACT_PHONE_HREF} size="lg" variant="secondary">
              Book a walkthrough
            </ButtonLink>
          </div>
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
