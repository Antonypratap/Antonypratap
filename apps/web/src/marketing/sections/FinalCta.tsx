import { ButtonLink, Container, Reveal } from '../../design-system';
import { demoEntryHref } from '../../access/demoAccess';
import { CONTACT_PHONE, CONTACT_PHONE_HREF } from '../../site/host';
import styles from './FinalCta.module.css';

export function FinalCta() {
  return (
    <section className={styles.section} aria-labelledby="cta-title">
      <Container>
        <Reveal className={styles.band}>
          <div className={styles.copy}>
            <h2 id="cta-title" className={styles.title}>
              See an invoice handled in three minutes.
            </h2>
            <p className={styles.lede}>
              Open the demo with sample invoices, or call us and we’ll walk you through it.
            </p>
          </div>
          <div className={styles.actions}>
            <ButtonLink href={demoEntryHref()} size="lg" variant="inverse" arrow>
              See Veyrafy in action
            </ButtonLink>
            <a href={CONTACT_PHONE_HREF} className={styles.phone}>
              {CONTACT_PHONE}
            </a>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
