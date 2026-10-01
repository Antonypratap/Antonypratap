import styles from './HomePage.module.css';
import { SiteNav } from './SiteNav';
import { BuiltForIndia } from './sections/BuiltForIndia';
import { FinalCta } from './sections/FinalCta';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { Outcomes } from './sections/Outcomes';
import { Philosophy } from './sections/Philosophy';
import { Problem } from './sections/Problem';
import { Showcase } from './sections/Showcase';
import { SiteFooter } from './sections/SiteFooter';
import { Trust } from './sections/Trust';
import { WhyNow } from './sections/WhyNow';

/** WHY → WHAT → HOW → TRUST → CTA */
export function HomePage() {
  return (
    <div className={styles.site}>
      <a className="visually-hidden" href="#main">
        Skip to content
      </a>
      <SiteNav />
      <main id="main">
        <div id="top" />
        <Hero />
        <WhyNow />
        <Problem />
        <Outcomes />
        <Showcase />
        <HowItWorks />
        <BuiltForIndia />
        <Philosophy />
        <Trust />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
