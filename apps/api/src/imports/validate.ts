import {
  IsoDateSchema,
  formatQty,
  formatRate,
  milliQty,
  normalizeUom,
  paise,
  paiseToDecimalString,
  parseMoney,
  parseQuantity,
  parseRatePercent,
  rateBp,
  type ApiImportIssue,
  type ApiImportTable,
} from '@veyra/shared';
import { isValidHsnSac, resolveStateCode, stateName, validateGstin } from '@veyra/india-tax';
import type {
  ErpConnector,
  Grn,
  ImportBusinessRecordsInput,
  Item,
  PurchaseOrder,
  Vendor,
} from '@veyra/erp-connector';
import { readSpreadsheet } from '../spreadsheet/read';
import { SpreadsheetError, type Cell, type SheetRow } from '../spreadsheet/xlsx';
import {
  EXAMPLE_PREFIX,
  TABLE_ALIASES,
  TABLES,
  tableSpec,
  type ColumnSpec,
  type TableKey,
} from './spec';

/**
 * Whole-upload validation (Phase 3C). Everything is checked before anything is imported: file
 * type, sheets, headers, every cell, duplicates, references between records (in the upload or
 * already in the ERP), dates, quantities, and what already exists. The result is a preview with
 * row-level messages and, only when there are no errors, a batch ready for
 * ErpConnector.importBusinessRecords. Nothing is guessed and no missing record is created.
 */

export interface UploadedFile {
  filename: string;
  bytes: Uint8Array;
}

/** What the ERP already holds, read through ErpConnector before validating. */
export interface ErpSnapshot {
  vendors: Vendor[];
  items: Item[];
  purchaseOrders: PurchaseOrder[];
  grns: Grn[];
}

/** Reads everything validation compares against, through ErpConnector's browsing reads. */
export async function erpSnapshot(
  erp: Pick<ErpConnector, 'listVendors' | 'listItems' | 'listPurchaseOrders' | 'listGrns'>,
): Promise<ErpSnapshot> {
  const [vendors, items, purchaseOrders, grns] = await Promise.all([
    erp.listVendors(),
    erp.listItems(),
    erp.listPurchaseOrders(),
    erp.listGrns(),
  ]);
  return { vendors, items, purchaseOrders, grns };
}

export interface ImportCheck {
  tables: ApiImportTable[];
  errors: ApiImportIssue[];
  notices: string[];
  batch: Omit<ImportBusinessRecordsInput, 'importId'>;
}

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_FILES = 8;

interface Located {
  source: string;
  rows: SheetRow[];
}

interface Row {
  rowNumber: number;
  values: Record<string, string | number | null>;
  ok: boolean;
}

// ── Reading ─────────────────────────────────────────────────────────────────

const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');
const headerKey = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, '_');

function detectTable(name: string, rows: readonly SheetRow[]): TableKey | null {
  const byName = TABLE_ALIASES[letters(name)];
  if (byName) return byName;
  const header = rows.find((r) => r.cells.some((c) => c.text.trim() !== ''));
  if (!header) return null;
  const names = new Set(header.cells.map((c) => headerKey(c.text)));
  const matches = TABLES.filter((t) =>
    t.columns.filter((c) => c.required).every((c) => names.has(c.name)),
  );
  if (matches.length === 0) return null;
  // The most specific match (most required columns) wins.
  return (
    [...matches].sort(
      (a, b) =>
        b.columns.filter((c) => c.required).length - a.columns.filter((c) => c.required).length,
    )[0]?.key ?? null
  );
}

// ── Cell parsing ────────────────────────────────────────────────────────────

type Parsed = { ok: true; value: string | number | null } | { ok: false; message: string };

