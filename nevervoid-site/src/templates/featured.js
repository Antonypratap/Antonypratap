// Hand-designed Why / What / How pages. Copy is taken from the live pages
// (data/pages.json) so the ranking content survives; layout is new.
import { SITE, waLink } from '../config.js';
import { yearsSince } from '../content-fixes.js';
import { PACKAGES, listText } from '../packages.js';
const HS_PKG = PACKAGES.headshot;
const FIT_PKG = PACKAGES.fitness;
const XM_PKG = PACKAGES.christmas;
const XM_ADD = XM_PKG.addon;
import { iconLinks, bookBtn, reserveAction, ogUrl, imgUrl as imgUrlOf, imgAbs as imgAbsOf, esc, img, href, ctaBand, faqHtml, faqLd, waIcon, crumbs, breadcrumbLd, abs } from '../lib.js';

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
      ${f.book ? bookBtn(f.book, f.tone === 'dark' ? 'btn-light' : 'btn-primary') : ''}
      <a class="btn ${f.book ? 'btn-ghost' : f.tone === 'dark' ? 'btn-light' : 'btn-primary'}" href="${href(f.link)}">${esc(f.linkLabel)}</a>
      ${iconLinks({ topic: f.topic, phone: false, email: false, cls: f.tone === 'dark' ? 'on-dark' : '' })}
    </div>
  </div>
