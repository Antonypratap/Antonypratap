# Webenza: Apple-style homepage concept

`index.html` is a single self-contained homepage concept for [webenza.com](https://webenza.com). It has no build step, so you can open it in a browser or drop it on any static host.

```sh
npx serve sites/webenza   # or just open index.html
```

## 1. What the best agency sites do (the analysis)

Agencies whose sites say clearly what they do share six habits:

| Pattern | Who does it well | What we took |
|---|---|---|
| **Say what you do in the first sentence.** Within about 5 seconds a visitor knows the service, who it is for and the outcome. | WebFX ("digital marketing that drives revenue"), Directive ("performance marketing for tech"), Clyde | Hero: *"Marketing that moves the numbers."* plus one plain sentence that lists the services and the outcome. |
| **Lead with a point of view, not a services list.** | Huge, R/GA, Wieden+Kennedy | A scroll-lit statement paragraph: *get found, get chosen, grow*. |
| **Show the outcome visually.** Dashboards, charts and results beat stock photos. | WebFX, Jellyfish, Media.Monks | An animated growth dashboard in the hero, plus a full-funnel bar chart in the dark section. |
| **Package services so each can be scanned.** One promise, 3–4 deliverables and one CTA per service. | Bureau Dimanche, DD.NYC, Made by Many | A bento grid of 7 service tiles, each with a one-line promise and an action CTA ("Plan my campaigns ›"). |
| **Make the process obvious.** This removes the "what happens after I sign?" fear. | Metalab, Work & Co | "Four steps. No mystery." Discover → Plan → Launch → Optimise. |
| **Show proof and one low-friction CTA, repeated.** | Most top performers | Client names, company facts, an FAQ, and "Get a free growth audit" repeated in the nav, sub-nav, hero and footer CTA. |

### Apple design language applied

- **One idea per section** and a huge headline with a short line underneath ("Everything digital. Under one roof.").
- **Typography does the work.** SF Pro on Apple devices (Inter elsewhere), tight tracking, and a gradient only on the key phrase.
- A **frosted sticky global nav** plus a **product-style sub-nav** with a scroll-spy and a persistent CTA.
- A **bento tile grid**, and a **black "Pro" section** for the measurement story.
- A **horizontal snap gallery** for industries, an **FAQ accordion**, and a **dense Apple-style footer** with a legal note.
- **Motion with restraint:** fade-up reveals, count-ups, a chart that draws itself and words that light up as you scroll. All of it turns off under `prefers-reduced-motion`.
- Automatic **dark mode** (`prefers-color-scheme`, or force it with `data-theme` on `<html>`), a mobile menu, and no horizontal scroll down to 360px.

## 2. Page structure

1. Hero: what we do and the outcome, primary CTA, live-dashboard visual
2. Statement: why Webenza, in one paragraph
3. Services bento: Performance, Social & Influencer, SEO & AI Search (GEO), Brand & Creative, Web & App, Data & MarTech, ORM
4. How we work: 4 steps
5. Measured by results (dark): funnel, dashboard, AI optimisation, 90-day plan
6. Industries gallery and client names
7. Why Webenza: comparison and company facts
8. FAQ
9. CTA: free growth audit form

## 3. Before going live: verify and replace

The content comes from public directory listings. Webenza's site could not be reached from the build environment, so check these points:

- [ ] **Brand colours and logo.** Swap the `--accent` / `--grad-*` tokens at the top of the `<style>` block and replace the `.logo-mark` gradient square with the real logo.
- [ ] **Facts:** founded 2012, "150+" specialists, offices in Bengaluru, Mumbai and Delhi.
- [ ] **Client names:** Schneider Electric, Clarks, Joy Personal Care, Inventure Academy, Angel Prime. Confirm them and get logo permission. Swap the text for SVG logos.
- [ ] **Contact email** `hello@webenza.com` is a placeholder. The form currently hands off to `mailto:`, so wire it to the CRM (HubSpot, Zoho and so on).
- [ ] **Dashboard numbers** in the hero are illustrative and labelled that way. Replace them with a real anonymised client snapshot if possible.
- [ ] Add real **case studies** (challenge → what we did → result with numbers) once approved. This is the biggest proof gap.
- [ ] Industry emoji art is a stand-in. Replace it with photography or 3D illustrations.