/** Moves the decimal point of a plain decimal string two places right (0.18 → 18), exactly. */
function timesHundred(text: string): string | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(2, '0');
  const whole = `${m[2] ?? ''}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, '') || '0';
  const rest = frac.slice(2);
  return `${m[1]}${whole}${rest ? `.${rest}` : ''}`;
}

function serialToIso(serial: string, date1904: boolean): string | null {
  if (!/^\d+$/.test(serial)) return null;
  const n = Number(serial);
  if (!date1904 && n < 61) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

function parseDate(cell: Cell, date1904: boolean): Parsed {
  const t = cell.text.trim();
  if (cell.kind === 'number') {
    const iso = serialToIso(t, date1904);
    return iso
      ? { ok: true, value: iso }
      : { ok: false, message: 'is not a valid date (a date without a time is expected).' };
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  const iso = dmy ? `${dmy[3]}-${dmy[2]?.padStart(2, '0')}-${dmy[1]?.padStart(2, '0')}` : t;
  return IsoDateSchema.safeParse(iso).success
    ? { ok: true, value: iso }
    : { ok: false, message: `“${t}” is not a valid date. Use YYYY-MM-DD or DD/MM/YYYY.` };
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/;

function parseCell(col: ColumnSpec, cell: Cell | undefined, date1904: boolean): Parsed {
  if (cell?.formula && cell.kind === 'empty')
    return {
      ok: false,
      message:
        'is a formula with no saved value. Veyrafy never calculates formulas: paste the value instead.',
    };
  if (!cell || cell.kind === 'empty' || cell.text.trim() === '') {
    return col.required ? { ok: false, message: 'is missing.' } : { ok: true, value: null };
  }
  if (cell.kind === 'error') return { ok: false, message: `contains an error (${cell.text}).` };
  const t = cell.text.trim();
  switch (col.kind) {
    case 'code':
      if (t.length > 40) return { ok: false, message: 'is longer than 40 characters.' };
      return CODE.test(t)
        ? { ok: true, value: t }
        : { ok: false, message: 'may only contain letters, digits, spaces and . _ / -' };
    case 'text':
      return t.length > 500
        ? { ok: false, message: 'is longer than 500 characters.' }
        : { ok: true, value: t };
    case 'gstin': {
      const g = t.toUpperCase();
      const r = validateGstin(g);
      if (r.ok) return { ok: true, value: g };
      return {
        ok: false,
        message:
          r.error.code === 'bad_checksum'
            ? `${g} is not valid: the check digit does not match.`
            : `${g} is not a valid GSTIN.`,
      };
    }
    case 'pan':
      return { ok: true, value: t.toUpperCase() };
    case 'state': {
      const r = resolveStateCode(t);
      return r.ok
        ? { ok: true, value: r.value }
        : { ok: false, message: `“${t}” is not a GST state name or code.` };
    }
    case 'yesno': {
      const v = t.toLowerCase();
      if (['yes', 'y', 'true', '1', 'active'].includes(v)) return { ok: true, value: 'yes' };
      if (['no', 'n', 'false', '0', 'inactive'].includes(v)) return { ok: true, value: 'no' };
      return { ok: false, message: 'must be yes or no.' };
    }
    case 'hsn':
      return isValidHsnSac(t)
        ? { ok: true, value: t }
        : {
            ok: false,
            message: `“${t}” must have 4, 6 or 8 digits${cell.kind === 'number' ? ' (enter it as text to keep leading zeros)' : ''}.`,
          };
    case 'uom': {
      const u = normalizeUom(t);
      return u
        ? { ok: true, value: u }
        : {
            ok: false,
            message: `“${t}” is not a recognised unit. Use KGS, NOS, PCS, REAM, BOX, MTR, LTR or SET.`,
          };
    }
    case 'rate': {
      const text = cell.format === 'percent' ? timesHundred(t) : t;
      const r = text === null ? null : parseRatePercent(text);
      return r?.ok
        ? { ok: true, value: r.value }
        : {
            ok: false,
            message: `“${t}” must be a percentage such as 18 or 18%, with up to 2 decimals.`,
          };
    }
    case 'date':
      return parseDate(cell, date1904);
    case 'poStatus': {
      const v = t.toLowerCase();
      return v === 'open' || v === 'closed'
        ? { ok: true, value: v }
        : { ok: false, message: 'must be open or closed.' };
    }
    case 'lineNumber':
      return /^\d{1,4}$/.test(t) && Number(t) > 0
        ? { ok: true, value: Number(t) }
        : { ok: false, message: `“${t}” must be a whole number from 1.` };
    case 'qty': {
      const r = parseQuantity(t);
      return r.ok
        ? { ok: true, value: r.value }
        : { ok: false, message: `“${t}” must be a quantity with up to 3 decimals.` };
    }
    case 'money': {
      const r = parseMoney(t);
      return r.ok
        ? { ok: true, value: r.value }
        : {
            ok: false,
            message: `“${t}” must be an amount in rupees with up to 2 decimals, such as 62.50.`,
          };
    }
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

export function checkImport(
  files: readonly UploadedFile[],
  erp: ErpSnapshot,
  today: string,
): ImportCheck {
  const errors: ApiImportIssue[] = [];
  const notices: string[] = [];
  const found = new Map<TableKey, Located>();
  const date1904BySource = new Map<string, boolean>();
  const fileError = (file: string, message: string) =>
    errors.push({ table: null, file, row: null, column: null, message });

  // 1. Files and sheets.
  if (files.length === 0) fileError('', 'Choose a file to upload.');
  if (files.length > MAX_IMPORT_FILES)
    fileError('', `Upload at most ${MAX_IMPORT_FILES} files at a time.`);
  for (const f of files.slice(0, MAX_IMPORT_FILES)) {
    if (f.bytes.length === 0) {
      fileError(f.filename, 'The file is empty.');
      continue;
    }
    if (f.bytes.length > MAX_IMPORT_FILE_BYTES) {
      fileError(f.filename, 'The file is larger than 5 MB.');
      continue;
    }
    const sheets: { name: string; source: string; rows: SheetRow[] }[] = [];
    try {
      const book = readSpreadsheet(f.bytes, f.filename);
      for (const s of book.sheets) {
        // A CSV is one sheet: it is named by the file alone.
        const source = book.kind === 'csv' ? f.filename : `${f.filename} › ${s.name}`;
        sheets.push({ name: s.name, source, rows: s.rows });
        date1904BySource.set(source, book.date1904);
      }
    } catch (e) {
      fileError(
        f.filename,
        e instanceof SpreadsheetError ? e.message : 'The file could not be read.',
      );
      continue;
    }
    for (const s of sheets) {
      if (letters(s.name) === 'howtofillin') continue;
      const key = detectTable(s.name, s.rows);
      if (!key) {
        if (s.rows.some((r) => r.cells.some((c) => c.text.trim() !== '')))
          notices.push(`“${s.source}” was not read: it is not one of the Veyrafy template sheets.`);
        continue;
      }
      const already = found.get(key);
      if (already) {
        fileError(
          f.filename,
          `${tableSpec(key).sheet} appear twice in this upload (${already.source} and ${s.source}). Upload them once.`,
        );
        continue;
      }
      found.set(key, { source: s.source, rows: s.rows });
    }
  }

  // 2. Headers and cells.
  const rowsOf = new Map<TableKey, Row[]>();
  const sourceOf = (key: TableKey) => found.get(key)?.source ?? tableSpec(key).sheet;
  const rowError = (key: TableKey, row: number | null, column: string | null, message: string) =>
    errors.push({ table: tableSpec(key).sheet, file: sourceOf(key), row, column, message });

  for (const [key, loc] of found) {
    const spec = tableSpec(key);
    const headerIdx = loc.rows.findIndex((r) => r.cells.some((c) => c.text.trim() !== ''));
    const header = loc.rows[headerIdx];
    if (!header) continue;
    const positions = new Map<string, number>();
    header.cells.forEach((c, i) => {
      const h = headerKey(c.text);
      if (!h) return;
      const col = spec.columns.find((x) => x.name === h || headerKey(x.label) === h);
      if (col) positions.set(col.name, i);
      else notices.push(`Column “${c.text.trim()}” on ${loc.source} was not read.`);
    });
    const missing = spec.columns.filter((c) => c.required && !positions.has(c.name));
    for (const c of missing) rowError(key, null, c.label, `The column “${c.name}” is missing.`);
    if (missing.length) continue;

    const rows: Row[] = [];
    let examples = 0;
    for (const r of loc.rows.slice(headerIdx + 1)) {
      if (!r.cells.some((c) => c.text.trim() !== '')) continue;
      const first = r.cells[positions.get(spec.columns[0]?.name ?? '') ?? 0]?.text.trim() ?? '';
      if (first.toUpperCase().startsWith(EXAMPLE_PREFIX)) {
        examples++;
        continue;
      }
      const values: Row['values'] = {};
      let ok = true;
      for (const c of spec.columns) {
        const pos = positions.get(c.name);
        const parsed = parseCell(
          c,
          pos === undefined ? undefined : r.cells[pos],
          date1904BySource.get(loc.source) ?? false,
        );
        if (parsed.ok) values[c.name] = parsed.value;
        else {
          ok = false;
          values[c.name] = null;
          rowError(key, r.rowNumber, c.label, `${c.label} ${parsed.message}`);
        }
      }
      rows.push({ rowNumber: r.rowNumber, values, ok });
    }
    if (examples)
      notices.push(`${examples} example row${examples === 1 ? '' : 's'} on ${loc.source} skipped.`);
    rowsOf.set(key, rows);
  }

  const rows = (key: TableKey): Row[] => rowsOf.get(key) ?? [];
  const str = (r: Row, k: string) =>
    r.values[k] === null || r.values[k] === undefined ? null : String(r.values[k]);
  const num = (r: Row, k: string) =>
    typeof r.values[k] === 'number' ? (r.values[k] as number) : null;
  const fail = (key: TableKey, r: Row, column: string | null, message: string) => {
    r.ok = false;
    rowError(key, r.rowNumber, column, message);
  };
  const dupCheck = (key: TableKey, field: string, label: string) => {
    const first = new Map<string, number>();
    for (const r of rows(key)) {
      const v = str(r, field);
      if (v === null) continue;
      const k = v.toUpperCase();
      const seen = first.get(k);
      if (seen !== undefined) fail(key, r, label, `${label} ${v} also appears on row ${seen}.`);
      else first.set(k, r.rowNumber);
    }
  };

  const erpVendorByCode = new Map(erp.vendors.map((v) => [v.code, v]));
  const erpVendorByGstin = new Map<string, Vendor>(erp.vendors.map((v) => [v.gstin, v]));
  const erpVendorCodeById = new Map(erp.vendors.map((v) => [v.id, v.code]));
  const erpItemByCode = new Map(erp.items.map((i) => [i.code, i]));
  const erpItemCodeById = new Map(erp.items.map((i) => [i.id, i.code]));
  const erpPoByNumber = new Map(erp.purchaseOrders.map((p) => [p.poNumber, p]));
  const erpPoNumberById = new Map(erp.purchaseOrders.map((p) => [p.id, p.poNumber]));
  const erpGrnByNumber = new Map(erp.grns.map((g) => [g.grnNumber, g]));
  const existing = new Map<TableKey, number>();
  const markExisting = (key: TableKey, n = 1) => existing.set(key, (existing.get(key) ?? 0) + n);

  // Vendors
  dupCheck('vendors', 'vendor_code', 'Vendor code');
  dupCheck('vendors', 'gstin', 'GSTIN');
  const fileVendorCodes = new Set(
    rows('vendors')
      .map((r) => str(r, 'vendor_code'))
      .filter((x): x is string => x !== null),
  );
  for (const r of rows('vendors')) {
    const gstin = str(r, 'gstin');
    const code = str(r, 'vendor_code');
    const parsed = gstin ? validateGstin(gstin) : null;
    if (parsed?.ok) {
      const pan = str(r, 'pan');
      if (pan && pan !== parsed.value.pan)
        fail(
          'vendors',
          r,
          'PAN',
          `PAN ${pan} does not match the GSTIN (it should be ${parsed.value.pan}).`,
        );
      const state = str(r, 'state');
      if (state && state !== parsed.value.stateCode)
        fail(
          'vendors',
          r,
          'State',
          `State does not match the GSTIN (${parsed.value.stateCode} is ${stateName(parsed.value.stateCode) ?? 'another state'}).`,
        );
    }
    if (!r.ok || !code || !gstin) continue;
    const status = str(r, 'active') === 'yes' ? 'active' : 'inactive';
    const byCode = erpVendorByCode.get(code);
    if (byCode) {
      if (
        byCode.name === str(r, 'name') &&
        byCode.gstin === gstin &&
        byCode.address === str(r, 'address') &&
        byCode.status === status
      )
        markExisting('vendors');
      else
        fail(
          'vendors',
          r,
          'Vendor code',
          `Vendor ${code} already exists with different details. Veyrafy does not change existing records.`,
        );
      continue;
    }
    const byGstin = erpVendorByGstin.get(gstin);
    if (byGstin)
      fail(
        'vendors',
        r,
        'GSTIN',
        `GSTIN ${gstin} already belongs to vendor ${byGstin.code} (${byGstin.name}).`,
      );
  }

  // Items
  dupCheck('items', 'item_code', 'Item code');
  const fileItems = new Map(rows('items').map((r) => [str(r, 'item_code') ?? '', r]));
  for (const r of rows('items')) {
    const code = str(r, 'item_code');
    if (!r.ok || !code) continue;
    const e = erpItemByCode.get(code);
    if (!e) continue;
    if (
      e.name === str(r, 'name') &&
      e.hsnSac === str(r, 'hsn') &&
      e.uom === str(r, 'uom') &&
      e.gstRateBp === num(r, 'gst_rate')
    )
      markExisting('items');
    else
      fail(
        'items',
        r,
        'Item code',
        `Item ${code} already exists with different details. Veyrafy does not change existing records.`,
      );
  }
  const itemUom = (code: string): string | null => {
    const f = fileItems.get(code);
    if (f) return str(f, 'uom');
    return erpItemByCode.get(code)?.uom ?? null;
  };
  const itemKnown = (code: string) => fileItems.has(code) || erpItemByCode.has(code);

  // Purchase orders and their lines
  dupCheck('purchaseOrders', 'po_number', 'PO number');
  const filePos = new Map(rows('purchaseOrders').map((r) => [str(r, 'po_number') ?? '', r]));
  const linesByPo = new Map<string, Row[]>();
  for (const l of rows('purchaseOrderLines')) {
    const po = str(l, 'po_number');
    if (po === null) continue;
    if (!filePos.has(po)) {
      fail(
        'purchaseOrderLines',
        l,
        'PO number',
        erpPoByNumber.has(po)
          ? `${po} is already in your records; lines cannot be added to or changed on an existing order.`
          : `${po} is not on the Purchase orders sheet of this upload. Upload lines together with their order.`,
      );
      continue;
    }
    linesByPo.set(po, [...(linesByPo.get(po) ?? []), l]);
    const item = str(l, 'item_code');
    if (item && !itemKnown(item))
      fail(
        'purchaseOrderLines',
        l,
        'Item code',
        `Item ${item} is not in your records or in this upload.`,
      );
    const uom = str(l, 'uom');
    const expected = item ? itemUom(item) : null;
    if (uom && expected && uom !== expected)
      fail(
        'purchaseOrderLines',
        l,
        'Unit',
        `Unit ${uom} does not match item ${item} (${expected}).`,
      );
    if (num(l, 'quantity') === 0)
      fail('purchaseOrderLines', l, 'Quantity', 'Quantity must be more than zero.');
  }
  for (const r of rows('purchaseOrders')) {
    const po = str(r, 'po_number');
    const vendor = str(r, 'vendor_code');
    const date = str(r, 'po_date');
    if (vendor && !fileVendorCodes.has(vendor) && !erpVendorByCode.has(vendor))
      fail(
        'purchaseOrders',
        r,
        'Vendor code',
        `Vendor ${vendor} is not in your records or in this upload.`,
      );
    if (date && date > today)
      fail('purchaseOrders', r, 'PO date', `PO date ${date} is in the future.`);
    if (!po) continue;
    const lines = (linesByPo.get(po) ?? []).sort(
      (a, b) => (num(a, 'line_number') ?? 0) - (num(b, 'line_number') ?? 0),
    );
    if (lines.length === 0) {
      fail(
        'purchaseOrders',
        r,
        'PO number',
        `Purchase order ${po} has no lines. Add them on the Purchase order lines sheet.`,
      );
      continue;
    }
    const numbers = lines.map((l) => num(l, 'line_number'));
    const seen = new Set<number>();
    for (const l of lines) {
      const n = num(l, 'line_number');
      if (n !== null && seen.has(n))
        fail('purchaseOrderLines', l, 'Line', `Line ${n} of ${po} appears twice.`);
      if (n !== null) seen.add(n);
    }
    if (
      numbers.every((n) => n !== null) &&
      [...seen].sort((a, b) => a - b).some((n, i) => n !== i + 1)
    )
      fail(
        'purchaseOrders',
        r,
        'Line',
        `The lines of ${po} must be numbered 1, 2, 3 … without gaps.`,
      );
    const e = erpPoByNumber.get(po);
    if (e && r.ok && lines.every((l) => l.ok)) {
      const same =
        erpVendorCodeById.get(e.vendorId) === vendor &&
        e.poDate === date &&
        e.status === str(r, 'status') &&
        e.lines.length === lines.length &&
        e.lines.every((el, k) => {
          const l = lines[k];
          return (
            l !== undefined &&
            el.lineNo === num(l, 'line_number') &&
            erpItemCodeById.get(el.itemId) === str(l, 'item_code') &&
            el.qtyMilli === num(l, 'quantity') &&
            el.unitPricePaise === num(l, 'unit_rate') &&
            el.gstRateBp === num(l, 'gst_rate')
          );
        });
      if (same) {
        markExisting('purchaseOrders');
        markExisting('purchaseOrderLines', lines.length);
      } else
        fail(
          'purchaseOrders',
          r,
          'PO number',
          `Purchase order ${po} already exists with different details. Veyrafy does not change existing records.`,
        );
    }
  }

  // Goods receipts and their lines
  dupCheck('grns', 'grn_number', 'GRN number');
  const fileGrns = new Map(rows('grns').map((r) => [str(r, 'grn_number') ?? '', r]));
  const linesByGrn = new Map<string, Row[]>();
  const poLinesOf = (po: string): { lineNo: number; itemCode: string | null }[] => {
    if (filePos.has(po))
      return (linesByPo.get(po) ?? []).map((l) => ({
        lineNo: num(l, 'line_number') ?? 0,
        itemCode: str(l, 'item_code'),
      }));
    return (erpPoByNumber.get(po)?.lines ?? []).map((l) => ({
      lineNo: l.lineNo,
      itemCode: erpItemCodeById.get(l.itemId) ?? null,
    }));
  };
  const poDateOf = (po: string): string | null =>
    filePos.has(po)
      ? str(filePos.get(po) as Row, 'po_date')
      : (erpPoByNumber.get(po)?.poDate ?? null);
  for (const l of rows('grnLines')) {
    const grn = str(l, 'grn_number');
    if (grn === null) continue;
    if (!fileGrns.has(grn)) {
      fail(
        'grnLines',
        l,
        'GRN number',
        erpGrnByNumber.has(grn)
          ? `${grn} is already in your records; its lines cannot be changed.`
          : `${grn} is not on the Goods receipts sheet of this upload. Upload lines together with their receipt.`,
      );
      continue;
    }
    linesByGrn.set(grn, [...(linesByGrn.get(grn) ?? []), l]);
    const received = num(l, 'received_quantity');
    const accepted = num(l, 'accepted_quantity');
    if (received === 0)
      fail('grnLines', l, 'Received', 'Received quantity must be more than zero.');
    if (received !== null && accepted !== null && accepted > received)
      fail(
        'grnLines',
        l,
        'Accepted',
        `Accepted quantity (${formatQty(milliQty(accepted))}) is more than the received quantity (${formatQty(milliQty(received))}).`,
      );
  }
  for (const r of rows('grns')) {
    const grn = str(r, 'grn_number');
    const po = str(r, 'po_number');
    const date = str(r, 'grn_date');
    const poKnown = po !== null && (filePos.has(po) || erpPoByNumber.has(po));
    if (po && !poKnown)
      fail(
        'grns',
        r,
        'PO number',
        `Purchase order ${po} is not in your records or in this upload.`,
      );
    if (date && date > today)
      fail('grns', r, 'Received on', `Receipt date ${date} is in the future.`);
    const poDate = po && poKnown ? poDateOf(po) : null;
    if (date && poDate && date < poDate)
      fail('grns', r, 'Received on', `Receipt date ${date} is before the PO date (${poDate}).`);
    if (!grn) continue;
    const lines = linesByGrn.get(grn) ?? [];
    if (lines.length === 0) {
      fail(
        'grns',
        r,
        'GRN number',
        `Goods receipt ${grn} has no lines. Add them on the Goods receipt lines sheet.`,
      );
      continue;
    }
    if (po && poKnown) {
      const poLines = poLinesOf(po);
      const seen = new Set<number>();
      for (const l of lines) {
        const n = num(l, 'po_line_number');
        if (n === null) continue;
        const pl = poLines.find((x) => x.lineNo === n);
        if (!pl) {
          fail('grnLines', l, 'PO line', `Line ${n} is not on ${po}.`);
          continue;
        }
        if (seen.has(n))
          fail('grnLines', l, 'PO line', `Line ${n} of ${po} appears twice in ${grn}.`);
        seen.add(n);
        const item = str(l, 'item_code');
        if (item && pl.itemCode && item !== pl.itemCode)
          fail(
            'grnLines',
            l,
            'Item code',
            `Line ${n} of ${po} is item ${pl.itemCode}, not ${item}.`,
          );
        const uom = str(l, 'uom');
        const expected = pl.itemCode ? itemUom(pl.itemCode) : null;
        if (uom && expected && uom !== expected)
          fail(
            'grnLines',
            l,
            'Unit',
            `Unit ${uom} does not match item ${pl.itemCode} (${expected}).`,
          );
      }
    }
    const e = erpGrnByNumber.get(grn);
    if (e && r.ok && lines.every((l) => l.ok) && po) {
      const erpPo = erpPoByNumber.get(po);
      const lineNoById = new Map((erpPo?.lines ?? []).map((pl) => [pl.id, pl.lineNo]));
      const same =
        erpPoNumberById.get(e.poId) === po &&
        e.grnDate === date &&
        e.lines.length === lines.length &&
        e.lines.every((el, k) => {
          const l = lines[k];
          return (
            l !== undefined &&
            lineNoById.get(el.poLineId) === num(l, 'po_line_number') &&
            el.receivedQtyMilli === num(l, 'received_quantity') &&
            el.acceptedQtyMilli === num(l, 'accepted_quantity')
          );
        });
      if (same) {
        markExisting('grns');
        markExisting('grnLines', lines.length);
      } else
        fail(
          'grns',
          r,
          'GRN number',
          `Goods receipt ${grn} already exists with different details. Veyrafy does not change existing records.`,
        );
    }
  }

  // 3. Summary and batch.
  const tables: ApiImportTable[] = TABLES.filter((t) => rowsOf.has(t.key)).map((t) => {
    const all = rows(t.key);
    const bad = all.filter((r) => !r.ok).length;
    const already = existing.get(t.key) ?? 0;
    return {
      key: t.key,
      label: t.sheet,
      noun: t.noun,
      source: sourceOf(t.key),
      rows: all.length,
      ready: all.length - bad - already,
      existing: already,
      errors: bad,
    };
  });
  if (errors.length === 0 && tables.every((t) => t.rows === 0))
    errors.push({
      table: null,
      file: files.map((f) => f.filename).join(', '),
      row: null,
      column: null,
      message: 'There are no records to import in this upload.',
    });

  const batch: ImportCheck['batch'] = {
    vendors: rows('vendors').map((r) => ({
      code: str(r, 'vendor_code') ?? '',
      name: str(r, 'name') ?? '',
      gstin: str(r, 'gstin') ?? '',
      address: str(r, 'address') ?? '',
      status: str(r, 'active') === 'yes' ? ('active' as const) : ('inactive' as const),
    })),
    items: rows('items').map((r) => ({
      code: str(r, 'item_code') ?? '',
      name: str(r, 'name') ?? '',
      hsnSac: str(r, 'hsn') ?? '',
      uom: str(r, 'uom') ?? '',
      gstRateBp: num(r, 'gst_rate') ?? 0,
    })),
    purchaseOrders: rows('purchaseOrders').map((r) => ({
      poNumber: str(r, 'po_number') ?? '',
      vendorCode: str(r, 'vendor_code') ?? '',
      poDate: str(r, 'po_date') ?? '',
      status: str(r, 'status') === 'closed' ? ('closed' as const) : ('open' as const),
      lines: (linesByPo.get(str(r, 'po_number') ?? '') ?? []).map((l) => ({
        lineNo: num(l, 'line_number') ?? 0,
        itemCode: str(l, 'item_code') ?? '',
        qtyMilli: num(l, 'quantity') ?? 0,
        unitPricePaise: num(l, 'unit_rate') ?? 0,
        gstRateBp: num(l, 'gst_rate') ?? 0,
      })),
    })),
    grns: rows('grns').map((r) => ({
      grnNumber: str(r, 'grn_number') ?? '',
      poNumber: str(r, 'po_number') ?? '',
      grnDate: str(r, 'grn_date') ?? '',
      lines: (linesByGrn.get(str(r, 'grn_number') ?? '') ?? []).map((l) => ({
        poLineNo: num(l, 'po_line_number') ?? 0,
        receivedQtyMilli: num(l, 'received_quantity') ?? 0,
        acceptedQtyMilli: num(l, 'accepted_quantity') ?? 0,
      })),
    })),
  };
  return { tables, errors, notices, batch };
}

/** Business-record rows for export, in template format (so an export can be imported again). */
export function erpRows(
  erp: ErpSnapshot,
): Record<TableKey, (string | number | { money: string })[][]> {
  const itemById = new Map(erp.items.map((i) => [i.id, i]));
  const vendorById = new Map(erp.vendors.map((v) => [v.id, v]));
  const poById = new Map(erp.purchaseOrders.map((p) => [p.id, p]));
  const rupees = (p: number) => ({ money: paiseToDecimalString(paise(p)) });
  const rate = (bp: number) => formatRate(rateBp(bp)).replace('%', '');
  const qty = (m: number) => formatQty(milliQty(m));
  return {
    vendors: erp.vendors.map((v) => [
      v.code,
      v.name,
      v.gstin,
      v.pan,
      v.address,
      stateName(v.stateCode) ?? v.stateCode,
      v.status === 'active' ? 'yes' : 'no',
    ]),
    items: erp.items.map((i) => [i.code, i.name, i.hsnSac, i.uom, rate(i.gstRateBp)]),
    purchaseOrders: erp.purchaseOrders.map((p) => [
      p.poNumber,
      vendorById.get(p.vendorId)?.code ?? p.vendorId,
      p.poDate,
      p.status,
    ]),
    purchaseOrderLines: erp.purchaseOrders.flatMap((p) =>
      p.lines.map((l) => {
        const item = itemById.get(l.itemId);
        return [
          p.poNumber,
          l.lineNo,
          item?.code ?? l.itemId,
          qty(l.qtyMilli),
          rupees(l.unitPricePaise),
          rate(l.gstRateBp),
          item?.uom ?? '',
        ];
      }),
    ),
    grns: erp.grns.map((g) => [g.grnNumber, poById.get(g.poId)?.poNumber ?? g.poId, g.grnDate]),
    grnLines: erp.grns.flatMap((g) => {
      const po = poById.get(g.poId);
      return g.lines.map((l) => {
        const pl = po?.lines.find((x) => x.id === l.poLineId);
        const item = pl ? itemById.get(pl.itemId) : undefined;
        return [
          g.grnNumber,
          pl?.lineNo ?? '',
          item?.code ?? '',
          qty(l.receivedQtyMilli),
          qty(l.acceptedQtyMilli),
          item?.uom ?? '',
        ];
      });
    }),
  };
}
