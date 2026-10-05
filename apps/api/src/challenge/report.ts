import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { GlobalFonts, PDFDocument } from '@napi-rs/canvas';
import {
  FINDING_TYPE_LABEL,
  formatInr,
  paise,
  type ApiChallengeInvoice,
  type ApiChallengeSummary,
} from '@veyra/shared';

/**
 * The Veyrafy Invoice Verification Report (5 Invoice Challenge): an A4 PDF drawn as vectors
 * (Skia's PDF backend, already a dependency), from the challenge's results only. Every number is
 * the engine's; nothing is extrapolated (no "per month", no "saved"). Inter is the product's
 * typeface; the rupee sign is drawn as a shape, so it renders the same on every server whatever
 * fonts it has.
 */
export interface ReportInput {
  company: string;
  gstin: string | null;
  date: Date;
  summary: ApiChallengeSummary;
  invoices: ApiChallengeInvoice[];
  records: { name: string; kind: string; summary: string }[];
  challengeId: string;
}

let fontsReady = false;
function registerFonts(): void {
  if (fontsReady) return;
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve('@fontsource-variable/inter/package.json')), 'files');
  GlobalFonts.registerFromPath(join(dir, 'inter-latin-wght-normal.woff2'), 'Inter');
  GlobalFonts.registerFromPath(join(dir, 'inter-latin-ext-wght-normal.woff2'), 'Inter');
  fontsReady = true;
}

const W = 595.28;
const H = 841.89;
const M = 54;
const INK = '#0d0f12';
const INK2 = '#3a3f47';
const INK3 = '#6b7079';
const LINE = '#e3ddd0';
const ACCENT = '#145c46';
const ATTENTION = '#9a5a0b';
const SOFT = '#f6f1e7';

type Weight = 400 | 500 | 600 | 700;

const money = (p: number) => formatInr(paise(p));

class Pdf {
  readonly doc: PDFDocument;
  ctx!: ReturnType<PDFDocument['beginPage']>;
  y = 0;
  page = 0;

  constructor(
    title: string,
    readonly footer: string,
  ) {
    this.doc = new PDFDocument({
      title,
      author: 'Veyrafy',
      creator: 'Veyrafy',
      producer: 'Veyrafy',
      subject: 'Invoice verification report',
    });
    this.newPage();
  }

