// Hand-designed Why / What / How pages. Copy is taken from the live pages
// (data/pages.json) so the ranking content survives; layout is new.
import { SITE, waLink } from '../config.js';
import { yearsSince } from '../content-fixes.js';
import { ogUrl, esc, img, href, ctaBand, faqHtml, faqLd, waIcon, crumbs, breadcrumbLd, abs } from '../lib.js';

const gallery = (ctx, page, n = 24) =>
  `<div class="gallery">${ctx
    .imagesOf(page)
    .slice(0, n)
    .map((im) => `<a href="${href(ctx.imagePageOf(page, im.id) ?? page)}">${img(im, { sizes: '(max-width: 640px) 100vw, 33vw' })}</a>`)
    .join('')}</div>`;

const card = (ctx, path, heading, text, { feature = false, image } = {}) => {
  const im = image ? ctx.image(image) : ctx.imagesOf(path)[0];
  return `<a class="card${feature ? ' feature' : ''}" href="${href(path)}">${im ? img(im, { sizes: feature ? '(max-width: 640px) 100vw, 66vw' : '(max-width: 640px) 100vw, 33vw' }) : ''}<div class="card-body"><h3>${esc(heading)}</h3><p>${esc(text)}</p><div class="more">Explore →</div></div></a>`;
};

const postCards = (ctx, posts) =>
  `<div class="cards">${posts
    .map((p) => {
      const im = ctx.imagesOf(p.imagePage ?? '')[0];
      return `<a class="card" href="${href(p.path)}">${im ? img(im, { sizes: '(max-width: 640px) 100vw, 33vw' }) : ''}<div class="card-body"><span class="eyebrow" style="margin-bottom:8px">${esc(p.category)}</span><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p></div></a>`;
    })
    .join('')}</div>`;

