import { ButtonLink, Container } from '../../design-system';
import { HeroVisual } from '../visuals/HeroVisual';
import styles from './Hero.module.css';

export function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <Container className={styles.grid}>
        <div className={styles.copy}>
          <p className={styles.kicker}>Accounts payable</p>
          <h1 id="hero-title" className={styles.title}>
            Invoices, handled.
          </h1>
          <p className={styles.lede}>
            Your finance team has better things to do than process invoices.
          </p>
          <p className={styles.body}>
            Veyra takes the reading, keying, checking and chasing out of accounts payable. What
            reaches your team is only what needs a decision.
          </p>
          <div className={styles.ctas}>
            <ButtonLink href="#product" size="lg" arrow>
              See Veyra in action
            </ButtonLink>
            <ButtonLink href="#how-it-works" size="lg" variant="secondary">
              How it works
            </ButtonLink>
          </div>
        </div>
        <div className={styles.visual}>
          <HeroVisual />
        </div>
      </Container>
    </section>
  );
}