  newPage(): void {
    if (this.page > 0) this.endPage();
    this.page += 1;
    this.ctx = this.doc.beginPage(W, H);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, W, H);
    // Running header.
    this.text('Veyrafy', M, 36, { size: 11, weight: 700, color: INK });
    this.text('Invoice Verification Report', W - M, 36, {
      size: 8.5,
      color: INK3,
      align: 'right',
    });
    this.rule(M, 46, W - M, 46);
    this.y = 74;
  }

  endPage(): void {
    this.rule(M, H - 46, W - M, H - 46);
    this.text(this.footer, M, H - 30, { size: 7.5, color: INK3 });
    this.text(`Page ${this.page}`, W - M, H - 30, { size: 7.5, color: INK3, align: 'right' });
    this.doc.endPage();
  }

  close(): Buffer {
    this.endPage();
    return this.doc.close();
  }

  ensure(height: number): void {
    if (this.y + height > H - 64) this.newPage();
  }

  font(size: number, weight: Weight): void {
    this.ctx.font = `${weight} ${size}px Inter`;
  }

  /** Width of a text, the rupee sign included. */
  measure(s: string, size: number, weight: Weight): number {
    this.font(size, weight);
    let w = 0;
    for (const [i, part] of s.split('₹').entries()) {
      if (i > 0) w += size * 0.58;
      w += this.ctx.measureText(part).width;
    }
    return w;
  }

  /** One line of text at (x, y baseline). The rupee sign is drawn, not typed. */
  text(
    s: string,
    x: number,
    y: number,
    o: { size?: number; weight?: Weight; color?: string; align?: 'left' | 'right' } = {},
  ): number {
    const size = o.size ?? 10;
    const weight = o.weight ?? 400;
    const width = this.measure(s, size, weight);
    let cx = o.align === 'right' ? x - width : x;
    this.font(size, weight);
    this.ctx.fillStyle = o.color ?? INK;
    this.ctx.strokeStyle = o.color ?? INK;
    for (const [i, part] of s.split('₹').entries()) {
      if (i > 0) {
        this.rupee(cx, y, size, weight);
        cx += size * 0.58;
      }
      this.ctx.fillText(part, cx, y);
      cx += this.ctx.measureText(part).width;
    }
    return width;
  }

  /** ₹, drawn in an em box: two bars, the bowl, and the diagonal leg. */
  rupee(x: number, y: number, size: number, weight: Weight): void {
    const c = this.ctx;
    const s = size;
    c.save();
    c.lineWidth = s * (weight >= 600 ? 0.095 : 0.072);
    c.lineCap = 'butt';
    c.lineJoin = 'miter';
    c.beginPath();
    c.moveTo(x + s * 0.06, y - s * 0.7);
    c.lineTo(x + s * 0.52, y - s * 0.7);
    c.moveTo(x + s * 0.06, y - s * 0.53);
    c.lineTo(x + s * 0.52, y - s * 0.53);
    c.moveTo(x + s * 0.08, y - s * 0.7);
    c.lineTo(x + s * 0.2, y - s * 0.7);
    c.bezierCurveTo(
      x + s * 0.44,
      y - s * 0.7,
      x + s * 0.44,
      y - s * 0.36,
      x + s * 0.2,
      y - s * 0.36,
    );
    c.lineTo(x + s * 0.08, y - s * 0.36);
    c.moveTo(x + s * 0.12, y - s * 0.36);
    c.lineTo(x + s * 0.46, y);
    c.stroke();
    c.restore();
  }

  /** Wrapped paragraph from the cursor; returns its height. */
  para(
    s: string,
    o: {
      x?: number;
      width?: number;
      size?: number;
      weight?: Weight;
      color?: string;
      lead?: number;
    } = {},
  ): void {
    const size = o.size ?? 10;
    const weight = o.weight ?? 400;
    const x = o.x ?? M;
    const width = o.width ?? W - M - x;
    const lead = o.lead ?? size * 1.45;
    const words = s.split(/\s+/).filter(Boolean);
    let line = '';
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (this.measure(next, size, weight) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      this.ensure(lead);
      this.y += lead;
      this.text(l, x, this.y - lead * 0.28, {
        size,
        weight,
        ...(o.color ? { color: o.color } : {}),
      });
    }
  }

  rule(x1: number, y1: number, x2: number, y2: number, color = LINE): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 0.6;
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
  }

  box(x: number, y: number, w: number, h: number, fill: string, stroke?: string): void {
    this.ctx.fillStyle = fill;
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, w, h, 6);
    this.ctx.fill();
    if (stroke) {
      this.ctx.strokeStyle = stroke;
      this.ctx.lineWidth = 0.6;
      this.ctx.stroke();
    }
  }

  heading(s: string): void {
    this.ensure(44);
    this.y += 26;
    this.text(s, M, this.y, { size: 12.5, weight: 600 });
    this.y += 8;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function renderChallengeReport(r: ReportInput): Promise<Buffer> {
  registerFonts();
  const s = r.summary;
  const dateText = r.date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  const pdf = new Pdf(
    `Veyrafy Invoice Verification Report: ${r.company}`,
    `Prepared by Veyrafy · ${r.company} · ${dateText} · Ref. ${r.challengeId.slice(-8)}`,
  );

  // ── Title ────────────────────────────────────────────────────────────────
  pdf.text('Veyrafy Invoice Verification Report', M, pdf.y + 6, { size: 21, weight: 600 });
  pdf.y += 30;
  pdf.text(r.company, M, pdf.y, { size: 11.5, weight: 500, color: INK2 });
  pdf.y += 16;
  pdf.text(
    [r.gstin ? `GSTIN ${r.gstin}` : null, dateText, `${plural(s.checked, 'invoice')} checked`]
      .filter(Boolean)
      .join('  ·  '),
    M,
    pdf.y,
    { size: 9, color: INK3 },
  );
  pdf.y += 22;

  // ── Executive summary ────────────────────────────────────────────────────
  const summaryLines = [
    `${plural(s.checked, 'invoice')} ${s.checked === 1 ? 'was' : 'were'} checked.`,
    `${s.cleared} cleared without exceptions.`,
    `${s.attention} require${s.attention === 1 ? 's' : ''} attention.`,
    `${money(s.reviewValuePaise)} of invoice value requires review.`,
  ];
  const boxH = 30 + summaryLines.length * 17;
  pdf.box(M, pdf.y, W - 2 * M, boxH, SOFT);
  pdf.text('EXECUTIVE SUMMARY', M + 16, pdf.y + 20, { size: 7.5, weight: 600, color: INK3 });
  summaryLines.forEach((l, i) =>
    pdf.text(l, M + 16, pdf.y + 40 + i * 17, {
      size: 11,
      weight: i === 3 ? 600 : 400,
      color: i === 3 && s.attention ? ATTENTION : INK,
    }),
  );
  pdf.y += boxH + 18;

  // ── Figures ──────────────────────────────────────────────────────────────
  const kpis: [string, string][] = [
    ['Invoices checked', String(s.checked)],
    ['Total invoice value', money(s.totalPaise)],
    ['Cleared', String(s.cleared)],
    ['Need attention', String(s.attention)],
    ['Value requiring review', money(s.reviewValuePaise)],
  ];
  const kw = (W - 2 * M) / kpis.length;
  kpis.forEach(([label, value], i) => {
    const x = M + i * kw;
    pdf.text(label, x, pdf.y, { size: 7.5, color: INK3 });
    pdf.text(value, x, pdf.y + 18, {
      size: value.length > 12 ? 11 : 14,
      weight: 600,
      color: i === 4 && s.attention ? ATTENTION : INK,
    });
  });
  pdf.y += 34;
  const notes: string[] = [];
  if (s.totalUnread)
    notes.push(
      `${plural(s.totalUnread, 'invoice')} without a readable total ${s.totalUnread === 1 ? 'is' : 'are'} not included in the amounts.`,
    );
  if (s.failed)
    notes.push(
      `${plural(s.failed, 'document')} could not be processed and ${s.failed === 1 ? 'is' : 'are'} listed separately.`,
    );
  for (const n of notes) pdf.para(n, { size: 8.5, color: INK3 });

  // ── What the invoices were checked against ───────────────────────────────
  pdf.heading('What was checked');
  if (r.records.length) {
    pdf.para(
      'Each invoice was checked on its own (required details, GSTINs, calculations, tax and duplicate copies) and against the purchasing records provided:',
      { size: 9.5, color: INK2 },
    );
    for (const f of r.records)
      pdf.para(`•  ${f.name}: ${f.summary}`, { x: M + 8, size: 9.5, color: INK2 });
    if (s.clearedInvoiceOnly)
      pdf.para(
        `${plural(s.clearedInvoiceOnly, 'cleared invoice')} had no matching purchasing record and ${s.clearedInvoiceOnly === 1 ? 'was' : 'were'} verified from the invoice only.`,
        { size: 9.5, color: INK2 },
      );
  } else {
    pdf.para(
      'No purchasing or accounting records were provided. Every invoice was verified from the invoice itself (required details, GSTINs, calculations, tax and duplicate copies). Rates, quantities and receipts were not compared with purchase orders or goods receipts.',
      { size: 9.5, color: INK2 },
    );
  }

  // ── Exception breakdown ──────────────────────────────────────────────────
  const attention = r.invoices.filter((i) => i.outcome === 'review' || i.outcome === 'confirm');
  if (attention.length) {
    pdf.heading('Exception breakdown');
    const byType = new Map<string, { n: number; value: number }>();
    for (const i of attention) {
      const k = i.finding?.type ?? 'other';
      const e = byType.get(k) ?? { n: 0, value: 0 };
      e.n += 1;
      e.value += i.totalPaise ?? 0;
      byType.set(k, e);
    }
    pdf.y += 6;
    pdf.text('Type', M, pdf.y + 10, { size: 7.5, weight: 600, color: INK3 });
    pdf.text('Invoices', W - M - 150, pdf.y + 10, {
      size: 7.5,
      weight: 600,
      color: INK3,
      align: 'right',
    });
    pdf.text('Invoice value', W - M, pdf.y + 10, {
      size: 7.5,
      weight: 600,
      color: INK3,
      align: 'right',
    });
    pdf.y += 16;
    for (const [k, e] of [...byType.entries()].sort((a, b) => b[1].value - a[1].value)) {
      pdf.ensure(20);
      pdf.rule(M, pdf.y, W - M, pdf.y);
      pdf.y += 15;
      pdf.text(FINDING_TYPE_LABEL[k] ?? k, M, pdf.y, { size: 9.5 });
      pdf.text(String(e.n), W - M - 150, pdf.y, { size: 9.5, align: 'right' });
      pdf.text(money(e.value), W - M, pdf.y, { size: 9.5, align: 'right' });
      pdf.y += 5;
    }
  }

  // ── Findings ─────────────────────────────────────────────────────────────
  if (attention.length) {
    pdf.heading('Findings');
    for (const inv of attention) {
      const f = inv.finding;
      pdf.ensure(110);
      pdf.y += 10;
      let top = pdf.y;
      const startPage = pdf.page;
      const state = inv.outcome === 'review' ? 'NEEDS REVIEW' : 'NEEDS CONFIRMATION';
      pdf.text(
        `${(FINDING_TYPE_LABEL[f?.type ?? 'other'] ?? 'Finding').toUpperCase()}  ·  ${state}`,
        M + 12,
        pdf.y + 10,
        {
          size: 7.5,
          weight: 600,
          color: ATTENTION,
        },
      );
      pdf.y += 26;
      pdf.text(f?.label ?? 'Needs attention', M + 12, pdf.y, { size: 11.5, weight: 600 });
      pdf.y += 15;
      pdf.text(
        [
          inv.supplier ?? 'Supplier not read',
          inv.number ? `Invoice ${inv.number}` : null,
          inv.totalPaise !== null ? money(inv.totalPaise) : null,
        ]
          .filter(Boolean)
          .join('  ·  '),
        M + 12,
        pdf.y,
        { size: 9, color: INK3 },
      );
      if (f) {
        for (const c of f.compare) {
          pdf.y += 15;
          pdf.text(`${c.label}:`, M + 12, pdf.y, { size: 9.5, color: INK2 });
          pdf.text(c.value, M + 220, pdf.y, {
            size: 9.5,
            weight: c.tone === 'attention' ? 600 : 400,
          });
        }
        if (f.difference) {
          pdf.y += 15;
          pdf.text('Difference:', M + 12, pdf.y, { size: 9.5, color: INK2 });
          pdf.text(f.difference, M + 220, pdf.y, { size: 9.5, weight: 600, color: ATTENTION });
        }
        if (f.impactPaise !== null && f.impactPaise !== 0) {
          pdf.y += 15;
          pdf.text('Amount at stake:', M + 12, pdf.y, { size: 9.5, color: INK2 });
          pdf.text(f.impact, M + 220, pdf.y, { size: 9.5, weight: 600 });
        }
        pdf.y += 4;
        pdf.para(f.explanation, { x: M + 12, width: W - 2 * M - 24, size: 9.5, color: INK2 });
        const ev = f.evidence
          .slice(0, 4)
          .map((e) =>
            e.source === 'invoice'
              ? `invoice${e.page ? ` p.${e.page}` : ''}: ${e.label.replace(/^Invoice · /, '')} ${e.value}`
              : `compared with: ${e.label} ${e.value}`,
          );
        if (ev.length)
          pdf.para(`Evidence: ${ev.join('; ')}.`, {
            x: M + 12,
            width: W - 2 * M - 24,
            size: 8.5,
            color: INK3,
          });
        pdf.para(`Recommended action: ${f.action}.`, {
          x: M + 12,
          width: W - 2 * M - 24,
          size: 9.5,
          weight: 600,
          color: ACCENT,
        });
      }
      for (const m of inv.more)
        pdf.para(`Also on this invoice: ${m}`, {
          x: M + 12,
          width: W - 2 * M - 24,
          size: 8.5,
          color: INK3,
        });
      pdf.y += 10;
      // A thin bar marks the finding (drawn after: the card's height is known now); a card that
      // went over a page break is marked from the top of the new page.
      if (pdf.page !== startPage) top = 74;
      pdf.ctx.fillStyle = ATTENTION;
      pdf.ctx.fillRect(M, top, 2, Math.max(20, pdf.y - top - 4));
    }
  }

  // ── Cleared ──────────────────────────────────────────────────────────────
  const cleared = r.invoices.filter((i) => i.outcome === 'cleared');
  if (cleared.length) {
    pdf.heading(`Cleared invoices (${cleared.length})`);
    for (const inv of cleared) {
      pdf.ensure(20);
      pdf.y += 15;
      pdf.text('•', M, pdf.y, { size: 9.5, color: ACCENT });
      pdf.text(
        [inv.supplier ?? 'Supplier not read', inv.number ? `Invoice ${inv.number}` : null]
          .filter(Boolean)
          .join('  ·  '),
        M + 12,
        pdf.y,
        { size: 9.5 },
      );
      pdf.text(inv.totalPaise !== null ? money(inv.totalPaise) : '—', W - M - 150, pdf.y, {
        size: 9.5,
        align: 'right',
      });
      pdf.text(
        inv.basis === 'records' ? 'Checked against records' : 'Invoice checks only',
        W - M,
        pdf.y,
        {
          size: 8,
          color: INK3,
          align: 'right',
        },
      );
    }
  }

  // ── Not processed ────────────────────────────────────────────────────────
  const failed = r.invoices.filter((i) => i.outcome === 'failed');
  if (failed.length) {
    pdf.heading(`Not processed (${failed.length})`);
    for (const inv of failed) {
      pdf.ensure(30);
      pdf.y += 4;
      pdf.para(`${inv.filename}: ${inv.failure?.reason ?? 'could not be processed.'}`, {
        size: 9.5,
        color: INK2,
      });
    }
  }

  // ── Recommended actions ──────────────────────────────────────────────────
  if (attention.length) {
    pdf.heading('Recommended actions');
    for (const inv of attention) {
      const what = inv.finding?.action ?? 'Review';
      pdf.para(
        `•  ${what}: ${inv.supplier ?? 'Supplier not read'}${inv.number ? ` · ${inv.number}` : ''}. Hold payment until it is resolved.`,
        { size: 9.5, color: INK2 },
      );
    }
  }

  // ── Method note (kept together: never two lines alone on a last page) ────
  pdf.ensure(110);
  pdf.heading('About this report');
  pdf.para(
    'Results come from the Veyrafy verification engine, applied to the invoices and records provided for this challenge. A value Veyrafy could not read with certainty is reported as needing confirmation, never assumed. Amounts are the invoices’ own totals; "value requiring review" is the total of the invoices that need attention, not an amount saved or lost, and no figure is projected beyond these invoices.',
    { size: 8.5, color: INK3 },
  );

  return pdf.close();
}
