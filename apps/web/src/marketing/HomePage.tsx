import { SiteNav } from './SiteNav';
import { FinalCta } from './sections/FinalCta';
import { Hero } from './sections/Hero';
import { HowItWorks } from './sections/HowItWorks';
import { Outcomes } from './sections/Outcomes';
import { Philosophy } from './sections/Philosophy';
import { Problem } from './sections/Problem';
import { Showcase } from './sections/Showcase';
import { SiteFooter } from './sections/SiteFooter';
import { Trust } from './sections/Trust';

/** WHY → WHAT → HOW → TRUST → CTA */
export function HomePage() {
  return (
    <>
      <a className="visually-hidden" href="#main">
        Skip to content
      </a>
      <SiteNav />
      <main id="main">
        <div id="top" />
        <Hero />
        <Problem />
        <Outcomes />
        <Showcase />
        <HowItWorks />
        <Philosophy />
        <Trust />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