/* ------------------------------------------------------------------ HOME */
export function home(ctx) {
  const page = ctx.page('/');
  const heroImg = ctx.image('Pnw6GqR') ?? ctx.imagesOf('/Headshot-photographer-bangalore')[0];
  const portrait = ctx.imagesOf('/About')[0];
  const photo = (im) => !/review|process|pricing|screenshot|testimonial|banner|poster|logo/i.test(im.file + ' ' + (im.originalAlt ?? ''));
  const strip = [...ctx.imagesOf('/Headshot-photographer-bangalore').filter(photo).slice(0, 5), ...ctx.imagesOf('/Fitness-Photography').filter(photo).slice(0, 5)];
  const long = ctx.blocksAfter('/', 'BEST PHOTOGRAPHY SERVICES FROM BANGALORE', 'HISTORY OF NEVERVOID PHOTOGRAPHY');
  const history = ctx.blocksAfter('/', 'HISTORY OF NEVERVOID PHOTOGRAPHY', 'Book your photography session with confidence!');
  const body = `
<section class="hero">
  ${img(heroImg, { cls: 'hero-bg', eager: true, sizes: '100vw', alt: '' })}
  <div class="wrap">
    <span class="eyebrow">Nevervoid Photography · Bangalore · Since ${SITE.foundingYear}</span>
    <h1>Professional photographer in Bangalore for fitness, corporate headshots &amp; maternity</h1>
    <p class="lede">Memories are timeless treasures of the heart. We make headshots that open doors, fitness photos that show the work, and family portraits you will keep for a lifetime, in our studio or on location.</p>
    <div class="actions">
      <a class="btn btn-light" href="${waLink('a photoshoot')}" rel="noopener">${waIcon} Book on WhatsApp</a>
      <a class="btn btn-ghost" href="/Headshot-photographer-bangalore">Headshot sessions</a>
      <a class="btn btn-ghost" href="/Fitness-Photography">Fitness photoshoots</a>
    </div>
  </div>
</section>

<section class="section" id="why">
  <div class="wrap split">
    <div>
      <p class="wwh-label">Why</p>
      <h2>Because the right photograph changes how people see you.</h2>
      <p>Have you always wondered what kind of a personality would arrive when you hire a photographer? I'm ${SITE.founder}, and I have been providing photography services since ${SITE.foundingYear}. I take my photography service very seriously. It is not just about you coming to a location, the shoot happening, and you leaving.</p>
      <p>Look at it as an experience: get ready, look your best and enjoy the shoot. Feel it from inside, give your best expressions, and we take care of the rest. Nevervoid Photography offers posed and candid styles, and you will be comfortable throughout the session.</p>
      <ul class="ticks">
        <li>Studio sessions, or on-site at your office, home or gym anywhere in Bangalore</li>
        <li>Posing and expression coaching included, so camera-shy is fine</li>
        <li>Every photo from your session, with your favourites professionally retouched</li>
        <li>Edited by people, not presets. Experience-led retouching for every image</li>
      </ul>
    </div>
    <div>${img(portrait ?? heroImg, { alt: `${SITE.founder}, founder of Nevervoid Photography, Bangalore` })}</div>
  </div>
  <div class="wrap"><div class="stats">
    <div><strong>${SITE.foundingYear}</strong><span>Photographing Bangalore since</span></div>
    <div><strong>1000+</strong><span>Couples photographed for maternity</span></div>
    <div><strong>2 days</strong><span>Headshot delivery</span></div>
    <div><strong>${yearsSince()}+ years</strong><span>Studio in Banaswadi, or on-site at your location</span></div>
  </div></div>
</section>

<section class="section alt" id="what">
  <div class="wrap">
    <div class="section-head"><p class="wwh-label">What</p><h2>Photography services in Bangalore</h2><p>Specialists in professional headshots and fitness photography, with the experience to cover the moments that matter to your family.</p></div>
    <div class="cards">
      ${card(ctx, '/Headshot-photographer-bangalore', 'Professional headshots', 'Corporate, LinkedIn, founder and team headshots, in the studio or on-site. Clean or blurred backgrounds.', { feature: true })}
      ${card(ctx, '/Fitness-Photography', 'Fitness & gym photography', 'Transformations, physique, coach and trainer branding. High-contrast studio or on-site at your gym.')}
      ${card(ctx, '/Professional-branding-portraits', 'Personal branding portraits', 'Editorial portraits for speakers, authors, founders and thought leaders.')}
      ${card(ctx, '/Maternity-Photography', 'Maternity portraits', 'The motherhood phase needs patience and experience. Studio and outdoor sessions.', { feature: true })}
      ${card(ctx, '/Newborn-Photography', 'Newborn & family', 'Candid sessions with your little one, at home or at our family studio.')}
      ${card(ctx, '/Couple-photography', 'Couples & pre-wedding', 'Capture your love story, with natural, heartfelt portraits of your bond.')}
      ${card(ctx, '/Candid-wedding-photography', 'Wedding photography', 'Candid moments, portraits and details. We have covered weddings all over India.')}
      ${card(ctx, '/Modelling-portfolio-photography', 'Portfolios & fashion', 'Model and actor portfolios, lifestyle and fashion photography.')}
    </div>
    <p style="margin-top:28px"><a class="btn btn-primary" href="/services">See all services</a></p>
  </div>
</section>

<section class="section dark" id="how">
  <div class="wrap">
    <div class="section-head"><p class="wwh-label">How</p><h2>How a Nevervoid photoshoot works</h2><p>Simple, guided and relaxed, from the first message to the final download.</p></div>
    <ol class="steps">
      <li><strong>Talk to us</strong><p>A quick discussion over the phone or WhatsApp about what you would like to achieve from your photoshoot.</p></li>
      <li><strong>Plan the shoot</strong><p>Studio or on-site, date and time, and guidance on what to wear and bring.</p></li>
      <li><strong>Shoot day</strong><p>You show up. We guide every pose and expression and light every frame. We shoot until you're happy.</p></li>
      <li><strong>Select &amp; deliver</strong><p>You choose your favourites, we retouch them, and your photos arrive by download link.</p></li>
    </ol>
  </div>
</section>

<section class="section-tight"><div class="wrap">
  <div class="section-head" style="margin-bottom:24px"><h2>Recent work</h2></div>
  <div class="strip">${strip.map((im) => `<a href="${href(im.pages[0])}">${img(im, { sizes: '260px' })}</a>`).join('')}</div>
</div></section>

<section class="section alt"><div class="wrap split rev sticky-media">
  <div class="prose">
    <h2>Best photography services from Bangalore</h2>
    ${long.map((b) => `<p>${b.html}</p>`).join('')}
    <h3>History of Nevervoid Photography</h3>
    ${history.map((b) => `<p>${b.html}</p>`).join('')}
    <p><a href="/About">More about Antony Pratap and the studio →</a> · <a href="/Reviews">Read client reviews →</a></p>
  </div>
  <div>${img(ctx.imagesOf('/Maternity-Photography')[0], { alt: 'Maternity photoshoot by Nevervoid Photography, Bangalore' })}</div>
</div></section>

<section class="section"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Journal</span><h2>Guides for your next photoshoot</h2></div>
  ${postCards(ctx, ctx.posts.slice(0, 3))}
</div></section>
${ctaBand({ heading: 'Book your photography session with confidence.', text: 'Tell us what the photos are for: LinkedIn, your gym brand, a milestone. We will plan the shoot around it.' })}`;
  return {
    path: '/',
    title: page.title,
    description: page.description,
    ogImage: ogUrl(heroImg),
    body,
    waTopic: 'professional photography services',
  };
}

