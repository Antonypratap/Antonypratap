/**
 * What search engines and link previews see of veyrafy.com, in one place. The page itself (the
 * FAQ section), the structured data and the crawlable copy in index.html are all built from this
 * file (vite.config.ts), so they can never say different things. Every statement here must be
 * true of the product today: no claim Veyrafy cannot back.
 *
 * Audience: finance controllers, CFOs and accounts payable teams at Indian businesses that buy
 * against purchase orders (manufacturers, distributors, breweries, retailers).
 */
export const SITE_URL = 'https://veyrafy.com/';

export const SEO = {
  title: 'Veyrafy · Accounts Payable Automation for Indian Businesses | GST Invoice Verification',
  description:
    'Veyrafy automates accounts payable for Indian finance teams: it reads supplier invoices (PDF, scan or photo), checks GSTIN and GST, matches each invoice to the purchase order and goods receipt, catches duplicates and records verified invoices in your ERP. Your team only handles the exceptions.',
  keywords: [
    'accounts payable automation India',
    'AP automation',
    'invoice processing software',
    'GST invoice verification',
    'GSTIN validation',
    'three-way matching',
    'purchase order matching',
    'goods receipt matching',
    'invoice OCR',
    'duplicate invoice detection',
    'input tax credit',
    'GSTR-2B reconciliation',
    'MSME payment 43B(h)',
    'vendor invoice automation',
    'finance automation for manufacturers',
  ],
  shareTitle: 'Veyrafy · Every invoice checked before you pay',
  shareDescription:
    'Accounts payable automation for Indian businesses. Veyrafy reads, checks and records supplier invoices against your POs, goods receipts and GST. Your team only sees the decisions.',
} as const;

/** The homepage's questions, shown on the page and given to search engines as FAQ data. */
export const FAQ: readonly { q: string; a: string }[] = [
  {
    q: 'What does Veyrafy do?',
    a: 'Veyrafy automates the routine work of accounts payable. It reads each supplier invoice, checks it against your purchase order, goods receipt and GST rules, and records the verified invoice in your ERP. Your finance team only sees the invoices that need a decision.',
  },
  {
    q: 'Who is Veyrafy for?',
    a: 'Finance and accounts payable teams at Indian businesses that buy against purchase orders: manufacturers, distributors, breweries, retailers and their finance controllers and CFOs.',
  },
  {
    q: 'What is three-way matching?',
    a: 'Three-way matching compares the supplier invoice with the purchase order and the goods receipt, so you pay only for what you ordered and actually received, at the agreed rate. Veyrafy does this line by line for every invoice.',
  },
  {
    q: 'Which GST checks does Veyrafy run?',
    a: 'GSTIN format, checksum and state code for you and the supplier; CGST and SGST or IGST depending on intra- or inter-state supply; HSN or SAC against your item master; line, tax and round-off arithmetic; and duplicates by supplier, invoice number and financial year.',
  },
  {
    q: 'Can it read scanned invoices and phone photos?',
    a: 'Yes. Veyrafy reads PDFs, scanned invoices and phone photos (JPEG or PNG). A value it cannot read with certainty is never guessed: Veyrafy asks your team.',
  },
  {
    q: 'Does Veyrafy pay suppliers?',
    a: 'No. Veyrafy never pays anything. It makes sure each invoice is correct and ready for payment; paying stays with your team.',
  },
  {
    q: 'Does it work with our accounting system?',
    a: 'Veyrafy works alongside the ERP or accounting system you already use: it reads your suppliers, orders and receipts and records verified invoices there. Talk to us about yours.',
  },
  {
    q: 'Who decides when an invoice does not match?',
    a: 'Your team. Veyrafy shows exactly what differs, asks the person who owns the decision and waits. Every check, question and decision is recorded in an audit trail.',
  },
  {
    q: 'How long does Veyrafy keep our invoices?',
    a: 'You choose: keep original invoice documents, delete them after successful processing and delivery, or delete them after a set number of days. Processing records and the audit history are kept separately.',
  },
];

/** The homepage as plain HTML, for crawlers that do not run JavaScript (same words as the page). */
export const CRAWLABLE_SUMMARY = {
  kicker: 'Accounts payable for Indian businesses',
  h1: 'Every invoice checked before you pay.',
  lede: 'Veyrafy reads each supplier invoice, matches it to the purchase order, the goods receipt and GST, then records it in your ERP. Your team only sees the decisions.',
  points: [
    'Reads PDFs, scans and phone photos of supplier invoices',
    'Validates GSTIN, CGST, SGST and IGST, HSN and SAC codes',
    'Three-way matching against purchase orders and goods receipts',
    'Catches duplicate invoices, short supplies and rates above the order',
    'Records verified invoices in your ERP; never pays anything',
    'Every check, question and decision kept in an audit trail',
  ],
} as const;
