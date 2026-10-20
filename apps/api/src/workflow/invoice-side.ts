import type { ExtractionResult } from '@veyra/shared';
import { readField, type JsonValue, type StoredField } from '../engine/fields';
import { toPaise, type InvoiceSide } from './erp-receipts';

/**
 * What an invoice says, as Veyrafy read it, for a comparison with a record (the receipt check and
 * the verification API use this one implementation). A value below the confidence threshold, or
 * one that does not parse, is "not read" (null): never a guess, and never filled from the record
 * it is compared with.
 */
export function invoiceSideFrom(
  fields: ReadonlyMap<string, StoredField>,
  lineNos: readonly number[],
  otherFields: readonly { label: string; value: string }[],
  minConfidenceBp: number,
): InvoiceSide {
  const v = <T extends string | number>(path: string) =>
    readField<T>(fields, path as never, minConfidenceBp).value;
  // Printed but not read with certainty: never taken as "not printed" (zero) by the comparison.
  const unclear = [
    'header.taxablePaise',
    'header.cgstPaise',
    'header.sgstPaise',
    'header.igstPaise',
    'header.roundOffPaise',
    'header.totalPaise',
  ].filter((path) => {
    const state = readField(fields, path as never, minConfidenceBp).state;
    return state !== 'usable' && state !== 'absent';
  });
  const freight = otherFields
    .filter((o) => /freight|cartage|carriage|transport/i.test(o.label))
    .map((o) => toPaise(o.value.replace(/[₹\s]|Rs\.?/gi, '')))
    .filter((p): p is number => p !== null);
  return {
    vendorName: v<string>('header.vendorName'),
    vendorGstin: v<string>('header.vendorGstin'),
    invoiceNumber: v<string>('header.invoiceNumber'),
    invoiceDate: v<string>('header.invoiceDate'),
    poNumber: v<string>('header.poNumber'),
    taxablePaise: v<number>('header.taxablePaise'),
    cgstPaise: v<number>('header.cgstPaise'),
    sgstPaise: v<number>('header.sgstPaise'),
    igstPaise: v<number>('header.igstPaise'),
    roundOffPaise: v<number>('header.roundOffPaise'),
    totalPaise: v<number>('header.totalPaise'),
    freightPaise: freight.length ? freight.reduce((a, b) => a + b, 0) : null,
    unclear,
    lines: lineNos.map((lineNo) => ({
      lineNo,
      description: v<string>(`lines[${lineNo}].description`),
      hsnSac: v<string>(`lines[${lineNo}].hsnSac`),
      uom: v<string>(`lines[${lineNo}].uom`),
      qtyMilli: v<number>(`lines[${lineNo}].qtyMilli`),
      unitPricePaise: v<number>(`lines[${lineNo}].unitPricePaise`),
      taxablePaise: v<number>(`lines[${lineNo}].taxablePaise`),
      gstRateBp: v<number>(`lines[${lineNo}].gstRateBp`),
    })),
  };
}

/** A reading's fields as stored fields (the same paths and rules as `extracted_fields`). */
export function fieldsFromExtraction(result: ExtractionResult): Map<string, StoredField> {
  const out = new Map<string, StoredField>();
  const add = (path: string, f: unknown) => {
    const field = f as {
      value: JsonValue;
      confidenceBp: number;
      source: StoredField['source'];
      evidence: StoredField['evidence'];
    };
    out.set(path, {
      path: path as StoredField['path'],
      value: field.value,
      confidenceBp: field.confidenceBp,
      source: field.source,
      evidence: field.evidence,
      evidenceDetail: null,
    });
  };
  for (const [key, f] of Object.entries(result.header)) add(`header.${key}`, f);
  for (const line of result.lines)
    for (const [key, f] of Object.entries(line))
      if (key !== 'lineNo') add(`lines[${line.lineNo}].${key}`, f);
  return out;
}
