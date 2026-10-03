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
            For breweries, brewpubs and restaurants
          </p>
          <h1 id="hero-title" className={styles.title}>
            Every invoice checked <span className={styles.accent}>before you pay.</span>
          </h1>
          <p className={styles.lede}>
            Short deliveries billed in full. Rates above what you agreed. The same bill twice.
            Veyrafy checks every supplier bill against your order, what actually arrived and GST,
            and shows your team only the ones that are wrong.
          </p>
          <div className={styles.ctas}>
            <ButtonLink href={demoEntryHref()} size="lg" arrow>
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
