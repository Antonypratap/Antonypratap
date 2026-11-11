// Approved package details: the single source of truth for package facts
// shown anywhere on the site (pages, FAQs, cards, structured data, Journal).
// Owner-approved, 11 Nov 2026. Change prices or inclusions HERE only.
//
// Journal posts (Markdown) can use tokens such as {{headshot.priceText}},
// replaced at build time from this file. Unknown tokens fail the build.

export const PACKAGES = {
  headshot: {
    name: 'Headshot Studio',
    price: 5899,
    priceText: '₹5,899',
    duration: '15–20 minutes',
    durationAdj: '15–20 minute', // "a 15–20 minute session"
    retouched: 5,
    officeBackground: 2,
    totalDelivered: 7,
    outfits: 'up to 2 outfit changes',
    delivery: '2–3 days',
    location: 'Nevervoid Studio, Bengaluru',
    // Short phrases used in running text.
    deliverables: '5 professionally retouched photos, plus 2 additional photos with digitally edited office backgrounds (7 images in total)',
    deliverablesShort: '5 retouched photos + 2 additional office-background edits',
    bring: ['2 outfits', 'a grooming kit', 'tissues'],
    includes: [
      'Every photo from the session is supplied',
      '5 professionally retouched photos of your choice',
      'Plus 2 additional photos with digitally edited office backgrounds (7 professionally delivered images in total)',
      '15–20 minute session',
      'Up to 2 outfit changes, with a space to change at the studio',
      'Delivery in 2–3 days',
    ],
  },
  fitness: {
    name: 'Fitness Photography Studio',
    price: 9899,
    priceText: '₹9,899',
    duration: '1 hour',
    durationAdj: '1-hour',
    edited: 30,
    outfits: '4–5 outfit changes',
    location: 'Nevervoid Studio, Bengaluru',
    posing: "posing guidance based on your references, your coach or a friend you bring along",
    bring: ['outfits', 'gym gear or equipment to pose with', 'water spray', 'body oil', 'tissues and snacks'],
    includes: [
      '1-hour session',
      'Every photo from the session is supplied',
      'You choose your best 30 photos for professional editing',
      '4–5 outfit changes',
      "Posing guidance based on your references, your coach or a friend you bring along",
      'Studio lighting setup, with an assistant available',
    ],
  },
  christmas: {
    name: 'Christmas Photoshoot',
    price: 6899,
    priceText: '₹6,899',
    duration: '30 minutes',
    durationAdj: '30-minute',
    edited: 20,
    lastDate: '24 December',
    lastDateIso: '2026-12-24',
    location: 'Nevervoid Studio, Bengaluru',
    who: 'Kids, siblings, couples and families',
    includes: [
      '30-minute session',
      '20 edited photos',
      'All photos from your shoot',
      'An album from your shoot',
      'Christmas backdrop, Santa red hats and lights',
      'Kids, siblings, couples and families',
    ],
  },
};

// "outfits, gym gear …, and tissues and snacks"
export const listText = (items) => {
  if (items.length < 2) return items.join('');
  // Oxford comma when the last item itself contains "and" ("tissues and snacks").
  const sep = / and /.test(items.at(-1)) && items.length > 2 ? ', and ' : ' and ';
  return `${items.slice(0, -1).join(', ')}${sep}${items.at(-1)}`;
};
// Fitness kit to bring besides outfits (for "on the day" checklists).
PACKAGES.fitness.bringKit = PACKAGES.fitness.bring.filter((x) => x !== 'outfits');

// Replace {{package.field}} tokens in Markdown. Throws on unknown tokens so a
// typo can never publish a blank or stale fact.
export function fillPackageTokens(text, file = '') {
  return text.replace(/\{\{(\w+)\.(\w+)\}\}/g, (m, pkg, field) => {
    const v = PACKAGES[pkg]?.[field];
    if (v === undefined) throw new Error(`Unknown package token ${m} in ${file}`);
    return Array.isArray(v) ? listText(v) : String(v);
  });
}
