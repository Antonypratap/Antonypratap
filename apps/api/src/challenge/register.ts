import type { Cell, SheetRow } from '../spreadsheet/xlsx';
import { VeyraError } from '../workflow/veyra';

/**
 * The business's own record of its invoices (its purchase register, bills or goods receipts),
 * as exported from the system it uses: an Excel or CSV sheet, or JSON, one row per invoice line.
 * Each invoice in it becomes the same record the ERP goods-receipt export gives, so the invoice is
 * compared with it value by value (./../workflow/erp-receipts.ts). Nothing is guessed: a column is
 * recognised only by one of the names below, and a value that is not a plain number stays empty.
 */

/** Recognised column names (compared without case, spaces or punctuation). */
const COLUMNS = {
  invoiceNo: [
    'invoiceno',
    'invoicenumber',
    'invno',
    'supplierinvoiceno',
    'supplierinvoicenumber',
    'vendorinvoiceno',
    'billno',
    'billnumber',
    'supplierbillno',
    'refno',
    'supplierref',
    'dcno',
  ],
  supplier: [
    'supplier',
    'suppliername',
    'vendor',
    'vendorname',
    'party',
    'partyname',
    'partyaccount',
    'particulars',
  ],
  date: ['invoicedate', 'billdate', 'date', 'supplierinvoicedate', 'documentdate'],
  item: [
    'item',
    'itemname',
    'description',
    'itemdescription',
    'product',
    'productname',
    'stockitem',
    'nameofitem',
    'material',
  ],
  hsn: ['hsn', 'hsnsac', 'hsncode', 'hsnsaccode', 'sac'],
  qty: ['qty', 'quantity', 'billedqty', 'receivedqty', 'actualqty'],
  uom: ['uom', 'unit', 'units', 'per'],
  rate: ['rate', 'unitprice', 'price', 'basicrate', 'itemrate'],
  amount: [
    'amount',
    'taxablevalue',
    'taxableamount',
    'basicamount',
    'lineamount',
    'value',
    'netamount',
  ],
  cgst: ['cgst', 'cgstamount', 'centraltax', 'centraltaxamount'],
  sgst: ['sgst', 'sgstamount', 'utgst', 'statetax', 'statetaxamount', 'sgstutgst'],
  igst: ['igst', 'igstamount', 'integratedtax', 'integratedtaxamount'],
  total: [
    'invoicetotal',
    'invoiceamount',
    'billamount',
    'grandtotal',
    'totalamount',
    'invoicevalue',
  ],
  reference: ['grnno', 'grnnumber', 'receiptno', 'voucherno', 'vouchernumber', 'docno', 'entryno'],
} as const;
type Key = keyof typeof COLUMNS;
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
const KEY_OF = new Map<string, Key>(
  (Object.entries(COLUMNS) as [Key, readonly string[]][]).flatMap(([k, names]) =>
    names.map((n) => [n, k] as const),
  ),
);

type Row = Partial<Record<Key, string>>;
export const MAX_REGISTER_INVOICES = 500;

/** "₹ 3,450.00" → "3450.00"; anything that is not a plain amount stays as it is (not used). */
const amountText = (s: string | undefined) =>
  s === undefined ? undefined : s.replace(/[₹,\s]|Rs\.?|INR/gi, '');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A date as ISO: an Excel date serial, YYYY-MM-DD, DD/MM/YYYY or DD-Mon-YYYY; else undefined. */
function dateText(cell: Cell | undefined, text: string | undefined): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  if (cell?.kind === 'number' && cell.format === 'date' && /^\d+$/.test(t)) {
    const n = Number(t);
    if (n < 61) return undefined;
    return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (dmy) return `${dmy[3]}-${dmy[2]?.padStart(2, '0')}-${dmy[1]?.padStart(2, '0')}`;
  const mon = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{4})$/.exec(t);
  const m = mon ? MONTHS.indexOf((mon[2] ?? '').toLowerCase()) : -1;
  if (mon && m >= 0)
    return `${mon[3]}-${String(m + 1).padStart(2, '0')}-${mon[1]?.padStart(2, '0')}`;
  return undefined;
}

/** Whether a sheet's header row names an invoice register (invoice number, supplier and item). */
export function looksLikeRegister(header: readonly string[]): boolean {
  const keys = new Set(header.map((h) => KEY_OF.get(norm(h))));
  return keys.has('invoiceNo') && keys.has('supplier') && keys.has('item');
}

/** The rows of a sheet (first row: column names), as named values. */
export function registerRowsFromSheet(rows: readonly SheetRow[]): Row[] {
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.cells.map((c) => KEY_OF.get(norm(c.text)));
  return body.map((r) => {
    const row: Row = {};
    r.cells.forEach((c, i) => {
      const k = keys[i];
      if (!k || row[k] !== undefined || c.text.trim() === '') return;
      const v = k === 'date' ? dateText(c, c.text) : c.text.trim();
      if (v !== undefined) row[k] = v;
    });
    return row;
  });
}

