# Nevervoid.com: SEO audit and migration plan

Audit date: 2 November 2026. Method: read-only crawl of `www.nevervoid.com` (sitemap, server HTML of every page, and a headless-browser render of every page to capture JavaScript-loaded galleries). Nothing was changed on SmugMug or DNS.

URL-by-URL results are in [`migration-report.csv`](migration-report.csv) and [`migration-report.md`](migration-report.md), with the columns: Existing URL, Search Console performance, Existing title, New destination URL, Redirect status and Verification status.

## Still blocked

| Item | Status | What is needed |
|---|---|---|
| Google Search Console (indexed URLs, queries, clicks, impressions, positions) | **Not available.** The session has no Google credentials. The Search Console API returns 401. | Export *Performance → Pages* (last 16 months) as CSV to `data/gsc-pages.csv`, and *Queries* to `data/gsc-queries.csv`. Then run `npm test`: the report fills the Search Console column automatically. Alternative: give a service account Restricted access to the property. |
| SmugMug API | 401 without an API key | Not required. Galleries were captured with a rendered crawl instead. |
| `web.archive.org` | Blocked by this environment's network policy | Optional. It would show old URLs that are no longer linked anywhere. |
| Bare `nevervoid.com` and `http://` | Did not resolve or connect from this environment | Check in your DNS settings that the bare domain has a record and redirects to `www`. The new site does this redirect itself once it is hosted (tested). |

Without Search Console data, we can't yet tell which pages actually rank. That is why the plan **keeps every URL and every page title unchanged**. No ranking page can be lost to a rename or consolidation, and every proposed consolidation below waits for the data.

## Inventory

| | Count |
|---|---|
| Pages in the SmugMug sitemap (all return 200) | 139 (81 galleries with dates, 58 pages and folders) |
| Images (photos.smugmug.com) | 7,690 |
| Per-image pages (`/Gallery/i-XXXX`) | 7,743 |
| SmugMug `/keyword/…` pages linked internally (Google is allowed to crawl these) | 18 |
| Broken internal link | 1 (`/Corporate-Photography` returns 404 but is linked from the site) |
| Other hosts | `framed.nevervoid.com` (separate Cloudflare-hosted shop, not part of this migration) |

## Pages that target fitness and headshot searches in Bangalore

Identified from titles, H1s and copy. Confirm with Search Console once it is available. **All are kept at the identical URL with the identical title.**

| URL | Title (unchanged) |
|---|---|
| `/Headshot-photographer-bangalore` | Headshot Photographer in Bangalore \| Corporate & LinkedIn Headshots |
| `/Professional-studio-headshots` | Professional Studio Headshots |
| `/Headshot-linkedIn-photography` | Headshot-LinkedIn-Photography |
| `/Bangalore-headshots` | Elevate Your Professional Image with Expert Headshot Photography in Bangalore |
| `/Professionals-headshots-bangalore` | Why a Professional Headshot Is More Than Just a Profile Picture |
| `/Studio-corporate-portrait-photography` | Studio corporate portrait photography |
| `/Innosolv-Headshots`, `/Portrait-headshot-photography-reviews` | Team headshots, reviews |
| `/Professional-branding-portraits`, `/Professional-Personal-Branding-Portraits` | Personal branding |
| `/Fitness-Photography` | Gym & Fitness Photoshoot Bangalore \| Bodybuilding Photographer |
| `/Fitness-bikini-photoshoots`, `/Cult-Anniversary` | Fitness galleries |
| `/` | Professional photographer in Bangalore for Fitness, Corporate Headshots, Maternity |

## Audit findings on the current site

