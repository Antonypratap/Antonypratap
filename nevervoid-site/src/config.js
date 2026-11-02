// Business facts used across the site. Everything here was taken from the
// live nevervoid.com pages; anything not found there is left null rather than
// guessed.
export const SITE = {
  name: 'Nevervoid Photography',
  shortName: 'Nevervoid',
  origin: 'https://www.nevervoid.com',
  founder: 'Antony Pratap',
  foundingYear: 2008,
  email: 'contact@nevervoid.com',
  // One number for calls and WhatsApp everywhere (owner, 2 Nov 2026).
  phone: '919880000990',
  phoneDisplay: '+91 98800 00990',
  locality: 'Bengaluru',
  localityAlt: 'Bangalore',
  region: 'Karnataka',
  country: 'IN',
  // Keep this identical to the Google Business Profile (name, address, phone).
  studioName: 'Nevervoid photography creative studio',
  streetAddress: 'No 54, ground floor, 10th A Main, 100 Feet Rd, HRBR Layout 1st Block, Balaji Layout, Subbaiahnapalya, Banaswadi',
  postalCode: '560043',
  sameAs: [], // filled from data/site-links.json (links found on the live site)
  defaultOgImage:
    'https://photos.smugmug.com/photos/i-LPQ9Jzq/0/MJjrc2RbDnBBvRMRVw6gjgM6S9B7SWCchB6Sx9CZH/L/i-LPQ9Jzq-L.png',
};

export const fullAddress = () => `${SITE.streetAddress}, ${SITE.locality}, ${SITE.region} ${SITE.postalCode}`;
export const mapsLink = () => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${SITE.studioName}, ${fullAddress()}`)}`;
export const waLink = (topic, number = SITE.phone) =>
  `https://wa.me/${number}?text=${encodeURIComponent(`Hi, I’m interested in ${topic} in Bangalore`)}`;
