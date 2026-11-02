// Business facts used across the site. Everything here was taken from the
// live nevervoid.com pages; anything not found there is left null rather than
// guessed. Confirm the TODOs before launch.
export const SITE = {
  name: 'Nevervoid Photography',
  shortName: 'Nevervoid',
  origin: 'https://www.nevervoid.com',
  founder: 'Antony Pratap',
  foundingYear: 2008,
  email: 'contact@nevervoid.com',
  // The live site uses two WhatsApp numbers: the first on the homepage and
  // headshot links, the second on the fitness page. Kept as-is.
  // TODO(owner): confirm both numbers are current.
  whatsapp: { main: '919880000990', fitness: '919632492092' },
  locality: 'Bengaluru',
  localityAlt: 'Bangalore',
  region: 'Karnataka',
  country: 'IN',
  // TODO(owner): add the studio street address and postcode if you want them
  // public. Google Business Profile ranking benefits from a consistent NAP.
  streetAddress: null,
  postalCode: null,
  sameAs: [], // filled from data/site-links.json (links found on the live site)
  defaultOgImage:
    'https://photos.smugmug.com/photos/i-LPQ9Jzq/0/MJjrc2RbDnBBvRMRVw6gjgM6S9B7SWCchB6Sx9CZH/L/i-LPQ9Jzq-L.png',
};

export const waLink = (topic, number = SITE.whatsapp.main) =>
  `https://wa.me/${number}?text=${encodeURIComponent(`Hi, I’m interested in ${topic} in Bangalore`)}`;
