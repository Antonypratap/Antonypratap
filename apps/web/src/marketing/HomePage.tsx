import styles from './HomePage.module.css';
import { SiteNav } from './SiteNav';
import { BuiltForIndia } from './sections/BuiltForIndia';
import { Control } from './sections/Control';
import { Faq } from './sections/Faq';
import { FinalCta } from './sections/FinalCta';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { Industries } from './sections/Industries';
import { Outcome } from './sections/Outcome';
import { RealProblem } from './sections/RealProblem';
import { SiteFooter } from './sections/SiteFooter';
import { Trust } from './sections/Trust';
import { WhyNow } from './sections/WhyNow';

/**
 * What and why first, then how: the control point before payment (hero) → the three records that
 * disagree (real problem) → what it costs (why now) → the process with Veyrafy in it (how it
 * works) → what changes for the business (outcome) → control, not reading (one line) → who it is
 * for → GST → trust → questions → CTA
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
        <RealProblem />
        <WhyNow />
        <HowItWorks />
        <Outcome />
        <Control />
        <Industries />
        <BuiltForIndia />
        <Trust />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
