import { readZip, writeZip, ZipError, type ZipLimits, DEFAULT_ZIP_LIMITS } from './zip';

/**
 * Just enough of the Office Open XML spreadsheet format to read and write simple tables.
 *
 * Reading treats the file as untrusted data: only cell VALUES are read. Formulas are never
 * evaluated (a formula cell yields the value Excel stored with it, or nothing), macros, external
 * links and embedded objects are ignored, and size limits apply throughout. Cell styles are read
 * only to recognise date and percentage cells, so 18% and 01/09/2026 mean what the user sees.
 */

export type CellKind = 'string' | 'number' | 'boolean' | 'error' | 'empty';

export interface Cell {
  /** The stored value as text, exactly as in the file (numbers are never turned into floats). */
  text: string;
  kind: CellKind;
  /** Display format of a numeric cell, when it matters for meaning. */
  format: 'date' | 'percent' | null;
  /** True when the cell held a formula; its stored result is used, never recalculated. */
  formula: boolean;
}

export interface SheetRow {
  /** 1-based row number as the user sees it in Excel. */
  rowNumber: number;
  cells: Cell[];
}

export interface Sheet {
  name: string;
  rows: SheetRow[];
}

export interface Workbook {
  sheets: Sheet[];
  /** True when dates are counted from 1904 (older Mac Excel). */
  date1904: boolean;
}

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

export const MAX_ROWS = 20_000;
export const MAX_COLUMNS = 60;

const EMPTY: Cell = { text: '', kind: 'empty', format: null, formula: false };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isSafeInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** Removes namespace prefixes from element names (`<x:row>` → `<row>`), leaving attributes. */
const stripPrefixes = (xml: string): string => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');

const attr = (attrs: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1] ?? '') : null;
};

/** Text of every <t> inside a string item, skipping phonetic runs. */
function stringItemText(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g))
    out += decodeXml(m[1] ?? '');
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_PERCENT_FORMATS = new Set([9, 10]);

function classifyFormat(id: number, custom: Map<number, string>): Cell['format'] {
  if (BUILTIN_PERCENT_FORMATS.has(id)) return 'percent';
  if (BUILTIN_DATE_FORMATS.has(id)) return 'date';
  const code = custom.get(id);
  if (!code) return null;
  const plain = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  if (plain.includes('%')) return 'percent';
  if (/[dmyhs]/i.test(plain)) return 'date';
  return null;
}

export function readXlsx(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Workbook {
  let zip: ReturnType<typeof readZip>;
  try {
    zip = readZip(bytes, limits);
  } catch (e) {
    throw new SpreadsheetError(
      e instanceof ZipError
        ? `This is not a readable .xlsx file (${e.message}).`
        : 'This is not a readable .xlsx file.',
    );
  }
  const text = (name: string): string | null => {
    const b = zip.read(name);
    return b ? stripPrefixes(b.toString('utf8')) : null;
  };
  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) throw new SpreadsheetError('This is not an Excel workbook (.xlsx).');
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(workbookXml);

  const rels = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\b([^>]*)\/?>/g,
  )) {
    const id = attr(m[1] ?? '', 'Id');
    const target = attr(m[1] ?? '', 'Target');
    if (id && target)
      rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }

  const shared: string[] = [];
  for (const m of (text('xl/sharedStrings.xml') ?? '').matchAll(
    /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g,
  ))
    shared.push(stringItemText(m[1] ?? ''));

  const stylesXml = text('xl/styles.xml') ?? '';
  const customFormats = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1] ?? '', 'numFmtId'));
    const code = attr(m[1] ?? '', 'formatCode');
    if (Number.isSafeInteger(id) && code !== null) customFormats.set(id, code);
  }
  const xfFormats: Cell['format'][] = [];
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  for (const m of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    xfFormats.push(classifyFormat(Number(attr(m[1] ?? '', 'numFmtId') ?? '0'), customFormats));
  }

  const sheets: Sheet[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1] ?? '', 'name') ?? 'Sheet';
    const rid = attr(m[1] ?? '', 'r:id') ?? attr(m[1] ?? '', 'id');
    const path = rid ? rels.get(rid) : undefined;
    const xml = path ? text(path) : null;
    if (!xml) continue;
    sheets.push({ name, rows: readSheet(xml, shared, xfFormats, name) });
  }
  return { sheets, date1904 };
}

