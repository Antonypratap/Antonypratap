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
// Highlighted services, in priority order: Headshots, Corporate, Fitness.
const pick = (ctx, ids, fallbackPage, n) => {
  const out = ids.map((id) => ctx.image(id)).filter(Boolean);
  for (const im of ctx.imagesOf(fallbackPage)) if (out.length < n && !out.includes(im)) out.push(im);
  return out.slice(0, n);
};
const CLIENT_LOGOS = [
  ['f45Phsp', 'Anand Diagnostic Laboratory'],
  ['MRhLfFg', 'Elior India'],
  ['nzGcRN4', 'Walkwater Talent Advisors'],
  ['F3n3nXx', 'Millet Amma'],
  ['Z22SfjF', 'Sweet Chariot'],
];
export const logoStrip = (ctx, label = 'Trusted by teams and brands including') => {
  const logos = CLIENT_LOGOS.map(([id, name]) => [ctx.image(id), name]).filter(([im]) => im);
  if (!logos.length) return '';
  return `<section class="logos"><div class="wrap"><p>${esc(label)}</p><ul>${logos
    .map(([im, name]) => `<li>${img(im, { sizes: '160px', alt: `${name} logo` })}</li>`)
    .join('')}<li class="logos-more"><a href="/Clients">and more →</a></li></ul></div></section>`;
};

function featureBlock(ctx, f) {
  const [a, b, c] = f.images;
  return `<section class="feature-x${f.tone ? ' ' + f.tone : ''}" id="${f.id}"><div class="wrap feature-grid${f.reverse ? ' rev' : ''}">
  <div class="mosaic">
    <a class="m-a" href="${href(f.link)}">${img(a, { sizes: '(max-width: 860px) 100vw, 34vw' })}</a>
    ${b ? `<a class="m-b" href="${href(f.link)}">${img(b, { sizes: '(max-width: 860px) 50vw, 17vw' })}</a>` : ''}
    ${c ? `<a class="m-c" href="${href(f.link)}">${img(c, { sizes: '(max-width: 860px) 50vw, 17vw' })}</a>` : ''}
  </div>
  <div class="feature-copy">
    <div class="feature-kicker"><span class="feature-num">${f.num}</span><span class="eyebrow">${esc(f.eyebrow)}</span></div>
    <h2>${f.title}</h2>
    <p class="feature-lede">${f.text}</p>
    <ul class="ticks">${f.bullets.map((x) => `<li>${x}</li>`).join('')}</ul>
    <dl class="facts">${f.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <div class="actions">
      <a class="btn ${f.tone === 'dark' ? 'btn-light' : 'btn-primary'}" href="${href(f.link)}">${esc(f.linkLabel)}</a>
      <a class="btn btn-ghost" href="${waLink(f.topic)}" rel="noopener">${waIcon} WhatsApp</a>
    </div>
  </div>
</div></section>`;
}

