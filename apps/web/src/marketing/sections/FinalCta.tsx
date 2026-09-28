import { ButtonLink, Container, Reveal } from '../../design-system';
import styles from './FinalCta.module.css';

export function FinalCta() {
  return (
    <section className={styles.section} aria-labelledby="cta-title">
      <Container>
        <Reveal className={styles.inner}>
          <h2 id="cta-title" className={styles.title}>
            Give your finance team their time back.
          </h2>
          <p className={styles.copy}>
            Veyra handles the invoice work.
            <br />
            Your people handle the business.
          </p>
          <ButtonLink href="#product" size="lg" arrow>
            See Veyra in action
          </ButtonLink>
        </Reveal>
      </Container>
    </section>
  );
}