/* -------------------------------------------------------------- HEADSHOTS */
export function headshots(ctx) {
  const P = '/Headshot-photographer-bangalore';
  const page = ctx.page(P);
  const ims = ctx.imagesOf(P);
  const hero = ctx.image('R2Sg6fk') ?? ims[0];
  const importance = ctx.blocksAfter(P, 'Some of the key benefits of having a great headshot include:', 'Overall, a great headshot');
  const choose = ctx.blocksAfter(P, 'Here are some tips to help you choose the right headshot photographer:', 'By considering these factors');
  const steps = ctx.blocksAfter(P, 'This is how it works:', 'PORTFOLIO').map((b) => b.text.replace(/^\d+\.\s*/, ''));
  const faqRaw = ctx.blocksAfter(P, 'FAQs', 'Frequently Asked Questions (FAQs)');
  const faqs = [];
  for (let i = 0; i + 1 < faqRaw.length; i += 2) faqs.push({ q: faqRaw[i].text.replace(/^\d+\.\s*/, ''), a: `<p>${faqRaw[i + 1].html}</p>` });
  const eduQs = [
    'What is headshot photography?',
    'Who is a headshot photographer?',
    'Do you need a photographer for headshots?',
    'What is the pricing or package for corporate Headshot photography?',
  ];
  for (const q of eduQs) {
    const a = ctx.blocksUntilHeading(P, q);
    if (a.length) faqs.push({ q, a: a.map((b) => `<p>${b.html}</p>`).join('') });
  }
  const trail = [[P, 'Headshot photographer Bangalore']];
  const body = `
<section class="hero">
  ${img(hero, { cls: 'hero-bg', eager: true, sizes: '100vw', alt: '' })}
  <div class="wrap">
    ${crumbs(trail).replace('class="crumbs"', 'class="crumbs" style="color:#cfc7bb"')}
    <span class="eyebrow">Corporate &amp; LinkedIn headshots · Studio or on-site</span>
    <h1>Headshot Photographer in Bangalore</h1>
    <p class="lede">Rule the game with a great professional portrait headshot. Clean, confident portraits for LinkedIn, founders and teams, at our Bangalore studio or at your office.</p>
    <ul class="badges"><li>2-day delivery</li><li>No watermarks</li><li>Poses assisted</li><li>Comfort prioritised</li><li>Wardrobe guidance</li><li>Expression coaching</li></ul>
    <div class="actions">
      <a class="btn btn-light" href="${waLink('professional headshots')}" rel="noopener">${waIcon} Book a headshot session</a>
      <a class="btn btn-ghost" href="#pricing">Pricing ₹5,899</a>
    </div>
  </div>
</section>

<section class="section" id="why"><div class="wrap split">
  <div>
    <p class="wwh-label">Why</p>
    <h2>Your first impression online matters</h2>
    <p>We provide high-quality, professional headshot photography services that help individuals and businesses to create a strong, positive first impression and establish credibility in their industry.</p>
    <ul class="ticks">${importance.map((b) => `<li>${b.html}</li>`).join('')}</ul>
  </div>
  <div>${img(ims[2] ?? hero)}</div>
</div></section>

<section class="section alt" id="what"><div class="wrap">
  <div class="section-head"><p class="wwh-label">What</p><h2>Headshot photograph session</h2><p>Who it's for: professionals updating their LinkedIn, founders and leadership teams, doctors, lawyers and consultants, and actors and creators.</p></div>
  <div class="split" id="pricing" style="align-items:start">
    <div class="price-card">
      <span class="eyebrow">Studio session</span>
      <div class="price">₹5,899 <small>all-inclusive, no hidden fees</small></div>
      <ul class="ticks">
        <li>All photos from the session will be given to you</li>
        <li>Pictures with grey and white backgrounds</li>
        <li>Standing and sitting poses</li>
        <li>The best 5 photos you choose will be advanced edited</li>
        <li>Delivery in 2 days</li>
        <li>Poses will be assisted, and posing help is included</li>
        <li>100% satisfaction guarantee: re-edit if needed</li>
      </ul>
      <p class="meta"><strong>Payment terms:</strong> 50% transfer to book the slot · 40% on location post the shoot · 10% to receive all the photos from us.</p>
      <a class="btn btn-primary" href="${waLink('professional headshots')}" rel="noopener">${waIcon} Check availability</a>
    </div>
    <div class="price-card" style="background:var(--paper)">
      <span class="eyebrow">Corporate &amp; team headshots</span>
      <h3>We come to your office</h3>
      <p>A portable studio setup anywhere in Bangalore, with consistent lighting and background for the whole team, so everyone matches on your website and company profiles.</p>
      <p>The pricing or packages differ upon the requirements for headshots as per the client's need. One look (one style with one set of costumes, such as a shirt and blazer) is ₹8,899. Two costumes or different looks, and on-location shoots at your premises, are customised packages.</p>
      <a class="btn btn-ghost" href="${waLink('corporate headshot photography')}" rel="noopener">Request a team quote</a>
      <p class="meta" style="margin-top:16px">Planning a team shoot? Read <a href="/blog/studio-vs-on-site-corporate-headshots">studio vs on-site corporate headshots</a>.</p>
    </div>
  </div>
</div></section>

<section class="section dark" id="how"><div class="wrap">
  <div class="section-head"><p class="wwh-label">How</p><h2>How do we go about this?</h2><p>A quick, guided session. You don't need to know how to pose.</p></div>
  <ol class="steps">${steps.map((s) => `<li><p>${esc(s)}</p></li>`).join('')}</ol>
</div></section>

<section class="section" id="portfolio"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Portfolio</span><h2>Corporate and LinkedIn headshots in Bangalore</h2></div>
  ${gallery(ctx, P, 30)}
  <ul class="chips" style="margin-top:28px">
    <li><a href="/Professional-studio-headshots">Professional studio headshots</a></li>
    <li><a href="/Headshot-linkedIn-photography">LinkedIn headshots</a></li>
    <li><a href="/Studio-corporate-portrait-photography">Studio corporate portraits</a></li>
    <li><a href="/Innosolv-Headshots">Team headshots: Innosolv</a></li>
    <li><a href="/Professional-branding-portraits">Personal branding portraits</a></li>
    <li><a href="/Portrait-headshot-photography-reviews">Headshot reviews</a></li>
  </ul>
</div></section>

<section class="section alt"><div class="wrap split">
  <div class="prose">
    <h2>How to choose the right headshot photographer</h2>
    <p>Choosing the right headshot photographer for your headshots can be critical in ensuring that you get high-quality, professional-looking images that accurately represent you or your brand. Here are some tips:</p>
    <ul>${choose.map((b) => `<li>${b.html}</li>`).join('')}</ul>
    <p>Preparing for your session? Read <a href="/blog/what-to-wear-for-a-professional-headshot">what to wear for a professional headshot</a> and our <a href="/blog/linkedin-profile-photo-guide">LinkedIn profile photo guide</a>.</p>
  </div>
  <div>${img(ims[5] ?? hero)}</div>
</div></section>

<section class="section" id="faq"><div class="wrap narrow">
  <div class="section-head"><span class="eyebrow">FAQs</span><h2>Frequently asked questions</h2></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand({ heading: 'Ready for a headshot that works for you?', text: 'Studio sessions in Bangalore from ₹5,899, or a portable studio at your office for the whole team.', topic: 'professional headshots' })}`;
  return {
    path: P,
    title: page.title,
    description: page.description,
    ogImage: ogUrl(hero),
    body,
    waTopic: 'professional headshots',
    ld: [
      breadcrumbLd(trail),
      {
        '@type': 'Service',
        '@id': abs(P) + '#service',
        name: 'Headshot photography in Bangalore',
        serviceType: 'Headshot photography',
        provider: { '@id': `${SITE.origin}/#business` },
        areaServed: { '@type': 'City', name: SITE.locality },
        offers: { '@type': 'Offer', name: 'Headshot photograph session (studio)', price: '5899', priceCurrency: 'INR', url: abs(P) },
      },
      faqLd(faqs),
    ],
  };
}

