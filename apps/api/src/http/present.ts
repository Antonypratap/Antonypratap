import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  RULES,
  formatQty,
  milliQty,
  type ApiAuditEntry,
  type ApiInbox,
  type ApiInputSpec,
  type ApiInvoiceDetail,
  type ApiInvoiceSummary,
  type ApiQuestion,
  type InvoiceState,
  type RuleCode,
  type UiStatus,
} from '@veyra/shared';
import { stateName, validateGstin } from '@veyra/india-tax';
import * as t from '../db/schema';
import { readField, type StoredField } from '../engine/fields';
import { dateText, displayValue, fieldLabel, rupees } from '../engine/questions';
import { storedField, type Veyra } from '../workflow/veyra';
import { buildComparison } from './comparison';
import { compareWithReceipt } from '../workflow/erp-receipts';

type InvoiceRow = typeof t.invoices.$inferSelect;
type DocumentRow = typeof t.documents.$inferSelect;
type QuestionRow = typeof t.questions.$inferSelect;

interface QuestionContext {
  summary: string;
  evidence: string;
  facts: { label: string; value: string; tone?: 'attention' }[];
  why: string[];
  paths: string[];
  optionMeta: Record<string, { emphasis: 'primary' | 'secondary' | 'quiet'; result: string }>;
}

/** Status labels in business language, as the product shows them. */
export const STATUS_TEXT: Record<UiStatus, string> = {
  attention: 'Needs your attention',
  processing: 'Processing',
  ready: 'Ready',
  handled: 'Handled',
  rejected: 'Rejected',
};

/** Status in business language (the approved product semantics). */
export function uiStatus(state: InvoiceState, decidedByYou: boolean): UiStatus {
  if (state === 'NEEDS_INPUT' || state === 'FAILED') return 'attention';
  if (state === 'REJECTED') return 'rejected';
  if (state === 'VERIFIED_PENDING_PAYMENT') return decidedByYou ? 'ready' : 'handled';
  return 'processing';
}

export function questionDto(q: QuestionRow, invoice: ApiQuestion['invoice']): ApiQuestion {
  const context = JSON.parse(q.contextJson) as QuestionContext;
  const options = JSON.parse(q.optionsJson) as {
    id: string;
    label: string;
    effect: { type: string };
  }[];
  const inputs = (q.inputSchemaJson ? JSON.parse(q.inputSchemaJson) : {}) as Record<
    string,
    ApiInputSpec
  >;
  const answer = q.answerJson ? (JSON.parse(q.answerJson) as { optionId: string }) : null;
  const chosen = answer ? options.find((o) => o.id === answer.optionId) : undefined;
  return {
    id: q.id,
    invoiceId: q.invoiceId,
    code: q.code,
    kind: q.kind as ApiQuestion['kind'],
    status: q.status as ApiQuestion['status'],
    summary: context.summary,
    evidence: context.evidence,
    headline: q.prompt,
    facts: context.facts,
    why: context.why,
    paths: context.paths,
    options: options.map((o) => ({
      id: o.id,
      label: o.label,
      emphasis: context.optionMeta[o.id]?.emphasis ?? 'secondary',
      result: context.optionMeta[o.id]?.result ?? '',
      input: inputs[o.id] ?? null,
      rejects: o.effect.type === 'REJECT_INVOICE',
    })),
    createdAt: q.createdAt,
    answeredAt: q.answeredAt,
    answer:
      answer && chosen
        ? {
            optionId: chosen.id,
            label: chosen.label,
            result: context.optionMeta[chosen.id]?.result ?? '',
          }
        : null,
    invoice,
  };
}

/** The header fields list views (inbox, questions) show. */
const LIST_PATHS = [
  'header.invoiceNumber',
  'header.vendorName',
  'header.invoiceDate',
  'header.totalPaise',
];

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** Whether the inbox note names the matched ERP order (a verified invoice that created none). */
function needsPoNumber(inv: InvoiceRow, committed: string[]): boolean {
  return inv.state === 'VERIFIED_PENDING_PAYMENT' && !committed.includes('po');
}

/** The inbox note: what Veyra did for a verified invoice, or why it was rejected. */
function note(inv: InvoiceRow, committed: string[], poNumber: string | null): string | null {
  if (inv.state === 'REJECTED')
    return inv.rejectedReason ? `Rejected: ${inv.rejectedReason}` : 'Rejected';
  if (inv.state !== 'VERIFIED_PENDING_PAYMENT') return null;
  const parts: string[] = [];
  if (committed.includes('vendor')) parts.push('New supplier added');
  if (committed.includes('vendor_reactivation')) parts.push('Supplier reactivated');
  if (committed.includes('item')) parts.push('New item added');
  if (committed.includes('po')) parts.push('order created');
  else if (poNumber) parts.push(`Matched to ${poNumber}`);
  if (committed.includes('grn')) parts.push('receipt recorded');
  const text = parts.join(', ');
  return text ? text[0]?.toUpperCase() + text.slice(1) : null;
}

