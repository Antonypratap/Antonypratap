import type { Cell, SheetRow } from './xlsx';
import { MAX_COLUMNS, MAX_ROWS, SpreadsheetError } from './xlsx';

/**
 * CSV (RFC 4180, comma-separated, UTF-8). Every value is text; nothing is evaluated.
 */
export function readCsv(bytes: Uint8Array, name: string): SheetRow[] {
  let text = Buffer.from(bytes).toString('utf8');
  if (text.includes('\u0000')) throw new SpreadsheetError(`${name} is not a text (CSV) file.`);
  if (text.startsWith('﻿')) text = text.slice(1);
  const rows: SheetRow[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let rowNumber = 1;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) {
      if (rows.length >= MAX_ROWS)
        throw new SpreadsheetError(`${name} has more than ${MAX_ROWS} rows.`);
      rows.push({
        rowNumber,
        cells: row.slice(0, MAX_COLUMNS).map((t): Cell => ({
          text: t,
          kind: t === '' ? 'empty' : 'string',
          format: null,
          formula: false,
        })),
      });
    }
    row = [];
    rowNumber++;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else field += ch;
  }
  if (quoted) throw new SpreadsheetError(`${name} has an unclosed quote.`);
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Writes CSV. A value starting with = + - @ (or a tab/CR) is prefixed with an apostrophe so a
 * spreadsheet opening the export never treats it as a formula (CSV injection guard).
 */
const BOM = String.fromCharCode(0xfeff);

export function writeCsv(rows: readonly (string | number | null)[][]): Buffer {
  const cell = (v: string | number | null): string => {
    if (v === null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from(`${BOM}${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`, 'utf8');
}
