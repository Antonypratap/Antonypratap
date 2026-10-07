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
              Know what you’re paying for before you pay.
            </h2>
            <p className={styles.lede}>
              See how Veyrafy can fit into your supplier invoice and payment workflow.
            </p>
            <p className={styles.demo}>
              <a href={demoEntryHref()}>Or try the demo with sample invoices</a>
            </p>
          </div>
          <div className={styles.actions}>
            <ButtonLink href="#/request-access" size="lg" variant="inverse" arrow>
              Book a Demo
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
