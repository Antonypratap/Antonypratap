import { createHash } from 'node:crypto';
import {
  ExtractionResultSchema,
  confidenceBp,
  formatInr,
  formatQty,
  formatRate,
  milliQty,
  paise,
  rateBp,
  type ExtractionResult,
} from '@veyra/shared';
import { renderPdf, renderPng } from './document';
import { DEMO_BUYER, type FixtureScenario } from './scenarios';

const money = (p: number): string => formatInr(paise(p), { symbol: false });
const dmy = (iso: string): string => iso.split('-').reverse().join('/');

/** The text printed on the scenario's document, top to bottom. */
export function documentLines(s: FixtureScenario): string[] {
  const lines = [
    'TAX INVOICE',
    s.vendor.name,
    s.vendor.address,
    `GSTIN: ${s.vendor.gstin}`,
    `Invoice No: ${s.invoiceNumber}    Date: ${dmy(s.invoiceDate)}`,
    ...(s.poNumber ? [`PO No: ${s.poNumber}`] : []),
    `Bill to: ${DEMO_BUYER.name}, GSTIN: ${s.buyerGstin}`,
    ...(s.placeOfSupply ? [`Place of Supply: ${s.placeOfSupply}`] : []),
    ...(s.shipTo
      ? [`Ship to: ${[s.shipTo.state, s.shipTo.gstin].filter(Boolean).join(', GSTIN: ')}`]
      : []),
    '#  Description  HSN  Qty  Rate  Taxable  GST',
    ...s.lines.map(
      (l, i) =>
        `${i + 1}  ${l.description}${l.vendorItemCode ? ` [${l.vendorItemCode}]` : ''}  ${l.hsnSac}  ` +
        `${formatQty(milliQty(l.qtyMilli))} ${l.uom}  ${money(l.unitPricePaise)}  ${money(l.taxablePaise)}  ` +
        formatRate(rateBp(l.gstRateBp)),
    ),
    `Taxable value: ${money(s.taxablePaise)}`,
    ...(s.cgstPaise !== null ? [`CGST: ${money(s.cgstPaise)}`] : []),
    ...(s.sgstPaise !== null ? [`SGST: ${money(s.sgstPaise)}`] : []),
    ...(s.igstPaise !== null ? [`IGST: ${money(s.igstPaise)}`] : []),
    ...(s.roundOffPaise !== null ? [`Round off: ${money(s.roundOffPaise)}`] : []),
    `Invoice total: Rs. ${money(s.totalPaise)}`,
  ];
  return lines;
}

export function scenarioMime(s: FixtureScenario): 'application/pdf' | 'image/png' {
  return s.kind === 'pdf' ? 'application/pdf' : 'image/png';
}

/** The scenario's document bytes. Deterministic: the same scenario always gives the same bytes. */
export function renderScenario(s: FixtureScenario): Uint8Array {
  const lines = documentLines(s);
  if (s.kind === 'pdf') return renderPdf(lines);
  const seed = createHash('sha256').update(s.id).digest().readUInt32BE(0);
  return renderPng(lines, seed);
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * What an extractor reads from the scenario's document: every printed value with its evidence.
 * Clean PDFs read at 0.99; photos at 0.94, except the fields a scenario marks as weak.
 */
export function scenarioExtraction(s: FixtureScenario): ExtractionResult {
  const base = s.kind === 'pdf' ? 9900 : 9400;
  const field = <T>(value: T | null, printed: string | null) => ({
    value,
    confidenceBp: confidenceBp(base),
    evidence: value === null || printed === null ? null : { page: 1, text: printed, bbox: null },
    source: 'fixture' as const,
  });
  const weak = <T>(key: 'vendorGstin' | 'totalPaise', value: T, printed: string) => {
    const w = s.weak?.[key];
    return w
      ? {
          value: w.value,
          confidenceBp: confidenceBp(w.confidenceBp),
          evidence: { page: 1, text: `${printed} (hard to read)`, bbox: null },
          source: 'fixture' as const,
        }
      : field(value, printed);
  };
  const tax = (v: number | null, label: string) =>
    field(v, v === null ? null : `${label}: ${money(v)}`);
  const result = {
    extractor: { id: 'fixture', version: '1' },
    header: {
      vendorName: field(s.vendor.name, s.vendor.name),
      vendorGstin: weak('vendorGstin', s.vendor.gstin, `GSTIN: ${s.vendor.gstin}`),
      vendorAddress: field(s.vendor.address, s.vendor.address),
      vendorPan: field(null, null),
      buyerGstin: field(s.buyerGstin, `Bill to GSTIN: ${s.buyerGstin}`),
      billingAddress: field(null, null),
      placeOfSupply: field(
        s.placeOfSupply,
        s.placeOfSupply && `Place of Supply: ${s.placeOfSupply}`,
      ),
      shipToState: field(s.shipTo?.state ?? null, s.shipTo?.state ?? null),
      shipToGstin: field(s.shipTo?.gstin ?? null, s.shipTo?.gstin ?? null),
      shipToAddress: field(null, null),
      invoiceNumber: field(s.invoiceNumber, `Invoice No: ${s.invoiceNumber}`),
      invoiceDate: field(s.invoiceDate, `Date: ${dmy(s.invoiceDate)}`),
      poNumber: field(s.poNumber, s.poNumber && `PO No: ${s.poNumber}`),
      taxablePaise: field(s.taxablePaise, `Taxable value: ${money(s.taxablePaise)}`),
      cgstPaise: tax(s.cgstPaise, 'CGST'),
      sgstPaise: tax(s.sgstPaise, 'SGST'),
      igstPaise: tax(s.igstPaise, 'IGST'),
      cessPaise: field(null, null),
      roundOffPaise: tax(s.roundOffPaise, 'Round off'),
      totalPaise: weak('totalPaise', s.totalPaise, `Invoice total: ${money(s.totalPaise)}`),
    },
    lines: s.lines.map((l, i) => {
      const row = `line ${i + 1}: ${l.description}`;
      return {
        lineNo: i + 1,
        description: field(l.description, row),
        vendorItemCode: field(l.vendorItemCode ?? null, l.vendorItemCode ?? null),
        hsnSac: field(l.hsnSac, `${row}, HSN ${l.hsnSac}`),
        qtyMilli: field(l.qtyMilli, `${row}, ${formatQty(milliQty(l.qtyMilli))} ${l.uom}`),
        uom: field(l.uom, `${row}, ${l.uom}`),
        unitPricePaise: field(l.unitPricePaise, `${row}, rate ${money(l.unitPricePaise)}`),
        discountPaise: field(null, null),
        taxablePaise: field(l.taxablePaise, `${row}, taxable ${money(l.taxablePaise)}`),
        gstRateBp: field(l.gstRateBp, `${row}, GST ${formatRate(rateBp(l.gstRateBp))}`),
        cgstPaise: field(null, null),
        sgstPaise: field(null, null),
        igstPaise: field(null, null),
        lineTotalPaise: field(null, null),
      };
    }),
    pages: 1,
    warnings: s.kind === 'photo' ? ['Phone photo: read with lower confidence.'] : [],
  };
  return ExtractionResultSchema.parse(result);
}
