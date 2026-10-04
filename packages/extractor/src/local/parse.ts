import {
  confidenceBp,
  parseMoney,
  parseQuantity,
  parseRatePercent,
  type ExtractedHeader,
  type ExtractedLine,
  type ExtractionMethod,
} from '@veyra/shared';
import { ExtractorError } from '../extractor';
import {
  joinSegments,
  rows,
  unitOf,
  valueConf,
  xMid,
  yMid,
  type PageText,
  type Segment,
} from './layout';

/**
 * Deterministic invoice parser: positioned text in, proposed fields out.
 *
 * It reads what is printed where Indian GST invoices print it (labels such as "Invoice No",
 * "Bill To", "Place of Supply", a line-item table, a totals block). It never fills a gap: a value
 * it cannot find is `null`; a value found twice with different contents is `null` with both
 * readings as evidence; an unreadable value keeps its evidence so the question can show it.
 * Confidence is the reader's own (text layer exact; OCR per word) and decides nothing by itself:
 * the deterministic core applies its threshold and rules to every field.
 */

type Field<T> = {
  value: T | null;
  confidenceBp: ReturnType<typeof confidenceBp>;
  evidence: { page: number; text: string; bbox: [number, number, number, number] | null } | null;
  source: ExtractionMethod;
};

/** Confidence of text-layer reads: the characters are exact; 0.99 leaves room for layout. */
const TEXT_LAYER_BP = 9900;

/**
 * A proposed field. `spelled` is the value as printed (e.g. "7,375.00" for 737500) so that only
 * the words spelling it count towards its confidence.
 */
