# Package consistency audit: Headshot Studio and Fitness Photography Studio

Date: 11 November 2026. Scope: the new site (`nevervoid-site/`, previewed at nevervoid.pages.dev). The live www.nevervoid.com, DNS and deployment settings were not touched.

Source of truth: the owner's approved package sheet, now stored in `src/packages.js`. Every page, FAQ, card, Journal post and structured-data Offer reads from it, and `npm run verify` fails if an outdated fact reappears.

## Discrepancies found and corrected

| File | Existing information | Conflict with approved package | Correction |
|---|---|---|---|
| `src/templates/featured.js`: headshot pricing card | "The best 5 photos you choose will be advanced edited" | Missing the 2 additional office-background photos (7 in total) | 5 retouched photos **plus** 2 additional office-background photos (7 in total), listed separately |
| same | "Delivery in 2 days"; hero badge "2-day delivery" | Approved: 2–3 days | "Delivery in 2–3 days" |
| same | No duration, outfit or changing-space information | Approved: 15–20 min, up to 2 outfit changes, changing space | Added from the package data |
| same | No bring list | Approved: 2 outfits, grooming kit, tissues | "Bring: 2 outfits, a grooming kit and tissues." |
| same: headshot Offer (JSON-LD) | Name "Headshot photograph session (studio)", no inclusions | — | Name "Headshot Studio", price 5899 INR, description with duration, deliverables and delivery |
| `src/content-fixes.js` (SmugMug copy on the headshot page) | FAQ: "Mostly it should take about half to one hour" | Approved: 15–20 minutes | "The studio session takes 15–20 minutes, with up to 2 outfit changes." |
| same | Step: "within the estimated time (20 minutes)" | Approved: 15–20 minutes | "(15–20 minutes)" |
| same | FAQ: "You will get your photos in 2 days" (originally "next day") | Approved: 2–3 days | "in 2–3 days" |
| same | Meta description: "a 20-minute session …, 5 retouched photos delivered in 2 days … bring 2–3 options" | Duration, deliverables, delivery and outfits | 15–20 minutes; 5 + 2 additional office-background photos; 2–3 days; "bring 2 outfits" |
| `featured.js`: homepage headshot section | "Every photo …; your best 5 advanced-edited"; Delivery "2 days"; Where "Banaswadi studio or on-site" | Deliverables, delivery, location | 5 retouched + 2 additional office-background edits; 2–3 days; Nevervoid Studio, Bengaluru |
| `featured.js`: homepage hero | "2 days headshot delivery" | 2–3 days | "2–3 days" |
| `featured.js`: corporate page, individual headshot card | "your best 5 advanced-edited, and delivery in 2 days" | Deliverables, delivery | Full deliverables (7 images) and 2–3 days |
| `featured.js`: branding page comparison table | Looks "One or two outfits"; Output "best 5 advanced-edited"; "delivered in 2 days" | Outfits, deliverables, delivery | "Up to 2 outfit changes"; 5 + 2 office-background edits (7 images); 2–3 days |
| `src/content/page-copy.js`: studio headshots page and LinkedIn page FAQ | "best 5 photos advanced-edited, delivered in 2 days"; "delivered in 2 days" | Deliverables, delivery | Read from package data |
| Journal: `professional-headshot-cost-bangalore.md`, `how-to-look-natural-in-a-headshot.md`, `actor-headshots-bangalore.md`, `headshots-for-doctors-lawyers-consultants.md`, `team-headshots-checklist-for-hr.md` | "best 5 advanced-edited", "Delivery in 2 days", no duration or bring list | Deliverables, delivery, duration | Package tokens (e.g. `{{headshot.delivery}}`) filled from `src/packages.js` at build |
| `featured.js`: fitness page | No price or package anywhere on the site | Approved: ₹9,899 package | New package card (existing price-card design): ₹9,899, 1 hour, every photo, best 30 edited, 4–5 outfit changes, posing guidance, studio lighting with assistant, Nevervoid Studio, Bengaluru; "What to bring" card; cost FAQ; Offer in JSON-LD |
| same | FAQ: "bring 2–3 solid-colour outfits, and we will guide your posing" | Approved: 4–5 outfit changes; posing guidance based on references, coach or friend | Approved bring list, 4–5 outfit changes, approved posing wording |
| same | Badge "Every pose guided"; step "we guide every pose" | Approved posing wording | "Posing guidance"; "A 1-hour session with posing guidance based on your references, your coach or a friend you bring along" |
| `featured.js`: homepage fitness section | Facts: Delivery 4–5 days / Studio or your gym / Style | Package price, duration and edits absent | Studio session ₹9,899 · Session 1 hour · Edited photos 30 |
| `featured.js`: female fitness page | "Bring 2–3 solid-colour outfits"; "2–3 solid-colour sets"; "Bring a towel, water and a snack"; "We guide every pose" | Outfits, bring list, posing | 4–5 outfits; approved bring list; approved posing wording; ₹9,899 package line and cost FAQ |
| Journal: `how-to-prepare-for-a-fitness-photoshoot.md` | "Bring 3–4 outfit options"; "skip heavy oil on the day"; "bring a towel, water, a snack" | Outfits; body oil and water spray are on the approved bring list | 4–5 outfits; bring body oil and water spray; approved bring list; package summary |

## Needs the owner's confirmation (not changed)

1. **Headshot payment terms**: "50% to book · 40% on location after the shoot · 10% to receive the photos". These appear on the headshot page, in the cost guide and on the Cancellation & refunds page. They are not part of the approved package sheet, so they were left as published.
2. **"100% satisfaction guarantee: re-edit if needed"** on the headshot pricing card. This is from the original site and is not on the approved sheet. Confirm or remove.
3. **Fitness delivery time "4–5 days"** (fitness, female fitness and Cult pages, homepage how-it-works, fitness Journal post). The owner set this on 2 Nov; the approved sheet gives no fitness delivery time. Kept.
4. **Fitness shoots "at your gym"** (on-site). The approved package is a studio package, and its price for on-site gym shoots is not defined. The on-site option and the "Choice of location" step were kept as published.
5. **Headshot "grey and white backgrounds", "standing and sitting poses", "no watermarks"** are original-site details that the approved sheet neither confirms nor contradicts. Kept.
6. **Corporate headshot ₹8,899 single look** and customised team packages: a different service, out of scope. Unchanged.
