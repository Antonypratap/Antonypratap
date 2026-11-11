// Written copy for service and gallery pages that were photo-only on
// SmugMug. Each page targets its own search intent and links up to its main
// service page, so the pages support (rather than compete with) the main
// headshot, corporate and fitness pages.
// Package facts (price, duration, deliverables, delivery) come from
// src/packages.js, the approved source of truth. Other facts: studio in
// Banaswadi, on-site across Bangalore, Rs 8,899 corporate single look.
//
// Shape: { lede?, sections: [{ h, p: [..], list?: [..] }], faqs?: [{ q, a }] }
// (p, list and a may contain inline HTML links.)

import { PACKAGES } from '../packages.js';
const HSP = PACKAGES.headshot;

const HS = '<a href="/Headshot-photographer-bangalore">headshot photography in Bangalore</a>';
const CORP = '<a href="/Corporate-photoshoot">corporate photography</a>';
const FIT = '<a href="/Fitness-Photography">gym &amp; fitness photoshoots</a>';

export const PAGE_COPY = {
  '/Professional-studio-headshots': {
    lede: 'Clean, consistent studio headshots on grey or white backgrounds, photographed under controlled light at our studio in Banaswadi, Bangalore.',
    sections: [
      {
        h: 'Why choose a studio headshot',
        p: [
          'A studio gives full control over light and background, so every frame is sharp, evenly lit and free of distractions. It is the most dependable choice when your photo has to work everywhere: LinkedIn, company websites, speaker bios, press releases and ID badges.',
          `Our studio session is the same one described on our ${HS} page: every photo from the session, grey and white backgrounds, standing and sitting poses, posing and expression coaching, and ${HSP.deliverables}, delivered in ${HSP.delivery}.`,
        ],
      },
      {
        h: 'What to expect',
        list: [
          'A short chat about where the photo will be used',
          'Guided posing and expression, so you do not need any experience',
          'Live review as we shoot, so you can see what works',
          'Retouching that keeps you looking like you, only on your best day',
        ],
      },
    ],
    faqs: [
      { q: 'How much does a studio headshot cost?', a: `A studio headshot session is ${HSP.priceText}, all-inclusive. See <a href="/Headshot-photographer-bangalore#pricing">what is included</a>.` },
      { q: 'What should I wear?', a: 'Solid colours and well-fitted clothes, with one or two options. Read <a href="/blog/what-to-wear-for-a-professional-headshot">what to wear for a professional headshot</a>.' },
    ],
  },

  '/Headshot-linkedIn-photography': {
    lede: 'LinkedIn headshots that make people want to read your profile: confident, approachable and sharp at the small circle size LinkedIn uses.',
    sections: [
      {
        h: 'A LinkedIn photo has one job',
        p: [
          'Recruiters, clients and colleagues decide in a second or two whether to read further. A professional LinkedIn headshot gives that second the best possible impression: good light, a clean background, eye contact and a natural expression.',
          'We frame every shot so your face reads clearly inside the LinkedIn circle, and we coach expression between frames so the smile looks real rather than forced.',
        ],
      },
      {
        h: 'Studio or at your office',
        p: [
          `Book an individual session at our Banaswadi studio, or bring us to your office for the whole team with ${CORP}. Either way you get grey or white backgrounds, or a softly blurred workplace, and files sized for LinkedIn, your website and email signature.`,
        ],
      },
    ],
    faqs: [
      { q: 'How soon will I get my LinkedIn photo?', a: `Studio headshot sessions are delivered in ${HSP.delivery}.` },
      { q: 'Any tips for a better LinkedIn photo?', a: 'Read our <a href="/blog/linkedin-profile-photo-guide">LinkedIn profile photo guide</a> on framing, expression and backgrounds.' },
    ],
  },

  '/Professional-photographer-near-me': {
    sections: [
      {
        h: 'A professional photographer in Bangalore, near you',
        p: [
          'Nevervoid Photography works from a studio in HRBR Layout, Banaswadi, and travels for on-site sessions across Bangalore. We specialise in portraits: corporate and LinkedIn headshots, team photography, fitness photoshoots and personal branding.',
          `Start with our main services: ${HS}, ${CORP} and ${FIT}.`,
        ],
      },
    ],
  },

  '/Innosolv-Headshots': {
    lede: 'Team headshots for Innosolv Consultancy, Bangalore: matching outdoor portraits for every team member, photographed on-site in one session.',
    sections: [
      {
        h: 'The brief',
        p: [
          'Innosolv wanted a consistent set of profile photos for their team: the same light, framing and natural backdrop for everyone, so the team page and LinkedIn profiles look like they belong together.',
          'We photographed the team outdoors against soft greenery, with each person stepping in for a few minutes of guided posing. The result is a warm, approachable look that is still clearly professional.',
        ],
      },
      {
        h: 'Planning headshots for your team?',
        p: [
          `See how team shoots work on our ${CORP} page. We bring a portable setup to your office or a location of your choice, anywhere in Bangalore.`,
        ],
      },
    ],
  },

  '/Studio-corporate-portrait-photography': {
    lede: 'Corporate portraits made in the studio: controlled light, a seamless background and a polished, executive finish.',
    sections: [
      {
        h: 'For leadership, profiles and press',
        p: [
          'Studio corporate portraits suit founders, leadership teams and professionals who need an authoritative, consistent image for company websites, annual reports, press releases and LinkedIn.',
          'These portraits show the same person photographed in the studio and in an office setting, so you can compare the two styles before you decide.',
        ],
      },
      {
        h: 'Studio or on-site',
        p: [
          `Individuals can book a studio headshot session for ${HSP.priceText} (see ${HS}). For teams, a corporate single look is ₹8,899 and on-location shoots at your premises are customised; see ${CORP}.`,
        ],
      },
    ],
  },

  '/Corporate-event-photography-innosolv': {
    lede: 'Corporate event photography in Bangalore: an office celebration at Innosolv, covered candidly from preparations to the finished details.',
    sections: [
      {
        h: 'Covering the moments people remember',
        p: [
          'Office celebrations, launches and festivals say a lot about a company culture. We photograph them candidly: people at work on the decorations, the details, the space and the team together, without getting in the way.',
          'The images are delivered ready for internal newsletters, social media, careers pages and the company website.',
        ],
      },
      {
        h: 'Add headshots on the same day',
        p: [`Many teams combine an event with team headshots, since everyone is already in one place. See how that works on our ${CORP} page.`],
      },
    ],
  },

  '/Corporate-event-photoshoot': {
    lede: 'Portraits from a corporate event day in Bangalore: natural, outdoor profile photos of the team, taken while everyone was together.',
    sections: [
      {
        h: 'Make the most of an event day',
        p: [
          'Offsites, anniversaries and team days are the easiest time to photograph a whole team. We set up a simple outdoor or indoor station and photograph each person in a few minutes, alongside candid coverage of the day.',
          `See the full approach to team shoots on our ${CORP} page, or the matching <a href="/Innosolv-Headshots">Innosolv team headshots</a>.`,
        ],
      },
    ],
  },

  '/Office-spaces': {
    lede: 'Office and workspace photography in Bangalore: receptions, work floors and meeting areas photographed bright, straight and true to colour.',
    sections: [
      {
        h: 'Show the space people will work in',
        p: [
          'Good workspace photos help with recruitment, client confidence, coworking listings and interior design portfolios. We shoot wide, level frames that show the layout, plus detail shots of finishes, furniture and branding.',
          `For residential and commercial interiors, see <a href="/Interiors-architecture-photography">interior and architecture photography</a>. For the people who work there, see ${CORP}.`,
        ],
      },
    ],
  },

  '/Cult-Anniversary': {
    lede: 'Fitness event photography at a Cult gym anniversary in Bangalore: group classes, trainers and members in full energy.',
    sections: [
      {
        h: 'Gym and fitness studio events',
        p: [
          'Anniversaries, challenges and community classes are where a gym brand comes alive. We capture the movement, the trainers leading from the front and the crowd energy, in images ready for Instagram, posters and the website.',
          `Want individual photos for trainers or members as well? See ${FIT}, studio or on-site at your gym, with edited photos delivered within 4–5 days.`,
        ],
      },
    ],
  },

  '/Dance-photographer-bangalore': {
    lede: 'Dance photography in Bangalore for dancers, students and performers: movement, expression and costume captured at the peak of every pose.',
    sections: [
      {
        h: 'Freeze the moment the dance is about',
        p: [
          'Dance happens in fractions of a second. We time each frame for the height of a jump, the line of an arm or the turn of a skirt, and light it so costume detail and expression both come through.',
          'Sessions suit portfolios, performance posters, Arangetram memories and social media. See also <a href="/Art/Arangetram-Photography">Arangetram photography</a> and <a href="/Dance-photography">more dance photography</a>.',
        ],
      },
    ],
  },

  '/Modelling-portfolio-photography': {
    lede: 'Modelling portfolio photoshoots in Bangalore for aspiring and professional models: clean portraits, fashion looks and full-length frames agencies ask for.',
    sections: [
      {
        h: 'What a modelling portfolio needs',
        list: [
          'Clear headshots with natural makeup, from the front and three-quarter angle',
          'Full-length frames that show height and proportions',
          'A few styled fashion looks that show range',
          'Guided posing throughout, so first-timers get usable frames',
        ],
      },
      {
        h: 'Planning your shoot',
        p: [
          `Bring 2–3 outfits in solid colours and arrange your own makeup if you want a styled look. For actors and professionals, see <a href="/Portrait-photographer-bangalore">portrait photography</a> and ${HS}.`,
        ],
      },
    ],
  },

  '/Portrait-photographer-bangalore': {
    lede: 'Portrait photography in Bangalore: LinkedIn headshots, casual portraits, portfolios and matrimony portraits, in our studio or outdoors.',
    sections: [
      {
        h: 'Portraits for every purpose',
        list: [
          `<strong>Professional:</strong> LinkedIn and corporate headshots (see ${HS})`,
          '<strong>Casual and lifestyle:</strong> relaxed portraits outdoors or at home',
          '<strong>Portfolios:</strong> for models, actors and creatives',
          '<strong>Matrimony:</strong> natural, flattering portraits for profiles',
        ],
      },
      {
        h: 'How a portrait session works',
        p: [
          'We start with a short chat about where the photos will be used, plan the look and location, and guide your posing and expression throughout. You choose your favourites, and we retouch them so you look like yourself on your best day.',
        ],
      },
    ],
  },

  '/Food-photography': {
    lede: 'Food photography in Bangalore for restaurants, cafés, cloud kitchens and food brands: appetising images for menus, delivery apps and social media.',
    sections: [
      {
        h: 'Make people hungry',
        p: [
          'Great food photos sell before the first bite. We light each dish to show texture, steam and colour, style the plate and props around your brand, and shoot both hero images and the square crops delivery apps and Instagram need.',
          'Food and product brands we have worked with include Millet Amma; see our <a href="/Clients">clients</a>.',
        ],
      },
    ],
  },

  '/Newborn-Photography': {
    sections: [
      {
        h: 'Candid newborn photography at home',
        p: [
          'This is a purely candid session of your newborn and the new parents: the tiny hands, the sleepy yawns and the way you hold them. We work around feeds and naps and keep everything calm and gentle.',
          'Sessions can be at your home in Bangalore or at our studio, and pair well with <a href="/Baby-family-photoshoots">baby and family photoshoots</a> as your little one grows.',
        ],
      },
    ],
  },
};
