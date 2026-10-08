import { readCsv } from './csv';
import { isCompoundFile, readXls } from './xls';
import { readXlsx, SpreadsheetError, type Sheet } from './xlsx';

/**
 * Any spreadsheet a person uploads: .xlsx, legacy .xls or CSV, told apart by their first bytes
 * (never by the file name or the browser's type). Everything else is refused.
 */
export type SpreadsheetKind = 'xlsx' | 'xls' | 'csv' | 'other';

export function spreadsheetKind(bytes: Uint8Array): SpreadsheetKind {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    return 'xlsx';
  if (isCompoundFile(bytes)) return 'xls';
  // Text: no NUL bytes in the first 4 KB. Anything binary that is not a workbook is refused.
  const head = bytes.subarray(0, 4096);
  if (head.includes(0) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) return 'other';
  return 'csv';
}

export const SPREADSHEET_ONLY = 'Upload an Excel workbook (.xlsx or .xls) or a CSV file.';

/** The sheets of an uploaded spreadsheet. A CSV is one sheet named after the file. */
export function readSpreadsheet(
  bytes: Uint8Array,
  filename: string,
): { kind: Exclude<SpreadsheetKind, 'other'>; sheets: Sheet[]; date1904: boolean } {
  const kind = spreadsheetKind(bytes);
  if (kind === 'xlsx') return { kind, ...readXlsx(bytes) };
  if (kind === 'xls') return { kind, ...readXls(bytes) };
  if (kind === 'csv')
    return {
      kind,
      sheets: [{ name: filename.replace(/\.[^.]*$/, ''), rows: readCsv(bytes, filename) }],
      date1904: false,
    };
  throw new SpreadsheetError(SPREADSHEET_ONLY);
}
