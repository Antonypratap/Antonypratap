import { ButtonLink, Container, Reveal } from '../../design-system';
import { demoEntryHref } from '../../access/demoAccess';
import styles from './FinalCta.module.css';

export function FinalCta() {
  return (
    <section className={styles.section} aria-labelledby="cta-title">
      <Container>
        <Reveal className={styles.inner}>
          <h2 id="cta-title" className={styles.title}>
            Let the work disappear.
          </h2>
          <p className={styles.copy}>
            Veyrafy handles the invoice work.
            <br />
            Your people handle the business.
          </p>
          <ButtonLink href={demoEntryHref()} size="lg" arrow>
            See Veyrafy in action
          </ButtonLink>
        </Reveal>
      </Container>
    </section>
  );
}
