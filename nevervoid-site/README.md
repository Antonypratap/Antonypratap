# Nevervoid Photography website

A static, SEO-first replacement for the SmugMug site at www.nevervoid.com. It keeps **every existing URL and page title**, so current rankings (headshots and fitness in Bangalore) are preserved. Pages are rebuilt around a Why / What / How structure, and the site adds a Journal (blog).

See [`reports/seo-audit-and-migration-plan.md`](reports/seo-audit-and-migration-plan.md) for the audit, the plan and the open questions for the owner.

## Commands

```bash
npm install
npm run build        # data/ + src/ -> dist/ (pages, image pages, sitemap, robots, redirects)
npm run verify       # tests every old URL + on-page SEO, writes reports/migration-report.*
npm test             # build + verify
npm run serve        # preview at http://localhost:4321 (same redirect logic as production)
node scripts/check-live.mjs https://<deployed-site>   # run the old-URL checks against a deployment
```

Refreshing content from the live SmugMug site (read-only):

```bash
NODE_EXTRA_CA_CERTS=... node scripts/crawl-rendered.cjs urls.txt rendered.json   # galleries & image pages
NODE_USE_ENV_PROXY=1 node scripts/extract.mjs rendered.json                       # -> data/*.json
```

## Layout

| Path | What it is |
|---|---|
| `data/pages.json` | Every live page: title, description, copy blocks (with links), image IDs, image-page URLs |
| `data/images.json` | Every image: SmugMug URL parts, alt text, galleries it appears in |
| `src/config.js` | Business facts (email, WhatsApp numbers, founder, address). **Confirm before launch.** |
| `src/site-map.js` | Service groups (navigation and internal links), Journal archive, legacy and keyword redirects |
| `src/templates/featured.js` | Home, headshot and fitness pages (Why / What / How) |
| `src/content/blog/*.md` | Journal posts. Add a `.md` file with the same front matter to publish a new post |
| `src/redirects.js` | The single redirect resolver used in production, in local preview and in tests |
| `functions/_middleware.js` | Generated Cloudflare Pages middleware (301s). Do not edit by hand |
| `public/` | CSS, favicon, `_headers` |

## Hosting

Built for **Cloudflare Pages**: root directory `nevervoid-site`, build command `npm run build`, output `dist`. Pages are written as `Page.html` and served at `/Page`, with no trailing slash, exactly like SmugMug. Images are still served from SmugMug's CDN, so keep the SmugMug subscription active until the images are self-hosted.

## Adding a Journal post

Create `src/content/blog/my-post.md`:

```markdown
---
title: Post title
description: One sentence, about 150 characters.
date: 2026-11-15
author: Antony Pratap
category: Headshots
image: Headshot-photographer-bangalore
related: /Headshot-photographer-bangalore, /Professional-studio-headshots
---

Body in Markdown. Link to the service page you want to support.
```

`image` names the gallery whose photos illustrate the post. Run `npm test` before deploying.