export class Presenter {
  constructor(readonly v: Veyra) {}

  private fields(invoiceId: string): Promise<Map<string, StoredField>> {
    return this.v.loadFields(this.v.db, invoiceId);
  }

  private shown<T extends string | number>(f: Map<string, StoredField>, path: string): T | null {
    // Display what is printed even when it is not (yet) usable; decisions never use this.
    const r = readField<T>(f, path as never, 0);
    return r.value;
  }

  /** The invoice's questions in the order they were raised. */
  private questionsOf(invoiceId: string): Promise<QuestionRow[]> {
    return this.v.db
      .select()
      .from(t.questions)
      .where(eq(t.questions.invoiceId, invoiceId))
      .orderBy(asc(t.questions.seq));
  }

  /** What the ERP holds for this invoice: the order's goods receipts and the recorded invoice. */
  async erpEvidence(
    inv: InvoiceRow,
  ): Promise<Pick<ApiInvoiceDetail['erp'], 'receipts' | 'purchaseInvoice'>> {
    const grns = inv.poErpId ? await this.v.erp.listGrnsForPo(inv.poErpId as never) : [];
    const recorded = inv.erpPurchaseInvoiceId
      ? (await this.v.erp.listPurchaseInvoices()).find((p) => p.id === inv.erpPurchaseInvoiceId)
      : undefined;
    return {
      receipts: grns.map((g) => ({
        number: g.grnNumber,
        date: g.grnDate,
        byYou: g.origin === 'user_confirmed_via_veyra',
      })),
      purchaseInvoice: recorded
        ? {
            id: recorded.id,
            status: recorded.status,
            totalPaise: recorded.totalPaise,
            lines: recorded.lines.length,
          }
        : null,
    };
  }

  /**
   * The invoice compared value by value: with its ERP goods-receipt record when the ERP exported
   * one (the receipt check), otherwise with the ERP's records through the full checks.
   */
  private async receiptOrErpComparison(
    ...args: Parameters<Presenter['comparison']>
  ): Promise<ApiInvoiceDetail['comparison']> {
    const [inv] = args;
    if (['UPLOADED', 'EXTRACTING'].includes(inv.state)) return null;
    const side = await this.v.invoiceSide(inv.id);
    const record = await this.v.receiptRecordFor(side);
    return record ? compareWithReceipt(side, record) : this.comparison(...args);
  }

  /** The invoice compared with the ERP, value by value (built from the latest check run). */
  private async comparison(
    inv: InvoiceRow,
    f: Map<string, StoredField>,
    checks: Parameters<typeof buildComparison>[0]['checks'],
    lineRows: { lineNo: number; itemErpId: string | null; poLineErpId: string | null }[],
    companyGstin: string,
  ) {
    if (checks.length === 0) return null;
    const str = (p: string) => this.shown<string>(f, p);
    const num = (p: string) => this.shown<number>(f, p);
    const erp = this.v.erp;
    const vendor = inv.vendorErpId ? await erp.getVendor(inv.vendorErpId as never) : null;
    const po = inv.poErpId ? await erp.getPurchaseOrder(inv.poErpId as never) : null;
    const poVendor = po ? await erp.getVendor(po.vendorId) : null;
    const grns = po ? await erp.listGrnsForPo(po.id) : [];
    const lines = await Promise.all(
      lineRows.map(async (l) => {
        const poLine = po?.lines.find((pl) => pl.id === l.poLineErpId) ?? null;
        const item = l.itemErpId
          ? await erp.getItem(l.itemErpId as never)
          : poLine
            ? await erp.getItem(poLine.itemId)
            : null;
        const path = (k: string) => `lines[${l.lineNo}].${k}`;
        return {
          lineNo: l.lineNo,
          description: str(path('description')),
          hsnSac: str(path('hsnSac')),
          uom: str(path('uom')),
          qtyMilli: num(path('qtyMilli')),
          unitPricePaise: num(path('unitPricePaise')),
          taxablePaise: num(path('taxablePaise')),
          gstRateBp: num(path('gstRateBp')),
          item,
          poLine,
          acceptedMilli: poLine
            ? grns
                .flatMap((g) => g.lines)
                .filter((gl) => gl.poLineId === poLine.id)
                .reduce((s, gl) => s + gl.acceptedQtyMilli, 0)
            : null,
        };
      }),
    );
    const date = str('header.invoiceDate');
    return buildComparison({
      cleared: inv.state === 'VERIFIED_PENDING_PAYMENT' || inv.state === 'COMMITTING',
      checks,
      header: {
        vendorName: str('header.vendorName'),
        vendorGstin: str('header.vendorGstin'),
        buyerGstin: str('header.buyerGstin'),
        invoiceNumber: str('header.invoiceNumber'),
        invoiceDate: date ? dateText(date) : null,
        poNumber: str('header.poNumber'),
        taxablePaise: num('header.taxablePaise'),
        cgstPaise: num('header.cgstPaise'),
        sgstPaise: num('header.sgstPaise'),
        igstPaise: num('header.igstPaise'),
        roundOffPaise: num('header.roundOffPaise'),
        totalPaise: num('header.totalPaise'),
      },
      companyGstin,
      vendor,
      po,
      poVendorName: poVendor?.name ?? null,
      grns,
      lines,
    });
  }