</div></section>`;
}

// Direct answers about the business (homepage "About Nevervoid" section and
// its FAQPage data). Facts only from the site's verified business details.
const ABOUT_QA = [
  ['What is Nevervoid Photography?', `Nevervoid Photography is a Bangalore-based photography studio specialising in professional headshots, corporate team photography and fitness photography. It was founded in ${SITE.foundingYear} by ${SITE.founder}, who has ${yearsSince()}+ years of photography experience.`],
  ['Where is Nevervoid located?', `The studio is in Banaswadi, Bangalore (${esc(SITE.streetAddress)}, ${SITE.locality} ${SITE.postalCode}). We also photograph on location at offices and gyms across Bangalore.`],
  ['Does Nevervoid offer LinkedIn headshots in Bangalore?', `Yes. Professional headshots for LinkedIn, founders, executives and personal branding, with studio sessions from ${HS_PKG.priceText}. See <a href="/Headshot-photographer-bangalore">headshot photography in Bangalore</a>.`],
  ['Does Nevervoid photograph corporate teams at offices?', 'Yes. We bring a portable studio setup to your office for team and employee headshots and leadership portraits, so the whole team matches. See <a href="/Corporate-photoshoot">corporate photography</a>.'],
  ['Does Nevervoid offer fitness photography?', `Yes. Fitness photography for personal trainers, athletes and bodybuilders, including physique shoots and fitness portfolios, with a studio package at ${FIT_PKG.priceText}. See <a href="/Fitness-Photography">fitness photography</a>.`],
  ['How do I enquire or book?', `Book a headshot or fitness session online, or message us on <a href="${waLink('a photoshoot')}" rel="noopener">WhatsApp</a> or call ${SITE.phoneDisplay}. All options are on the <a href="/contact">contact page</a>.`],
];

// Seasonal campaign block on the homepage, linking to the Christmas landing
// page. Styles are scoped to .xmas-promo.
function christmasPromo(ctx) {
  const im = ctx.image('Gh9BHdv') ?? ctx.imagesOf('/Christmas-theme-photoshoots')[0];
  if (!im) return '';
  return `<section class="xmas-promo" aria-labelledby="xmas-promo-h"><div class="wrap xmas-promo-grid">
  <div class="xmas-promo-img">${img(im, { sizes: '(max-width: 860px) 100vw, 40vw' })}</div>
  <div class="xmas-promo-copy">
    <span class="eyebrow">Christmas portraits at Nevervoid</span>
    <h2 id="xmas-promo-h">Make this Christmas a memory worth keeping.</h2>
    <p>Celebrate the season with beautiful Christmas portraits. Bring your family, your partner or your little ones for a festive photography experience at Nevervoid.</p>
    <div class="actions"><a class="btn btn-xmas" href="/christmas-photoshoot-bangalore">Explore Christmas Sessions →</a></div>
    <p class="xmas-promo-note">Limited seasonal sessions. Enquire for availability.</p>
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
      <p class="lede">Nevervoid Photography is a Bangalore-based photography studio specialising in professional headshots, corporate team photography and fitness photography. In our Banaswadi studio or on location anywhere in the city.</p>
      <div class="actions">
        <a class="btn btn-light" href="/contact">Book a session</a>
        <a class="btn btn-ghost" href="/Headshot-photographer-bangalore#pricing">Headshots from ${HS_PKG.priceText}</a>
      </div>
      <ul class="hero-facts">
        <li><strong>${yearsSince()}+ yrs</strong>behind the camera</li>
        <li><strong>${HS_PKG.delivery}</strong>headshot delivery</li>
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
${christmasPromo(ctx)}
${logoStrip(ctx)}
${featureBlock(ctx, {
  id: 'headshots',
  num: '01',
  eyebrow: 'Headshots',
  title: 'Headshots that make the right first impression',
  text: 'Professional headshots for LinkedIn profiles, company websites, speaker bios and personal branding. Photographed in our Banaswadi studio, or on location at your office.',
  bullets: [
    'For founders, entrepreneurs, executives and working professionals, plus doctors, lawyers, consultants, actors and creators',
    'Grey and white backgrounds, standing and sitting poses',
    'Posing and expression coaching, so camera-shy is fine',
    `Every photo from the session; ${HS_PKG.deliverablesShort}`,
  ],
  facts: [['Studio session', HS_PKG.priceText], ['Delivery', HS_PKG.delivery], ['Where', HS_PKG.location]],
  link: '/Headshot-photographer-bangalore',
  linkLabel: 'Sessions & pricing',
  book: 'headshots',
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
  text: 'Corporate team headshots and employee photography at your office anywhere in Bangalore, with a portable studio setup. Consistent lighting and background for the whole team, so everyone matches on your company website and professional profiles.',
  bullets: [
    'Team and employee headshots at your office, with minutes per person',
    'Leadership and executive portraits',
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
  text: "Fitness photography for personal trainers, coaches, athletes and bodybuilders, and for anyone proud of a transformation. Photographed in our studio or at your gym.",
  bullets: [
    'Bodybuilding, physique, transformation and competition shoots',
    'Fitness portfolios and personal branding for trainers, coaches and gyms',
    'High-contrast lighting, hero shots and motion captures',
    `${FIT_PKG.edited} professionally edited photos of your choice, with ${FIT_PKG.posing}`,
  ],
  facts: [['Studio session', FIT_PKG.priceText], ['Session', FIT_PKG.duration], ['Edited photos', String(FIT_PKG.edited)]],
  link: '/Fitness-Photography',
  linkLabel: 'Fitness photoshoots',
  book: 'fitness',
  topic: 'fitness photography',
  images: fit,
})}

<section class="section" id="why"><div class="wrap split">
  <div>
    <span class="eyebrow">Why Nevervoid</span>
    <h2>${yearsSince()} years of making people look like their best selves.</h2>
    <p>I'm ${SITE.founder}, the founder of Nevervoid Photography, and I have been providing photography services since ${SITE.foundingYear}. Over ${yearsSince()}+ years, that experience has shaped the studio's three specialisations: professional headshots, corporate team photography and fitness photography. I take my photography service very seriously. It's not just about you arriving, the shoot happening, and you leaving. It's an experience: you get ready, feel it from inside and give your best expressions, and we take care of the rest.</p>
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
  <div class="section-head"><span class="eyebrow">Also photographing</span><h2>Portraits, families and celebrations</h2><p>Alongside our three specialisations, we also photograph these sessions.</p></div>
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
  <div class="section-head"><span class="eyebrow">About Nevervoid</span><h2>Best photography services from Bangalore</h2></div>
  <div class="prose-cols">
    ${ABOUT_QA.map(([q, a]) => `<h3>${esc(q)}</h3><p>${a}</p>`).join('')}
    ${long.filter((b) => /^(Corporate headshot|Fitness photography)/.test(b.text ?? b.html.replace(/<[^>]+>/g, ''))).map((b) => `<p>${b.html}</p>`).join('')}
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
    ld: [
      {
        '@type': ['LocalBusiness', 'ProfessionalService'],
        '@id': `${SITE.origin}/#business`,
        description: 'Nevervoid Photography is a Bangalore-based photography studio specialising in professional headshots, corporate team photography and fitness photography.',
        knowsAbout: ['Professional headshots', 'LinkedIn headshots', 'Corporate team photography', 'Leadership portraits', 'Fitness photography', 'Bodybuilding and physique photography'],
        hasOfferCatalog: {
          '@type': 'OfferCatalog',
          name: 'Photography specialisations',
          itemListElement: [
            { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Professional headshots', url: abs('/Headshot-photographer-bangalore') }, price: String(HS_PKG.price), priceCurrency: 'INR' },
            { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Corporate team photography', url: abs('/Corporate-photoshoot') } },
            { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Fitness photography', url: abs('/Fitness-Photography') }, price: String(FIT_PKG.price), priceCurrency: 'INR' },
          ],
        },
      },
      faqLd(ABOUT_QA.map(([q, a]) => ({ q, a: `<p>${a}</p>` }))),
    ],
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
    <div class="price-card" style="background:var(--paper)"><span class="eyebrow">Individual headshots</span><div class="price">${HS_PKG.priceText} <small>studio session</small></div><p>Just you? Our studio headshot session includes every photo, ${HS_PKG.deliverables}, and delivery in ${HS_PKG.delivery}.</p><div class="actions" style="margin-top:8px">${bookBtn('headshots', 'btn-primary')}<a class="btn btn-ghost" href="/Headshot-photographer-bangalore#pricing">Headshot sessions</a></div></div>
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

/* --------------------------------------------------------------- BRANDING */
export function branding(ctx) {
  const P = '/Professional-branding-portraits';
  const page = ctx.page(P);
  const ims = ctx.imagesOf(P);
  const byId = (id) => ctx.image(id);
  const hero = byId('NQ9cP7g') ?? ims[0];
  const who = [
    ['Founders & entrepreneurs', 'Portraits that make your company story personal, for your website, pitch decks and press.', byId('zHjSFg8')],
    ['Speakers & thought leaders', 'Stage-ready images for event listings, speaker profiles and conference promotions.', byId('ngdHTRh')],
    ['Executives & leaders', 'Executive presence for annual reports, leadership pages and LinkedIn.', byId('NQ9cP7g')],
    ['Authors & writers', 'Author photos for book jackets, publisher pages and media kits.', byId('4KMSkfZ')],
    ['Consultants & coaches', 'Approachable, confident portraits that help clients choose you.', byId('mwWw2D8')],
    ['Women in leadership', 'Portraits that carry authority and warmth in equal measure.', byId('6CbCQg2')],
  ].filter(([, , im]) => im);
  const faqs = [
    { q: 'What is personal branding photography?', a: '<p>Personal branding photography is a planned set of portraits that tells people who you are, what you do and why they should work with you. Unlike a single profile photo, it gives you a consistent library of images for LinkedIn, your website, social media, speaker profiles, publications and marketing.</p>' },
    { q: 'How is it different from a headshot?', a: '<p>A <a href="/Headshot-photographer-bangalore">professional headshot</a> is one clean, head-and-shoulders image for your profile. A personal branding shoot goes further: more looks, poses and settings, and images designed around your message, so you have the right photo for every place your brand appears.</p>' },
    { q: 'Who is personal branding photography for?', a: '<p>Founders, entrepreneurs, executives, consultants, coaches, speakers, authors and other professionals in Bangalore who are the face of their work and want to be seen consistently online and in print.</p>' },
    { q: 'Where does the shoot take place?', a: '<p>At our studio in Banaswadi, Bangalore, or on location: your office, workspace or a setting that suits your story. We plan this together before the shoot.</p>' },
    { q: 'What should I wear?', a: '<p>Outfits that match how your audience knows you, usually two or three looks from formal to smart casual, in solid colours. We give wardrobe guidance before the shoot; see also <a href="/blog/what-to-wear-for-a-professional-headshot">what to wear for a professional photoshoot</a>.</p>' },
    { q: 'How much does a personal branding shoot cost?', a: '<p>Each shoot is planned around your brief: the number of looks, locations and visual assets you need. Message us on WhatsApp with what the images are for and we will send a quote.</p>' },
  ];
  const trail = [[P, 'Personal branding photography']];
  const body = `
<section class="hero hero-dim">
  ${img(hero, { cls: 'hero-bg hero-right', eager: true, sizes: '100vw', alt: '' })}
  <div class="wrap">
    ${crumbs(trail).replace('class="crumbs"', 'class="crumbs" style="color:#cfc7bb"')}
    <span class="eyebrow">Founders · Executives · Speakers · Authors · Consultants</span>
    <h1>Personal Branding Photography in Bangalore</h1>
    <p class="lede">Authentic portraits and visual assets for founders, entrepreneurs, executives, consultants and professionals, created for LinkedIn, websites, social media, speaking and publications.</p>
    <ul class="badges"><li>Planned around your brand</li><li>Multiple looks &amp; settings</li><li>Posing &amp; expression coaching</li><li>Studio or on location</li></ul>
    <div class="actions">
      <a class="btn btn-light" href="${waLink('personal branding photography')}" rel="noopener">${waIcon} Plan your branding shoot</a>
      <a class="btn btn-ghost" href="#portfolio">See the portfolio</a>
    </div>
  </div>
</section>

<section class="section" id="why"><div class="wrap split">
  <div>
    <p class="wwh-label">Why</p>
    <h2>People buy from people they can see</h2>
    <p>Before anyone books a call, reads your book or invites you to speak, they look you up. The images they find decide whether you come across as credible, approachable and established, or as one more profile among many.</p>
    <p>Personal branding photography gives you a consistent set of portraits that carry your message everywhere you appear: your LinkedIn profile and banner, your website's About page, speaker bios, press features, book covers and social posts. One coherent look, instead of a mix of cropped holiday photos and old event shots.</p>
    <ul class="ticks">
      <li><strong>Credibility:</strong> professional images signal that you take your work seriously</li>
      <li><strong>Recognition:</strong> the same look across platforms makes you memorable</li>
      <li><strong>Connection:</strong> natural expressions make you approachable before the first meeting</li>
      <li><strong>Ready content:</strong> a library of images for months of posts, pages and press</li>
    </ul>
  </div>
  <div>${img(byId('zHjSFg8') ?? ims[1] ?? hero)}</div>
</div></section>

<section class="section alt" id="who"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Who it's for</span><h2>Personal branding portraits for professionals in Bangalore</h2><p>Every brief is different. These are the people we photograph most often, and what the images do for them.</p></div>
  <div class="cards">${who
    .map(([t, d, im]) => `<div class="card">${img(im, { sizes: '(max-width: 640px) 100vw, 33vw' })}<div class="card-body"><h3>${esc(t)}</h3><p>${esc(d)}</p></div></div>`)
    .join('')}</div>
</div></section>

<section class="section" id="what"><div class="wrap">
  <div class="section-head"><p class="wwh-label">What</p><h2>What a personal branding shoot includes</h2></div>
  <div class="split" style="align-items:start">
    <div>
      <h3>Portraits with intent</h3>
      <p>Every frame is planned around how you want to be seen: confident and authoritative, warm and approachable, creative and bold. We direct posture, expression and styling so the images feel like you on your best day.</p>
      <ul class="ticks">
        <li>Multiple looks, from formal to smart casual</li>
        <li>Close portraits, half-length and full-length frames</li>
        <li>Studio backdrops or your own workspace and city settings</li>
        <li>Posing and expression coaching throughout</li>
      </ul>
    </div>
    <div>
      <h3>Visual assets for your brand</h3>
      <p>Beyond the portraits, we create magazine-cover style visuals that pair your image with your positioning, as you can see in the portfolio below. They are ready to use as LinkedIn banners, speaker cards, social posts and website features.</p>
      <ul class="ticks">
        <li>Professionally retouched, high-resolution images</li>
        <li>Crops for LinkedIn, websites and social media</li>
        <li>Branded visual layouts around your message</li>
      </ul>
    </div>
  </div>
  <div class="table-wrap" style="margin-top:48px">
    <table class="compare">
      <caption>Headshot or personal branding shoot?</caption>
      <thead><tr><th></th><th>Professional headshot</th><th>Personal branding shoot</th></tr></thead>
      <tbody>
        <tr><th>Best for</th><td>A clean profile photo for LinkedIn and company pages</td><td>A full image library for your website, social media, speaking and press</td></tr>
        <tr><th>Looks</th><td>Up to 2 outfit changes</td><td>Several looks, poses and settings</td></tr>
        <tr><th>Output</th><td>${HS_PKG.deliverablesShort} (${HS_PKG.totalDelivered} images)</td><td>A set of portraits plus designed visual assets</td></tr>
        <tr><th>Pricing</th><td>${HS_PKG.priceText} studio session, delivered in ${HS_PKG.delivery}</td><td>Planned around your brief: message us for a quote</td></tr>
        <tr><th></th><td><a href="/Headshot-photographer-bangalore">Headshot sessions →</a></td><td><a href="${waLink('personal branding photography')}" rel="noopener">Plan a branding shoot →</a></td></tr>
      </tbody>
    </table>
  </div>
</div></section>

<section class="section dark" id="how"><div class="wrap">
  <div class="section-head"><p class="wwh-label">How</p><h2>How a personal branding shoot works</h2></div>
  <ol class="steps">
    <li><strong>Brand conversation</strong><p>We talk about what you do, who your audience is and where the images will be used.</p></li>
    <li><strong>Plan the shoot</strong><p>Looks, wardrobe, props and setting: our studio in Banaswadi or a location that tells your story.</p></li>
    <li><strong>Shoot day</strong><p>A relaxed, guided session. We coach posture and expression so you look natural, not posed.</p></li>
    <li><strong>Select &amp; retouch</strong><p>You choose your favourites and we retouch them to a polished, consistent finish.</p></li>
    <li><strong>Visual assets</strong><p>We design branded layouts around your portraits, ready for LinkedIn, your website and social media.</p></li>
  </ol>
</div></section>

<section class="section" id="portfolio"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Portfolio</span><h2>Personal branding portraits by Nevervoid, Bangalore</h2></div>
  <div class="gallery">${ims.map((im) => `<a href="${href(ctx.imagePageOf(P, im.id) ?? P)}">${img(im, { sizes: '(max-width: 640px) 100vw, 33vw' })}</a>`).join('')}</div>
  <ul class="chips" style="margin-top:28px">
    <li><a href="/Headshot-photographer-bangalore">Headshot photographer Bangalore</a></li>
    <li><a href="/Corporate-photoshoot">Corporate &amp; team photography</a></li>
    <li><a href="/Portrait-photographer-bangalore">Portrait photographer</a></li>
    <li><a href="/Modelling-portfolio-photography">Modelling portfolios</a></li>
    <li><a href="/blog/linkedin-profile-photo-guide">LinkedIn profile photo guide</a></li>
  </ul>
</div></section>

<section class="section alt" id="faq"><div class="wrap narrow">
  <div class="section-head"><span class="eyebrow">FAQs</span><h2>Personal branding photography questions</h2></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand({ heading: 'Build a brand people recognise.', text: 'Tell us what you do and where the images will be used. We will plan a shoot around your story.', topic: 'personal branding photography' })}`;
  return {
    path: P,
    title: page.title,
    description: page.description,
    ogImage: ogUrl(hero),
    body,
    waTopic: 'personal branding photography',
    ld: [
      breadcrumbLd(trail),
      { '@type': 'Service', '@id': abs(P) + '#service', name: 'Personal branding photography in Bangalore', serviceType: 'Personal branding photography', provider: { '@id': `${SITE.origin}/#business` }, areaServed: { '@type': 'City', name: SITE.locality } },
      faqLd(faqs),
    ],
  };
}

/* ---------------------------------------------------------- FEMALE FITNESS */
// URL kept as /Fitness-bikini-photoshoots (indexed); the owner's wording is
// "female fitness", which is what the page now says everywhere.
export function femaleFitness(ctx) {
  const P = '/Fitness-bikini-photoshoots';
  const page = ctx.page(P);
  const ims = ctx.imagesOf(P);
  const byId = (id) => ctx.image(id);
  const hero = byId('5chvhzC') ?? ims[0];
  const faqs = [
    { q: 'Where do female fitness photoshoots take place?', a: '<p>In our studio in Banaswadi, Bangalore, or at your own gym anywhere in the city. The studio gives clean, controlled lighting; your gym adds the equipment and setting your clients and followers recognise.</p>' },
    { q: 'When is the best time to book?', a: '<p>Plan the shoot near your peak condition, after a competition prep, a transformation or a training block, before your body settles back to normal. For brand and content shoots, choose a week when your training and sleep are consistent.</p>' },
    { q: 'How much does a female fitness photoshoot cost?', a: `<p>Our ${FIT_PKG.name} package is ${FIT_PKG.priceText} for a ${FIT_PKG.durationAdj} session at ${FIT_PKG.location}: every photo from the session, your best ${FIT_PKG.edited} professionally edited, and ${FIT_PKG.outfits}. <a href="/Fitness-Photography#package">See the full package</a>.</p>` },
    { q: 'What should I wear?', a: '<p>Bring 4–5 outfits for your outfit changes: sports bras and crop tops, shorts or leggings, and one coordinated set if you have it. Avoid busy prints and large logos. See our <a href="/blog/how-to-prepare-for-a-fitness-photoshoot">fitness photoshoot preparation guide</a>.</p>' },
    { q: 'I have never done a photoshoot. Will I know how to pose?', a: `<p>You do not need any experience. You get ${FIT_PKG.posing} throughout the session, and you can see the photos as we shoot.</p>` },
    { q: 'Do you provide hair and makeup?', a: '<p>We do not provide makeup and styling at the moment. If you would like it, book a makeup artist for the morning of your shoot.</p>' },
    { q: 'How soon will I get my photos?', a: '<p>Edited photos are delivered within 4–5 days.</p>' },
  ];
  const trail = [['/Fitness-Photography', 'Fitness photography'], [P, 'Female fitness photoshoot']];
  const gal = (list) => list.map((im) => `<a href="${href(ctx.imagePageOf(P, im.id) ?? P)}">${img(im, { sizes: '(max-width: 640px) 100vw, 33vw' })}</a>`).join('');
  const body = `
<section class="hero">
  ${img(hero, { cls: 'hero-bg', eager: true, sizes: '(max-width: 860px) 100vw, 54vw', alt: '' })}
  <div class="wrap">
    ${crumbs(trail).replace('class="crumbs"', 'class="crumbs" style="color:#cfc7bb"')}
    <span class="eyebrow">Women's fitness · Gym · Studio · Transformation</span>
    <h1>Female Fitness Photoshoot in Bangalore</h1>
    <p class="lede">Strong, confident photos of your training and your progress, shot in our Banaswadi studio or at your gym. For athletes, coaches, trainers and every woman proud of the work she has put in.</p>
    <ul class="badges"><li>${FIT_PKG.priceText} studio session</li><li>Posing guidance</li><li>Black &amp; white or colour</li><li>Delivered in 4–5 days</li></ul>
    <div class="actions">
      ${bookBtn('fitness', 'btn-light', 'Book your shoot')}
      <a class="btn btn-ghost" href="#portfolio">See the portfolio</a>
      ${iconLinks({ topic: 'female fitness photoshoot', email: false, cls: 'on-dark' })}
    </div>
  </div>
</section>

<section class="section" id="why"><div class="wrap split">
  <div>
    <p class="wwh-label">Why</p>
    <h2>Your strength deserves better than a mirror selfie</h2>
    <p>Months of training, early mornings and discipline show in how you move and how you carry yourself. A professional fitness photoshoot captures that properly, with lighting that shows muscle definition and poses that show strength rather than strain.</p>
    <p>Whether you are marking a transformation, building your profile as a coach or trainer, or creating content for your fitness brand, you get photos you will be proud to share for years.</p>
    <ul class="ticks">
      <li>Celebrate a transformation, weight-loss milestone or competition prep</li>
      <li>Build your personal brand as a trainer, coach or instructor</li>
      <li>Fresh, professional content for Instagram, your website and promotions</li>
    </ul>
  </div>
  <div>${img(byId('q5TwjNn') ?? ims[1] ?? hero)}</div>
</div></section>

<section class="section alt" id="who"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Who it's for</span><h2>Women's fitness photography for every kind of strong</h2></div>
  <div class="cards cards-4">
    <div class="card">${img(byId('bzmvxbW') ?? ims[2])}<div class="card-body"><h3>Athletes &amp; lifters</h3><p>Strength, form and physique: squats, pulls and presses captured at their best.</p></div></div>
    <div class="card">${img(byId('jbwXNhK') ?? ims[3])}<div class="card-body"><h3>Trainers &amp; coaches</h3><p>Brand photos that show clients who will be training them.</p></div></div>
    <div class="card">${img(byId('zVvqqRz') ?? ims[4])}<div class="card-body"><h3>Transformations</h3><p>Mark the result of months of work before life gets in the way.</p></div></div>
    <div class="card">${img(byId('6hZNRSV') ?? ims[5])}<div class="card-body"><h3>Yoga, pilates &amp; wellness</h3><p>Calm, strong portraits for instructors and wellness professionals.</p></div></div>
  </div>
</div></section>

<section class="section" id="what"><div class="wrap split rev">
  <div>
    <p class="wwh-label">What</p>
    <h2>What your shoot includes</h2>
    <p>We create powerful, dynamic images that bring out the best in your physique and personality, in our signature high-contrast style or in colour.</p>
    <ul class="ticks">
      <li>Studio or gym-based themes, with high-contrast lighting setups</li>
      <li>Training shots with real equipment: cables, barbells, dumbbells, battle ropes</li>
      <li>Hero portraits and motion captures</li>
      <li>Editorial and minimalist edits, delivered within 4–5 days</li>
      <li>${FIT_PKG.priceText} studio package: a ${FIT_PKG.durationAdj} session, every photo supplied, your best ${FIT_PKG.edited} professionally edited, ${FIT_PKG.outfits}</li>
    </ul>
    <p>Looking for men's or mixed fitness shoots? See <a href="/Fitness-Photography">gym &amp; fitness photography in Bangalore</a>.</p>
  </div>
  <div>${img(byId('CDLF4c6') ?? ims[6] ?? hero)}</div>
</div></section>

<section class="section alt" id="plan"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Planning your shoot</span><h2>How to prepare for a female fitness photoshoot</h2><p>A little preparation makes a big difference on the day. Here is what we recommend to every client.</p></div>
  <div class="cards cards-4 plan-cards">
    <div class="card"><div class="card-body"><h3>1. Time it well</h3><p>Book near your peak condition, after a prep, a transformation or a strong training block. Any diet or water changes should be planned with your own coach.</p></div></div>
    <div class="card"><div class="card-body"><h3>2. Outfits</h3><p>4–5 outfits for your outfit changes: sports bras or crop tops with shorts or leggings, plus one coordinated set. Skip busy prints and big logos.</p></div></div>
    <div class="card"><div class="card-body"><h3>3. Hair, skin &amp; makeup</h3><p>Moisturise in the days before. Makeup and styling are not included, so book a makeup artist if you want a polished look.</p></div></div>
    <div class="card"><div class="card-body"><h3>4. On the day</h3><p>Bring ${listText(FIT_PKG.bringKit)}. A light warm-up just before shooting brings out definition. We plan the key shots for while you are warm.</p></div></div>
  </div>
</div></section>

<section class="section dark" id="how"><div class="wrap">
  <div class="section-head"><p class="wwh-label">How</p><h2>How your shoot works</h2></div>
  <ol class="steps">
    <li><strong>Book your session</strong><p>Choose a date and time that works for you.</p></li>
    <li><strong>Choose the location</strong><p>Our studio in Banaswadi, or your own gym anywhere in Bangalore.</p></li>
    <li><strong>Prep guidance</strong><p>Tips on what to wear, bring and how to prepare.</p></li>
    <li><strong>Shoot day</strong><p>A ${FIT_PKG.durationAdj} session with ${FIT_PKG.posing}, under a studio lighting setup.</p></li>
    <li><strong>Delivery</strong><p>Edited photos delivered within 4–5 days.</p></li>
  </ol>
</div></section>

<section class="section" id="portfolio"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Portfolio</span><h2>Female fitness photography in Bangalore</h2></div>
  <div class="gallery">${gal(ims)}</div>
  <ul class="chips" style="margin-top:28px">
    <li><a href="/Fitness-Photography">Gym &amp; fitness photography</a></li>
    <li><a href="/Cult-Anniversary">Cult anniversary shoot</a></li>
    <li><a href="/Dance-photographer-bangalore">Dance photography</a></li>
    <li><a href="/Professional-branding-portraits">Personal branding portraits</a></li>
    <li><a href="/blog/how-to-prepare-for-a-fitness-photoshoot">Fitness photoshoot preparation guide</a></li>
  </ul>
</div></section>

<section class="section alt" id="faq"><div class="wrap narrow">
  <div class="section-head"><span class="eyebrow">FAQs</span><h2>Female fitness photoshoot questions</h2></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand({ heading: 'Show the strength you have built.', text: 'Tell us your goal and preferred dates. Studio in Banaswadi, or at your gym anywhere in Bangalore.', topic: 'female fitness photoshoot', book: 'fitness' })}`;
  return {
    path: P,
    title: page.title,
    description: "Female fitness photoshoots in Bangalore for athletes, trainers, coaches and transformations. Studio in Banaswadi or at your gym. Guided posing, delivered in 4–5 days.",
    ogImage: ogUrl(hero),
    body,
    waTopic: 'female fitness photoshoot',
    ld: [
      breadcrumbLd(trail),
      { '@type': 'Service', '@id': abs(P) + '#service', name: 'Female fitness photoshoot in Bangalore', serviceType: "Women's fitness photography", ...reserveAction('fitness'), offers: { '@type': 'Offer', name: FIT_PKG.name, price: String(FIT_PKG.price), priceCurrency: 'INR', url: abs('/Fitness-Photography') }, provider: { '@id': `${SITE.origin}/#business` }, areaServed: { '@type': 'City', name: SITE.locality } },
      { '@type': 'ImageGallery', name: 'Female fitness photography in Bangalore', url: abs(P), image: ims.map((im) => ({ '@type': 'ImageObject', contentUrl: imgAbsOf(im), name: im.alt, creator: { '@id': `${SITE.origin}/#business` } })) },
      faqLd(faqs),
    ],
  };
}

/* ---------------------------------------------------------------- CLIENTS */
export function clients(ctx) {
  const P = '/Clients';
  const page = ctx.page(P);
  const logos = CLIENT_LOGOS.map(([id, name]) => [ctx.image(id), name]).filter(([im]) => im);
  const work = [
    ['Innosolv', 'Team headshots', 'Matching outdoor headshots for the Innosolv team, photographed on-site.', '/Innosolv-Headshots', ctx.image('GX9tjxT')],
    ['Innosolv', 'Corporate event', 'Candid coverage of an office celebration at Innosolv, Bangalore.', '/Corporate-event-photography-innosolv', ctx.image('PHwkhfF')],
    ['Walkwater Talent Advisors', 'Founder portrait', "Executive portrait of Harold D'Souza, founder of Walkwater Talent Advisors.", '/Headshot-photographer-bangalore', ctx.image('br92FtZ')],
    ['Elior India', 'Corporate headshot', 'Business headshot for a professional at Elior India, ready for brand and recruitment use.', '/Headshot-photographer-bangalore', ctx.image('HDsq6mp')],
  ].filter((w) => w[4]);
  const trail = [[P, 'Clients']];
  const body = `
<section class="page-hero"><div class="wrap">
  ${crumbs(trail)}
  <span class="eyebrow">Clients</span>
  <h1>Clients we are proud to work with</h1>
  <p class="lede">${esc(page.description)}</p>
</div></section>

<section class="section-tight"><div class="wrap">
  <ul class="logo-wall" aria-label="Client logos">
    ${logos.map(([im, name]) => `<li>${img(im, { sizes: '200px', alt: `${name} logo` })}<span>${esc(name)}</span></li>`).join('')}
    <li class="logo-wall-cta"><a href="/Corporate-photoshoot"><strong>Your team next?</strong>Corporate photography →</a></li>
  </ul>
</div></section>

<section class="section alt"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Selected client work</span><h2>Headshots, teams and events for Bangalore companies</h2></div>
  <div class="cards cards-4">${work
    .map(([client, kind, text, link, im]) => `<a class="card" href="${href(link)}">${img(im, { sizes: '(max-width: 640px) 100vw, 25vw' })}<div class="card-body"><span class="eyebrow" style="margin-bottom:6px">${esc(kind)}</span><h3>${esc(client)}</h3><p>${esc(text)}</p></div></a>`)
    .join('')}</div>
</div></section>
${ctaBand({ heading: 'Photography your company can rely on.', text: 'Team headshots, leadership portraits, events and offices, anywhere in Bangalore.', topic: 'corporate headshot photography' })}`;
  return {
    path: P,
    title: page.title,
    description: page.description,
    ogImage: ogUrl(work[0]?.[4]),
    body,
    waTopic: 'corporate headshot photography',
    ld: [breadcrumbLd(trail), { '@type': 'CollectionPage', name: 'Nevervoid Photography clients', url: abs(P), about: { '@id': `${SITE.origin}/#business` } }],
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
    <ul class="badges"><li>Delivery in ${HS_PKG.delivery}</li><li>No watermarks</li><li>Poses assisted</li><li>Comfort prioritised</li><li>Wardrobe guidance</li><li>Expression coaching</li></ul>
    <div class="actions">
      ${bookBtn('headshots', 'btn-light', 'Book a headshot session')}
      <a class="btn btn-ghost" href="#pricing">Pricing ${HS_PKG.priceText}</a>
      ${iconLinks({ topic: 'professional headshots', email: false, cls: 'on-dark' })}
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
      <span class="eyebrow">${HS_PKG.name} · ${HS_PKG.location}</span>
      <div class="price">${HS_PKG.priceText} <small>all-inclusive, no hidden fees</small></div>
      <ul class="ticks">
        ${HS_PKG.includes.map((x) => `<li>${x}</li>`).join('')}
        <li>Pictures with grey and white backgrounds</li>
        <li>Standing and sitting poses</li>
        <li>Poses will be assisted, and posing help is included</li>
        <li>100% satisfaction guarantee: re-edit if needed</li>
      </ul>
      <p class="meta"><strong>Bring:</strong> ${listText(HS_PKG.bring)}.</p>
      <p class="meta"><strong>Payment terms:</strong> 50% transfer to book the slot · 40% on location post the shoot · 10% to receive all the photos from us.</p>
      <div class="actions" style="margin-top:8px">${bookBtn('headshots', 'btn-primary', 'Book your session')}${iconLinks({ topic: 'professional headshots', email: false })}</div>
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
${ctaBand({ heading: 'Ready for a headshot that works for you?', text: `Studio sessions in Bangalore from ${HS_PKG.priceText}, or a portable studio at your office for the whole team.`, topic: 'professional headshots', book: 'headshots' })}`;
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
        offers: { '@type': 'Offer', name: HS_PKG.name, description: `${HS_PKG.durationAdj} studio session at ${HS_PKG.location}: every photo supplied, ${HS_PKG.deliverables}, ${HS_PKG.outfits}, delivered in ${HS_PKG.delivery}.`, price: String(HS_PKG.price), priceCurrency: 'INR', url: abs(P) },
        ...reserveAction('headshots'),
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
    ['Shoot day', `A ${FIT_PKG.durationAdj} session with ${FIT_PKG.posing}, under a studio lighting setup.`],
    ['Delivery', 'Edited photos delivered within 4–5 days.'],
  ];
  const faqs = [
    { q: 'How much does a fitness photoshoot cost?', a: `<p>The ${FIT_PKG.name} package is ${FIT_PKG.priceText} for a ${FIT_PKG.durationAdj} session at ${FIT_PKG.location}. Every photo from the session is supplied, and you choose your best ${FIT_PKG.edited} for professional editing, with ${FIT_PKG.outfits}. <a href="#package">See what is included</a>.</p>` },
    { q: 'Where do fitness photoshoots happen?', a: '<p>In our studio in Banaswadi, or at your gym anywhere in Bangalore. The studio gives high-contrast, controlled lighting. Your gym adds equipment and context your clients recognise.</p>' },
    { q: 'When should I book a fitness photoshoot?', a: '<p>If you have just come out of a fitness competition and wish to record your body condition and muscle shape, book before your body gets back to the usual normal. Weight-loss champions should also get a photoshoot to celebrate their achievement.</p>' },
    { q: 'What should I bring?', a: `<p>Plan your shoot near your peak condition and bring ${listText(FIT_PKG.bring)}, with outfits for ${FIT_PKG.outfits}. You get ${FIT_PKG.posing}. See our <a href="/blog/how-to-prepare-for-a-fitness-photoshoot">fitness photoshoot preparation guide</a>.</p>` },
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
    <ul class="badges"><li>${FIT_PKG.priceText} studio session</li><li>High-contrast lighting</li><li>Posing guidance</li><li>Hero &amp; motion shots</li></ul>
    <div class="actions">
      ${bookBtn('fitness', 'btn-light', 'Book a fitness shoot')}
      <a class="btn btn-ghost" href="#portfolio">See the portfolio</a>
      ${iconLinks({ topic: 'fitness photography', number: n, email: false, cls: 'on-dark' })}
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

<section class="section" id="package"><div class="wrap split" style="align-items:start">
  <div class="price-card">
    <span class="eyebrow">${FIT_PKG.name} · ${FIT_PKG.location}</span>
    <div class="price">${FIT_PKG.priceText} <small>${FIT_PKG.durationAdj} studio session</small></div>
    <ul class="ticks">${FIT_PKG.includes.map((x) => `<li>${x}</li>`).join('')}</ul>
    <div class="actions" style="margin-top:8px">${bookBtn('fitness', 'btn-primary', 'Book your session')}${iconLinks({ topic: 'fitness photography', number: n, email: false })}</div>
  </div>
  <div class="price-card" style="background:var(--paper)">
    <span class="eyebrow">What to bring</span>
    <ul class="ticks">${FIT_PKG.bring.map((x) => `<li>${x[0].toUpperCase() + x.slice(1)}</li>`).join('')}</ul>
    <p class="meta">Preparing? Read <a href="/blog/how-to-prepare-for-a-fitness-photoshoot">how to prepare for a fitness photoshoot</a>.</p>
  </div>
</div></section>

<section class="section dark" id="how"><div class="wrap">
  <div class="section-head"><p class="wwh-label">How</p><h2>What to expect: how your fitness shoot works</h2></div>
  <ol class="steps">${steps.map(([t, d]) => `<li><strong>${esc(t)}</strong><p>${esc(d)}</p></li>`).join('')}</ol>
</div></section>

<section class="section" id="portfolio"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Portfolio</span><h2>Fitness &amp; bodybuilding photography in Bangalore</h2></div>
  ${gallery(ctx, P, 36)}
  <ul class="chips" style="margin-top:28px">
    <li><a href="/Fitness-bikini-photoshoots">Female fitness photoshoots</a></li>
    <li><a href="/Cult-Anniversary">Cult anniversary shoot</a></li>
    <li><a href="/Dance-photographer-bangalore">Dance photography</a></li>
    <li><a href="/Professional-branding-portraits">Personal branding portraits</a></li>
  </ul>
</div></section>

<section class="section alt" id="faq"><div class="wrap narrow">
  <div class="section-head"><span class="eyebrow">FAQs</span><h2>Fitness photoshoot questions</h2></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand({ heading: 'Show the work you put in.', text: 'Studio in Banaswadi or at your gym anywhere in Bangalore. Tell us your goal and preferred dates.', topic: 'fitness photography', number: n, book: 'fitness' })}`;
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
        ...reserveAction('fitness'),
        offers: { '@type': 'Offer', name: FIT_PKG.name, description: `${FIT_PKG.durationAdj} studio session at ${FIT_PKG.location}: every photo supplied, best ${FIT_PKG.edited} professionally edited, ${FIT_PKG.outfits}.`, price: String(FIT_PKG.price), priceCurrency: 'INR', url: abs(P) },
        provider: { '@id': `${SITE.origin}/#business` },
        areaServed: { '@type': 'City', name: SITE.locality },
      },
      faqLd(faqs),
    ],
  };
}

export { postCards };

/* -------------------------------------------------------------- CHRISTMAS */
// Christmas photos supplied by the owner (Nov 2026), self-hosted in
// public/img/christmas/ at 400/800/1200 px, all 2:3. '@id' entries reuse
// existing gallery photos; true marks a large tile.
const XMAS_PHOTOS = [
  ['mother-two-daughters-santa-hats', 'Mother and two daughters in red with Santa hats, family Christmas photoshoot in Bangalore', true],
  ['mother-daughter-christmas-hug', 'Mother in red hugging her daughter in a Santa hat beside the Christmas tree'],
  ['girl-elf-hat-christmas-gift', 'Girl in a green elf hat holding a Christmas gift by the tree'],
  ['sisters-santa-hats-presents', 'Two sisters in Santa hats holding wrapped presents by the Christmas tree'],
  ['parents-kiss-daughter-christmas', 'Parents kissing their daughter on the cheeks beside the Christmas tree'],
  ['@Gh9BHdv'],
  ['couple-santa-hats-christmas-tree', 'Couple in Santa hats smiling in front of the Christmas tree, couple Christmas photoshoot'],
  ['sisters-christmas-lights', 'Two sisters in red sweaters and Santa hats in front of Christmas lights'],
  ['@t26PDgX'],
  ['family-christmas-portrait-red-tshirts', 'Smiling family of three in matching red t-shirts, Christmas family portrait in a Bangalore studio', true],
  ['girl-santa-hat-christmas-gifts', 'Girl in a red shawl and Santa hat placing gifts by the Christmas tree'],
  ['@BtpmQdr'],
  ['family-of-three-christmas-tree', 'Family of three in red t-shirts beside the Christmas tree'],
  ['@8x7Lwrg'],
  ['woman-red-dress-christmas-celebration', 'Woman in a red dress and Santa hat celebrating by the Christmas tree'],
  ['@4wzwMkR'],
  ['woman-decorating-christmas-tree', 'Woman in a red t-shirt hanging an ornament on the Christmas tree'],
  ['woman-peeking-christmas-tree', 'Woman in a Santa hat peeking out from behind the Christmas tree'],
  ['santa-hat-portrait-bokeh', 'Close-up portrait of a woman in a knitted Santa hat with warm bokeh lights'],
  ['woman-red-dress-christmas-wave', 'Woman in a red dress waving beside the Christmas tree'],
  ['woman-santa-hat-seated-gifts', 'Woman in a red dress and Santa hat seated beside Christmas gifts'],
  ['woman-santa-hat-christmas-gifts', 'Woman in a Santa hat holding gifts beside the lit Christmas tree'],
];

// Christmas products from NevervoidStore (the sister shop), shown on the
// Christmas page. Images are self-hosted copies in public/img/store/.
const STORE = 'https://nevervoidstore.com';
const STORE_UTM = 'utm_source=nevervoid&utm_medium=referral&utm_campaign=christmas';
const storeLink = (path) => `${STORE}/${path}${path.includes('?') ? '&' : '?'}${STORE_UTM}`;
const STORE_XMAS = [
  ['initials/', 'christmas-initial-mug', 'Christmas Initial Mugs', 'Their first letter in a Santa hat. Pick a letter A to Z.'],
  ['products/tis-the-season-mug.html', 'tis-the-season-mug', 'Tis the Season Mug', 'A watercolour reindeer under a winter moon.'],
  ['cases/', 'christmas-phone-case', 'Christmas Phone Cases', '55 festive glass cases, made for your exact phone.'],
  ['products/dear-santa-i-can-explain-mug.html', 'dear-santa-i-can-explain-mug', 'Dear Santa, I Can Explain Mug', 'A guilty golden pup tangled in Christmas lights.'],
  ['products/dear-santa-it-wasnt-me-mug.html', 'dear-santa-it-wasnt-me-mug', "Dear Santa, It Wasn't Me Mug", 'A cheeky pup in a Santa hat, very obviously guilty.'],
  ['send-a-wish-custom-mug/', 'send-a-wish-mug', 'Send a Wish Mug', 'Your own Christmas wish and name on a mug.'],
];
const storeSection = () => `<section class="section alt xmas-store" id="gifts"><div class="wrap">
  <div class="section-head"><span class="eyebrow">From NevervoidStore</span><h2>Christmas gifts from our sister store</h2><p>Made-to-order Christmas mugs and phone cases from <a href="${storeLink('')}" rel="noopener" target="_blank">NevervoidStore</a>, also by Nevervoid. Delivered across Karnataka.</p></div>
  <ul class="store-grid">${STORE_XMAS.map(([path, file, name, text]) => `<li><a href="${storeLink(path)}" rel="noopener" target="_blank"><span class="store-img"><img src="/img/store/${file}-600.webp" srcset="/img/store/${file}-300.webp 300w, /img/store/${file}-600.webp 600w" sizes="(max-width: 640px) 50vw, 16vw" width="600" height="600" alt="${esc(name)} from NevervoidStore" loading="lazy" decoding="async"></span><span class="store-body"><strong>${esc(name)}</strong><span>${esc(text)}</span><em>Shop now ↗</em></span></a></li>`).join('')}</ul>
  <p class="store-more"><a class="btn btn-xmas" href="${storeLink('')}" rel="noopener" target="_blank">Shop all Christmas gifts ↗</a></p>
</div></section>
`;

// Seasonal landing page. Festive styling is scoped to .xmas so no other page
// changes. No price or dates are stated (none approved); visitors are sent
// to WhatsApp to pick a date. Package facts come from src/packages.js.
export function christmas(ctx) {
  const P = '/christmas-photoshoot-bangalore';
  const G = '/Christmas-theme-photoshoots';
  const ims = ctx.imagesOf(G);
  const byId = (id) => ctx.image(id);
  const hero = byId('Gh9BHdv') ?? ims[0];
  const topic = 'a Christmas photoshoot';
  const faqs = [
    { q: 'Where does the Christmas photoshoot take place?', a: `<p>At our studio, ${esc(SITE.studioName)}, in Banaswadi, Bangalore. The Christmas backdrop, tree and lights are all set up there, so you just walk in and start.</p>` },
    { q: 'What should we wear?', a: '<p>Come in full red, full green or full white. Everyone can wear the same colour, or mix the three. Plain fabrics photograph best, so avoid big logos and busy prints.</p>' },
    { q: 'Do we need to bring Santa hats or props?', a: '<p>No. We have Santa red hats for everyone and the full Christmas set. Bring a favourite toy or ornament if you would like it in the photos.</p>' },
    { q: 'Who can be in the photos?', a: `<p>${XM_PKG.who}. We photograph individual portraits and group photos in the same session.</p>` },
    { q: 'How much does a Christmas photoshoot cost?', a: `<p>${XM_PKG.priceText} for a ${XM_PKG.durationAdj} session. You get ${XM_PKG.edited} edited photos, all the photos from your shoot and an album from your shoot.</p>` },
    { q: 'Can we get a photo from the shoot printed on a mug?', a: `<p>Yes. Add the ${XM_ADD.name.toLowerCase()} to your session for ${XM_ADD.priceText} (usually ${XM_ADD.wasText}). We print a photo from your Christmas shoot on a mug.</p>` },
    { q: 'Until when can we book?', a: `<p>Christmas sessions run until ${XM_PKG.lastDate}. Message us on <a href="${waLink(topic)}" rel="noopener">WhatsApp</a> or call ${SITE.phoneDisplay} to pick your date.</p>` },
  ];
  const trail = [['/services', 'Services'], [P, 'Christmas photoshoot']];
  const local = (f, w) => `/img/christmas/christmas-${f}-${w}.webp`;
  const gal = XMAS_PHOTOS.map(([f, alt, big]) => {
    if (f.startsWith('@')) {
      const im = byId(f.slice(1));
      if (!im) return '';
      return `<a class="xg" href="${href(ctx.imagePageOf(G, im.id) ?? G)}" data-full="${imgUrlOf(im)}" data-alt="${esc(im.alt)}">${img(im, { sizes: '(max-width: 640px) 50vw, 25vw' })}</a>`;
    }
    return `<a class="xg${big ? ' xg-big' : ''}" href="${local(f, 1200)}" data-full="${local(f, 1200)}" data-alt="${esc(alt)}"><img src="${local(f, 800)}" srcset="${local(f, 400)} 400w, ${local(f, 800)} 800w, ${local(f, 1200)} 1200w" sizes="${big ? '(max-width: 640px) 100vw, 50vw' : '(max-width: 640px) 50vw, 25vw'}" width="1200" height="1800" alt="${esc(alt)}" loading="lazy" decoding="async"></a>`;
  }).join('');
  const galLd = XMAS_PHOTOS.map(([f, alt]) => {
    if (f.startsWith('@')) { const im = byId(f.slice(1)); return im && { contentUrl: imgAbsOf(im), name: im.alt }; }
    return { contentUrl: abs(local(f, 1200)), name: alt };
  }).filter(Boolean);
  const body = `<div class="xmas">
<section class="hero xmas-hero">
  ${img(hero, { cls: 'hero-bg', eager: true, sizes: '(max-width: 860px) 100vw, 54vw', alt: '' })}
  <div class="xmas-lights" aria-hidden="true"></div>
  <div class="wrap">
    ${crumbs(trail).replace('class="crumbs"', 'class="crumbs" style="color:#d9cfc0"')}
    <span class="eyebrow">Christmas · Family · Kids · Couples</span>
    <h1>Christmas Photoshoot in Bangalore</h1>
    <p class="lede">Festive portraits of you and your family in our Banaswadi studio. We have the Christmas backdrop, the Santa hats and the lights. All you have to do is come in full red, green or white.</p>
    <ul class="badges"><li>${XM_PKG.priceText} · ${XM_PKG.duration}</li><li>${XM_PKG.edited} edited photos + album</li><li>Santa red hats &amp; lights</li><li>Until ${XM_PKG.lastDate}</li></ul>
    <div class="actions">
      <a class="btn btn-xmas" href="${waLink(topic)}" rel="noopener">${waIcon} Book on WhatsApp</a>
      <a class="btn btn-ghost" href="#portfolio">See the photos</a>
      ${iconLinks({ topic, whatsapp: false, email: false, map: true, cls: 'on-dark' })}
    </div>
  </div>
</section>

<section class="section" id="why"><div class="wrap split">
  <div>
    <p class="wwh-label">Why</p>
    <h2>A family portrait you will bring out every December</h2>
    <p>Christmas photos on a phone rarely capture the moment: the light is flat, someone is always missing, and the background is the living room. A studio session gives you warm, glowing portraits with everyone in the frame.</p>
    <ul class="ticks">
      <li>Holiday cards, WhatsApp greetings and family albums</li>
      <li>A yearly tradition to watch the kids grow</li>
      <li>Framed prints for grandparents and family abroad</li>
    </ul>
  </div>
  <div>${img(byId('t26PDgX') ?? ims[1] ?? hero)}</div>
</div></section>

<section class="section alt" id="what"><div class="wrap">
  <div class="section-head"><p class="wwh-label">What</p><h2>We set the scene. You bring the smiles.</h2><p>Everything Christmas is ready in the studio before you arrive.</p></div>
  <div class="xmas-props">
    <div><span class="xmas-icon" aria-hidden="true">🎄</span><h3>Christmas backdrop</h3><p>A decorated tree, stars and stockings, set against a warm studio backdrop.</p></div>
    <div><span class="xmas-icon" aria-hidden="true">🎅</span><h3>Santa red hats</h3><p>Hats for everyone, from the smallest kid to the grandparents.</p></div>
    <div><span class="xmas-icon" aria-hidden="true">✨</span><h3>Lights</h3><p>Strings of warm fairy lights and studio lighting for that soft festive glow.</p></div>
    <div><span class="xmas-icon" aria-hidden="true">📸</span><h3>Festive portraits</h3><p>Family groups, couples and individual portraits of each child.</p></div>
  </div>
</div></section>

<section class="section" id="package"><div class="wrap split" style="align-items:start">
  <div class="price-card xmas-price">
    <span class="eyebrow">${XM_PKG.name} · ${XM_PKG.location}</span>
    <div class="price">${XM_PKG.priceText} <small>${XM_PKG.durationAdj} session</small></div>
    <ul class="ticks">${XM_PKG.includes.map((x) => `<li>${x}</li>`).join('')}</ul>
    <p class="xmas-addon-line"><span class="addon-tag">Add-on</span> ${XM_ADD.name} <strong>${XM_ADD.priceText}</strong> <s>${XM_ADD.wasText}</s></p>
    <p class="xmas-deadline">Sessions until ${XM_PKG.lastDate}. Pick your date.</p>
    <div class="actions" style="margin-top:8px"><a class="btn btn-xmas" href="${waLink(topic)}" rel="noopener">${waIcon} Pick your date</a>${iconLinks({ topic, whatsapp: false, email: false })}</div>
  </div>
  <div>
    <span class="eyebrow">The package</span>
    <h2>Festive portraits, ready to share and keep</h2>
    <p>One ${XM_PKG.durationAdj} studio session for ${XM_PKG.who.toLowerCase()}. You take home every photo from the shoot, ${XM_PKG.edited} of them fully edited, and an album to keep.</p>
    <p>Slots fill up in the weeks before Christmas, and sessions run only until ${XM_PKG.lastDate}, so book early.</p>
    <div class="xmas-addon" id="photo-mug">
      <img src="/img/christmas/family-photo-christmas-mug-600.webp" srcset="/img/christmas/family-photo-christmas-mug-300.webp 300w, /img/christmas/family-photo-christmas-mug-600.webp 600w, /img/christmas/family-photo-christmas-mug-1200.webp 1200w" sizes="(max-width: 640px) 40vw, 200px" width="1200" height="1200" alt="White mug printed with a family photo from a Nevervoid Christmas photoshoot" loading="lazy" decoding="async">
      <div>
        <span class="addon-tag">Add-on</span>
        <h3>Your Christmas photo on a mug</h3>
        <p>${XM_ADD.text}. A keepsake for the family, or a gift for grandparents.</p>
        <p class="addon-price"><strong>${XM_ADD.priceText}</strong> <s>${XM_ADD.wasText}</s> <span>with your Christmas session</span></p>
      </div>
    </div>
  </div>
</div></section>

<section class="section alt" id="wear"><div class="wrap">
  <div class="section-head"><span class="eyebrow">What to wear</span><h2>Come in full red, green or white</h2><p>One colour, head to toe. Everyone in the same colour, or mix the three, and the photos look festive straight away.</p></div>
  <ul class="xmas-swatches">
    <li class="sw-red"><strong>Full red</strong><span>The classic Santa look. Red dresses, shirts and sweaters.</span></li>
    <li class="sw-green"><strong>Full green</strong><span>Rich and warm against the tree and lights.</span></li>
    <li class="sw-white"><strong>Full white</strong><span>Soft and snowy, beautiful for babies and families.</span></li>
  </ul>
  <p class="xmas-note">Plain fabrics photograph best. Skip big logos and busy prints.</p>
</div></section>

<section class="section dark xmas-dark" id="how"><div class="wrap">
  <div class="section-head"><p class="wwh-label">How</p><h2>How your Christmas photoshoot works</h2></div>
  <ol class="steps">
    <li><strong>Pick your date</strong><p>Message us on WhatsApp. Sessions run until ${XM_PKG.lastDate}.</p></li>
    <li><strong>Dress in red, green or white</strong><p>Full red, full green or full white. Mix them across the family if you like.</p></li>
    <li><strong>Come to the studio</strong><p>The backdrop, Santa hats and lights are ready at our Banaswadi studio.</p></li>
    <li><strong>We light and shoot</strong><p>We use the lights to make warm, festive portraits of you and your family.</p></li>
    <li><strong>Your festive portraits</strong><p>All your photos, ${XM_PKG.edited} edited, and an album from your shoot.</p></li>
  </ol>
</div></section>

<section class="section" id="portfolio"><div class="wrap">
  <div class="section-head"><span class="eyebrow">Portfolio</span><h2>Christmas portraits from our studio</h2><p>Families, kids, siblings, couples and solo portraits, all photographed on our Christmas set in Banaswadi.</p></div>
  <div class="xmas-grid">${gal}</div>
  <dialog class="xlb" aria-label="Photo viewer"><button class="xlb-x" type="button" aria-label="Close">×</button><button class="xlb-p" type="button" aria-label="Previous photo">‹</button><button class="xlb-n" type="button" aria-label="Next photo">›</button></dialog>
  <script>(()=>{const d=document.querySelector('.xlb');if(!d||!d.showModal)return;const a=[...document.querySelectorAll('.xmas-grid .xg')],im=d.insertBefore(document.createElement('img'),d.firstChild);let i=0;const show=(k)=>{i=(k+a.length)%a.length;im.src=a[i].dataset.full;im.alt=a[i].dataset.alt};a.forEach((el,k)=>el.addEventListener('click',(e)=>{e.preventDefault();show(k);d.showModal()}));d.querySelector('.xlb-x').onclick=()=>d.close();d.querySelector('.xlb-p').onclick=()=>show(i-1);d.querySelector('.xlb-n').onclick=()=>show(i+1);d.addEventListener('click',(e)=>{if(e.target===d)d.close()});d.addEventListener('keydown',(e)=>{if(e.key==='ArrowLeft')show(i-1);if(e.key==='ArrowRight')show(i+1)});let x=null;d.addEventListener('touchstart',(e)=>{x=e.touches[0].clientX},{passive:true});d.addEventListener('touchend',(e)=>{if(x===null)return;const dx=e.changedTouches[0].clientX-x;x=null;if(Math.abs(dx)>50)show(dx>0?i-1:i+1)},{passive:true})})()</script>
  <ul class="chips" style="margin-top:28px">
    <li><a href="${G}">Christmas theme gallery</a></li>
    <li><a href="/Family-photography-studio-bangalore">Family photography studio</a></li>
    <li><a href="/Diwali-theme-photoshoot">Diwali theme photoshoot</a></li>
    <li><a href="/Baby-photography">Baby photography</a></li>
  </ul>
</div></section>

${storeSection()}
<section class="section" id="faq"><div class="wrap narrow">
  <div class="section-head"><span class="eyebrow">FAQs</span><h2>Christmas photoshoot questions</h2></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand({ heading: 'Make this Christmas one to remember.', text: `${XM_PKG.priceText} for a ${XM_PKG.durationAdj} session, ${XM_PKG.edited} edited photos and an album. Sessions until ${XM_PKG.lastDate}: pick your date.`, topic })}
</div>`;
  return {
    path: P,
    title: 'Christmas Photoshoot in Bangalore | Festive Family Portraits - Nevervoid Photography',
    description: `Christmas photoshoot in Bangalore: ${XM_PKG.priceText} for 30 minutes, ${XM_PKG.edited} edited photos, all photos and an album. Santa hats, backdrop and lights. Until ${XM_PKG.lastDate}.`,
    ogImage: ogUrl(hero),
    body,
    waTopic: topic,
    ld: [
      breadcrumbLd(trail),
      { '@type': 'Service', '@id': abs(P) + '#service', name: 'Christmas photoshoot in Bangalore', serviceType: 'Christmas family photography', description: 'Festive studio portraits for families and kids, with a Christmas backdrop, Santa hats and lights.', offers: { '@type': 'Offer', name: XM_PKG.name, price: String(XM_PKG.price), priceCurrency: 'INR', priceValidUntil: XM_PKG.lastDateIso, url: abs(P), description: XM_PKG.includes.slice(0, 4).join(', '), addOn: { '@type': 'Offer', name: XM_ADD.name, price: String(XM_ADD.price), priceCurrency: 'INR', priceValidUntil: XM_PKG.lastDateIso, description: XM_ADD.text } }, provider: { '@id': `${SITE.origin}/#business` }, areaServed: { '@type': 'City', name: SITE.locality } },
      { '@type': 'ImageGallery', name: 'Christmas photoshoots in Bangalore', url: abs(P), image: galLd.map((x) => ({ '@type': 'ImageObject', ...x, creator: { '@id': `${SITE.origin}/#business` } })) },
      faqLd(faqs),
    ],
  };
}
