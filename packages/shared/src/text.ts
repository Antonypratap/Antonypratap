/**
 * Deterministic text normalisation from RULES.md §1.4–1.5. These define what "normalised"
 * means in ERP lookups; the ERP stores and queries the same normal forms.
 */

const NAME_STOP_TOKENS = new Set([
  'm',
  's',
  'ms',
  'pvt',
  'private',
  'ltd',
  'limited',
  'llp',
  'co',
  'company',
  'and',
  'the',
]);

/**
 * Normalises a party or item name for building candidate lists (never for auto-linking):
 * NFKC, lowercase, `&` → space, strip `. , ( ) ' " - /`, collapse whitespace, drop legal-form
 * and filler tokens.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('&', ' ')
    .replace(/[.,()'"\-/]/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '' && !NAME_STOP_TOKENS.has(token))
    .join(' ');
}

/** Invoice numbers for duplicate detection: NFKC, uppercase, all whitespace removed; nothing else changes. */
export function normalizeInvoiceNumber(invoiceNumber: string): string {
  return invoiceNumber.normalize('NFKC').toUpperCase().replace(/\s+/g, '');
}
