// Owner-approved corrections applied on top of the content extracted from
// SmugMug (data/pages.json stays an untouched copy of the live site, so the
// extraction can be re-run safely). Each fix is listed in the build log.
//
// Owner decisions, 2 November 2026:
//   - one phone / WhatsApp number everywhere: 98800 00990
//   - headshot delivery: 2 days
//   - fitness delivery: 4–5 days
//   - remove all Covid content (the /Covid page redirects to the homepage)
//   - experience counted from 2008 (computed at build time)
import { SITE } from './config.js';

export const yearsSince = (date = new Date()) => date.getFullYear() - SITE.foundingYear;

// Pages removed at the owner's request: 301 to the destination.
export const REMOVED = { '/Covid': '/' };

export function fixRules(years) {
  return [
    // ---- phone numbers ----
    { re: /(\+?91[\s-]?)?96324[\s-]?92092/g, to: '9880000990' },
    { re: /(\+?91[\s-]?)?86607[\s-]?83566/g, to: '9880000990' },
    // ---- years of experience (founded 2008) ----
    { re: /Over 12 years of experience/g, to: `Over ${years} years of experience` },
    { re: /over 12 years of experience/g, to: `over ${years} years of experience` },
    { re: /since 2008, which is almost 12 years/g, to: `since 2008, which is over ${years} years` },
    { re: /with 8 years experience\./g, to: `with ${years} years experience.`, paths: ['/Maternity-Photography'] },
    { re: /for over 6 years\./g, to: `for over ${years} years.`, paths: ['/Maternity-Photography'] },
    { re: /editors with over 8 years of experience/g, to: `editors with over ${years} years of experience` },
    { re: /\b8 years of experience\./g, to: `${years} years of experience.`, paths: ['/Maternity-photo-editing'] },
    { re: /professional photographer for over 10 years/g, to: `professional photographer for over ${years} years` },
    // ---- corporate hub (owner, 2 Nov 2026: corporate is a highlighted service) ----
    { re: /^Corporate photoshoot - Nevervoid Photography - Bangalore$/, to: 'Corporate Photoshoot in Bangalore | Team Headshots, Events & Offices - Nevervoid Photography', paths: ['/Corporate-photoshoot'] },
    // ---- delivery times ----
    { re: /You will get your photos the next day via a link/g, to: 'You will get your photos in 2 days via a link', paths: ['/Headshot-photographer-bangalore'] },
    { re: /48-hour delivery/g, to: '2-day delivery', paths: ['/Headshot-photographer-bangalore'] },
    { re: /delivered within 5[–-]7 working days/g, to: 'delivered within 4–5 days', paths: ['/Fitness-Photography'] },
    { re: /delivered in 3-4 days/g, to: 'delivered in 4–5 days', paths: ['/Fitness-Photography'] },
  ];
}

// Covid-era blocks removed wherever they appear.
const COVID_BLOCK = /^(✔\s*)?(safety first|no contact|the team is fully vaccinated.*|mask will be on at all times.*|the distance between the photographer and (you|the subject) will be more than six feet.*)$/i;

export function applyFixes(pages, images = {}, years = yearsSince()) {
  const rules = fixRules(years);
  const log = [];
  const fix = (path, field, s) => {
    if (!s) return s;
    let out = s;
    for (const r of rules) {
      if (r.paths && !r.paths.includes(path)) continue;
      out = out.replace(r.re, r.to);
    }
    if (out !== s) log.push(`${path} ${field}`);
    return out;
  };
  const fixed = pages
    .filter((p) => !(p.path in REMOVED))
    .map((p) => {
      const q = { ...p, title: fix(p.path, 'title', p.title), description: fix(p.path, 'description', p.description), ogTitle: fix(p.path, 'ogTitle', p.ogTitle) };
      const before = p.blocks.length;
      q.blocks = p.blocks
        .filter((b) => !COVID_BLOCK.test(b.text.replace(/\s+\./g, '.').trim()))
        .map((b) => ({ ...b, text: fix(p.path, 'copy', b.text), html: fix(p.path, 'copy-html', b.html) }));
      if (q.blocks.length !== before) log.push(`${p.path} removed ${before - q.blocks.length} Covid block(s)`);
      return q;
    });
  for (const im of Object.values(images)) {
    const a = fix(im.pages?.[0] ?? '', 'alt', im.alt);
    im.alt = a;
  }
  return { pages: fixed, log };
}
