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

/**
 * Units of measure (RULES §1.4): a fixed synonym table onto canonical codes. Unknown units are
 * unparseable (null), never guessed. NOS and PCS are distinct units.
 */
const UOM_SYNONYMS: Readonly<Record<string, string>> = {
  KG: 'KGS',
  KGS: 'KGS',
  KILOGRAM: 'KGS',
  KILOGRAMS: 'KGS',
  NOS: 'NOS',
  NO: 'NOS',
  NUMBERS: 'NOS',
  PCS: 'PCS',
  PC: 'PCS',
  PIECES: 'PCS',
  REAM: 'REAM',
  REAMS: 'REAM',
  BOX: 'BOX',
  BOXES: 'BOX',
  MTR: 'MTR',
  METRE: 'MTR',
  METRES: 'MTR',
  LTR: 'LTR',
  LITRE: 'LTR',
  LITRES: 'LTR',
  SET: 'SET',
  SETS: 'SET',
  // GST unit codes (UQC) and their common spellings on Indian invoices.
  KILO: 'KGS',
  KILOS: 'KGS',
  L: 'LTR',
  LITER: 'LTR',
  LITERS: 'LTR',
  BAG: 'BAG',
  BAGS: 'BAG',
  BTL: 'BTL',
  BTLS: 'BTL',
  BOTTLE: 'BTL',
  BOTTLES: 'BTL',
  CAN: 'CAN',
  CANS: 'CAN',
  DOZ: 'DOZ',
  DOZEN: 'DOZ',
  DOZENS: 'DOZ',
  G: 'GMS',
  GM: 'GMS',
  GMS: 'GMS',
  GRAM: 'GMS',
  GRAMS: 'GMS',
  ML: 'ML',
  MLS: 'ML',
  PKT: 'PKT',
  PKTS: 'PKT',
  PACKET: 'PKT',
  PACKETS: 'PKT',
  PACK: 'PKT',
  PACKS: 'PKT',
  ROL: 'ROL',
  ROLL: 'ROL',
  ROLLS: 'ROL',
  PRS: 'PRS',
  PAIR: 'PRS',
  PAIRS: 'PRS',
  QTL: 'QTL',
  QUINTAL: 'QTL',
  QUINTALS: 'QTL',
  CTN: 'CTN',
  CARTON: 'CTN',
  CARTONS: 'CTN',
  TIN: 'TIN',
  TINS: 'TIN',
  JAR: 'JAR',
  JARS: 'JAR',
  DRM: 'DRM',
  DRUM: 'DRM',
  DRUMS: 'DRM',
  TON: 'TON',
  TONS: 'TON',
  TONNE: 'TON',
  TONNES: 'TON',
  UNT: 'UNT',
  UNIT: 'UNT',
  UNITS: 'UNT',
};

export function normalizeUom(uom: string): string | null {
  const key = uom.normalize('NFKC').trim().toUpperCase().replace(/\.$/, '');
  return UOM_SYNONYMS[key] ?? null;
}