/* ---------------------------------------------------------------- FITNESS */
export function fitness(ctx) {
  const P = '/Fitness-Photography';
  const page = ctx.page(P);
  const ims = ctx.imagesOf(P);
  const hero = ctx.image('npqHvJ8') ?? ims[0];
  const n = SITE.phone;
  const steps = [
    ['Book your session', 'Choose a date and time that works for you.'],
    ['Choice of location', 'Studio, or at your gym space?'],
    ['Prep guidance', 'We can let you know some tips on what to wear, bring, and how to prep.'],
    ['Shoot day', 'You show up, we guide every pose and light every frame.'],
    ['Delivery', 'Edited photos delivered within 4–5 days.'],
  ];
  const faqs = [
    { q: 'Where do fitness photoshoots happen?', a: '<p>In our studio in Banaswadi, or at your gym anywhere in Bangalore. The studio gives high-contrast, controlled lighting. Your gym adds equipment and context your clients recognise.</p>' },
    { q: 'When should I book a fitness photoshoot?', a: '<p>If you have just come out of a fitness competition and wish to record your body condition and muscle shape, book before your body gets back to the usual normal. Weight-loss champions should also get a photoshoot to celebrate their achievement.</p>' },
    { q: 'What should I bring?', a: '<p>Plan your shoot near your peak condition, bring 2–3 solid-colour outfits, and we will guide your posing throughout. See our <a href="/blog/how-to-prepare-for-a-fitness-photoshoot">fitness photoshoot preparation guide</a>.</p>' },
    { q: 'How soon will I get my photos?', a: '<p>Edited photos are delivered within 4–5 days.</p>' },
  ];
  const trail = [[P, 'Fitness photography Bangalore']];
  const body = `
<section class="hero">
  ${img(hero, { cls: 'hero-bg', eager: true, sizes: '100vw', alt: '' })}
  <div class="wrap">
    ${crumbs(trail).replace('class="crumbs"', 'class="crumbs" style="color:#cfc7bb"')}
    <span class="eyebrow">Gym · Fitness · Bodybuilding · Transformation</span>
    <h1>Gym &amp; Fitness Photoshoot in Bangalore</h1>
    <p class="lede">Studio and on-site gym photoshoots that showcase your dedication. Whether you're a fitness coach, bodybuilder, or simply proud of your transformation, we help you capture it professionally.</p>
    <ul class="badges"><li>Studio or your gym</li><li>High-contrast lighting</li><li>Every pose guided</li><li>Hero &amp; motion shots</li></ul>
    <div class="actions">
      <a class="btn btn-light" href="${waLink('fitness photography', n)}" rel="noopener">${waIcon} Book a fitness shoot</a>
      <a class="btn btn-ghost" href="#portfolio">See the portfolio</a>
    </div>
  </div>
</section>

<section class="section" id="why"><div class="wrap split">
  <div>
    <p class="wwh-label">Why</p>
    <h2>Professional fitness photoshoot</h2>
    <p>I'm a fitness lover myself. It is inspiring and motivating to see a body transformation, a workout routine, a weight-loss success or a yoga stance. Showcasing your hard work through photography is my job.</p>
    <ul class="ticks">
      <li>Elevate your personal brand on Instagram and beyond</li>
      <li>Get images that reflect your commitment and growth</li>
      <li>Perfect for portfolio, promotions, and personal milestones</li>
    </ul>
    <h3 style="margin-top:28px">Who it's for</h3>
    <ul class="chips">
      <li><span class="chip">Personal trainers &amp; fitness coaches</span></li>
      <li><span class="chip">Bodybuilders &amp; physique athletes</span></li>
      <li><span class="chip">Body transformations &amp; weight loss</span></li>
      <li><span class="chip">Yoga instructors &amp; wellness coaches</span></li>
      <li><span class="chip">Fitness models &amp; creators</span></li>
      <li><span class="chip">Male &amp; female fitness shoots</span></li>
    </ul>
  </div>
  <div>${img(ims[3] ?? hero)}</div>
</div></section>

<section class="section alt" id="what"><div class="wrap split rev">
  <div>
    <p class="wwh-label">What</p>
    <h2>Real. Raw. Resilient. Our signature style</h2>
    <p>We create powerful, dynamic images that bring out the best in your physique and personality.</p>
    <ul class="ticks">
      <li>High-contrast lighting setups</li>
      <li>Studio and gym-based themes</li>
      <li>Hero shots and motion captures</li>
      <li>Editorial and minimalist edits</li>
    </ul>
    <p>We shoot physique and transformation shoots, gym and trainer/coach portfolios, and fitness brand content in our studio in Banaswadi or at your gym anywhere in Bangalore.</p>
  </div>
  <div>${img(ims[5] ?? hero)}</div>
</div></section>

<section class="section dark" id="how"><div class="wrap">
  <div class="section-head"><p class="wwh-label">How</p><h2>What to expect: how your fitness shoot works</h2></div>
  <ol class="steps">${steps.map(([t, d]) => `<li><strong>${esc(t)}</strong><p>${esc(d)}</p></li>`).join('')}</ol>
</div></section>

<section class="section" id="portfolio"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Portfolio</span><h2>Fitness &amp; bodybuilding photography in Bangalore</h2></div>
  ${gallery(ctx, P, 36)}
  <ul class="chips" style="margin-top:28px">
    <li><a href="/Fitness-bikini-photoshoots">Fitness bikini photoshoots</a></li>
    <li><a href="/Cult-Anniversary">Cult anniversary shoot</a></li>
    <li><a href="/Dance-photographer-bangalore">Dance photography</a></li>
    <li><a href="/Professional-branding-portraits">Personal branding portraits</a></li>
  </ul>
</div></section>

<section class="section alt" id="faq"><div class="wrap narrow">
  <div class="section-head"><span class="eyebrow">FAQs</span><h2>Fitness photoshoot questions</h2></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand({ heading: 'Show the work you put in.', text: 'Studio in Banaswadi or at your gym anywhere in Bangalore. Tell us your goal and preferred dates.', topic: 'fitness photography', number: n })}`;
  return {
    path: P,
    title: page.title,
    // The live description is ~600 characters; search engines truncate at ~155.
    description:
      'Gym, fitness and bodybuilding photoshoots in Bangalore. Got a transformation done, back from a bodybuilding contest, or hit a weight-loss goal? Get photos that show your hard work.',
    ogImage: ogUrl(hero),
    body,
    waTopic: 'fitness photography',
    waNumber: n,
    ld: [
      breadcrumbLd(trail),
      {
        '@type': 'Service',
        '@id': abs(P) + '#service',
        name: 'Gym & fitness photoshoot in Bangalore',
        serviceType: 'Fitness photography',
        provider: { '@id': `${SITE.origin}/#business` },
        areaServed: { '@type': 'City', name: SITE.locality },
      },
      faqLd(faqs),
    ],
  };
}

export { postCards };