/**
 * The rows of a JSON export: an array of line objects, or of invoices each with an `items` (or
 * `lines`) array, at the top level or under `data`, `rows`, `invoices`, `bills` or `records`.
 * Null when the JSON has no such rows.
 */
export function registerRowsFromJson(json: unknown): Row[] | null {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? (['data', 'rows', 'invoices', 'bills', 'records', 'purchases']
          .map((k) => (json as Record<string, unknown>)[k])
          .find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (!list?.length) return null;
  const flat = (o: Record<string, unknown>): Row => {
    const row: Row = {};
    for (const [name, v] of Object.entries(o)) {
      const k = KEY_OF.get(norm(name));
      if (!k || row[k] !== undefined || v === null || v === undefined || typeof v === 'object')
        continue;
      const text = String(v).trim();
      if (text === '') continue;
      const value = k === 'date' ? dateText(undefined, text) : text;
      if (value !== undefined) row[k] = value;
    }
    return row;
  };
  const rows: Row[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    const lines = (Array.isArray(e.items) ? e.items : Array.isArray(e.lines) ? e.lines : null) as
      unknown[] | null;
    const parent = flat(e);
    if (lines)
      for (const l of lines)
        rows.push({
          ...parent,
          ...(l && typeof l === 'object' ? flat(l as Record<string, unknown>) : {}),
        });
    else rows.push(parent);
  }
  return rows;
}

/**
 * The register as goods-receipt records (the shape of the ERP export), one per invoice. Rows
 * without an invoice number, supplier or item are refused with their row numbers.
 */
export function registerToReceipts(rows: readonly Row[], source: string): unknown {
  const missing: number[] = [];
  const groups = new Map<string, Row[]>();
  rows.forEach((r, i) => {
    if (Object.keys(r).length === 0) return;
    if (!r.invoiceNo || !r.supplier || !r.item) {
      missing.push(i + 2);
      return;
    }
    const key = `${norm(r.invoiceNo)}|${norm(r.supplier)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  });
  if (missing.length)
    throw new VeyraError(
      'INVALID_INPUT',
      `${source}: ${missing.length === 1 ? 'row' : 'rows'} ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''} ${missing.length === 1 ? 'has' : 'have'} no invoice number, supplier or item.`,
    );
  if (groups.size === 0) throw new VeyraError('INVALID_INPUT', `${source} has no invoice lines.`);
  if (groups.size > MAX_REGISTER_INVOICES)
    throw new VeyraError(
      'INVALID_INPUT',
      `${source} has more than ${MAX_REGISTER_INVOICES} invoices. Export only the invoices you are checking.`,
    );
  let n = 0;
  return {
    data: [...groups.values()].map((lines) => {
      const first = lines[0] as Row;
      n += 1;
      const total = lines.map((l) => amountText(l.total)).find((x) => x !== undefined);
      const ref = lines.map((l) => l.reference).find((x) => x !== undefined);
      return {
        invoice_info: {
          grn_id: `register-${n}`,
          grn_no: ref ?? `entry ${n}`,
          po_id: null,
          dc_no: first.invoiceNo,
          grn_date: null,
          invoice_date: first.date ?? null,
          // A total in the register is the system's own record of the invoice amount.
          invoice_amount: total ?? 0,
          vendor_name: first.supplier,
          vendor_code: null,
        },
        items: lines.map((l) => ({
          item_name: l.item,
          hsn_sac_code: l.hsn ?? null,
          uom: l.uom ?? null,
          quantity: amountText(l.qty) ?? null,
          basic_rate: amountText(l.rate) ?? null,
          basic_amount: amountText(l.amount) ?? null,
          cgst: amountText(l.cgst) ?? null,
          sgst: amountText(l.sgst) ?? null,
          igst: amountText(l.igst) ?? null,
        })),
      };
    }),
  };
}

/** The register template's columns and a made-up example (never a real business). */
export const REGISTER_TEMPLATE = {
  header: [
    'Invoice No',
    'Supplier',
    'Invoice Date',
    'Item',
    'HSN',
    'Qty',
    'Unit',
    'Rate',
    'Amount',
    'CGST',
    'SGST',
    'IGST',
    'Invoice Total',
  ],
  rows: [
    [
      'INV-1042',
      'Example Traders',
      '2026-09-12',
      'Steel bracket 40mm',
      '7326',
      100,
      'NOS',
      '45.00',
      '4500.00',
      '405.00',
      '405.00',
      '',
      '6608.00',
    ],
    [
      'INV-1042',
      'Example Traders',
      '2026-09-12',
      'Hex bolt M8',
      '7318',
      200,
      'NOS',
      '7.50',
      '1500.00',
      '135.00',
      '135.00',
      '',
      '6608.00',
    ],
  ],
} as const;