1. **No structured data.** None of the 139 pages has JSON-LD, so there is no LocalBusiness, Service, FAQ, Breadcrumb or Image markup.
2. **Headings.** The homepage has 15 `<h1>` elements. 120 pages have no `<h1>` in the HTML that search engines receive first.
3. **Meta descriptions.** 39 pages have none. 14 pages reuse the homepage description. 23 are under 70 characters. The fitness description is about 600 characters and contradicts the page ("3–4 days" vs "5–7 working days").
4. **Duplicate image pages.** Each of the 7,743 image pages repeats its gallery's title and description. The headshot gallery alone produces about 160 pages titled "Headshot Photographer in Bangalore…", all competing with the main page.
5. **Alt text.** 5,403 of 7,690 images (70%) have no useful alt text: they're blank, "Untitled photo" or a file ID.
6. **Case-duplicate URLs.** Five pairs of pages differ only in letter case: `/Food-Photography` and `/Food-photography`, `/House-warming` and `/House-Warming`, `/Photo-editing-services` and `/Photo-Editing-services`, `/Baby-Shower-Bangalore` and `/Baby-shower-bangalore`, `/Candid-wedding-photography` and `/Candid-Wedding-Photography`.
7. **Trailing slashes use 302, not 301.** For example, `/Clients/` → `/Clients`. Internal links use the slash version.
8. **robots.txt blocks every crawler not on SmugMug's allow-list** (`User-agent: * Disallow: /`). That includes newer AI search crawlers.
9. **Thin or test pages are indexable:** `/Temp`, `/Homepage`, `/Homepage/Fullscreen`, `/Other`, `/Other/My-Smug-Mug`.
10. **Content inconsistencies.** Resolved by the owner on 2 Nov 2026 and applied in `src/content-fixes.js`:
    - **Phone and WhatsApp:** one number everywhere, **+91 98800 00990**. This replaces 96324 92092 (fitness and birthday pages) and 86607 83566 (gown rental).
    - **Headshot delivery: 2 days.** This replaces "next day" and "48-hour".
    - **Fitness delivery: 4–5 days.** This replaces "5–7 working days" and "3–4 days".
    - **Covid content removed.** The "safety first", mask, distance and vaccination lines on the maternity, portrait and baby/family pages are gone, and `/Covid` now redirects (301) to `/`.
    - **Experience counted from 2008.** The count is computed at build time, 18 years in 2026. The **maternity page title** changes from "…with 8 years experience." to "…with 18 years experience."; this is the only title change on the site.
    - **Studio address published:** Nevervoid photography creative studio, No 54, ground floor, 10th A Main, 100 Feet Rd, HRBR Layout 1st Block, Balaji Layout, Subbaiahnapalya, Banaswadi, Bengaluru, Karnataka 560043. It appears in the footer, on `/contact` and in the LocalBusiness markup. Make sure your Google Business Profile uses the exact same name, address and phone.
    - **Still open:** the session length ("20 minutes" vs "half to one hour") and the ₹5,899 studio price vs ₹8,899 corporate "one look" price. Both are shown as published.

## Migration plan (implemented in this folder; not deployed)

### URLs
- **138 of the 139 sitemap URLs are kept exactly**: same path, same letter case, no trailing slash. **No ranking page is deleted, renamed or consolidated.** The one removal is `/Covid` (owner request), which gets a 301 to `/`.
- **All 7,622 image pages captured in the crawl are kept at the same URL.** Any other `/Gallery/i-XXXX`, or a size variant such as `/i-XXXX/A`, gets a 301 to its gallery.
- **301 redirects (tested):**
  - Trailing slash → no slash, upgraded from SmugMug's 302.
  - Lowercase or uppercase variants → the correct case, matching SmugMug's own behaviour, including the five case-collision pairs.
  - `.html` → clean URL.
  - Bare `nevervoid.com` → `www`.
  - 18 `/keyword/…` pages → the nearest service page.
  - `/Corporate-Photography` (currently 404) → `/Corporate-photoshoot`.
  - `/search`, `/date`, `/popular` → `/browse`.
  - The old `/sitemap-base.xml.gz` → `/sitemap.xml`.
- **New URLs:** `/services`, `/contact`, `/blog` (the Journal) and four Journal posts under `/blog/…`.