  async poNumberOf(inv: InvoiceRow): Promise<string | null> {
    if (!inv.poErpId) return null;
    return (await this.v.erp.getPurchaseOrder(inv.poErpId as never))?.poNumber ?? null;
  }

  /** One invoice's summary, loading what it needs (the invoice detail uses this). */
  async summary(inv: InvoiceRow, doc: DocumentRow): Promise<ApiInvoiceSummary> {
    const committed = await this.v.db
      .select({ entity: t.creationActions.entity })
      .from(t.creationActions)
      .where(
        and(eq(t.creationActions.invoiceId, inv.id), eq(t.creationActions.status, 'committed')),
      )
      .orderBy(asc(t.creationActions.seq));
    return this.buildSummary(inv, doc, {
      fields: await this.fields(inv.id),
      questions: await this.questionsOf(inv.id),
      minConfidenceBp: (await this.v.settings()).confidenceMinBp,
      committed: committed.map((a) => a.entity),
      poNumber: needsPoNumber(
        inv,
        committed.map((a) => a.entity),
      )
        ? await this.poNumberOf(inv)
        : null,
    });
  }

  /**
   * Many invoices' summaries with a fixed number of queries (Phase 7): the list fields,
   * questions and committed creations of all of them at once, settings once, and each distinct
   * ERP order looked up once. Same result as `summary` for each invoice (tested).
   */
  async summaries(rows: { invoices: InvoiceRow; documents: DocumentRow }[]) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.invoices.id);
    const [fields, questions, committed, settings] = await Promise.all([
      this.listFields(ids),
      this.v.db
        .select()
        .from(t.questions)
        .where(inArray(t.questions.invoiceId, ids))
        .orderBy(asc(t.questions.seq)),
      this.v.db
        .select({ invoiceId: t.creationActions.invoiceId, entity: t.creationActions.entity })
        .from(t.creationActions)
        .where(
          and(inArray(t.creationActions.invoiceId, ids), eq(t.creationActions.status, 'committed')),
        )
        .orderBy(asc(t.creationActions.seq)),
      this.v.settings(),
    ]);
    const questionsBy = groupBy(questions, (q) => q.invoiceId);
    const committedBy = groupBy(committed, (a) => a.invoiceId);
    const entitiesOf = (id: string) => (committedBy.get(id) ?? []).map((a) => a.entity);
    // Each distinct ERP order once (the same order can be matched by many invoices).
    const poIds = [
      ...new Set(
        rows
          .filter((r) => needsPoNumber(r.invoices, entitiesOf(r.invoices.id)))
          .map((r) => r.invoices.poErpId)
          .filter((x): x is string => x !== null),
      ),
    ];
    const poNumbers = new Map<string, string | null>();
    for (const id of poIds)
      poNumbers.set(id, (await this.v.erp.getPurchaseOrder(id as never))?.poNumber ?? null);
    return rows.map(({ invoices: inv, documents: doc }) =>
      this.buildSummary(inv, doc, {
        fields: fields.get(inv.id) ?? new Map(),
        questions: questionsBy.get(inv.id) ?? [],
        minConfidenceBp: settings.confidenceMinBp,
        committed: entitiesOf(inv.id),
        poNumber:
          needsPoNumber(inv, entitiesOf(inv.id)) && inv.poErpId
            ? (poNumbers.get(inv.poErpId) ?? null)
            : null,
      }),
    );
  }

  /** The fields list views show, for many invoices in one query. */
  private async listFields(invoiceIds: string[]): Promise<Map<string, Map<string, StoredField>>> {
    const rows = await this.v.db
      .select()
      .from(t.extractedFields)
      .where(
        and(
          inArray(t.extractedFields.invoiceId, invoiceIds),
          inArray(t.extractedFields.path, LIST_PATHS),
        ),
      );
    const out = new Map<string, Map<string, StoredField>>();
    for (const r of rows) {
      const m = out.get(r.invoiceId) ?? new Map<string, StoredField>();
      m.set(r.path, storedField(r));
      out.set(r.invoiceId, m);
    }
    return out;
  }

  private buildSummary(
    inv: InvoiceRow,
    doc: DocumentRow,
    x: {
      fields: Map<string, StoredField>;
      questions: QuestionRow[];
      minConfidenceBp: number;
      committed: string[];
      poNumber: string | null;
    },
  ): ApiInvoiceSummary {
    const f = x.fields;
    const qs = x.questions;
    const open = qs.find((q) => q.status === 'open');
    const answered = qs
      .filter((q) => q.status === 'answered')
      .sort((a, b) => (b.answerSeq ?? 0) - (a.answerSeq ?? 0));
    const lastDecision = answered[0];
    const openCtx = open ? (JSON.parse(open.contextJson) as QuestionContext) : null;
    let decision: ApiInvoiceSummary['decision'] = null;
    if (lastDecision) {
      const ctx = JSON.parse(lastDecision.contextJson) as QuestionContext;
      const ans = JSON.parse(lastDecision.answerJson ?? '{}') as { optionId: string };
      const option = (JSON.parse(lastDecision.optionsJson) as { id: string; label: string }[]).find(
        (o) => o.id === ans.optionId,
      );
      decision = {
        summary: ctx.summary,
        label: option?.label ?? '',
        result: ctx.optionMeta[ans.optionId]?.result ?? '',
        at: lastDecision.answeredAt ?? '',
      };
    }
    const state = inv.state as InvoiceState;
    return {
      id: inv.id,
      documentId: doc.id,
      state,
      status: uiStatus(state, answered.length > 0),
      number: this.shown<string>(f, 'header.invoiceNumber'),
      supplierName: this.shown<string>(f, 'header.vendorName'),
      invoiceDate: this.shown<string>(f, 'header.invoiceDate'),
      // Only a total Veyra can use is shown as the amount; an unclear reading stays in the question.
      totalPaise: readField<number>(f, 'header.totalPaise', x.minConfidenceBp).value,
      source: doc.mime === 'application/pdf' ? 'PDF' : 'Photo',
      filename: doc.filename,
      receivedAt: doc.uploadedAt,
      updatedAt: inv.updatedAt,
      question:
        open && openCtx
          ? {
              id: open.id,
              kind: open.kind as ApiQuestion['kind'],
              summary: openCtx.summary,
              evidence: openCtx.evidence,
              headline: open.prompt,
            }
          : null,
      decision,
      note: note(inv, x.committed, x.poNumber),
      failure:
        state === 'FAILED'
          ? { stage: inv.failedStage ?? '', reason: plainFailure(inv.failureReason ?? '') }
          : null,
    };
  }

  async inbox(): Promise<ApiInbox> {
    const rows = await this.v.db
      .select()
      .from(t.invoices)
      .innerJoin(t.documents, eq(t.documents.id, t.invoices.documentId))
      .orderBy(desc(t.documents.uploadedAt), desc(t.invoices.seq));
    const invoices = await this.summaries(rows);
    const count = (s: UiStatus) => invoices.filter((i) => i.status === s).length;
    return {
      counts: {
        received: invoices.length,
        needsYou: count('attention'),
        processing: count('processing'),
        handled: count('handled'),
        ready: count('ready'),
        rejected: count('rejected'),
        decidedByYou: invoices.filter((i) => i.decision !== null).length,
      },
      invoices,
    };
  }

  async detail(invoiceId: string): Promise<ApiInvoiceDetail> {
    const inv = await this.v.invoiceRow(this.v.db, invoiceId);
    const doc = (
      await this.v.db.select().from(t.documents).where(eq(t.documents.id, inv.documentId)).limit(1)
    )[0];
    if (!doc) throw new Error('document missing');
    const base = await this.summary(inv, doc);
    const f = await this.fields(invoiceId);
    const min = (await this.v.settings()).confidenceMinBp;
    const str = (p: string) => this.shown<string>(f, p);
    const num = (p: string) => this.shown<number>(f, p);
    const lineNos = await this.v.db
      .select()
      .from(t.invoiceLines)
      .where(eq(t.invoiceLines.invoiceId, invoiceId))
      .orderBy(asc(t.invoiceLines.lineNo));
    const vendorGstin = (f.get('header.vendorGstin')?.value as string | null) ?? null;
    const vendorState = vendorGstin ? validateGstin(vendorGstin) : null;
    const pos = readField<string>(f, 'header.placeOfSupply', min).value;
    const company = await this.v.erp.getCompany();
    const taxable = num('header.taxablePaise');
    const heads = ['header.cgstPaise', 'header.sgstPaise', 'header.igstPaise'].map(
      (p) => num(p) ?? 0,
    );
    const roundOff = num('header.roundOffPaise');
    const unclear = [...f.values()]
      .filter((x) => {
        const s = readField(f, x.path, min).state;
        return s === 'low_confidence' || s === 'unparseable';
      })
      .map((x) => x.path);
    const latestRun = inv.runNo;
    const checks = (
      await this.v.db
        .select()
        .from(t.validationResults)
        .where(
          and(
            eq(t.validationResults.invoiceId, invoiceId),
            eq(t.validationResults.runNo, latestRun),
          ),
        )
        .orderBy(asc(t.validationResults.seq))
    ).map((r) => ({
      rule: r.ruleCode,
      name: RULES[r.ruleCode as RuleCode].name,
      lineNo: r.lineNo,
      outcome: r.outcome as 'pass',
      naReason: r.naReason,
      message: r.message,
    }));
    const records = (
      await this.v.db
        .select()
        .from(t.auditEvents)
        .where(
          and(
            eq(t.auditEvents.invoiceId, invoiceId),
            eq(t.auditEvents.event, 'creation.committed'),
          ),
        )
        .orderBy(asc(t.auditEvents.seq))
    ).map((e) => String((JSON.parse(e.detailJson) as { label?: string }).label ?? ''));
    const vendor = inv.vendorErpId ? await this.v.erp.getVendor(inv.vendorErpId as never) : null;
    const invoiceBrief = {
      number: base.number,
      supplierName: base.supplierName,
      totalPaise: base.totalPaise,
    };
    return {
      ...base,
      supplier: {
        name: str('header.vendorName'),
        gstin: vendorGstin,
        address: str('header.vendorAddress'),
        state: vendorState?.ok ? (stateName(vendorState.value.stateCode) ?? null) : null,
        stateCode: vendorState?.ok ? vendorState.value.stateCode : null,
      },
      buyer: {
        name: company.name,
        gstin: str('header.buyerGstin'),
        address: null,
        state: stateName(company.stateCode) ?? null,
        stateCode: company.stateCode,
      },
      poNumber: str('header.poNumber') ?? (await this.poNumberOf(inv)),
      placeOfSupply: pos
        ? `${stateName(pos as never) ?? pos} (${pos})`
        : ((f.get('header.placeOfSupply')?.value as string | null) ?? null),
      supply:
        vendorState?.ok && pos
          ? vendorState.value.stateCode === pos
            ? 'intra_state'
            : 'inter_state'
          : null,
      lines: lineNos.map((l) => ({
        lineNo: l.lineNo,
        description: str(`lines[${l.lineNo}].description`),
        hsnSac: str(`lines[${l.lineNo}].hsnSac`),
        qtyMilli: num(`lines[${l.lineNo}].qtyMilli`),
        uom: str(`lines[${l.lineNo}].uom`),
        unitPricePaise: num(`lines[${l.lineNo}].unitPricePaise`),
        taxablePaise: num(`lines[${l.lineNo}].taxablePaise`),
        gstRateBp: num(`lines[${l.lineNo}].gstRateBp`),
      })),
      taxablePaise: taxable,
      cgstPaise: num('header.cgstPaise'),
      sgstPaise: num('header.sgstPaise'),
      igstPaise: num('header.igstPaise'),
      roundOffPaise: roundOff,
      readTotalPaise: num('header.totalPaise'),
      totals:
        taxable === null
          ? null
          : {
              calculatedPaise: taxable + heads.reduce((a, b) => a + b, 0),
              roundOffPaise: roundOff,
              invoicePaise: base.totalPaise,
            },
      unclearPaths: unclear,
      questions: (await this.questionsOf(invoiceId))
        .filter((q) => q.status !== 'superseded')
        .map((q) => questionDto(q, invoiceBrief)),
      checks,
      comparison: await this.receiptOrErpComparison(inv, f, checks, lineNos, company.gstin),
      erp: {
        vendor: vendor ? `${vendor.name} (${vendor.code})` : null,
        poNumber: await this.poNumberOf(inv),
        purchaseInvoiceId: inv.erpPurchaseInvoiceId,
        records,
        reconciling: inv.state === 'COMMITTING' && (await this.v.hasUnresolvedErpWrite(inv.id)),
        ...(await this.erpEvidence(inv)),
      },
    };
  }

  async questions(status: 'open' | 'answered'): Promise<ApiQuestion[]> {
    const rows = await this.v.db
      .select()
      .from(t.questions)
      .where(eq(t.questions.status, status))
      .orderBy(status === 'open' ? asc(t.questions.seq) : desc(t.questions.answerSeq));
    // The invoices' list fields in one query (Phase 7), not one full field load per question.
    const fields = rows.length
      ? await this.listFields([...new Set(rows.map((q) => q.invoiceId))])
      : new Map();
    return rows.map((q) => {
      const f = fields.get(q.invoiceId) ?? new Map<string, StoredField>();
      return questionDto(q, {
        number: this.shown<string>(f, 'header.invoiceNumber'),
        supplierName: this.shown<string>(f, 'header.vendorName'),
        totalPaise: this.shown<number>(f, 'header.totalPaise'),
      });
    });
  }

  async question(id: string): Promise<ApiQuestion | null> {
    const q = (
      await this.v.db.select().from(t.questions).where(eq(t.questions.id, id)).limit(1)
    )[0];
    if (!q) return null;
    const f = await this.fields(q.invoiceId);
    return questionDto(q, {
      number: this.shown<string>(f, 'header.invoiceNumber'),
      supplierName: this.shown<string>(f, 'header.vendorName'),
      totalPaise: this.shown<number>(f, 'header.totalPaise'),
    });
  }

  /** Business-record import events (no invoice). */
  async recordsAudit(): Promise<ApiAuditEntry[]> {
    return (
      await this.v.db
        .select()
        .from(t.auditEvents)
        .where(sql`${t.auditEvents.invoiceId} IS NULL AND ${t.auditEvents.event} LIKE 'records.%'`)
        .orderBy(asc(t.auditEvents.seq))
    ).flatMap((e) => auditEntry(e));
  }

  /** The audit trail in the order it was written. */
  async audit(invoiceId: string | null): Promise<ApiAuditEntry[]> {
    const rows = await this.v.db
      .select()
      .from(t.auditEvents)
      .where(invoiceId ? eq(t.auditEvents.invoiceId, invoiceId) : undefined)
      .orderBy(asc(t.auditEvents.seq));
    // Questions raised together are one entry ("Asked you about 3 values"), not one line each.
    const entries: ApiAuditEntry[] = [];
    for (const entry of rows.flatMap((e) => auditEntry(e))) {
      const last = entries.at(-1);
      if (
        last &&
        entry.title === 'Asked you' &&
        (last.title === 'Asked you' || last.title.startsWith('Asked you about ')) &&
        last.invoiceId === entry.invoiceId
      ) {
        const count = last.title === 'Asked you' ? 2 : Number(last.title.split(' ')[3]) + 1;
        entries[entries.length - 1] = {
          ...last,
          title: `Asked you about ${count} values`,
          detail: `${last.detail}\n${entry.detail}`,
        };
      } else entries.push(entry);
    }
    return entries;
  }
}

