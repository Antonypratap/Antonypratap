# The Veyrafy blog (veyrafy.com/blog)

The blog is part of the website service (**veyrafy-site**), switched on with `VEYRA_BLOG=true`.
Without it the website is exactly what it was: static files, no database. With it, the same
process also:

- serves the blog's public pages, rendered on the server (complete HTML, metadata and structured
  data in the first response; no JavaScript needed to read an article);
- serves the publishing studio at `/admin/blog` (part of the web app) and its API
  (`/api/v1/blog/…`) for Veyrafy's editors;
- serves `/sitemap.xml` (built from the database) and `/blog/feed.xml` (RSS).

There is no separate CMS. It is the same Docker image, the same PostgreSQL schema and migrations,
the same sign-in, sessions, CSRF protection and access control as every Veyrafy service.

## Architecture

| Piece | Where |
|---|---|
| Content model, lifecycle, editorial checks (shared by server and studio) | `packages/shared/src/blog.ts`, `schemas/blog.ts` |
| Database tables (`blog_*`) | `apps/api/src/db/schema.ts`, migration `0009_blog.sql` |
| Rules: publishing, scheduling, slugs, redirects, revisions, media | `apps/api/src/blog/service.ts` |
| Image handling (sniff, decode, re-encode as WebP) | `apps/api/src/blog/media.ts` |
| Public HTML, JSON-LD, sitemap, RSS | `apps/api/src/blog/render.ts` |
| Stylesheet and analytics script (served from memory, hashed) | `apps/api/src/blog/assets.ts` |
| Routes (public and studio API) | `apps/api/src/blog/routes.ts` |
| Website server with the blog | `apps/api/src/http/site-server.ts`, `site-main.ts` |
| Sign-in routes (shared with client instances) | `apps/api/src/http/auth-routes.ts` |
| Studio (React) | `apps/web/src/blog-studio/` |
| Starting categories and articles (drafts) | `apps/api/src/blog/seed.ts`, `articles.ts`, `npm run blog:seed -w @veyra/api` |

**Content is never HTML.** An article body is a list of typed blocks (paragraph, heading H2/H3,
list, quote, image, table, callout, editorial note). The server renders every block itself and
escapes all text; inline markup is limited to `**bold**`, `*italic*`, `` `code` `` and
`[text](link)`, and a link is rendered only if it is a site path, an anchor, `https://`, `http://`
or `mailto:`. Stored XSS has no way in.

**Who may do what.** Only `VEYRA_ADMIN` accounts of the platform organization can sign in to the
studio; customer roles never get blog permissions. Each studio route declares `blog.view`,
`blog.write` or `blog.publish`, enforced by the server's access hook before anything is read.
Changing a live (or scheduled) article, publishing, scheduling, unpublishing and archiving also
need `blog.publish`. Today every `VEYRA_ADMIN` has all three; there is no separate reviewer role.

## Lifecycle

`DRAFT → IN_REVIEW → SCHEDULED → PUBLISHED → ARCHIVED`, plus: back to draft from review, scheduled
or published (unpublish), and from archived. Enforced on the server (`BLOG_TRANSITIONS`).

- **Public** means `PUBLISHED`, or `SCHEDULED` whose time has come. This is decided when a page is
  read, so a scheduled article can never be read early. A timer (every minute) only records the
  move to `PUBLISHED`.
- **Publishing and scheduling run the publication checks** (title, slug, excerpt, author,
  category, at least one paragraph, no editorial notes, alt text on every image, complete FAQ
  entries, only allowed links, an https canonical). Errors refuse it.
- **A public article is only saved by hand**; autosave applies to drafts only. Saving a public
  article runs the same checks.
- **Versions.** Every save names the version it was edited from; an older one is refused (two
  editors, or two tabs). Manual saves, status changes and restores keep a revision (restore makes a
  new version; nothing is lost).
- **Slugs** are unique (database constraint) and checked when saving. Changing the slug of an
  article that has ever been public adds a permanent 301 redirect (older redirects are pointed at
  the new address: no chains).
