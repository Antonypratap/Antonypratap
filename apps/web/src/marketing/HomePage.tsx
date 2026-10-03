import styles from './HomePage.module.css';
import { SiteNav } from './SiteNav';
import { BuiltForIndia } from './sections/BuiltForIndia';
import { Faq } from './sections/Faq';
import { FinalCta } from './sections/FinalCta';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { Outcomes } from './sections/Outcomes';
import { Philosophy } from './sections/Philosophy';
import { Problem } from './sections/Problem';
import { Roadmap } from './sections/Roadmap';
import { Showcase } from './sections/Showcase';
import { SiteFooter } from './sections/SiteFooter';
import { Trust } from './sections/Trust';
import { Verification } from './sections/Verification';
import { WhyNow } from './sections/WhyNow';

/**
 * WHAT it does (hero) → WHAT it checks against (verification) → WHEN something doesn't match
 * (problem) → WHY before payment (why now) → HOW the exception is handled → TRUST → CTA
 */
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
        <Verification />
        <Problem />
        <WhyNow />
        <Outcomes />
        <Showcase />
        <HowItWorks />
        <BuiltForIndia />
        <Philosophy />
        <Trust />
        <Roadmap />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