function toField<T>(
  value: T | null,
  segs: readonly Segment[],
  ambiguous = false,
  spelled?: string,
): Field<T> {
  const [first] = segs;
  if (!first)
    return { value: null, confidenceBp: confidenceBp(0), evidence: null, source: 'pdf_text' };
  const joined = joinSegments(segs, ' · ');
  const conf =
    value === null || ambiguous
      ? 0
      : Math.max(
          0,
          Math.min(TEXT_LAYER_BP, Math.round(valueConf(segs, spelled ?? String(value)) * 100)),
        );
  return {
    value: ambiguous ? null : value,
    confidenceBp: confidenceBp(conf),
    evidence: {
      page: first.page,
      text: joined.text.slice(0, 500),
      bbox: [
        round1(joined.x0),
        round1(joined.y0),
        round1(joined.x1 - joined.x0),
        round1(joined.y1 - joined.y0),
      ],
    },
    source: joined.source,
  };
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const none = <T>(): Field<T> => toField<T>(null, []);

// ── Value parsers (RULES §1.1, §1.4) ────────────────────────────────────────

const GSTIN = /[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/;
const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** RULES §1.4 dates: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD-Mon-YYYY, YYYY-MM-DD. Day first. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (r) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(t))) {
    const mi = MONTHS.indexOf((r[2] ?? '').toUpperCase());
    if (mi < 0) return null;
    [d, m, y] = [Number(r[1]), mi + 1, Number(r[3])];
  } else if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)))
    [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A money amount as printed (₹, Rs., INR, Indian grouping, brackets or minus for negatives). */
export function parseAmount(text: string, allowNegative = false): number | null {
  // Tally prints a negative amount as "(-)0.40".
  let t = text
    .trim()
    .replace(/\s+/g, '')
    .replace(/^\(-\)/, '-');
  let negative = false;
  const bracket = /^\((.*)\)$/.exec(t);
  if (bracket) {
    negative = true;
    t = bracket[1] ?? '';
  }
  t = t.replace(/^(₹|rs\.?|inr)/i, '');
  if (t.startsWith('-')) {
    negative = !negative;
    t = t.slice(1);
  }
  t = t.replace(/^(₹|rs\.?|inr)/i, '');
  if (!/^\d[\d,]*(\.\d+)?$/.test(t)) return null;
  if (negative && !allowNegative) return null;
  const r = parseMoney(negative ? `-${t}` : t, { allowNegative });
  return r.ok ? (r.value as number) : null;
}

const isMoneyToken = (t: string) =>
  /^(\(-\)|\(?-?)(₹|rs\.?|inr)?\s?-?\d[\d,]*(\.\d+)?\)?$/i.test(t.trim());

/** The rightmost amount on a row of segments (the value column of a totals block). */
function rowAmount(
  row: readonly Segment[],
  allowNegative = false,
): { value: number | null; seg: Segment | null; token: string } {
  for (let i = row.length - 1; i >= 0; i--) {
    const seg = row[i];
    if (!seg) continue;
    const tokens = seg.text.replace(/(₹|rs\.?|inr)\s+/gi, '$1').split(/\s+/);
    for (let k = tokens.length - 1; k >= 0; k--) {
      const tok = tokens[k] ?? '';
      if (tok.endsWith('%')) continue;
      if (isMoneyToken(tok)) return { value: parseAmount(tok, allowNegative), seg, token: tok };
    }
  }
  return { value: null, seg: null, token: '' };
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

// ── Labels ──────────────────────────────────────────────────────────────────

const L = {
  title:
    /^(tax\s+invoice|invoice|gst\s+invoice|bill\s+of\s+supply|original|duplicate|triplicate|page\s+\d)/i,
  invoiceNo: /^(?:tax\s+)?(?:invoice|inv|bill)\.?\s*(?:no|number|num|#)\.?\s*[:\-.#]?\s*(.*)$/i,
  invoiceDate: /^(?:invoice\s+|inv\.?\s+|bill\s+)?dated?(?:\s+of\s+invoice)?\s*[:\-.]?\s*(.*)$/i,
  // "Buyer's Order No." (Tally) is the purchase order; a bare "Order No." may be the seller's own.
  po: /^(?:buyer'?s\s+)?(?:p\.?\s?o\.?|purchase\s+order|(?<=buyer'?s\s+)order)\s*(?:no|number|ref(?:erence)?|#)?\.?\s*[:\-.#]?\s*(.*)$/i,
  pos: /^place\s+of\s+supply\s*[:\-.]?\s*(.*)$/i,
  billTo: /^(bill(?:ed)?\s*to|buyer|invoice\s+to|billing\s+address|customer)\b\s*[:-]?\s*(.*)$/i,
  shipTo: /^(ship(?:ped)?\s*to|consignee|deliver(?:y)?\s*(?:to|address))\b\s*[:-]?\s*(.*)$/i,
  gstin: /^(?:gstin|gst\s*(?:no|number|in)|gstin\/uin)\.?\s*[:\-.]?\s*(.*)$/i,
  pan: /^pan(?:\s*no)?\.?\s*[:\-.]?\s*(.*)$/i,
  state: /^state(?:\s*(?:name|code))?\s*[:\-.]?\s*(.*)$/i,
  contact: /^(phone|ph|tel|mobile|mob|email|e-mail|web|www|cin|msme|udyam)\b/i,
};

const TOTALS = {
  // "Basic Value" / "Basic Amount" (Tally), "Goods Value", "Assessable Value": the goods subtotal.
  taxable:
    /^(total\s+)?taxable\s*(value|amount)?\b|^sub\s*-?\s*total\b|^total\s+before\s+tax\b|^(basic|goods|assessable)\s+(value|amount)\b/i,
  cgst: /^(output\s+)?cgst\b/i,
  sgst: /^(output\s+)?(sgst|utgst)\b/i,
  igst: /^(output\s+)?igst\b/i,
  cess: /^(total\s+)?cess\b/i,
  roundOff: /^round(?:ing|ed)?\s*(?:off)?\b/i,
  total:
    /^(grand\s+total|invoice\s+total|invoice\s+value|total\s+(?:invoice\s+)?(?:amount|value)|total\s+payable|net\s+(?:amount|payable)|amount\s+payable|total)\b/i,
};

/** Labels with their value either after the label, to the right on the same row, or just below. */
function labelled(
  pages: readonly PageText[],
  label: RegExp,
  accept: (text: string) => string | null,
  unitOf1: (p: number) => number,
): Cand<string>[] {
  const found: Cand<string>[] = [];
  for (const p of pages) {
    const unit = unitOf1(p.page);
    for (const s of p.segments) {
      const m = label.exec(s.text);
      if (!m) continue;
      const rest = clean(m[m.length - 1] ?? '');
      if (rest) {
        const v = accept(rest);
        found.push({ value: v ?? '', segs: [s], spelled: rest.split(/\s+/)[0] ?? rest });
        continue;
      }
      // The value to the right on the same row, unless that is the next box's own label.
      const right = p.segments
        .filter(
          (o) =>
            o !== s &&
            o.x0 >= s.x1 - unit * 0.2 &&
            Math.abs(yMid(o) - yMid(s)) <= unit * 0.5 &&
            !isMeta(o.text),
        )
        .sort((a, b) => a.x0 - b.x0)[0];
      const below = p.segments
        .filter(
          (o) =>
            o !== s &&
            o.y0 >= s.y1 - unit * 0.2 &&
            o.y0 - s.y1 <= unit * 1.2 &&
            Math.abs(o.x0 - s.x0) <= unit * 1.5,
        )
        .sort((a, b) => a.y0 - b.y0)[0];
      const next = right ?? below;
      if (!next) continue;
      const v = accept(clean(next.text));
      found.push({
        value: v ?? '',
        segs: [s, next],
        spelled: clean(next.text).split(/\s+/)[0] ?? '',
      });
    }
  }
  return found;
}

/** A candidate reading: its value ('' = printed but unreadable), where, and how it was spelled. */
interface Cand<T> {
  value: T | '';
  segs: Segment[];
  spelled?: string;
}

/** One value from candidates: all agree → it; they disagree → null with every reading as evidence. */
function single<T>(candidates: readonly Cand<T>[]): {
  value: T | null;
  segs: Segment[];
  ambiguous: boolean;
  unreadable: boolean;
  spelled?: string;
} {
  const readable = candidates.filter((c) => c.value !== '');
  const distinct = [...new Set(readable.map((c) => JSON.stringify(c.value)))];
  if (distinct.length > 1)
    return {
      value: null,
      segs: readable.flatMap((c) => c.segs),
      ambiguous: true,
      unreadable: false,
    };
  const first = readable[0];
  if (first)
    return {
      value: first.value as T,
      segs: readable.length > 1 ? readable.flatMap((c) => c.segs).slice(0, 2) : first.segs,
      ambiguous: false,
      unreadable: false,
      ...(first.spelled ? { spelled: first.spelled } : {}),
    };
  const bad = candidates[0];
  return { value: null, segs: bad?.segs ?? [], ambiguous: false, unreadable: bad !== undefined };
}

// ── Table ───────────────────────────────────────────────────────────────────

type Col =
  | 'sl'
  | 'description'
  | 'code'
  | 'hsn'
  | 'qty'
  | 'uom'
  | 'rate'
  | 'disc'
  | 'gst'
  | 'taxable'
  | 'amount'
  | 'tax';

function classify(label: string): Col | null {
  const t = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(sl|s\.? ?no|sr|#|no\.?)\b/.test(t) || t === 'sl' || t === '#') return 'sl';
  if (/hsn|sac/.test(t)) return 'hsn';
  if (/desc|particular|goods|product|item name|services/.test(t)) return 'description';
  if (/item ?code|sku|part ?no|code/.test(t)) return 'code';
  if (/^(qty|quantity)/.test(t)) return 'qty';
  if (/^(uom|unit|units|per)$/.test(t)) return 'uom';
  if (/disc/.test(t)) return 'disc';
  if (/(gst|tax) ?(%|rate)|^rate ?%|^gst$|igst ?%|^tax ?%/.test(t)) return 'gst';
  if (/rate|unit ?price|price/.test(t)) return 'rate';
  if (/taxable/.test(t)) return 'taxable';
  if (/cgst|sgst|igst|tax amount|^tax$/.test(t)) return 'tax';
  if (/amount|total|value/.test(t)) return 'amount';
  return null;
}

interface Table {
  page: number;
  top: number;
  bottom: number;
  cols: { col: Col; x0: number; x1: number; seg: Segment }[];
}

/** Finds the line-item table header on a page: a row band holding at least three column labels. */
function findHeader(page: PageText, unit: number): Table | null {
  const anchors = page.segments.filter((s) =>
    /\b(description|particulars|goods|product)\b/i.test(s.text),
  );
  for (const a of anchors) {
    const band = page.segments.filter((s) => Math.abs(yMid(s) - yMid(a)) <= unit * 1.6);
    // Stack two-line header cells ("Taxable" over "Value") by horizontal overlap.
    const cells: Segment[][] = [];
    for (const s of [...band].sort((x, y) => x.x0 - y.x0 || x.y0 - y.y0)) {
      const cell = cells.find((c) =>
        c.some((o) => Math.min(o.x1, s.x1) - Math.max(o.x0, s.x0) > 0),
      );
      if (cell) cell.push(s);
      else cells.push([s]);
    }
    const cols = cells
      .map((c) => {
        const seg = joinSegments([...c].sort((x, y) => x.y0 - y.y0));
        return { col: classify(seg.text), x0: seg.x0, x1: seg.x1, seg };
      })
      .filter((c): c is Table['cols'][number] => c.col !== null);
    const kinds = new Set(cols.map((c) => c.col));
    if (kinds.size >= 3 && kinds.has('description')) {
      // Two "amount" columns: when a taxable column exists, the other is the line total.
      return {
        page: page.page,
        top: Math.min(...cols.map((c) => c.seg.y0)),
        bottom: Math.max(...cols.map((c) => c.seg.y1)),
        cols: cols.sort((x, y) => x.x0 - y.x0),
      };
    }
  }
  return null;
}

/** Which column a value belongs to: by its centre, between the midpoints of adjacent headers. */
function columnOf(table: Table, s: Segment): Col | null {
  const cx = xMid(s);
  const cols = table.cols;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (!c) continue;
    const left = i === 0 ? -Infinity : ((cols[i - 1]?.x1 ?? c.x0) + c.x0) / 2;
    const right = i === cols.length - 1 ? Infinity : (c.x1 + (cols[i + 1]?.x0 ?? c.x1)) / 2;
    if (cx >= left && cx < right) return c.col;
  }
  return null;
}

const isTotalsLabel = (t: string) =>
  Object.values(TOTALS).some((re) => re.test(t)) || /^amount\s+in\s+words/i.test(t);

interface RawLine {
  cells: Partial<Record<Col, Segment[]>>;
}

function tableLines(
  page: PageText,
  table: Table,
  unit: number,
): { lines: RawLine[]; endY: number | null } {
  const below = page.segments.filter((s) => s.y0 >= table.bottom - unit * 0.2);
  const endSeg = below
    .filter((s) => isTotalsLabel(s.text) && columnOf(table, s) !== 'sl')
    .sort((a, b) => a.y0 - b.y0)[0];
  const endY = endSeg ? endSeg.y0 - unit * 0.2 : null;
  const body = below.filter((s) => endY === null || s.y1 <= endY + unit * 0.4);
  const anchorCol: Col = table.cols.some((c) => c.col === 'qty') ? 'qty' : 'taxable';
  const isAnchor = (s: Segment) => {
    if (columnOf(table, s) !== anchorCol) return false;
    const tok = s.text.split(/\s+/)[0] ?? '';
    return anchorCol === 'qty' ? parseQuantity(tok).ok : parseAmount(tok) !== null;
  };
  const anchors = body.filter(isAnchor).sort((a, b) => yMid(a) - yMid(b));
  const lines: RawLine[] = anchors.map(() => ({ cells: {} }));
  for (const s of body) {
    let best = -1;
    let dist = Infinity;
    anchors.forEach((a, i) => {
      const d = Math.abs(yMid(s) - yMid(a));
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    if (best < 0 || dist > unit * 2.2) continue;
    const col = columnOf(table, s);
    if (!col) continue;
    const line = lines[best];
    if (line) (line.cells[col] ??= []).push(s);
  }
  return { lines, endY };
}

function cellText(segs: readonly Segment[] | undefined): string {
  if (!segs?.length) return '';
  return clean(
    [...segs]
      .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
      .map((s) => s.text)
      .join(' '),
  );
}

function lineFields(raw: RawLine, lineNo: number): ExtractedLine {
  const f = <T>(col: Col, parse: (t: string) => T | null): Field<T> => {
    const segs = raw.cells[col];
    if (!segs?.length) return none<T>();
    const text = cellText(segs);
    return toField(text ? parse(text) : null, segs, false, text);
  };
  let qtyText = cellText(raw.cells.qty);
  let uomFromQty: string | null = null;
  // "1 Nos": the unit printed with the quantity (Tally prints it even beside a "per" column).
  const split = /^([\d,]+(?:\.\d+)?)\s+([A-Za-z]{2,6})$/.exec(qtyText);
  if (split) {
    qtyText = split[1] ?? qtyText;
    if (!raw.cells.uom) uomFromQty = (split[2] ?? '').toUpperCase();
  }
  const qty = raw.cells.qty
    ? toField(
        (() => {
          const r = parseQuantity(qtyText);
          return r.ok ? (r.value as number) : null;
        })(),
        raw.cells.qty,
        false,
        qtyText,
      )
    : none<number>();
  const uom = raw.cells.uom
    ? f('uom', (t) => (/^[A-Za-z]{2,10}\.?$/.test(t) ? t.replace(/\.$/, '').toUpperCase() : null))
    : raw.cells.qty && uomFromQty
      ? toField(uomFromQty, raw.cells.qty, false, uomFromQty)
      : none<string>();
  return {
    lineNo: lineNo as ExtractedLine['lineNo'],
    description: (() => {
      // A serial number whose column header was not read lands in the description cell, left
      // of the text: drop it (it is the row number, not part of the description).
      const segs = raw.cells.description ?? [];
      const left = Math.min(...segs.map((x) => x.x0));
      const kept = segs.filter(
        (x) => !(x.text === String(lineNo) && x.x0 <= left + 1 && segs.length > 1),
      );
      const text = cellText(kept);
      return kept.length ? toField(text || null, kept, false, text) : none<string>();
    })(),
    vendorItemCode: f('code', (t) => (/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(t) ? t : null)),
    hsnSac: f('hsn', (t) => (/^\d{4}(\d{2}){0,2}$/.test(t) ? t : null)),
    qtyMilli: qty as ExtractedLine['qtyMilli'],
    uom,
    unitPricePaise: f('rate', (t) => parseAmount(t)) as ExtractedLine['unitPricePaise'],
    discountPaise: f('disc', (t) =>
      t.includes('%') ? null : parseAmount(t),
    ) as ExtractedLine['discountPaise'],
    taxablePaise: f(raw.cells.taxable ? 'taxable' : 'amount', (t) =>
      parseAmount(t),
    ) as ExtractedLine['taxablePaise'],
    gstRateBp: f('gst', (t) => {
      const r = parseRatePercent(t.replace(/\s+/g, '').replace(/%?$/, '%'));
      return r.ok ? (r.value as number) : null;
    }) as ExtractedLine['gstRateBp'],
    cgstPaise: none(),
    sgstPaise: none(),
    igstPaise: none(),
    lineTotalPaise: (raw.cells.taxable && raw.cells.amount
      ? f('amount', (t) => parseAmount(t))
      : none()) as ExtractedLine['lineTotalPaise'],
  } as ExtractedLine;
}

// ── Blocks (seller, bill-to, ship-to) ────────────────────────────────────────

interface Block {
  label: Segment | null;
  segs: Segment[];
}

function blockUnder(page: PageText, label: Segment, stopY: number, unit: number): Block {
  const peers = page.segments.filter(
    (s) =>
      s !== label &&
      (L.billTo.test(s.text) || L.shipTo.test(s.text)) &&
      Math.abs(yMid(s) - yMid(label)) <= unit * 0.6,
  );
  const rightLimit = Math.min(
    ...peers.filter((p) => p.x0 > label.x0).map((p) => p.x0 - unit * 0.5),
    Infinity,
  );
  const leftLimit = Math.max(
    ...peers.filter((p) => p.x0 < label.x0).map((p) => p.x1),
    label.x0 - unit * 2,
  );
  const inColumn = page.segments
    .filter(
      (s) =>
        s !== label &&
        s.y0 >= label.y0 - unit * 0.3 &&
        s.y1 <= stopY &&
        s.x0 >= leftLimit &&
        s.x0 < rightLimit,
    )
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  // A block ends at the first vertical gap wider than two lines.
  const segs: Segment[] = [];
  let lastY = label.y1;
  for (const s of inColumn) {
    if (s.y0 - lastY > unit * 2.2) break;
    segs.push(s);
    lastY = Math.max(lastY, s.y1);
  }
  const rest = clean(label.text.replace(L.billTo, '$2').replace(L.shipTo, '$2'));
  const own = rest && rest !== label.text ? [{ ...label, text: rest }] : [];
  return { label, segs: [...own, ...segs] };
}

function gstinsIn(segs: readonly Segment[]): { value: string; segs: Segment[] }[] {
  const out: { value: string; segs: Segment[] }[] = [];
  for (const s of segs) {
    const up = s.text.toUpperCase();
    const m = GSTIN.exec(up.replace(/\s+/g, ''));
    const labelled1 = L.gstin.exec(s.text);
    if (m) out.push({ value: m[0], segs: [s] });
    else if (labelled1) {
      // A GSTIN label whose value does not have the GSTIN shape: keep the reading (it becomes
      // "not readable" downstream), never correct it.
      const raw = clean(labelled1[1] ?? '').toUpperCase();
      if (raw) out.push({ value: raw, segs: [s] });
    }
  }
  return out;
}

const isMeta = (t: string) =>
  L.invoiceNo.test(t) ||
  L.invoiceDate.test(t) ||
  L.po.test(t) ||
  L.pos.test(t) ||
  L.title.test(t) ||
  /^(due\s+date|payment\s+terms|terms|e-?way|irn|ack|vehicle|transport|dispatch|challan|order\s+date|po\s+date)/i.test(
    t,
  );

function addressOf(segs: readonly Segment[]): Segment[] {
  return segs.filter(
    (s) =>
      !L.gstin.test(s.text) &&
      !GSTIN.test(s.text.toUpperCase()) &&
      !L.pan.test(s.text) &&
      !L.state.test(s.text) &&
      !L.contact.test(s.text) &&
      !isMeta(s.text),
  );
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface ParsedInvoice {
  header: ExtractedHeader;
  lines: ExtractedLine[];
  warnings: string[];
}

export function parseInvoice(pages: readonly PageText[]): ParsedInvoice {
  const warnings: string[] = [];
  const units = new Map(pages.map((p) => [p.page, unitOf(p.segments)]));
  const unitFor = (page: number) => units.get(page) ?? 10;
  const first = pages[0];
  if (!first || pages.every((p) => p.segments.length === 0)) {
    throw new ExtractorError(
      'MALFORMED_DOCUMENT',
      "Veyrafy couldn't read this invoice: no words were found on any page, even when each page was read as an image.",
    );
  }

  // Invoice boundaries: different invoice numbers on different pages means more than one invoice.
  const numbers = labelled(
    pages,
    L.invoiceNo,
    (t) => {
      const tok = t.split(/\s+/)[0] ?? '';
      return /\d/.test(tok) && /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(tok) && !/^date/i.test(tok)
        ? tok.toUpperCase()
        : null;
    },
    unitFor,
  );
  const byPage = new Map<number, Set<string>>();
  for (const n of numbers) {
    const page = n.segs[0]?.page;
    if (!n.value || page === undefined) continue;
    const set = byPage.get(page) ?? new Set<string>();
    set.add(n.value);
    byPage.set(page, set);
  }
  const pageNumbers = [...byPage.values()]
    .filter((set) => set.size === 1)
    .flatMap((set) => [...set]);
  if (new Set(pageNumbers).size > 1) {
    throw new ExtractorError(
      'MULTIPLE_INVOICES',
      `This file seems to hold more than one invoice (${[...new Set(pageNumbers)].join(', ')}). Upload each invoice as its own file.`,
    );
  }
  const invoiceNumber = single(numbers);
  if (invoiceNumber.ambiguous)
    warnings.push('More than one invoice number is printed; please confirm which it is.');

  // Several "Dated" boxes (the invoice's, the order's): the one beside the invoice number is the
  // invoice date; any other disagreement stays unresolved (asked, never guessed).
  const dates = labelled(pages, L.invoiceDate, (t) => parseDate(t.split(/\s+/)[0] ?? ''), unitFor);
  const numberLabel = numbers.find((n) => n.value)?.segs[0];
  const besideNumber = numberLabel
    ? dates.filter((d) => {
        const l = d.segs[0];
        return (
          l !== undefined &&
          l.page === numberLabel.page &&
          Math.abs(yMid(l) - yMid(numberLabel)) <= unitFor(l.page) * 0.6
        );
      })
    : [];
  const date = single(besideNumber.length === 1 ? besideNumber : dates);
  const po = single(
    labelled(
      pages,
      L.po,
      (t) => {
        const tok = t.split(/\s+/)[0] ?? '';
        return /\d/.test(tok) && /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(tok) && !/^date/i.test(tok)
          ? tok.toUpperCase()
          : null;
      },
      unitFor,
    ),
  );
  const pos = single(labelled(pages, L.pos, (t) => t || null, unitFor));

  // Table(s): a header per page (printed headers repeat on continuation pages).
  const lines: ExtractedLine[] = [];
  let tableTop: { page: number; y: number } | null = null;
  let totalsFrom: { page: number; y: number } | null = null;
  let previous: Table | null = null;
  let hasTaxColumn = false;
  for (const p of pages) {
    const unit = unitFor(p.page);
    // A continuation page without a printed header keeps the previous page's columns.
    const carried = previous as Table | null;
    const table: Table | null =
      findHeader(p, unit) ??
      (carried && !totalsFrom
        ? { ...carried, page: p.page, top: -Infinity, bottom: -Infinity }
        : null);
    if (!table) continue;
    previous = table;
    if (table.cols.some((c) => c.col === 'tax')) hasTaxColumn = true;
    tableTop ??= { page: p.page, y: table.top };
    const { lines: raw, endY } = tableLines(p, table, unit);
    for (const r of raw) lines.push(lineFields(r, lines.length + 1));
    if (endY !== null && !totalsFrom) totalsFrom = { page: p.page, y: endY };
  }
  if (!tableTop) warnings.push('No line-item table was recognised.');

  // Blocks on the first page: seller above bill-to/ship-to/table; buyer and ship-to under their labels.
  const unit1 = unitFor(first.page);
  const billLabel = first.segments.find((s) => L.billTo.test(s.text)) ?? null;
  const shipLabel = first.segments.find((s) => L.shipTo.test(s.text)) ?? null;
  const tableY = tableTop?.page === first.page ? tableTop.y : Infinity;
  const blockStop = (label: Segment) => {
    const lower = [billLabel, shipLabel].filter(
      (b): b is Segment =>
        b !== null &&
        b !== label &&
        b.y0 > label.y1 + unit1 &&
        Math.abs(b.x0 - label.x0) < unit1 * 3,
    );
    return Math.min(tableY, ...lower.map((b) => b.y0));
  };
  const bill = billLabel ? blockUnder(first, billLabel, blockStop(billLabel), unit1) : null;
  const ship = shipLabel ? blockUnder(first, shipLabel, blockStop(shipLabel), unit1) : null;
  const sellerStop = Math.min(billLabel?.y0 ?? Infinity, shipLabel?.y0 ?? Infinity, tableY);
  const metaX = Math.min(
    ...first.segments
      .filter((s) => s.y0 < sellerStop && isMeta(s.text) && !L.title.test(s.text))
      .map((s) => s.x0),
    Infinity,
  );
  const sellerLabel = first.segments.find(
    (s) =>
      /^(from|seller|supplier|sold\s+by|vendor)\s*[:-]?\s*$/i.test(s.text) && s.y0 < sellerStop,
  );
  const sellerSegs = first.segments
    .filter(
      (s) =>
        s.y0 < sellerStop &&
        s !== sellerLabel &&
        (sellerLabel ? s.y0 > sellerLabel.y0 - unit1 * 0.3 : true),
    )
    .filter(
      (s) =>
        !(metaX < Infinity && s.x0 >= metaX - unit1 * 0.5 && !GSTIN.test(s.text.toUpperCase())),
    )
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

  const nameSeg = sellerSegs.find(
    (s) =>
      /[A-Za-z]{2}/.test(s.text) &&
      !isMeta(s.text) &&
      !L.gstin.test(s.text) &&
      !L.pan.test(s.text) &&
      !L.contact.test(s.text) &&
      !L.state.test(s.text),
  );
  const vendorGstin = single(gstinsIn(sellerSegs));
  if (vendorGstin.ambiguous) warnings.push('More than one supplier GSTIN is printed.');
  const panCands = sellerSegs
    .map((s) => {
      const m = L.pan.exec(s.text);
      const v = m ? (PAN.exec((m[1] ?? '').toUpperCase())?.[0] ?? '') : null;
      return v === null ? null : { value: v, segs: [s] };
    })
    .filter((c): c is { value: string; segs: Segment[] } => c !== null);
  const vendorPan = single(panCands);
  const addressSegs = nameSeg
    ? addressOf(sellerSegs.filter((s) => s !== nameSeg && s.y0 >= nameSeg.y0))
    : [];

  const buyerGstin = bill ? single(gstinsIn(bill.segs)) : null;
  const billAddress = bill ? addressOf(bill.segs).slice(1) : [];
  const shipGstin = ship ? single(gstinsIn(ship.segs)) : null;
  const shipState = ship
    ? single(
        ship.segs
          .map((s) => L.state.exec(s.text))
          .map((m, i) => (m ? { value: clean(m[1] ?? ''), segs: [ship.segs[i] as Segment] } : null))
          .filter((c): c is { value: string; segs: Segment[] } => c !== null),
      )
    : null;
  const shipAddress = ship ? addressOf(ship.segs).slice(1) : [];

  // Totals: rows below the table (on its last page and after), matched by label.
  const totalRows: Segment[][] = [];
  for (const p of pages) {
    if (totalsFrom && p.page < totalsFrom.page) continue;
    const from =
      totalsFrom && p.page === totalsFrom.page
        ? totalsFrom.y
        : tableTop && p.page === tableTop.page
          ? tableTop.y
          : -Infinity;
    totalRows.push(
      ...rows(
        p.segments.filter((s) => s.y0 >= from),
        unitFor(p.page),
      ),
    );
  }
  const total = (re: RegExp, allowNegative = false) => {
    const cands: Cand<number>[] = [];
    for (const row of totalRows) {
      const labelSeg = row.find((s) => re.test(s.text));
      if (!labelSeg) continue;
      if (
        re === TOTALS.total &&
        (TOTALS.taxable.test(labelSeg.text) ||
          /^total\s+(cgst|sgst|igst|tax|cess|qty|quantity)/i.test(labelSeg.text))
      )
        continue;
      const after = row.filter((s) => s.x0 >= labelSeg.x0);
      const { value, seg, token } = rowAmount(after, allowNegative);
      const segs = seg && seg !== labelSeg ? [labelSeg, seg] : [labelSeg];
      cands.push({ value: value ?? '', segs, spelled: token });
    }
    // "Grand Total" is the grand total even when a plain "Total" row also exists above it.
    if (re === TOTALS.total) {
      const grand = cands.filter((c) => /grand|invoice|payable|net/i.test(c.segs[0]?.text ?? ''));
      if (grand.length) return single(grand);
      return single(cands.slice(-1));
    }
    return single(cands);
  };
  const totals = {
    taxable: total(TOTALS.taxable),
    cgst: total(TOTALS.cgst),
    sgst: total(TOTALS.sgst),
    igst: total(TOTALS.igst),
    cess: total(TOTALS.cess),
    roundOff: total(TOTALS.roundOff, true),
    total: total(TOTALS.total),
  };
  for (const [k, t] of Object.entries(totals))
    if (t.unreadable)
      warnings.push(`The ${k === 'total' ? 'invoice total' : k} is printed but could not be read.`);

  const pick = <T>(
    r: { value: T | null; segs: Segment[]; ambiguous: boolean; spelled?: string } | null,
  ): Field<T> => (r ? toField(r.value, r.segs, r.ambiguous, r.spelled) : none<T>());

  const header = {
    vendorName: nameSeg ? toField(clean(nameSeg.text), [nameSeg]) : none<string>(),
    vendorGstin: pick(vendorGstin),
    vendorAddress: addressSegs.length
      ? toField(clean(addressSegs.map((s) => s.text).join(', ')), addressSegs)
      : none<string>(),
    vendorPan: pick(vendorPan),
    buyerGstin: pick(buyerGstin),
    billingAddress: billAddress.length
      ? toField(clean(billAddress.map((s) => s.text).join(', ')), billAddress)
      : none<string>(),
    placeOfSupply: pick(pos),
    shipToState: pick(shipState),
    shipToGstin: pick(shipGstin),
    shipToAddress: shipAddress.length
      ? toField(clean(shipAddress.map((s) => s.text).join(', ')), shipAddress)
      : none<string>(),
    invoiceNumber: pick(invoiceNumber),
    invoiceDate: pick(date),
    poNumber: pick(po),
    taxablePaise: pick(totals.taxable),
    cgstPaise: pick(totals.cgst),
    sgstPaise: pick(totals.sgst),
    igstPaise: pick(totals.igst),
    cessPaise: pick(totals.cess),
    roundOffPaise: pick(totals.roundOff),
    totalPaise: pick(totals.total),
  } as ExtractedHeader;
  // Nothing found: say how sure the reading is that nothing is printed there (RULES §1.3: a
  // confident null is "not printed"; an unsure one is asked). A text layer is exact, so absence
  // is certain; for OCR it is the page's own mean word confidence, so a blurred page never claims
  // that something is absent. Printed-but-unreadable and ambiguous values keep 0 (they have
  // evidence). Per-line tax columns are not split by this parser, so where the table has one the
  // line taxes are unknown rather than absent.
  const ocrWords = pages.flatMap((p) =>
    p.segments.filter((x) => x.source === 'tesseract').flatMap((x) => x.words ?? []),
  );
  const method: ExtractionMethod = ocrWords.length ? 'tesseract' : 'pdf_text';
  const absenceBp = ocrWords.length
    ? Math.min(
        TEXT_LAYER_BP,
        Math.round((ocrWords.reduce((n, w) => n + w.conf, 0) / ocrWords.length) * 100),
      )
    : TEXT_LAYER_BP;
  const stamp = <F extends { value: unknown; evidence: unknown; source: ExtractionMethod }>(
    f: F,
    unknown = false,
  ): F =>
    f.evidence === null && f.value === null
      ? { ...f, source: method, confidenceBp: confidenceBp(unknown ? 0 : absenceBp) }
      : f;
  for (const k of Object.keys(header) as (keyof ExtractedHeader)[])
    (header as Record<string, unknown>)[k] = stamp(header[k]);
  const lineTax = new Set<string>(['cgstPaise', 'sgstPaise', 'igstPaise']);
  for (const line of lines)
    for (const k of Object.keys(line) as (keyof ExtractedLine)[])
      if (k !== 'lineNo')
        (line as Record<string, unknown>)[k] = stamp(line[k], hasTaxColumn && lineTax.has(k));
  return { header, lines, warnings };
}