function readSheet(
  xml: string,
  shared: readonly string[],
  xfFormats: readonly Cell['format'][],
  sheetName: string,
): SheetRow[] {
  const data =
    /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>|<sheetData\b[^>]*\/>/.exec(xml)?.[1] ?? '';
  const rows: SheetRow[] = [];
  let implicitRow = 0;
  for (const rm of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rm[1] ?? '', 'r') ?? implicitRow + 1);
    implicitRow = rowNumber;
    if (rows.length >= MAX_ROWS)
      throw new SpreadsheetError(`Sheet "${sheetName}" has more than ${MAX_ROWS} rows.`);
    const cells: Cell[] = [];
    let implicitCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1] ?? '';
      const body = cm[2] ?? '';
      const ref = attr(a, 'r');
      const col = ref ? columnIndex(ref) : implicitCol;
      implicitCol = col + 1;
      if (col >= MAX_COLUMNS) continue;
      const type = attr(a, 't') ?? 'n';
      const style = Number(attr(a, 's') ?? '0');
      const formula = /<f\b/.test(body);
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let cell: Cell;
      if (type === 'inlineStr')
        cell = {
          text: stringItemText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? ''),
          kind: 'string',
          format: null,
          formula,
        };
      else if (v === undefined) cell = { ...EMPTY, formula };
      else if (type === 's')
        cell = { text: shared[Number(v)] ?? '', kind: 'string', format: null, formula };
      else if (type === 'str') cell = { text: decodeXml(v), kind: 'string', format: null, formula };
      else if (type === 'b')
        cell = {
          text: v.trim() === '1' ? 'TRUE' : 'FALSE',
          kind: 'boolean',
          format: null,
          formula,
        };
      else if (type === 'e') cell = { text: decodeXml(v), kind: 'error', format: null, formula };
      else if (type === 'd')
        cell = { text: decodeXml(v).slice(0, 10), kind: 'string', format: null, formula };
      else cell = { text: v.trim(), kind: 'number', format: xfFormats[style] ?? null, formula };
      while (cells.length < col) cells.push(EMPTY);
      cells[col] = cell;
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

// ── Writing ─────────────────────────────────────────────────────────────────

export type OutCell =
  string | number | null | { money: string } | { text: string; bold?: boolean; wrap?: boolean };

export interface OutSheet {
  name: string;
  /** Column widths in characters. */
  widths: number[];
  rows: OutCell[][];
  /** Style the first row as bold headers and keep it visible when scrolling. */
  header: boolean;
}

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot carry.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const colName = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sheet: OutSheet): string {
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (cell === null || cell === '') return '';
          const headerStyle = sheet.header && r === 0 ? ' s="1"' : '';
          if (typeof cell === 'number') return `<c r="${ref}"${headerStyle}><v>${cell}</v></c>`;
          if (typeof cell === 'string')
            return `<c r="${ref}" t="inlineStr"${headerStyle}><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
          if ('money' in cell) return `<c r="${ref}" s="2"><v>${cell.money}</v></c>`;
          const s = cell.bold ? ' s="1"' : cell.wrap ? ' s="3"' : headerStyle;
          return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const cols = sheet.widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  const pane = sheet.header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

/** Writes a workbook. The same input always produces the same bytes. */
export function writeXlsx(sheets: readonly OutSheet[]): Buffer {
  const enc = (s: string) => Buffer.from(s, 'utf8');
  const sheetEntries = sheets.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: enc(sheetXml(s)),
  }));
  const safeName = (n: string) => n.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31);
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('')}</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map(
            (s, i) =>
              `<sheet name="${escapeXml(safeName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
          )
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: enc(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join(
            '',
          )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    { name: 'xl/styles.xml', data: enc(STYLES) },
    ...sheetEntries,
  ]);
}