/** What the designated user did, by question code (codes stay machine-readable, never shown). */
const DECIDED: Record<string, string> = {
  CA_GRN: 'Confirmed goods receipt',
  CA_VENDOR: 'Approved the new supplier',
  CA_ITEM: 'Approved the new item',
  CA_PO: 'Approved the purchase order',
  AM_VENDOR: 'Chose the supplier',
  AM_VENDOR_PAN: 'Chose the supplier',
  AM_OPEN_PO: 'Chose the purchase order',
  AM_PO_LINE: 'Chose the order line',
  AM_ITEM: 'Chose the item',
  BD_VENDOR_INACTIVE: 'Decided on the inactive supplier',
  BD_PO_CLOSED: 'Decided on the closed order',
};
const cap = (x: string) => (x ? x[0]?.toUpperCase() + x.slice(1) : x);

const ENTITY: Record<string, string> = {
  vendor: 'new supplier',
  vendor_reactivation: 'supplier reactivation',
  item: 'new item',
  alias: "link for the supplier's item code",
  po: 'purchase order from the invoice',
  grn: 'goods receipt',
};

/** ERP writes, as a person would name them. */
const OPERATION: Record<string, string> = {
  reactivateVendor: 'supplier reactivation',
  createVendor: 'new supplier',
  createItem: 'new item',
  createVendorItemAlias: "link for the supplier's item code",
  createPurchaseOrder: 'purchase order',
  createGrn: 'goods receipt',
  recordPurchaseInvoice: 'purchase invoice',
};