- **Unpublished** articles answer 404; **archived** articles that were public answer **410 Gone**.
- **Deleting** is only for drafts that were never public; it retires the row (the application never
  deletes rows; see `apps/api/sql/runtime-role.sql`).
- Every change is recorded in `blog_events` (who, when, what), append-only for the application.

## SEO behaviour

| Item | Implementation |
|---|---|
| Server-rendered HTML | Every public page is complete HTML from the server. |
| Title, description | Unique per page; article: SEO title (or title) + "| Veyrafy"; pages 2+ say so. |
| Canonical | Self-referencing by default (`VEYRA_PUBLIC_ORIGIN` + path); an article may name another. |
| Robots | Articles `index, follow`, or `noindex, follow` when set; tag archives and search `noindex, follow`; previews `noindex, nofollow` (also `X-Robots-Tag`). |
| Sitemap | `/sitemap.xml`: home, `/blog`, categories with public articles, public articles that are indexable and self-canonical, with last-modified dates. |
| robots.txt | Disallows `/api/`, `/app/`, `/admin/`, `/blog/preview/`, `/blog/search`. |
| Structured data | `BlogPosting` (headline, dates, author, publisher, image, section), `BreadcrumbList`, `FAQPage` only when the FAQ is on the page, `Blog`/`CollectionPage` on lists. No ratings or reviews. |
| Social | Open Graph (article times, section, tags) and X cards; share image falls back to the featured image, then the site image. |
| URLs | `/blog/{slug}`, `/blog/category/{slug}`, `/blog/tag/{slug}`, `/blog/page/{n}`; a trailing slash redirects (301) to the address without it. |
| Pagination | Crawlable links, `rel=prev/next`, self-canonical; page 1 at `/blog`, `/blog/page/1` redirects. |
| Images | Re-encoded WebP, width and height set, `srcset` with an 800 px copy, lazy below the fold, the hero `fetchpriority=high`. |
| Speed | No JavaScript to read a page; one small stylesheet (hashed, cached for a year), the site's own fonts preloaded. |

## Analytics and consent

- **GA4** loads only when `VEYRA_GA4_MEASUREMENT_ID` is set **and** the visitor chose "Allow
  analytics" in the banner (a plain form; the choice is kept in a first-party, HttpOnly cookie
  read by the server for 180 days). Only then does the page's Content-Security-Policy allow
  Google's hosts. "No thanks", or no choice, loads nothing.
- Events (after consent): page views (GA4 default), `cta_click` (any link with `data-cta`, for
  example `challenge-{slug}` or `nav-challenge`), `article_read` at 50 % and 90 % of the article.
- Calls to action carry `utm_source=blog&utm_medium=cta&utm_campaign={slug}` to the challenge.
- **Not implemented:** challenge starts and completions, and demo or sign-up conversions, are not
  sent to GA4. The challenge runs on demo.veyrafy.com (another origin, without the blog's consent
  banner). Its starts, completions and walkthrough requests are counted in the Control Centre. Use
  the UTM campaign there; connecting them to GA4 needs a consent decision for that page first.
- The measurement id and the Search Console token are public values (never secrets).

## Setting it up in production (not done; needs your approval)

1. Railway: add a PostgreSQL database for the website (e.g. **postgres-site**).
2. **veyrafy-site → Variables:** `VEYRA_BLOG=true`,
   `DATABASE_URL=${{postgres-site.DATABASE_URL}}`, `VEYRA_PUBLIC_ORIGIN=https://veyrafy.com`,
   and keep `VEYRA_SITE_ONLY=true`. Optional: `VEYRA_GA4_MEASUREMENT_ID`, `VEYRA_GSC_VERIFICATION`.
   Production requires TLS to the database unless it is Railway's private network (as for the
   other services).
3. **Pre-deploy command:** `npm run db:migrate -w @veyra/api` (it applies the blog's migrations on
   the website service).
