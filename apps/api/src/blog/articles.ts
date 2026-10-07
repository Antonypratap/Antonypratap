import type { BlogBlock, BlogFaq } from '@veyra/shared';

/**
 * The blog's first articles, written for finance and accounts teams in India. Each one answers
 * a question people search for (GSTR-2B mismatches, three-way matching, genuine GST invoices,
 * duplicate payments, the 180-day rule, Rule 46 invoice fields, the Invoice Management System,
 * common invoice errors). Legal points cite the CGST Act and Rules and GSTN's own updates; every
 * money figure is an illustrative example, never a statistic. No dashes are used as punctuation.
 *
 * They are seeded as drafts: an editor reads each one and publishes it from the studio.
 */
export interface SeedArticle {
  slug: string;
  category:
    | 'invoice-verification'
    | 'accounts-payable-automation'
    | 'purchase-orders-grn-reconciliation'
    | 'gst-invoice-accuracy'
    | 'duplicate-invoices-fraud-prevention'
    | 'finance-operations';
  title: string;
  seoTitle: string;
  metaDescription: string;
  excerpt: string;
  focusKeyword: string;
  blocks: BlogBlock[];
  faq: BlogFaq[];
}

const p = (text: string): BlogBlock => ({ type: 'paragraph', text });
const h2 = (text: string): BlogBlock => ({ type: 'heading', level: 2, text });
const h3 = (text: string): BlogBlock => ({ type: 'heading', level: 3, text });
const ul = (...items: string[]): BlogBlock => ({ type: 'list', ordered: false, items });
const ol = (...items: string[]): BlogBlock => ({ type: 'list', ordered: true, items });
const tip = (text: string): BlogBlock => ({ type: 'callout', tone: 'tip', text });
const note = (text: string): BlogBlock => ({ type: 'callout', tone: 'info', text });
const warning = (text: string): BlogBlock => ({ type: 'callout', tone: 'warning', text });
const table = (header: string[], rows: string[][], caption?: string): BlogBlock => ({
  type: 'table',
  header,
  rows,
  ...(caption ? { caption } : {}),
});

const NOT_ADVICE = note(
  'This article explains the rules in plain language. It is not tax advice: for a decision on your own books, speak to your chartered accountant.',
);
const CHALLENGE = (lead: string): BlogBlock =>
  p(
    `${lead} [Try the 5 Invoice Challenge](/5-invoice-challenge): drop in five supplier invoices, add the export from your accounting system if you have it, and see what Veyrafy finds. No sign-up.`,
  );

