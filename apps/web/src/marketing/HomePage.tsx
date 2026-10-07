import styles from './HomePage.module.css';
import { SiteNav } from './SiteNav';
import { BuiltForIndia } from './sections/BuiltForIndia';
import { Control } from './sections/Control';
import { Faq } from './sections/Faq';
import { FinalCta } from './sections/FinalCta';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { Industries } from './sections/Industries';
import { Philosophy } from './sections/Philosophy';
import { Problem } from './sections/Problem';
import { RealProblem } from './sections/RealProblem';
import { Roadmap } from './sections/Roadmap';
import { Showcase } from './sections/Showcase';
import { SiteFooter } from './sections/SiteFooter';
import { Trust } from './sections/Trust';
import { Verification } from './sections/Verification';
import { WhyNow } from './sections/WhyNow';

/**
 * The business problem before the product: the control point before payment (hero) → the three
 * records that disagree (real problem) → the process with Veyrafy in it (how it works) → one
 * worked example (verification) → what slips through (problem) → control, not reading (control)
 * → why now → who it is for → GST, trust and the rest → CTA
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
        <HowItWorks />
        <Verification />
        <Problem />
        <Control />
        <WhyNow />
        <Industries />
        <Showcase />
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