4. Create each editor from the service's shell (password typed at the hidden prompt):
   `railway ssh --service veyrafy-site`, then
   `read -rs P && printf '%s\n' "$P" | npm run users -w @veyra/api -- create --email you@veyrafy.com --name "Your Name" --role VEYRA_ADMIN && unset P`.
   Only `VEYRA_ADMIN` accounts can be created there.
5. `npm run blog:seed -w @veyra/api` (categories, an author byline and eight complete articles,
   as drafts). Read each one in the studio and publish it.
6. Sign in at `https://veyrafy.com/admin/blog`.

Rollback: unset `VEYRA_BLOG` (the website goes back to static files; the blog's data stays in its
database). The migration only adds `blog_*` tables; removing them is `DROP TABLE` of those nine
tables, never needed for a rollback.

## Search Console

1. Add the property `https://veyrafy.com` (or the domain property `veyrafy.com`).
2. Verify: **DNS TXT record** (recommended, needs no setting), or the HTML tag method:
   put its `content` value in `VEYRA_GSC_VERIFICATION` and redeploy (the tag is added to the
   homepage and every blog page).
3. Sitemaps → submit `https://veyrafy.com/sitemap.xml` (it exists only with the blog on; without it
   the static one lists the homepage).
4. Use URL inspection on a published article to confirm Google sees the rendered HTML.

## GA4

1. Create a GA4 property and a web data stream for `https://veyrafy.com`; copy the measurement id
   (`G-…`) into `VEYRA_GA4_MEASUREMENT_ID`.
2. In GA4, mark `cta_click` as a key event if wanted; `article_read` is engagement.
3. Check with GA4 DebugView after allowing analytics in the banner. Nothing is sent without
   consent; expect lower counts than with an always-on tag.

## Content

`npm run blog:seed` creates six categories (Invoice Verification; Accounts Payable Automation;
Purchase Orders and GRN Reconciliation; GST and Invoice Accuracy; Duplicate Invoices and Fraud
Prevention; Finance Operations), the byline "Veyrafy Team", and eight complete articles as
**drafts**, written for the questions finance teams in India search for:

| Article | Focus phrase |
|---|---|
| GSTR-2B mismatch: why your ITC does not match your books | gstr-2b mismatch |
| Three-way matching explained: purchase order, GRN and invoice | three-way matching |
| How to check a GST invoice is genuine before you pay it | gst invoice is genuine |
| Duplicate invoice payments: how they happen and how to stop them | duplicate invoice payments |
| The GST 180-day rule: when unpaid supplier invoices cost you your ITC | 180-day rule |
| GST invoice mandatory fields under Rule 46 | gst invoice mandatory fields |
| GST Invoice Management System (IMS): a practical guide | invoice management system |
| Seven supplier invoice errors to check before you pay | supplier invoice errors |

Each has a search title (60 characters or fewer), a meta description of 120 to 160 characters,
FAQs (marked up as FAQPage), links to the related articles and the 5 Invoice Challenge, and a
note that it is not tax advice. Legal points cite the CGST Act and Rules or GSTN's updates; money
figures are illustrative examples, and there are no statistics, testimonials or claimed results.
The topics come from what people search for (GSTR-2B reconciliation, three-way matching, genuine
GST invoices, duplicate payments, the 180-day rule, Rule 46, IMS); no search volumes are claimed.
Have a chartered accountant read the GST articles before publishing, and check each against the
current law on the day you publish.

## Known limits

- Editors are `VEYRA_ADMIN` accounts; there is no separate editor/reviewer role (review is a
  status, not an enforced second person).
- The editor is a block editor with inline markup, not a WYSIWYG editor.
- Images are public at their address once uploaded (unguessable ids), including for drafts.
- Search is PostgreSQL full-text (English), rate-limited per address; no typo tolerance.
- Rate limits are per process (as elsewhere in Veyrafy).
- Categories, tags and authors are renamed, never deleted.