export const BLOG_ARTICLES: readonly SeedArticle[] = [
  // ── 1 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'gstr-2b-mismatch-itc',
    category: 'gst-invoice-accuracy',
    title: 'GSTR-2B mismatch: why your ITC does not match your books, and what to do about it',
    seoTitle: 'GSTR-2B Mismatch: Why ITC Does Not Match Your Books',
    metaDescription:
      'Your purchase register and GSTR-2B do not agree. The usual causes of a GSTR-2B mismatch, what it costs, and a monthly routine that fixes it.',
    excerpt:
      'Your purchase register says one thing and GSTR-2B says another. Here is why a GSTR-2B mismatch happens, what it can cost, and a simple monthly routine to close the gap.',
    focusKeyword: 'gstr-2b mismatch',
    blocks: [
      p(
        'Every month, someone in accounts opens GSTR-2B, lays it next to the purchase register and finds that the two do not agree. A GSTR-2B mismatch is one of the most common headaches in Indian finance teams, and it is not just a reporting nuisance: input tax credit you cannot support from GSTR-2B is credit you may have to give back.',
      ),
      p(
        'This guide covers why the two lists drift apart, why it matters more than it used to, and a practical routine that keeps the gap small.',
      ),
      h2('Why GSTR-2B decides how much ITC you can claim'),
      p(
        'GSTR-2B is a monthly statement of the purchases your suppliers have reported against your GSTIN. Since 1 January 2022, **section 16(2)(aa) of the CGST Act** allows input tax credit on an invoice only when the supplier has furnished its details in GSTR-1 (or the Invoice Furnishing Facility) and those details have been communicated to you in GSTR-2B.',
      ),
      p(
        'In other words, your own purchase register is no longer enough. If an invoice is in your books but not in GSTR-2B, the credit on it is not available yet, however genuine the purchase was.',
      ),
      h2('The usual reasons for a GSTR-2B mismatch'),
      p('Most mismatches come from a short list of causes:'),
      ul(
        '**The supplier filed late.** An invoice dated in March but reported in April’s GSTR-1 shows up in April’s GSTR-2B, not March’s.',
        '**A typing error on either side.** One wrong digit in your GSTIN, or an invoice number keyed as 1042 in your books and INV-1042 by the supplier, is enough to break the match.',
        '**Timing of booking.** You booked the invoice when the goods arrived; the supplier reported it by invoice date. The amounts agree, the months do not.',
        '**Tax amount differences.** Rounding, a wrong GST rate, or IGST charged where CGST and SGST should apply.',
        '**Reported as a B2C sale.** If the supplier left your GSTIN out of GSTR-1, the invoice never reaches your GSTR-2B at all.',
        '**Credit and debit notes.** A note the supplier reported but you never recorded, or the other way round.',
      ),
      h2('What a mismatch can cost you'),
      p(
        'If you claim credit that GSTR-2B does not support and use it to pay tax, you can be asked to reverse it with interest. Interest on wrongly availed and utilised credit runs at 18% a year under section 50 of the CGST Act. Mismatches that keep recurring are also a common trigger for scrutiny notices.',
      ),
      p(
        'There is a quieter cost too. Invoices that are in GSTR-2B but not in your books are credit you are entitled to and are not claiming. Section 16(4) puts a deadline on that: credit for a financial year has to be claimed by 30 November of the following year, or the date you file the annual return, whichever is earlier.',
      ),
      h2('A monthly routine that keeps GSTR-2B and your books in step'),
      ol(
        '**Download GSTR-2B as soon as it is generated.** Since the Invoice Management System arrived, a draft is available from the 14th of the following month.',
        '**Match on five keys:** supplier GSTIN, invoice number, invoice date, taxable value and tax amount. Normalise invoice numbers first (strip spaces, prefixes like “INV-” and leading zeros) so the same invoice is not counted as two.',
        '**Sort the result into four groups:** matched; in both but with a different amount; in your books but not in GSTR-2B (credit at risk); in GSTR-2B but not in your books (credit you may be missing).',
        '**Chase suppliers in the third group.** A short email with the invoice number, date and value usually gets a late GSTR-1 filed or an error amended.',
        '**Record a decision for every difference** before you file GSTR-3B: claim now, defer to next month, or reverse.',
      ),
      tip(
        'Do the GSTIN check before the invoice is approved, not at month end. A supplier GSTIN that is cancelled or does not match the supplier’s name is far cheaper to catch on day one.',
      ),
      h2('Use the Invoice Management System as your checkpoint'),
      p(
        'The GST portal’s Invoice Management System lets you accept, reject or keep pending each invoice your suppliers report. Accepted invoices flow into GSTR-2B; rejected ones do not. It is a good place to stop wrong invoices before they become wrong credit. We explain how it works in [our guide to the Invoice Management System](/blog/gst-invoice-management-system-ims).',
      ),
      h2('Catch the problem before it reaches GSTR-2B'),
      p(
        'Most of what shows up as a GSTR-2B mismatch was visible on the invoice the day it arrived: a GSTIN that does not match, a tax type that does not fit the place of supply, an amount that does not add up. Checking each supplier invoice against your own records before you approve it means fewer surprises at month end.',
      ),
      CHALLENGE('Want to see what your own invoices would show?'),
      NOT_ADVICE,
    ],
    faq: [
      {
        q: 'Can I claim ITC on an invoice that is not in GSTR-2B?',
        a: 'Under section 16(2)(aa) of the CGST Act, credit is available only when the supplier has reported the invoice and it has been communicated to you in GSTR-2B. If it is missing, ask the supplier to report it; you can claim the credit in the month it appears, within the section 16(4) time limit.',
      },
      {
        q: 'What is the difference between GSTR-2A and GSTR-2B?',
        a: 'GSTR-2A changes as suppliers keep filing. GSTR-2B is a fixed statement for each month, which is why it is the one to reconcile your input tax credit against.',
      },
      {
        q: 'How often should we reconcile GSTR-2B?',
        a: 'Every month, before you file GSTR-3B. A monthly routine keeps each batch of differences small enough to chase while the supplier still remembers the invoice.',
      },
    ],
  },

  // ── 2 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'three-way-matching-po-grn-invoice',
    category: 'purchase-orders-grn-reconciliation',
    title: 'Three-way matching explained: purchase order, GRN and invoice',
    seoTitle: 'Three-Way Matching: PO, GRN and Invoice Explained',
    metaDescription:
      'Three-way matching checks the purchase order, goods receipt note and supplier invoice before you pay. How it works in India, with GST, and an example.',
    excerpt:
      'Three-way matching compares what you ordered, what you received and what the supplier billed before any money goes out. Here is how it works, with GST, and a worked example.',
    focusKeyword: 'three-way matching',
    blocks: [
      p(
        'Three-way matching is the habit of checking three documents against each other before paying a supplier: the **purchase order** (what you agreed to buy), the **goods receipt note** or GRN (what actually arrived) and the **supplier invoice** (what you are being asked to pay). If all three agree, the invoice is paid. If they do not, someone looks before money leaves the bank.',
      ),
      p(
        'It sounds obvious, and most teams believe they already do it. In practice it often comes down to someone glancing at the invoice total and the PO number, which is where the expensive mistakes slip through.',
      ),
      h2('What each document proves'),
      table(
        ['Document', 'Who creates it', 'What it proves'],
        [
          [
            'Purchase order',
            'Your purchasing team',
            'The items, quantities and rates you agreed to',
          ],
          [
            'Goods receipt note',
            'Your stores or receiving team',
            'What actually arrived, in what quantity and condition',
          ],
          [
            'Supplier invoice',
            'The supplier',
            'What the supplier wants to be paid, and the GST charged',
          ],
        ],
      ),
      h2('A worked example'),
      p(
        'Say you order 100 steel brackets at ₹45 each. Ninety arrive; ten are back-ordered. The supplier then sends an invoice for 100 brackets at ₹47.',
      ),
      table(
        ['', 'Purchase order', 'GRN', 'Invoice', 'Result'],
        [
          ['Quantity', '100', '90', '100', 'Billed for 10 not received'],
          ['Rate', '₹45.00', '', '₹47.00', '₹2.00 above the agreed rate'],
          [
            'Taxable value',
            '₹4,500.00',
            '',
            '₹4,700.00',
            'Pay ₹4,050.00 (90 × ₹45), not ₹4,700.00',
          ],
        ],
        'Illustrative example',
      ),
      p(
        'Paying this invoice as it stands would mean paying for ten brackets you never received and ₹2 too much on every one. Neither shows up if you only check that the invoice total looks reasonable.',
      ),
      h2('Two-way, three-way and four-way matching'),
      ul(
        '**Two-way** compares the invoice with the purchase order. It suits services, where there is no delivery to receive.',
        '**Three-way** adds the goods receipt. It is the standard for goods and stock.',
        '**Four-way** adds a quality inspection report, for goods that must pass inspection before they are accepted.',
      ),
      h2('Three-way matching in India: add the GST layer'),
      p(
        'In India the three documents agreeing is not the whole story. The invoice also has to be a valid tax invoice for you to claim input tax credit. While matching, check:',
      ),
      ul(
        'the supplier’s GSTIN is valid and belongs to the supplier named on the invoice;',
        'your own GSTIN is printed on it, correctly;',
        'the tax type fits the place of supply: CGST and SGST within a state, IGST between states;',
        'the GST rate matches the HSN or SAC code and what was agreed;',
        'the tax and the total add up.',
      ),
      p(
        'A clean three-way match on a wrong tax invoice still costs you, either in credit you cannot claim or in a debit note you have to chase later. Our [checklist for genuine GST invoices](/blog/how-to-check-gst-invoice-genuine) covers these checks in detail.',
      ),
      h2('Where three-way matching goes wrong in practice'),
      ul(
        '**Partial deliveries.** One PO, three GRNs, two invoices. The match has to be done line by line, not document by document.',
        '**Rate revisions.** The supplier raised the price by email and nobody updated the PO.',
        '**Items named differently.** Your system says “Steel Bracket 40mm”, the invoice says “Bracket S/40”. A person can tell they are the same; a strict system cannot, and a careless one pairs the wrong lines.',
        '**Freight and loading charges** that are on the invoice but not the PO.',
        '**No GRN at all**, because stores were busy. The invoice waits, or worse, gets paid anyway.',
      ),
      tip(
        'Agree tolerances in advance, for example a rupee of rounding on the total, and decide who approves anything beyond them. A clear rule stops every small difference from turning into a meeting.',
      ),
      h2('Making three-way matching practical'),
      p(
        'The value of matching comes from doing it on every invoice, line by line, before payment. That is hard to sustain by hand when invoices arrive as scans, photos and PDFs in different layouts. Veyrafy reads each invoice, compares it line by line with your purchase orders and goods receipts, and shows every difference with the evidence from the invoice itself.',
      ),
      CHALLENGE('See how your own invoices match up.'),
    ],
    faq: [
      {
        q: 'What is a GRN in accounts payable?',
        a: 'A goods receipt note is the record your stores or receiving team makes when goods arrive: what came in, how much, and in what condition. In three-way matching it proves delivery before the invoice is paid.',
      },
      {
        q: 'Is three-way matching required by law in India?',
        a: 'No law requires it as such. It is an internal control, but it also protects your input tax credit, since credit depends on actually receiving the goods (section 16(2)(b) of the CGST Act) and on holding a valid tax invoice.',
      },
      {
        q: 'What should we do when the invoice and GRN quantities differ?',
        a: 'Hold the invoice and ask the supplier for a corrected invoice or a credit note for the difference. Pay only for what was received, at the rate on the purchase order.',
      },
    ],
  },

  // ── 3 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'how-to-check-gst-invoice-genuine',
    category: 'invoice-verification',
    title: 'How to check a GST invoice is genuine before you pay it',
    seoTitle: 'How to Check a GST Invoice Is Genuine Before You Pay',
    metaDescription:
      'Seven checks that show whether a GST invoice is genuine: GSTIN status, invoice number, tax type, HSN, totals, QR code and GSTR-2B. Do them before you pay.',
    excerpt:
      'Seven quick checks that tell you whether a GST invoice is genuine and safe to pay, from the supplier’s GSTIN to the e-invoice QR code.',
    focusKeyword: 'gst invoice is genuine',
    blocks: [
      p(
        'A fake or faulty invoice costs twice: once when you pay it, and again when the input tax credit on it is denied. Checking that a GST invoice is genuine takes a few minutes per invoice, and the checks below catch most problems before they reach a payment run.',
      ),
      h2('1. Look the supplier’s GSTIN up on the GST portal'),
      p(
        'On [the GST portal](https://www.gst.gov.in), use **Search Taxpayer** and enter the GSTIN. Check three things: the legal and trade name match the supplier on the invoice, the registration is **Active** (not cancelled or suspended), and the state matches the supplier’s address.',
      ),
      p(
        'A GSTIN also has a structure you can check at a glance: 15 characters, starting with a two-digit state code, followed by the supplier’s 10-character PAN, and ending in a check character. A typo usually breaks the check character, which is why good software validates it automatically.',
      ),
      h2('2. Check the invoice number and date'),
      p(
        'Under **Rule 46 of the CGST Rules**, the invoice number must be a consecutive serial number of up to 16 characters, unique for the financial year. Watch for numbers you have seen before from the same supplier, numbers that jump strangely, and dates in the future or long in the past.',
      ),
      h2('3. Make sure your own details are right'),
      p(
        'Your GSTIN, name and address must be on the invoice, correctly. An invoice with someone else’s GSTIN, or yours with a wrong digit, will not appear in your GSTR-2B, so the credit is lost even if the purchase is real.',
      ),
      h2('4. Check that the tax type fits the place of supply'),
      p(
        'Supplies within a state carry CGST and SGST. Supplies between states carry IGST. An invoice from a supplier in your own state charging IGST, or one from another state charging CGST and SGST, needs a closer look and usually a correction.',
      ),
      h2('5. Check HSN or SAC codes and GST rates'),
      p(
        'Each line should carry an HSN code (goods) or SAC code (services). Suppliers with aggregate turnover above ₹5 crore must show six digits on B2B invoices; smaller suppliers show at least four. The GST rate on each line should be the rate for that code.',
      ),
      h2('6. Check the arithmetic'),
      p(
        'Quantity times rate should give the line amount. The lines should add up to the taxable value. Taxable value plus tax plus round-off should give the total. Errors here are common and easy to miss when you only look at the bottom line.',
      ),
      h2('7. Check the e-invoice QR code and GSTR-2B'),
      p(
        'Suppliers with aggregate turnover above ₹5 crore must issue B2B invoices as e-invoices, with an IRN and a QR code. Scanning the QR code shows the details registered with the government; they should match the printed invoice. If a large supplier sends a B2B invoice without a QR code, ask why.',
      ),
      p(
        'Finally, once the supplier has filed, the invoice should appear in your GSTR-2B and in the Invoice Management System. One that never appears is a reason to stop and ask.',
      ),
      warning(
        'Treat any request to change a supplier’s bank account with suspicion, especially one that arrives by email with an invoice. Confirm it by phone on a number you already have, not one given in the same email.',
      ),
      h2('Make the checks routine, not occasional'),
      p(
        'These checks are easy to do on one invoice and hard to keep up on hundreds a month. That is exactly where Veyrafy helps: it reads each invoice, validates the GSTINs, checks the tax type, rates and arithmetic, and compares the invoice with your own records, showing the evidence for anything it flags. You can also read our list of [common supplier invoice errors](/blog/common-supplier-invoice-errors).',
      ),
      CHALLENGE('Check five of your own invoices.'),
      NOT_ADVICE,
    ],
    faq: [
      {
        q: 'How can I check if a GSTIN is valid?',
        a: 'Search it on the GST portal under Search Taxpayer. A valid GSTIN shows the registered name, the state and the registration status. If the portal shows nothing, or a different business, do not pay until the supplier explains.',
      },
      {
        q: 'Is an invoice without a QR code fake?',
        a: 'Not necessarily. Only suppliers whose aggregate turnover is above ₹5 crore must issue e-invoices with a QR code for B2B supplies. For a smaller supplier, a missing QR code is normal.',
      },
      {
        q: 'What happens if I claim ITC on a fake invoice?',
        a: 'The credit will be denied and must be reversed with interest, and penalties can apply. That is why checking the supplier and the invoice before you pay matters.',
      },
    ],
  },

  // ── 4 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'duplicate-invoice-payments',
    category: 'duplicate-invoices-fraud-prevention',
    title: 'Duplicate invoice payments: how they happen and how to stop them',
    seoTitle: 'Duplicate Invoice Payments: How to Spot and Stop Them',
    metaDescription:
      'How duplicate invoice payments happen, the checks that catch the same supplier invoice before it is paid twice, and how to recover money already paid.',
    excerpt:
      'Paying the same supplier invoice twice is easier than it sounds. How duplicate invoice payments happen, the checks that catch them, and what to do if one gets through.',
    focusKeyword: 'duplicate invoice payments',
    blocks: [
      p(
        'Nobody sets out to pay an invoice twice. Duplicate invoice payments happen because the same bill reaches you by two routes, or is keyed in two slightly different ways, and nothing connects the two copies before the payment run.',
      ),
      h2('How the same invoice gets paid twice'),
      ul(
        '**Two copies arrive.** The supplier emails a PDF, and the driver hands over a paper copy with the goods. Both get entered.',
        '**A reminder is treated as a new bill.** The supplier resends an unpaid invoice, and it is processed again.',
        '**The number is typed differently.** “INV/1042”, “INV-1042” and “1042” look different to most systems. So do “001042” and “1042”.',
        '**The supplier exists twice in your records.** One vendor entry under the trade name, another under the legal name, each with its own copy of the invoice.',
        '**A scan and a photo of the same page.** Different files, same invoice.',
        '**Partial payments** that are not linked to the invoice, so the full amount is paid again later.',
      ),
      h2('Checks that catch duplicates'),
      ol(
        '**Normalise invoice numbers before comparing them:** remove spaces, slashes, hyphens, common prefixes and leading zeros. “INV/001042” and “1042” then compare as the same.',
        '**Compare supplier, invoice number and amount together,** and look at near matches as well: same supplier and amount within a few days is worth a second look.',
        '**Keep one vendor record per supplier.** Use the GSTIN as the key, and merge duplicates you find.',
        '**Check every new invoice against everything already received,** not just against what is in this week’s batch.',
        '**Review the payment run** for the same supplier and amount appearing twice before it is released.',
      ),
      tip(
        'GST law helps here. A supplier’s invoice number must be unique for the financial year (Rule 46 of the CGST Rules), so the same supplier GSTIN and invoice number appearing twice in one year is almost always a duplicate.',
      ),
      h2('Duplicates and fraud'),
      p(
        'Most duplicates are honest mistakes. Some are not: slightly altered copies of real invoices, or invoices from a lookalike supplier name, can be used deliberately. The same controls catch both, which is why duplicate checks belong before approval, not in an annual audit.',
      ),
      h2('If a duplicate payment has already gone out'),
      ol(
        'Confirm it: same supplier, same invoice, paid twice.',
        'Write to the supplier with both payment references and ask for a refund or a credit note against future invoices.',
        'Make sure input tax credit was claimed only once.',
        'Find out how the second copy got in and close that route.',
      ),
      h2('Stop duplicates at the door'),
      p(
        'Veyrafy checks every invoice against those already received before it is cleared, using the supplier and a normalised invoice number, and holds a possible duplicate for a person to decide. You can read more about checking invoices before payment in [how to check a GST invoice is genuine](/blog/how-to-check-gst-invoice-genuine).',
      ),
      CHALLENGE('Find out what slips past in your own invoices.'),
    ],
    faq: [
      {
        q: 'How do I detect duplicate invoices in accounts payable?',
        a: 'Compare the supplier, a normalised invoice number and the amount for every new invoice against all invoices already received. Normalise the number first so that formats like INV/0042 and 42 are recognised as the same.',
      },
      {
        q: 'Can a supplier send two invoices with the same number?',
        a: 'Not within one financial year. Rule 46 of the CGST Rules requires a unique serial number, so the same number from the same supplier in the same year points to a duplicate or an error.',
      },
      {
        q: 'How do we recover a duplicate payment?',
        a: 'Write to the supplier with both payment references and ask for a refund or a credit note to be adjusted against future invoices. Check that GST credit was claimed only once.',
      },
    ],
  },

  // ── 5 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'gst-180-day-rule-itc-reversal',
    category: 'finance-operations',
    title: 'The GST 180-day rule: when unpaid supplier invoices cost you your ITC',
    seoTitle: 'GST 180-Day Rule: When Unpaid Invoices Cost You ITC',
    metaDescription:
      'Under the GST 180-day rule, ITC must be reversed if a supplier is not paid within 180 days. How the 180-day rule works, the exceptions and re-claiming.',
    excerpt:
      'Pay a supplier late and you can lose the input tax credit on the invoice. How the GST 180-day rule works, what is excluded, and how to claim the credit back.',
    focusKeyword: '180-day rule',
    blocks: [
      p(
        'Under GST, the **180-day rule** ties your input tax credit to paying your suppliers. If you have not paid the value of a supply and the tax on it within 180 days of the invoice date, the credit you took on that invoice has to be reversed. Pay later and you can claim it again, but the interest is a real cost.',
      ),
      h2('What the law says'),
      p(
        'The rule is in the second proviso to **section 16(2) of the CGST Act**, read with **Rule 37 of the CGST Rules**. In plain terms:',
      ),
      ul(
        'If you fail to pay the supplier the value of the supply plus tax within 180 days of the invoice date, an amount equal to the input tax credit you availed on it must be paid back, with interest under section 50.',
        'If you paid only part of the invoice, the reversal is proportionate to the unpaid part.',
        'When you later pay the supplier, you can take the credit again.',
      ),
      h2('A worked example'),
      table(
        ['', 'Amount'],
        [
          ['Invoice date', '1 April'],
          ['Taxable value', '₹1,00,000'],
          ['GST at 18%', '₹18,000'],
          ['Paid by 28 September (180 days)', '₹59,000 of ₹1,18,000'],
          ['Unpaid share', '50%'],
          ['Credit to reverse', '₹9,000 (50% of ₹18,000), with interest'],
        ],
        'Illustrative example',
      ),
      p(
        'When the remaining ₹59,000 is paid, the ₹9,000 can be claimed again. The interest is not refunded.',
      ),
      h2('What the rule does not cover'),
      ul(
        'supplies on which you pay tax yourself under **reverse charge**;',
        'supplies made without consideration that count as supplies under **Schedule I** of the CGST Act;',
        'amounts added to the value of a supply under section 15(2)(b), where you paid an amount the supplier was liable to pay.',
      ),
      h2('How to stay on the right side of the rule'),
      ol(
        'Run a payables ageing report every month and flag invoices approaching 180 days.',
        'Know why each old invoice is unpaid: a dispute, a missing GRN, a quality issue, or simply forgotten.',
        'Resolve disputes with a credit note rather than leaving an invoice partly unpaid indefinitely.',
        'When an invoice crosses 180 days unpaid, report the reversal in that period’s GSTR-3B, and keep a list so the credit is re-claimed when you pay.',
      ),
      tip(
        'Many invoices that cross 180 days were stuck waiting for a check: a missing goods receipt, a rate the PO does not support. Checking invoices when they arrive, not when the payment is due, keeps them from going stale.',
      ),
      h2('Where Veyrafy fits'),
      p(
        'Veyrafy checks each supplier invoice against your purchase orders and goods receipts as soon as it arrives, so problems are raised with the supplier while there is plenty of time. See also [three-way matching explained](/blog/three-way-matching-po-grn-invoice).',
      ),
      CHALLENGE('Want invoices cleared or questioned on day one?'),
      NOT_ADVICE,
    ],
    faq: [
      {
        q: 'Does the 180-day rule apply to partial payments?',
        a: 'Yes. If part of the invoice is unpaid after 180 days, the credit to reverse is proportionate to the unpaid part, under Rule 37 of the CGST Rules.',
      },
      {
        q: 'Can I re-claim ITC after paying the supplier late?',
        a: 'Yes. Once you pay the supplier the value and the tax, the credit can be taken again. The interest paid on the reversal is not returned.',
      },
      {
        q: 'Does the 180-day rule apply to reverse charge purchases?',
        a: 'No. Supplies on which you pay tax under reverse charge are excluded from the 180-day condition.',
      },
    ],
  },

  // ── 6 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'gst-invoice-mandatory-fields-rule-46',
    category: 'gst-invoice-accuracy',
    title: 'GST invoice mandatory fields under Rule 46: a checklist for every supplier bill',
    seoTitle: 'GST Invoice Mandatory Fields Under Rule 46: Checklist',
    metaDescription:
      'The GST invoice mandatory fields under Rule 46 of the CGST Rules, what to check on each supplier bill, and what to do when a field is missing or wrong.',
    excerpt:
      'Every field a GST tax invoice must carry under Rule 46, in plain language, with what to check on supplier bills and what to do when one is missing.',
    focusKeyword: 'gst invoice mandatory fields',
    blocks: [
      p(
        'A supplier invoice is not just a request for payment. For you, it is the document that supports your input tax credit. **Rule 46 of the CGST Rules** lists the GST invoice mandatory fields, and an invoice missing one of them can put that credit at risk.',
      ),
      h2('The mandatory fields'),
      table(
        ['Field', 'What to check'],
        [
          ['Supplier name, address and GSTIN', 'GSTIN active and registered to this supplier'],
          ['Invoice number', 'Consecutive, up to 16 characters, unique for the financial year'],
          ['Date of issue', 'Not in the future; sensible for the delivery'],
          ['Recipient name, address and GSTIN', 'Your details, exactly right'],
          ['Place of supply, with the state name', 'Decides CGST and SGST or IGST'],
          ['Delivery address, if different', 'Matches where goods actually went'],
          [
            'HSN or SAC code',
            'Six digits if supplier turnover is above ₹5 crore, at least four otherwise',
          ],
          ['Description of goods or services', 'Recognisably what you ordered'],
          ['Quantity and unit', 'Matches what was received'],
          ['Total value and taxable value', 'After any discount or abatement'],
          ['Rate and amount of tax', 'CGST, SGST or UTGST, IGST and cess shown separately'],
          ['Whether tax is payable on reverse charge', 'Stated where it applies'],
          ['Signature or digital signature', 'Of the supplier or an authorised person'],
        ],
        'Mandatory fields on a tax invoice, summarised from Rule 46 of the CGST Rules',
      ),
      note(
        'Suppliers with aggregate turnover above ₹5 crore must also issue B2B invoices as e-invoices, which carry an IRN and a QR code.',
      ),
      h2('The fields that cause the most trouble'),
      h3('Your GSTIN'),
      p(
        'A wrong or missing recipient GSTIN means the invoice will not reach your GSTR-2B, and the credit is not available until it is corrected. It is the single most important field to check on arrival.',
      ),
      h3('Place of supply'),
      p(
        'Place of supply decides whether the invoice should carry CGST and SGST or IGST. Tax paid under the wrong head is not simply moved across; the supplier has to correct it, which takes time.',
      ),
      h3('HSN codes and rates'),
      p(
        'Wrong HSN codes often travel with wrong GST rates. If the rate looks unusual for what you bought, check the code.',
      ),
      h3('Invoice number'),
      p(
        'Because numbers must be unique in a financial year, the invoice number is also your best defence against [paying the same invoice twice](/blog/duplicate-invoice-payments).',
      ),
      h2('What to do when a field is missing or wrong'),
      ol(
        'Hold the invoice; do not approve it for payment yet.',
        'Ask the supplier for a corrected invoice, or a credit or debit note where the value or tax is wrong.',
        'Make sure the corrected document is what reaches GSTR-2B.',
        'Pay against the corrected invoice.',
      ),
      h2('Checking every invoice, not just the big ones'),
      p(
        'Rule 46 errors are as likely on a ₹5,000 bill as on a ₹5 lakh one. Veyrafy reads every supplier invoice, checks the GSTINs, tax type, rates and arithmetic, and compares it with your own records, so problems are caught on arrival. More in [how to check a GST invoice is genuine](/blog/how-to-check-gst-invoice-genuine).',
      ),
      CHALLENGE('See how your supplier invoices measure up.'),
      NOT_ADVICE,
    ],
    faq: [
      {
        q: 'How many fields are mandatory on a GST invoice?',
        a: 'Rule 46 of the CGST Rules lists the particulars a tax invoice must contain, summarised in the table above. Some apply only in certain cases, such as the delivery address when it differs from the billing address, or the reverse charge statement.',
      },
      {
        q: 'How many HSN digits must an invoice show?',
        a: 'Suppliers with aggregate turnover above ₹5 crore must show six digits on B2B invoices. Suppliers with turnover up to ₹5 crore must show at least four digits.',
      },
      {
        q: 'Can I claim ITC on an invoice with a missing field?',
        a: 'Credit depends on holding a valid tax invoice and on the invoice reaching your GSTR-2B. Missing particulars put the credit at risk, so ask the supplier to correct the invoice.',
      },
    ],
  },

  // ── 7 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'gst-invoice-management-system-ims',
    category: 'gst-invoice-accuracy',
    title: 'GST Invoice Management System (IMS): a practical guide for accounts teams',
    seoTitle: 'GST Invoice Management System (IMS): A Practical Guide',
    metaDescription:
      'The GST invoice management system (IMS) lets you accept, reject or keep pending supplier invoices before GSTR-2B. What each action does and how to use it.',
    excerpt:
      'The Invoice Management System lets you accept, reject or keep pending each supplier invoice before it reaches GSTR-2B. What each action does and how to use it well.',
    focusKeyword: 'invoice management system',
    blocks: [
      p(
        'Since 14 October 2024, the GST portal has an **Invoice Management System**, or IMS. It shows you every invoice your suppliers report against your GSTIN and lets you act on each one before it decides your GSTR-2B. Used well, the Invoice Management System is the last checkpoint between a wrong supplier invoice and a wrong credit claim.',
      ),
      h2('How the Invoice Management System works'),
      p(
        'When a supplier reports an invoice in GSTR-1, GSTR-1A or the Invoice Furnishing Facility, it appears on your IMS dashboard. For each invoice you can take one of three actions:',
      ),
      table(
        ['Action', 'What happens'],
        [
          ['Accept', 'The invoice is included in your GSTR-2B, and its credit counts as available'],
          ['Reject', 'The invoice is left out of your GSTR-2B'],
          ['Pending', 'The invoice is held back from this month’s GSTR-2B and carried forward'],
          ['No action', 'The invoice is treated as accepted'],
        ],
      ),
      p(
        'A draft GSTR-2B is generated on the 14th of the following month from what you have accepted or left without action. If you change your actions after that, you can have GSTR-2B generated again before you file GSTR-3B.',
      ),
      h2('Why “no action” matters'),
      p(
        'Doing nothing counts as accepting. A wrong invoice you never looked at flows into GSTR-2B as if you had approved it. The system is only as useful as the checking you do before the filing date.',
      ),
      h2('When to accept, reject or keep pending'),
      ul(
        '**Accept** when the invoice matches your purchase order and goods receipt, your GSTIN is right, and the tax is correct.',
        '**Reject** when you did not make the purchase, the amount or tax is wrong, or the invoice is a duplicate. Tell the supplier so they can correct it.',
        '**Keep pending** when the purchase is genuine but you are not ready to take the credit yet, for example because the goods have not arrived.',
      ),
      warning(
        'An invoice cannot stay pending forever. Credit for a financial year must be claimed by 30 November of the following year, or the date you file the annual return if earlier (section 16(4) of the CGST Act).',
      ),
      h2('A monthly IMS routine'),
      ol(
        'Through the month, check supplier invoices as they arrive against your own records.',
        'Before the 14th, review the IMS dashboard and compare it with what you have already checked.',
        'Reject what is wrong, keep pending what is early, accept the rest.',
        'Read the draft GSTR-2B, then [reconcile it with your books](/blog/gstr-2b-mismatch-itc).',
      ),
      h2('Your own checks come first'),
      p(
        'IMS tells you what your suppliers reported. It cannot tell you whether the goods arrived, whether the rate is what you agreed, or whether you have seen the invoice before. Those answers are in your own records. Veyrafy checks each invoice against them on arrival, so by the time you open IMS you already know which invoices to accept.',
      ),
      CHALLENGE('Try it on five of your invoices.'),
      NOT_ADVICE,
    ],
    faq: [
      {
        q: 'What happens if I do not take any action in IMS?',
        a: 'Invoices with no action are treated as accepted and flow into your GSTR-2B. That is why it pays to review the dashboard before the draft GSTR-2B is generated.',
      },
      {
        q: 'When is GSTR-2B generated under IMS?',
        a: 'A draft GSTR-2B is generated on the 14th of the month after the tax period. If you change actions afterwards, you can have it generated again before filing GSTR-3B.',
      },
      {
        q: 'Should I reject an invoice with a small error?',
        a: 'If the tax or value is wrong, rejecting it and asking the supplier to correct it keeps your credit accurate. If the purchase is genuine and correct but early, keeping it pending is usually the better choice.',
      },
    ],
  },

  // ── 8 ─────────────────────────────────────────────────────────────────────
  {
    slug: 'common-supplier-invoice-errors',
    category: 'invoice-verification',
    title: 'Seven supplier invoice errors to check before you pay',
    seoTitle: '7 Supplier Invoice Errors to Check Before You Pay',
    metaDescription:
      'Seven supplier invoice errors that cost money: wrong rates, quantities not received, wrong GST, bad totals, freight and duplicates. Check before you pay.',
    excerpt:
      'Most overpayments come from a handful of ordinary mistakes. Seven supplier invoice errors to check before you pay, and how to catch them every time.',
    focusKeyword: 'supplier invoice errors',
    blocks: [
      p(
        'Most overpayments are not fraud. They are ordinary supplier invoice errors that nobody noticed because the total looked about right. Here are the seven that come up most often, and what to check for each.',
      ),
      h2('1. A rate above the agreed price'),
      p(
        'The supplier bills ₹47 for an item you agreed at ₹45. On one line it is small; across a year of orders it adds up. Check every line’s rate against the purchase order or your agreed price list, not just the total.',
      ),
      h2('2. Billed for more than you received'),
      p(
        'You ordered 100 and received 90, but the invoice says 100. This is why the goods receipt matters: [three-way matching](/blog/three-way-matching-po-grn-invoice) compares the billed quantity with what actually arrived.',
      ),
      h2('3. The wrong GST rate or tax type'),
      p(
        'A line taxed at 18% that should be 12%, or IGST charged on a supply within your own state. Wrong tax is a problem even when the total looks small, because it affects your input tax credit and has to be corrected by the supplier.',
      ),
      h2('4. Arithmetic that does not add up'),
      p(
        'Quantity times rate does not give the line amount; the lines do not add up to the taxable value; the tax is not the rate applied to the taxable value. Check the sums, not just the final figure.',
      ),
      h2('5. Round-off and totals'),
      p(
        'A round-off of a few paise is normal. A “round-off” of several rupees is not; it often hides an error in the tax or the lines.',
      ),
      h2('6. Freight and other charges'),
      p(
        'Freight, packing and loading charges that were not agreed, or freight added twice: once as a line and again in the footer. Where freight is taxable, check that the tax on it is right too.',
      ),
      h2('7. An item that does not match your records'),
      p(
        'The invoice says one thing, your purchase order says another. Sometimes it is just spelt differently (“MIRRIOR” for “MIRROR”) and the item is the same; sometimes it is a different item at a similar price. Either way, a person should confirm it rather than a system silently pairing two different items.',
      ),
      tip(
        'And one more: the invoice you have already paid. Duplicates deserve their own check; see [how duplicate invoice payments happen](/blog/duplicate-invoice-payments).',
      ),
      h2('Why these errors slip through'),
      p(
        'Each check is simple. The difficulty is doing all of them, on every line, on every invoice, when invoices arrive as scans and photos in a dozen different layouts. Teams under month-end pressure check the total and the supplier, and the line-level errors go straight into the payment run.',
      ),
      h2('How Veyrafy checks every invoice'),
      p(
        'Veyrafy reads each supplier invoice, checks the arithmetic, GST and GSTINs, and compares every line with your purchase orders, goods receipts or your accounting system’s export. Anything that differs is shown with the evidence from the invoice, and nothing is guessed: a value it cannot read with certainty is asked, not assumed.',
      ),
      CHALLENGE('See which of these turn up in your own invoices.'),
    ],
    faq: [
      {
        q: 'What are the most common invoice errors?',
        a: 'Rates above the agreed price, quantities billed but not received, wrong GST rates or tax type, arithmetic errors, unexplained round-off, unagreed or double-counted freight, and items that do not match your records.',
      },
      {
        q: 'How do I check a supplier invoice before payment?',
        a: 'Check the supplier and your GSTIN, compare each line’s item, quantity and rate with your purchase order and goods receipt, check the GST and the arithmetic, and make sure you have not already received or paid the same invoice.',
      },
      {
        q: 'What should I do if a supplier invoice has an error?',
        a: 'Hold the invoice and ask the supplier for a corrected invoice or a credit or debit note. Pay only the amount you agree is correct.',
      },
    ],
  },
];