export function home(ctx) {
  const page = ctx.page('/');
  const hs = pick(ctx, ['R2Sg6fk', 'qwKzjqx', 'br92FtZ'], '/Headshot-photographer-bangalore', 3);
  const corp = pick(ctx, ['N5P4mpP', 'GX9tjxT', 'NtD7JBW'], '/Corporate-photoshoot', 3);
  const fitImgs = ctx.imagesOf('/Fitness-Photography');
  const fit = pick(ctx, ['npqHvJ8', fitImgs[3]?.id, fitImgs[5]?.id].filter(Boolean), '/Fitness-Photography', 3);
  const portrait = ctx.imagesOf('/About')[0];
  const long = ctx.blocksAfter('/', 'BEST PHOTOGRAPHY SERVICES FROM BANGALORE', 'HISTORY OF NEVERVOID PHOTOGRAPHY');
  const history = ctx.blocksAfter('/', 'HISTORY OF NEVERVOID PHOTOGRAPHY', 'Book your photography session with confidence!');
  const panel = (num, label, sub, link, im, eager) =>
    `<a class="tri" href="${href(link)}">${img(im, { sizes: '(max-width: 860px) 70vw, 20vw', eager, alt: `${label} photography by Nevervoid, Bangalore` })}<span class="tri-label"><small>${num}</small>${esc(label)}<em>${esc(sub)} →</em></span></a>`;
  const mini = (path, label, id) => {
    const im = (id && ctx.image(id)) || ctx.imagesOf(path)[0];
    return `<a class="mini" href="${href(path)}">${im ? img(im, { sizes: '(max-width: 640px) 45vw, 22vw' }) : ''}<span>${esc(label)}</span></a>`;
  };
  const body = `
<section class="hero-x">
  <div class="wrap hero-x-grid">
    <div class="hero-x-copy">
      <span class="eyebrow">Banaswadi, Bangalore · Since ${SITE.foundingYear}</span>
      <h1>Headshot, corporate &amp; fitness photographer in Bangalore</h1>
      <p class="lede">Headshots that open doors, team portraits that show your company at its best, and fitness photos that show the work. In our Banaswadi studio or on-site anywhere in the city.</p>
      <div class="actions">
        <a class="btn btn-light" href="${waLink('professional headshots')}" rel="noopener">${waIcon} Book on WhatsApp</a>
        <a class="btn btn-ghost" href="/Headshot-photographer-bangalore#pricing">Headshots from ₹5,899</a>
      </div>
      <ul class="hero-facts">
        <li><strong>${yearsSince()}+ yrs</strong>behind the camera</li>
        <li><strong>2 days</strong>headshot delivery</li>
        <li><strong>Studio + on-site</strong>anywhere in Bangalore</li>
      </ul>
    </div>
    <div class="triptych">
      ${panel('01', 'Headshots', 'LinkedIn · founders · actors', '/Headshot-photographer-bangalore', hs[0], true)}
      ${panel('02', 'Corporate', 'Teams · leadership · events', '/Corporate-photoshoot', corp[0], true)}
      ${panel('03', 'Fitness', 'Physique · coaches · gyms', '/Fitness-Photography', fit[0], true)}
    </div>
  </div>
</section>
${logoStrip(ctx)}
${featureBlock(ctx, {
  id: 'headshots',
  num: '01',
  eyebrow: 'Headshots',
  title: 'Headshots that make the right first impression',
  text: 'We provide high-quality, professional headshot photography that helps individuals and businesses create a strong, positive first impression and establish credibility in their industry.',
  bullets: [
    'For LinkedIn, founders, doctors, lawyers, consultants, actors and creators',
    'Grey and white backgrounds, standing and sitting poses',
    'Posing and expression coaching, so camera-shy is fine',
    'Every photo from the session; your best 5 advanced-edited',
  ],
  facts: [['Studio session', '₹5,899'], ['Delivery', '2 days'], ['Where', 'Banaswadi studio or on-site']],
  link: '/Headshot-photographer-bangalore',
  linkLabel: 'Headshot sessions & pricing',
  topic: 'professional headshots',
  images: hs,
})}
${featureBlock(ctx, {
  id: 'corporate',
  num: '02',
  eyebrow: 'Corporate',
  tone: 'dark',
  reverse: true,
  title: 'Your whole team, photographed to match',
  text: 'We come to your office anywhere in Bangalore with a portable studio setup. Consistent lighting and background for the whole team, so everyone matches on your website and company profiles.',
  bullets: [
    'Team headshots at your office, with minutes per person',
    'Leadership and personal branding portraits',
    'Corporate events and office celebrations',
    'Office spaces and interiors',
  ],
  facts: [['One look', '₹8,899'], ['Teams', 'Custom quote'], ['Where', 'Your office or our studio']],
  link: '/Corporate-photoshoot',
  linkLabel: 'Corporate photography',
  topic: 'corporate headshot photography',
  images: corp,
})}
${featureBlock(ctx, {
  id: 'fitness',
  num: '03',
  eyebrow: 'Fitness',
  tone: 'alt',
  title: 'Fitness photography that shows the work',
  text: "Whether you're a fitness coach, bodybuilder, or simply proud of your transformation, we help you capture it professionally, in the studio or at your gym.",
  bullets: [
    'Physique, transformation and competition shoots',
    'Trainer, coach and gym brand content',
    'High-contrast lighting, hero shots and motion captures',
    'Every pose guided, every frame lit',
  ],
  facts: [['Delivery', '4–5 days'], ['Where', 'Studio or your gym'], ['Style', 'Editorial, high-contrast']],
  link: '/Fitness-Photography',
  linkLabel: 'Fitness photoshoots',
  topic: 'fitness photography',
  images: fit,
})}

<section class="section" id="why"><div class="wrap split">
  <div>
    <span class="eyebrow">Why Nevervoid</span>
    <h2>${yearsSince()} years of making people look like their best selves.</h2>
    <p>I'm ${SITE.founder}, and I have been providing photography services since ${SITE.foundingYear}. I take my photography service very seriously. It's not just about you arriving, the shoot happening, and you leaving. It's an experience: you get ready, feel it from inside and give your best expressions, and we take care of the rest.</p>
    <ul class="ticks">
      <li>Posed and candid styles, and you're comfortable throughout</li>
      <li>Studio in Banaswadi, or on-site at your office, home or gym</li>
      <li>Edited by people, not presets</li>
    </ul>
    <p><a href="/About">About Antony Pratap →</a> · <a href="/Reviews">Client reviews →</a></p>
  </div>
  <div>${img(portrait ?? hs[1], { alt: `${SITE.founder}, founder of Nevervoid Photography, Bangalore` })}</div>
</div></section>

<section class="section dark" id="how"><div class="wrap">
  <div class="section-head"><span class="eyebrow">How it works</span><h2>From first message to final download</h2></div>
  <ol class="steps">
    <li><strong>Talk to us</strong><p>A quick chat on WhatsApp or the phone about what the photos are for.</p></li>
    <li><strong>Plan the shoot</strong><p>Studio or on-site, date and time, and guidance on what to wear and bring.</p></li>
    <li><strong>Shoot day</strong><p>We guide every pose and expression and light every frame, until you're happy.</p></li>
    <li><strong>Select &amp; deliver</strong><p>You pick your favourites, we retouch them, and you download in full resolution.</p></li>
  </ol>
</div></section>

<section class="section"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Also photographing</span><h2>Portraits, families and celebrations</h2></div>
  <div class="minis">
    ${mini('/Professional-branding-portraits', 'Personal branding')}
    ${mini('/Maternity-Photography', 'Maternity')}
    ${mini('/Newborn-Photography', 'Newborn & family')}
    ${mini('/Couple-photography', 'Couples & pre-wedding')}
    ${mini('/Candid-wedding-photography', 'Weddings')}
    ${mini('/Modelling-portfolio-photography', 'Portfolios & fashion')}
    ${mini('/Food-photography', 'Food & interiors')}
    ${mini('/Photo-editing-services', 'Photo editing')}
  </div>
  <p style="margin-top:28px"><a class="btn btn-primary" href="/services">All services</a></p>
</div></section>

<section class="section alt"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Our services</span><h2>Best photography services from Bangalore</h2></div>
  <div class="prose-cols">
    ${long.map((b) => `<p>${b.html}</p>`).join('')}
    <h3>History of Nevervoid Photography</h3>
    ${history.map((b) => `<p>${b.html}</p>`).join('')}
  </div>
</div></section>

<section class="section"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Journal</span><h2>Guides for your next photoshoot</h2></div>
  ${postCards(ctx, ctx.posts.slice(0, 3))}
</div></section>
${ctaBand({ heading: 'Book your photography session with confidence.', text: 'Headshots, your whole team, or your fitness milestone. Tell us what the photos are for and we will plan the shoot around it.' })}`;
  return {
    path: '/',
    title: page.title,
    description: page.description,
    ogImage: ogUrl(hs[0]),
    body,
    waTopic: 'professional photography services',
  };
}