### On-page
- **Titles:** identical to today on 137 pages. The maternity title's years are updated, and `/Covid` is removed. Image pages get unique titles, for example "Chiseled Determination – Studio Fitness Portrait in Bangalore | Gym & Fitness Photoshoot Bangalore - Nevervoid Photography".
- **One H1 per page.** The H1 is the page's primary keyword phrase, taken from its title. Former extra H1s become H2s.
- **Body copy:** carried over word for word, with internal links kept. The home, headshot and fitness pages are redesigned around Why, What and How using their existing copy, FAQs, prices and process steps.
- **Meta descriptions:**
  - 72 are kept as they are.
  - 39 were missing and are written from each page's own first paragraph.
  - 23 short ones are extended, with the original wording kept.
  - 4 that were sitewide duplicates are rewritten.
  - The fitness description is shortened to its first two sentences.
- **Alt text:** real descriptions are kept. Placeholders are replaced with text derived from your descriptive filenames, for example `fitness-gym-portrait-bodybuilding-photography-bangalore`.
- **Structured data:**
  - Sitewide: LocalBusiness and ProfessionalService (founder, founding year 2008, Bengaluru, email, phone), plus WebSite.
  - BreadcrumbList on every page.
  - Service on the headshot and fitness pages, with an Offer of ₹5,899 on the headshot page.
  - FAQPage on the headshot and fitness pages.
  - ImageGallery on gallery pages, ImageObject on image pages, Article on archive articles, and BlogPosting on Journal posts.
- **Internal linking:**
  - Service groups with breadcrumbs.
  - "More in this category" chips on every page.
  - Journal posts link to the headshot and fitness pages with descriptive anchor text.
  - The footer links to all key service pages.
- **Sitemap:** `sitemap.xml` holds 146 indexable URLs with 7,944 image entries (the current sitemap has none). `sitemap-index.xml` still resolves.
- **robots.txt:** allows all crawlers and points to the sitemap.

### Pages proposed for consolidation (not done; needs Search Console data and your approval)
| Page | Proposal | Why it waits |
|---|---|---|
| `/Temp`, `/Homepage`, `/Homepage/Fullscreen`, `/Other`, `/Other/My-Smug-Mug` | `noindex` or 301 to `/` | Confirm they get no clicks |
| Case pairs (e.g. `/Food-Photography` and `/Food-photography`) | Keep the one that ranks, 301 the other | Need to know which one has clicks |
| `/Photo-Editing-services` and `/Creative-photo-editing-service` (same title) | Merge | Same |
| `/Candid-Wedding-Photography/Candid-Engagement` and `/…/Engagement-Photography` (same title) | Merge | Same |
| Long titles (48 over 65 characters) | Shorten | Only once we know which titles rank; changing a ranking title is a risk |

### Images
The new site still serves your photos from SmugMug's CDN, so **SmugMug must stay active** after launch. Before you ever cancel SmugMug, download the originals, self-host them, and re-run the build. Image search traffic also points at `photos.smugmug.com` URLs, so plan that step separately.

## Verification (run `npm test`)
- 138 old URLs return 200 at the identical URL with the expected title. `/Covid` returns a 301 to `/`.
- 24 legacy and keyword URLs return a single 301 to a live page.
- 551 URL variants (trailing slash, lowercase, UPPERCASE, `.html`) take one 301 to the right page.
- All 7,743 old image-page links return 200.
- Every page has exactly one H1, a title, a meta description of 50 or more characters, a self-referencing canonical, and valid JSON-LD. All 7,536 internal links return 200 with no redirect hops.
- Every sitemap URL returns 200, is indexable and matches its canonical.
- The generated Cloudflare middleware is executed against 8 cases: bare domain, case, trailing slash with query string, legacy, keyword, collision and 404.

## Launch steps (each needs your go-ahead)
1. Settle the two remaining content questions above (session length, corporate price).
2. Add the Search Console export and re-run `npm test`. Review which pages rank and decide on the consolidations.
3. Deploy to Cloudflare Pages: build command `npm run build`, output directory `dist`, root directory `nevervoid-site`. Run `node scripts/check-live.mjs https://<project>.pages.dev`.
4. Cutover: add `www.nevervoid.com` and `nevervoid.com` as custom domains in Cloudflare Pages, then update DNS. **This is the only step that changes DNS.** Keep SmugMug active.
5. Run `node scripts/check-live.mjs https://www.nevervoid.com`. In Search Console, submit `/sitemap.xml`, inspect the headshot, fitness and home URLs, and compare clicks weekly for 8 weeks against the export.