/** One audit row in plain language. State changes and bookkeeping rows are not shown. */
function auditEntry(e: typeof t.auditEvents.$inferSelect): ApiAuditEntry[] {
  const d = JSON.parse(e.detailJson) as Record<string, unknown>;
  const by = e.actorType === 'user' ? ('You' as const) : ('Veyrafy' as const);
  const make = (
    title: string,
    detail: string,
    tone: ApiAuditEntry['tone'] = 'neutral',
  ): ApiAuditEntry[] => [
    { id: e.id, invoiceId: e.invoiceId, at: e.createdAt, title, detail, by, tone },
  ];
  const s = (k: string) => String(d[k] ?? '');
  switch (e.event) {
    case 'invoice.uploaded':
      return make(
        'Uploaded invoice',
        `${s('filename')} (${s('mime') === 'application/pdf' ? 'PDF' : 'photo'})`,
      );
    case 'extraction.completed': {
      const unclear = (d.lowConfidence as string[] | undefined) ?? [];
      const how = readMethods((d.methods as string[] | undefined) ?? []);
      // When the AI reader could not be used, say why (a wrong model name, a key, a quota).
      const aiFallback = ((d.warnings as string[] | undefined) ?? []).find((w) =>
        w.startsWith('The AI reader was '),
      );
      return make(
        'Read invoice',
        `${how}${String(d.lines)} line${d.lines === 1 ? '' : 's'}, totals and tax${unclear.length ? `. Not clear: ${unclear.map(fieldLabel).join(', ')}` : ''}${aiFallback ? `. ${aiFallback}` : ''}`,
      );
    }
    case 'field.derived':
      return make(
        s('path') === 'header.placeOfSupply'
          ? 'Place of supply established'
          : 'GSTIN taken from the supplier you chose',
        s('path') === 'header.placeOfSupply'
          ? `From the ship-to details on the invoice: ${s('value')}`
          : s('value'),
      );
    case 'match.recorded': {
      // One matching pass, shown as what a person would say: supplier, then order.
      const vendor = d.vendor ? String(d.vendor) : null;
      const po = d.po ? String(d.po) : null;
      const isNew = (ref: string) => /^new \(.*\)$/.test(ref);
      if (!vendor && !po) return make('Checked your records', 'Supplier and order not settled yet');
      return [
        ...(vendor
          ? make(
              isNew(vendor) ? 'Prepared a new supplier' : 'Matched supplier',
              isNew(vendor) ? 'Not in your records yet' : `Supplier ${vendor} in your records`,
            )
          : []),
        ...(po
          ? make(
              isNew(po) ? 'Prepared a purchase order' : 'Matched purchase order',
              isNew(po) ? 'To be created from the invoice' : `Order ${po} in your records`,
            ).map((x) => ({ ...x, id: `${e.id}-po` }))
          : []),
      ];
    }
    case 'creation.staged':
      return make(
        'Prepared',
        `A ${ENTITY[s('entity')] ?? s('entity')}, to be written with the invoice`,
      );
    case 'creation.approved':
      // Shown once, as the decision itself (question.answered below).
      return [];
    case 'validation.completed': {
      const failed = (d.failed as string[] | undefined) ?? [];
      const na = (d.notApplicable as string[] | undefined) ?? [];
      return failed.length
        ? make(
            'Found something to check',
            `${failed.length} check${failed.length === 1 ? '' : 's'} did not pass`,
            'attention',
          )
        : make(
            'Validated invoice',
            `${String(d.passed)} checks passed${na.some((x) => x.includes('PO_DERIVED_FROM_INVOICE')) ? '; order comparisons not applicable (order created from this invoice)' : ''}`,
          );
    }
    case 'question.raised':
      return make('Asked you', `${s('summary')}: ${s('evidence')}`, 'attention');
    case 'question.answered': {
      // A typed or confirmed value is shown by its own entry; a rejection by the rejection.
      if (['SET_FIELD', 'CONFIRM_FIELD', 'REJECT_INVOICE'].includes(s('effect'))) return [];
      return make(
        DECIDED[s('code')] ?? (s('code').startsWith('VF_') ? 'Resolved a check' : 'Decided'),
        `${s('summary')}: ${s('option')}`,
      );
    }
    case 'field.corrected':
      return make(
        'Corrected a value',
        `${fieldLabel(s('path'))}: ${displayValue(kindOf(s('path')), d.to as never)}`,
      );
    case 'field.confirmed':
      return make('Confirmed a value', cap(fieldLabel(s('path'))));
    case 'commit.started':
      return make(
        'Validated ERP references',
        'Checked again against your ERP just before recording; nothing changed',
      );
    case 'creation.committed':
      return make('Recorded in your ERP', s('label'));
    case 'erp.unavailable':
      return make(
        'ERP unavailable',
        "Veyrafy couldn't reach your business system. Nothing was posted; it will try again.",
        'attention',
      );
    case 'erp.reconciliation_required':
      return make(
        'ERP transaction outcome requires reconciliation',
        `Veyrafy could not confirm whether your business system recorded the ${OPERATION[s('operation')] ?? 'transaction'}. Nothing is shown as recorded until it is confirmed.`,
        'attention',
      );
    case 'erp.reconciled':
      return make(
        'Confirmed the ERP transaction',
        `Your business system already had the ${OPERATION[s('operation')] ?? 'transaction'}; it was not recorded twice`,
      );
    case 'commit.conflict':
      return make('Checking again', s('reason'), 'attention');
    case 'commit.completed':
      return [
        ...make(
          'Recorded ERP transaction',
          `Purchase invoice ${s('purchaseInvoiceId')} recorded in your ERP`,
          'handled',
        ),
        {
          id: `${e.id}-ready`,
          invoiceId: e.invoiceId,
          at: e.createdAt,
          title: 'Ready for payment',
          detail: 'Verified. Paying stays with your team.',
          by: 'Veyrafy',
          tone: 'handled',
        },
      ];
    case 'invoice.rejected':
      return make('You rejected the invoice', s('reason'));
    case 'creation.discarded':
      return s('reason') === 'invoice rejected'
        ? make(
            'Not written to your ERP',
            `The ${ENTITY[s('entity')] ?? s('entity')} stays here for the record`,
          )
        : [];
    case 'records.import_checked': {
      const tables =
        (d.tables as { label: string; rows: number; errors: number }[] | undefined) ?? [];
      const n = Number(d.errorCount ?? 0);
      const files = ((d.files as string[] | undefined) ?? []).join(', ');
      const what = tables.map((x) => `${x.rows} ${x.label.toLowerCase()}`).join(', ');
      return make(
        'Business records uploaded',
        `${files}${what ? `: ${what}` : ''}${n ? `. ${n} problem${n === 1 ? '' : 's'} to fix; nothing imported` : '. Checked, ready to import'}`,
        n ? 'attention' : 'neutral',
      );
    }
    case 'records.import_confirmed':
      return make(
        'Business records imported',
        ((d.files as string[] | undefined) ?? []).join(', '),
      );
    case 'records.imported': {
      const c = (d.created ?? {}) as Record<string, number>;
      const k = (d.skipped ?? {}) as Record<string, number>;
      const labels: [string, string][] = [
        ['vendors', 'vendors'],
        ['items', 'items'],
        ['purchaseOrders', 'purchase orders'],
        ['grns', 'goods receipts'],
      ];
      const added = labels
        .filter(([key]) => (c[key] ?? 0) > 0)
        .map(([key, label]) => `${c[key]} ${label}`);
      const total = labels.reduce((n, [key]) => n + (c[key] ?? 0), 0);
      const skipped = labels.reduce((n, [key]) => n + (k[key] ?? 0), 0);
      return make(
        `${total} record${total === 1 ? '' : 's'} added`,
        `${added.length ? `${added.join(', ')} added to your business records` : 'Nothing new to add'}${skipped ? `; ${skipped} already existed and were left unchanged` : ''}.`,
        'handled',
      );
    }
    case 'invoice.failed':
      return make("Veyrafy couldn't finish", plainFailure(s('reason')), 'attention');
    case 'receipt.checked':
      return make(
        d.verdict === 'cleared'
          ? `Cleared against ERP receipt GRN ${s('grnNo')}`
          : `Checked against ERP receipt GRN ${s('grnNo')}`,
        s('summary'),
        d.verdict === 'cleared' ? 'handled' : 'attention',
      );
    case 'receipts.imported':
      return make(
        `${String(d.records)} ERP receipt record${d.records === 1 ? '' : 's'} imported`,
        s('file'),
        'handled',
      );
    default:
      return [];
  }
}

function kindOf(path: string) {
  return (
    path.endsWith('Paise')
      ? 'money'
      : path.endsWith('qtyMilli')
        ? 'qty'
        : path.endsWith('RateBp')
          ? 'rate'
          : path.endsWith('Date')
            ? 'date'
            : 'text'
  ) as 'money';
}

function plainFailure(reason: string): string {
  if (reason.startsWith('INVARIANT_VIOLATION'))
    return 'A check did not pass and no question could resolve it.';
  return reason;
}

export const fmt = {
  rupees,
  dateText,
  qty: (m: number, uom: string) => `${formatQty(milliQty(m))} ${uom}`,
};

/** How an invoice was read, for the audit trail ("Read from the PDF's text. "). */
function readMethods(methods: readonly string[]): string {
  const text: Record<string, string> = {
    pdf_text: "the PDF's text",
    tesseract: 'OCR (Tesseract)',
    ollama: 'a local AI model, checked against the document text',
    fixture: 'the sample invoice data',
    ai_vision: 'the AI reader, every value checked by Veyrafy',
  };
  const parts = methods.map((m) => text[m]).filter((t): t is string => t !== undefined);
  return parts.length ? `Read from ${parts.join(' and ')}. ` : '';
}
