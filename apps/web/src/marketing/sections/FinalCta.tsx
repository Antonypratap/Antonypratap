import { ButtonLink, Container, Reveal } from '../../design-system';
import { DEMO_ENTRY_HREF } from '../../access/demoAccess';
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
            Veyra handles the invoice work.
            <br />
            Your people handle the business.
          </p>
          <ButtonLink href={DEMO_ENTRY_HREF} size="lg" arrow>
            See Veyra in action
          </ButtonLink>
        </Reveal>
      </Container>
    </section>
  );
}