/* -------------------------------------------------------------- CORPORATE */
export function corporate(ctx) {
  const P = '/Corporate-photoshoot';
  const page = ctx.page(P);
  const hero = ctx.image('N5P4mpP') ?? ctx.imagesOf(P)[0];
  const team = ctx.imagesOf('/Innosolv-Headshots');
  const studio = ctx.imagesOf(P);
  const office = ctx.imagesOf('/Office-spaces');
  const events = ctx.imagesOf('/Corporate-event-photography-innosolv');
  const branding = ctx.imagesOf('/Professional-branding-portraits');
  const offer = (path, title, text, im) =>
    `<a class="card" href="${href(path)}">${img(im, { sizes: '(max-width: 640px) 100vw, 25vw' })}<div class="card-body"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="more">View work →</div></div></a>`;
  const mixed = [];
  for (let i = 0; mixed.length < 24 && i < 30; i++)
    for (const [pg, arr] of [[P, studio], ['/Innosolv-Headshots', team]]) if (arr[i] && mixed.length < 24) mixed.push([pg, arr[i]]);
  const faqs = [
    { q: 'Can you photograph our team at our office?', a: '<p>Yes. We come to your office anywhere in Bangalore with a portable studio setup, with consistent lighting and background for the whole team, so everyone matches on your website and company profiles. People step out for a few minutes and go back to work.</p>' },
    { q: 'How much does corporate headshot photography cost?', a: "<p>The pricing differs with the requirements. One look (one style with one set of costumes, such as a shirt and blazer) is ₹8,899. Two costumes or different looks, and on-location shoots at your premises, are customised packages. Message us with the team size and location for a quote.</p>" },
    { q: 'Studio or on-site: which is better for our team?', a: '<p>Studio sessions give the most polished result and suit founders and leadership teams. On-site sessions suit larger teams and busy schedules. Read <a href="/blog/studio-vs-on-site-corporate-headshots">studio vs on-site corporate headshots</a>.</p>' },
    { q: 'Do you also photograph corporate events and offices?', a: '<p>Yes: see our <a href="/Corporate-event-photography-innosolv">corporate event photography</a> and <a href="/Office-spaces">office spaces</a> galleries.</p>' },
  ];
  const trail = [[P, 'Corporate photography']];
  const body = `
<section class="hero">
  ${img(hero, { cls: 'hero-bg hero-right', eager: true, sizes: '100vw', alt: '' })}
  <div class="wrap">
    ${crumbs(trail).replace('class="crumbs"', 'class="crumbs" style="color:#cfc7bb"')}
    <span class="eyebrow">Teams · Leadership · Events · Offices</span>
    <h1>Corporate Photoshoot in Bangalore</h1>
    <p class="lede">Team headshots with a portable studio at your office, leadership portraits, corporate events and office spaces, photographed consistently and ready for your website, LinkedIn and company profiles.</p>
    <ul class="badges"><li>Portable studio at your office</li><li>Consistent look for the whole team</li><li>Minutes per person</li><li>Studio sessions in Banaswadi</li></ul>
    <div class="actions">
      <a class="btn btn-light" href="${waLink('corporate headshot photography')}" rel="noopener">${waIcon} Request a team quote</a>
      <a class="btn btn-ghost" href="#what">What we photograph</a>
    </div>
  </div>
</section>
${logoStrip(ctx, 'Teams and brands we have photographed')}

<section class="section" id="why"><div class="wrap split">
  <div>
    <p class="wwh-label">Why</p>
    <h2>Your team is your brand</h2>
    <p>Clients, candidates and investors meet your people online before they meet them in person. A team page where everyone has a different background, crop and lighting looks unfinished; a consistent set looks like a company that pays attention.</p>
    <p>There are a few styles of corporate headshots. It can be in our studio with flattering lights and a seamless background, or in your environment, giving it a natural and professional work-environment feel. You can be in a professional suit, formal attire or even semi-formal or casual as per your choice.</p>
    <ul class="ticks">
      <li>Same lighting, background and crop for everyone</li>
      <li>Posing and expression coaching for every person</li>
      <li>Retouched, high-resolution files for web and print</li>
    </ul>
  </div>
  <div>${img(team[0] ?? hero)}</div>
</div></section>

<section class="section alt" id="what"><div class="wrap">
  <div class="section-head"><p class="wwh-label">What</p><h2>What we photograph for companies</h2></div>
  <div class="cards cards-4">
    ${offer('/Innosolv-Headshots', 'Team headshots', 'A portable studio at your office. Consistent, matching headshots for everyone.', team[3] ?? team[0])}
    ${offer('/Professional-branding-portraits', 'Leadership & branding', 'Editorial portraits for founders, speakers and leadership teams.', ctx.image('br92FtZ') ?? branding[0])}
    ${offer('/Corporate-event-photography-innosolv', 'Corporate events', 'Celebrations, launches and office events, covered candidly.', ctx.image('PHwkhfF') ?? events[0])}
    ${offer('/Office-spaces', 'Offices & interiors', 'Workspaces, receptions and interiors for your website and listings.', office[1] ?? office[0])}
  </div>
  <div class="split" style="margin-top:48px;align-items:start">
    <div class="price-card"><span class="eyebrow">Corporate headshots</span><div class="price">₹8,899 <small>one look</small></div><p>One style with one set of costumes, such as a shirt and blazer. Two costumes or different looks, team sessions and on-location shoots at your premises are customised packages.</p><a class="btn btn-primary" href="${waLink('corporate headshot photography')}" rel="noopener">${waIcon} Get a quote</a></div>
    <div class="price-card" style="background:var(--paper)"><span class="eyebrow">Individual headshots</span><div class="price">₹5,899 <small>studio session</small></div><p>Just you? Our studio headshot session includes every photo, your best 5 advanced-edited, and delivery in 2 days.</p><a class="btn btn-ghost" href="/Headshot-photographer-bangalore#pricing">Headshot sessions</a></div>
  </div>
</div></section>

<section class="section dark" id="how"><div class="wrap">
  <div class="section-head"><p class="wwh-label">How</p><h2>How a team shoot works</h2></div>
  <ol class="steps">
    <li><strong>Share the brief</strong><p>Team size, preferred dates and location, and where the photos will be used.</p></li>
    <li><strong>Agree the look</strong><p>Dress code, background (grey, white or your office) and crop, so everyone matches.</p></li>
    <li><strong>Shoot day</strong><p>We set up a portable studio. Each person steps in for a few minutes, with posing and expression guidance.</p></li>
    <li><strong>Select &amp; deliver</strong><p>Everyone picks their favourites; we retouch and deliver consistent, high-resolution files.</p></li>
  </ol>
</div></section>

<section class="section" id="portfolio"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Portfolio</span><h2>Corporate headshots and portraits in Bangalore</h2></div>
  <div class="gallery">${mixed.map(([pg, im]) => `<a href="${href(ctx.imagePageOf(pg, im.id) ?? pg)}">${img(im, { sizes: '(max-width: 640px) 100vw, 33vw' })}</a>`).join('')}</div>
  <ul class="chips" style="margin-top:28px">
    <li><a href="/Innosolv-Headshots">Team headshots: Innosolv</a></li>
    <li><a href="/Studio-corporate-portrait-photography">Studio corporate portraits</a></li>
    <li><a href="/Corporate-event-photography-innosolv">Corporate event photography</a></li>
    <li><a href="/Corporate-event-photoshoot">Corporate event photoshoot</a></li>
    <li><a href="/Office-spaces">Office spaces</a></li>
    <li><a href="/Clients">Clients</a></li>
  </ul>
</div></section>

<section class="section alt" id="faq"><div class="wrap narrow">
  <div class="section-head"><span class="eyebrow">FAQs</span><h2>Corporate photography questions</h2></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand({ heading: 'Planning headshots for your team?', text: 'Tell us the team size, dates and location, and we will suggest the right setup.', topic: 'corporate headshot photography' })}`;
  return {
    path: P,
    title: page.title,
    description: 'Corporate photographer in Bangalore: on-site team headshots with a portable studio, leadership portraits, corporate events and office photography. One look from ₹8,899.',
    ogImage: ogUrl(hero),
    body,
    waTopic: 'corporate headshot photography',
    ld: [
      breadcrumbLd(trail),
      { '@type': 'Service', '@id': abs(P) + '#service', name: 'Corporate photography in Bangalore', serviceType: 'Corporate headshot and event photography', provider: { '@id': `${SITE.origin}/#business` }, areaServed: { '@type': 'City', name: SITE.locality }, offers: { '@type': 'Offer', name: 'Corporate headshot, one look', price: '8899', priceCurrency: 'INR', url: abs(P) } },
      faqLd(faqs),
    ],
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

<section class="section-tight"><div class="wrap"><a class="teaser" href="/Corporate-photoshoot">${img(ctx.image('GX9tjxT') ?? ctx.imagesOf('/Innosolv-Headshots')[0], { sizes: '(max-width: 760px) 100vw, 40vw' })}<span><span class="eyebrow">Corporate</span><strong>Photographing a whole team?</strong>We bring a portable studio to your office, with matching lighting and backgrounds for everyone. See corporate photography →</span></a></div></section>
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
