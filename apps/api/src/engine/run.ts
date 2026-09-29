import { createHash } from 'node:crypto';
import { stage as timingStage } from '../perf/timing';
import {
  RULE_CODES,
  milliQty,
  normalizeInvoiceNumber,
  normalizeName,
  paise,
  type AnswerEffect,
  type CreationEntity,
  type CreationPolicyCode,
  type ErpId,
  type FieldPath,
  type IsoDate,
  type NaReason,
  type QuestionCode,
  type RuleCode,
} from '@veyra/shared';
import {
  computeTax,
  lineTaxableAmount,
  checkTaxHeadsForSupplyType,
  determineSupplyType,
  financialYearOf,
  requiredRoundOff,
  resolvePlaceOfSupply,
  validateGstin,
  type EvidenceValue,
  type SupplyType,
} from '@veyra/india-tax';
import type { Grn, Item, PurchaseOrder, Vendor } from '@veyra/erp-connector';
import { readField, type FieldRead, type JsonValue, type StoredField } from './fields';
import * as Q from './questions';
import type {
  AnsweredDecision,
  CommitPlan,
  DuplicateKey,
  EngineInput,
  EngineOutput,
  LineResolution,
  MatchRecord,
  PlannedAction,
  PoLineRef,
  QuestionDraft,
  Ref,
  RuleRecord,
} from './types';

const erpId = (s: string): ErpId => s as ErpId;
const lineTaxableAmountCheck = (qty: number, price: number): number =>
  lineTaxableAmount(milliQty(qty), paise(price));

/** Canonical JSON (sorted keys) for signatures. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k] ?? null)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const refJson = (r: Ref): JsonValue =>
  r.kind === 'erp' ? { kind: 'erp', id: r.id } : { kind: 'staged', actionId: r.actionId };
const poLineJson = (r: PoLineRef): JsonValue =>
  r.kind === 'erp'
    ? { kind: 'erp', id: r.id }
    : { kind: 'staged', actionId: r.actionId, lineNo: r.lineNo };

interface LineFacts {
  lineNo: number;
  description: string | null;
  vendorItemCode: string | null;
  hsnSac: string | null;
  qtyMilli: number | null;
  uom: string | null;
  unitPricePaise: number | null;
  taxablePaise: number | null;
  gstRateBp: number | null;
  cgstPaise: number | null;
  sgstPaise: number | null;
  igstPaise: number | null;
}

interface ItemView {
  ref: Ref;
  code: string;
  name: string;
  hsnSac: string;
  uom: string;
  gstRateBp: number;
}

interface PoLineView {
  ref: PoLineRef;
  lineNo: number;
  item: ItemView;
  qtyMilli: number;
  unitPricePaise: number;
  gstRateBp: number;
}

interface PoView {
  ref: Ref;
  label: string;
  poDate: string;
  vendorRef: Ref;
  status: 'open' | 'closed';
  derived: boolean;
  lines: PoLineView[];
}

/**
 * One full deterministic run (ARCHITECTURE §5): MATCHING → RESOLVING → VALIDATING over the current
 * fields, the user's recorded decisions and live ERP data plus this invoice's staged records.
 *
 * Stages gate questions (RULES §4): 1 invoice checks, 2 vendor, 3 PO and items, 4 GRN. A later
 * stage runs only when every earlier stage raised no question, so the user always sees the
 * earliest problem first. The run never writes: it returns what the workflow should persist.
 */
export async function runEngine(input: EngineInput): Promise<EngineOutput> {
  return new Run(input).execute();
}

class Run {
  readonly matches: MatchRecord[] = [];
  readonly actions: PlannedAction[] = [];
  readonly rules: RuleRecord[] = [];
  readonly questions: QuestionDraft[] = [];
  readonly derived: StoredField[] = [];
  readonly fields: Map<string, StoredField>;
  readonly min: number;
  duplicateKey: DuplicateKey | null = null;
  vendorRef: Ref | null = null;
  vendorView: { name: string; code: string; stateCode: string } | null = null;
  po: PoView | null = null;
  lineMap = new Map<number, { item: ItemView | null; poLine: PoLineView | null }>();
  lines: LineFacts[] = [];
  supply: SupplyType | null = null;
  header = {
    taxable: null as number | null,
    cgst: null as number | null,
    sgst: null as number | null,
    igst: null as number | null,
    roundOff: null as number | null,
    total: null as number | null,
    invoiceNumber: null as string | null,
    invoiceDate: null as string | null,
  };
  perLineTax = false;

  constructor(readonly input: EngineInput) {
    this.fields = new Map(input.fields);
    this.min = input.settings.confidenceMinBp;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  h<T extends string | number>(key: string): FieldRead<T> {
    return readField<T>(this.fields, `header.${key}` as FieldPath, this.min);
  }

  l<T extends string | number>(n: number, key: string): FieldRead<T> {
    return readField<T>(this.fields, `lines[${n}].${key}` as FieldPath, this.min);
  }

  rule(
    ruleCode: RuleCode,
    outcome: RuleRecord['outcome'],
    message: string,
    opts: { lineNo?: number; expected?: JsonValue; actual?: JsonValue; naReason?: NaReason } = {},
  ): void {
    this.rules.push({
      ruleCode,
      lineNo: opts.lineNo ?? null,
      outcome,
      naReason: opts.naReason ?? null,
      expected: opts.expected ?? null,
      actual: opts.actual ?? null,
      message,
    });
  }

  ask(q: QuestionDraft): void {
    if (!this.questions.some((x) => x.code === q.code && x.subjectKey === q.subjectKey))
      this.questions.push(q);
  }

  askMissing(
    path: FieldPath,
    read: FieldRead<string | number>,
    extra?: Parameters<typeof Q.mdField>[2],
  ): void {
    const state = read.state === 'usable' ? 'absent' : read.state;
    this.ask(Q.mdField(path, { state, shown: read.field?.value ?? null }, extra));
  }

  /** The user's latest recorded decision for a subject, among the given question codes. */
  latest(codes: readonly QuestionCode[], subjectKey: string): AnsweredDecision | undefined {
    return this.input.answers
      .filter((a) => codes.includes(a.code) && a.subjectKey === subjectKey)
      .sort((a, b) => b.seq - a.seq)[0];
  }

  /** Stage a creation. A re-run with the same content reuses the same action (and idempotency key). */
  stage(
    entity: CreationEntity,
    policyCode: CreationPolicyCode,
    payload: Record<string, JsonValue>,
    approval: AnsweredDecision | null,
  ): PlannedAction {
    const signature = createHash('sha256')
      .update(
        canonical({
          entity,
          policyCode,
          questionId: approval?.questionId ?? null,
          payload,
        }),
      )
      .digest('hex');
    const existing = this.input.existingActions.find(
      (a) => a.signature === signature && a.status !== 'discarded',
    );
    const action: PlannedAction = {
      id: existing?.id ?? this.input.newId(),
      entity,
      policyCode,
      trigger: approval ? 'user_approval' : 'auto_policy',
      approvedByUserId: approval?.userId ?? null,
      questionId: approval?.questionId ?? null,
      payload,
      signature,
    };
    this.actions.push(action);
    return action;
  }

  hasQuestions(): boolean {
    return this.questions.length > 0;
  }

  // ── run ──────────────────────────────────────────────────────────────────

  async execute(): Promise<EngineOutput> {
    // Timing only (Phase 7): stage 1 checks the invoice on its own (VALIDATION); stages 2–4 find
    // the vendor, order, items and receipts (MATCHING). ERP time is measured separately.
    await timingStage('VALIDATION', async () => {
      const company = await this.input.erp.getCompany();
      await this.stage1(company.gstin);
    });
    await timingStage('MATCHING', async () => {
      if (!this.hasQuestions()) await this.stage2();
      if (!this.hasQuestions()) await this.stage3();
      if (!this.hasQuestions()) await this.stage4();
    });

    // Every rule has a result on every run.
    for (const code of RULE_CODES) {
      if (!this.rules.some((r) => r.ruleCode === code))
        this.rule(code, 'not_evaluated', 'Waiting on an earlier question.');
    }

    const clean =
      !this.hasQuestions() &&
      this.rules.every((r) => r.outcome === 'pass' || r.outcome === 'not_applicable');
    const lines: LineResolution[] = this.lines.map((f) => {
      const m = this.lineMap.get(f.lineNo);
      return { lineNo: f.lineNo, item: m?.item?.ref ?? null, poLine: m?.poLine?.ref ?? null };
    });
    return {
      matches: this.matches,
      actions: this.actions,
      validations: this.rules,
      questions: this.questions,
      derivedFields: this.derived,
      duplicateKey: this.duplicateKey,
      vendor: this.vendorRef,
      po: this.po?.ref ?? null,
      lines,
      plan: clean ? this.plan() : null,
    };
  }

  // ── Stage 1: the invoice on its own (R01–R11) ─────────────────────────────

  async stage1(companyGstin: string): Promise<void> {
    let requiredOk = true;
    const need = (key: string): void => {
      const r = this.h(key);
      if (r.state !== 'usable') {
        requiredOk = false;
        this.askMissing(`header.${key}` as FieldPath, r);
      }
    };
    for (const key of ['vendorName', 'buyerGstin', 'invoiceNumber', 'invoiceDate', 'taxablePaise'])
      need(key);

    // Optional fields: absence is fine; a value that is there but unreadable is not.
    for (const key of ['poNumber', 'cgstPaise', 'sgstPaise', 'igstPaise', 'roundOffPaise']) {
      const r = this.h(key);
      if (r.state === 'low_confidence' || r.state === 'unparseable')
        this.askMissing(`header.${key}` as FieldPath, r);
    }

    // Lines.
    const n = this.input.lineCount;
    for (let i = 1; i <= n; i++) {
      const get = <T extends string | number>(key: string): T | null => this.l<T>(i, key).value;
      const facts: LineFacts = {
        lineNo: i,
        description: get('description'),
        vendorItemCode: get('vendorItemCode'),
        hsnSac: get('hsnSac'),
        qtyMilli: get('qtyMilli'),
        uom: get('uom'),
        unitPricePaise: get('unitPricePaise'),
        taxablePaise: get('taxablePaise'),
        gstRateBp: get('gstRateBp'),
        cgstPaise: get('cgstPaise'),
        sgstPaise: get('sgstPaise'),
        igstPaise: get('igstPaise'),
      };
      this.lines.push(facts);
      for (const key of [
        'description',
        'hsnSac',
        'qtyMilli',
        'uom',
        'unitPricePaise',
        'taxablePaise',
        'gstRateBp',
      ]) {
        const r = this.l(i, key);
        if (r.state !== 'usable') {
          requiredOk = false;
          this.askMissing(`lines[${i}].${key}` as FieldPath, r);
        }
      }
      for (const key of ['vendorItemCode', 'cgstPaise', 'sgstPaise', 'igstPaise']) {
        const r = this.l(i, key);
        if (r.state === 'low_confidence' || r.state === 'unparseable')
          this.askMissing(`lines[${i}].${key}` as FieldPath, r);
      }
    }

    // Tax method (RULES §4.1): every line shows tax, or none does.
    const shows = this.lines.map(
      (l) => l.cgstPaise !== null || l.sgstPaise !== null || l.igstPaise !== null,
    );
    this.perLineTax = shows.length > 0 && shows.every(Boolean);
    const mixed = shows.some(Boolean) && !this.perLineTax;
    if (mixed) {
      const first = shows.indexOf(false) + 1;
      requiredOk = false;
      this.askMissing(`lines[${first}].cgstPaise` as FieldPath, this.l(first, 'cgstPaise'), {
        why: [
          'Some lines show their tax and some do not, so the tax cannot be checked either way.',
        ],
      });
    }

    const H = this.header;
    const num = (key: string): number | null => this.h<number>(key).value;
    H.taxable = num('taxablePaise');
    H.roundOff = num('roundOffPaise');
    H.invoiceNumber = this.h<string>('invoiceNumber').value;
    H.invoiceDate = this.h<string>('invoiceDate').value;
    const headOk = (key: string) =>
      this.h(key).state === 'usable' || this.h(key).state === 'absent';
    H.cgst = headOk('cgstPaise') ? (num('cgstPaise') ?? 0) : null;
    H.sgst = headOk('sgstPaise') ? (num('sgstPaise') ?? 0) : null;
    H.igst = headOk('igstPaise') ? (num('igstPaise') ?? 0) : null;

    // Total: always required; if unclear, show what the lines add up to.
    const total = this.h<number>('totalPaise');
    H.total = total.value;
    if (total.state !== 'usable') {
      requiredOk = false;
      const calc =
        H.taxable !== null && H.cgst !== null && H.sgst !== null && H.igst !== null
          ? H.taxable + H.cgst + H.sgst + H.igst + (H.roundOff ?? 0)
          : null;
      this.askMissing('header.totalPaise', total, {
        facts:
          calc === null ? [] : [{ label: 'The lines and tax add up to', value: Q.rupees(calc) }],
      });
    }

    // Vendor GSTIN (RULES §2.1 V5/V6).
    let vendorGstin = this.h<string>('vendorGstin');
    if (vendorGstin.state !== 'usable') {
      const name = this.h<string>('vendorName').value;
      const candidates = name
        ? await this.input.erp.findVendorsByNormalizedName(normalizeName(name))
        : [];
      const answer = this.latest(['AM_VENDOR'], 'vendor');
      const linked =
        answer?.effect.type === 'LINK_ERP_RECORD'
          ? candidates.find((c) => c.id === (answer.effect as { erpId: string }).erpId)
          : undefined;
      if (linked && answer) {
        const field: StoredField = {
          path: 'header.vendorGstin',
          value: linked.gstin,
          confidenceBp: null,
          source: 'derived_from_erp_choice',
          evidence: this.fields.get('header.vendorGstin')?.evidence ?? null,
          evidenceDetail: { vendorErpId: linked.id, questionId: answer.questionId },
        };
        this.fields.set(field.path, field);
        this.derived.push(field);
        vendorGstin = this.h<string>('vendorGstin');
      } else if (candidates.length > 0 && answer?.effect.type !== 'REQUEST_CREATION') {
        requiredOk = false;
        this.ask(Q.amVendor('AM_VENDOR', name ?? '', candidates.map(vendorCandidate), true));
        if (candidates.length > 1)
          this.matches.push({
            entity: 'vendor',
            lineNo: null,
            outcome: 'ambiguous',
            method: 'normalized_name',
            candidates: candidates.map((c) => c.id),
            chosenErpId: null,
          });
      } else {
        requiredOk = false;
        this.askMissing('header.vendorGstin', vendorGstin);
      }
    }

    // Place of supply (RULES §1.6, D3).
    const posCode = this.placeOfSupply();
    if (posCode === null) requiredOk = false;

    this.rule(
      'R01',
      requiredOk ? 'pass' : 'fail',
      requiredOk
        ? 'Every required value is usable.'
        : 'Some required values are missing or unclear.',
    );

    // R02
    const emptyLine = this.lines.find((l) =>
      Object.entries(l).every(([k, v]) => k === 'lineNo' || v === null),
    );
    if (n === 0 || emptyLine) {
      this.rule('R02', 'fail', 'The invoice has no readable lines.');
      this.ask(
        Q.vf({
          rule: 'R02',
          lineNo: null,
          summary: 'No lines',
          evidence: 'No item lines could be read',
          headline: 'This invoice has no readable item lines.',
          facts: [],
          why: ['An invoice is recorded only line by line.'],
          corrections: [],
          recheckLabel: 'Check again',
        }),
      );
    } else this.rule('R02', 'pass', `${n} line${n === 1 ? '' : 's'}.`);

    // R03 GSTINs
    const vendorG = vendorGstin.value;
    const buyerG = this.h<string>('buyerGstin').value;
    let vendorState: string | null = null;
    if (vendorG && buyerG) {
      const v = validateGstin(vendorG);
      const b = validateGstin(buyerG);
      if (v.ok) vendorState = v.value.stateCode;
      if (v.ok && b.ok) this.rule('R03', 'pass', 'Both GSTINs are valid.');
      else {
        this.rule('R03', 'fail', 'A GSTIN is not valid.', {
          actual: { vendor: vendorG, buyer: buyerG },
        });
        const bad = !v.ok ? vendorG : buyerG;
        this.ask(
          Q.vf({
            rule: 'R03',
            lineNo: null,
            summary: 'GSTIN not valid',
            evidence:
              !v.ok && v.error.code === 'bad_checksum'
                ? "The check digit doesn't match"
                : 'Not a valid GSTIN',
            headline: `${!v.ok ? 'The supplier' : 'Your'} GSTIN on the invoice, ${bad}, is not valid.`,
            facts: [
              {
                label: !v.ok ? 'Supplier GSTIN' : 'Your GSTIN on the invoice',
                value: bad,
                tone: 'attention',
              },
            ],
            why: [
              (!v.ok ? v.error : !b.ok ? b.error : null)?.code === 'bad_checksum'
                ? 'The last character of a GSTIN is a check digit calculated from the others. Here it does not match.'
                : 'The GSTIN does not have a valid state code or format.',
              'Veyra will not add a supplier or record an invoice with an invalid GSTIN.',
            ],
            corrections: [
              !v.ok
                ? { path: 'header.vendorGstin', label: 'The GSTIN was misread' }
                : { path: 'header.buyerGstin', label: 'The GSTIN was misread' },
            ],
            recheckLabel: 'Check again',
          }),
        );
      }
    } else this.rule('R03', 'not_evaluated', 'Waiting for the GSTINs.');

    // R04
    if (buyerG && validateGstin(buyerG).ok) {
      if (buyerG === companyGstin) this.rule('R04', 'pass', 'Billed to your company.');
      else {
        this.rule('R04', 'fail', 'Billed to another GSTIN.', {
          expected: companyGstin,
          actual: buyerG,
        });
        this.ask(
          Q.vf({
            rule: 'R04',
            lineNo: null,
            summary: 'Not billed to you',
            evidence: `Billed to ${buyerG}`,
            headline: 'This invoice is billed to a different GSTIN.',
            facts: [
              { label: 'Billed to', value: buyerG, tone: 'attention' },
              { label: 'Your GSTIN', value: companyGstin },
            ],
            why: ['Only invoices billed to your company are recorded.'],
            corrections: [{ path: 'header.buyerGstin', label: 'The GSTIN was misread' }],
            recheckLabel: 'Check again',
          }),
        );
      }
    } else this.rule('R04', 'not_evaluated', 'Waiting for a valid buyer GSTIN.');

    // R05
    if (H.invoiceDate) {
      if (H.invoiceDate <= this.input.today) this.rule('R05', 'pass', 'Dated on or before today.');
      else {
        this.rule('R05', 'fail', 'Dated in the future.', {
          expected: `<= ${this.input.today}`,
          actual: H.invoiceDate,
        });
        this.ask(
          Q.vf({
            rule: 'R05',
            lineNo: null,
            summary: 'Date in the future',
            evidence: `Dated ${Q.dateText(H.invoiceDate)}`,
            headline: 'The invoice is dated in the future.',
            facts: [{ label: 'Invoice date', value: Q.dateText(H.invoiceDate), tone: 'attention' }],
            why: ['An invoice cannot be dated after today.'],
            corrections: [{ path: 'header.invoiceDate', label: 'The date was misread' }],
            recheckLabel: 'Check again',
          }),
        );
      }
    } else this.rule('R05', 'not_evaluated', 'Waiting for the invoice date.');

    // R06 line amounts
    for (const l of this.lines) {
      if (l.qtyMilli === null || l.unitPricePaise === null || l.taxablePaise === null) {
        this.rule('R06', 'not_evaluated', 'Waiting for the line values.', { lineNo: l.lineNo });
        continue;
      }
      const expected = lineTaxableAmountCheck(l.qtyMilli, l.unitPricePaise);
      if (expected === l.taxablePaise)
        this.rule('R06', 'pass', 'Quantity × price = amount.', { lineNo: l.lineNo });
      else {
        this.rule('R06', 'fail', 'Line amount differs from quantity × price.', {
          lineNo: l.lineNo,
          expected,
          actual: l.taxablePaise,
        });
        this.ask(
          Q.vf({
            rule: 'R06',
            lineNo: l.lineNo,
            summary: "Line doesn't add up",
            evidence: `${Q.rupees(l.taxablePaise)} printed · ${Q.rupees(expected)} calculated`,
            headline: `Line ${l.lineNo}: quantity × price does not equal the amount printed.`,
            facts: [
              { label: 'Quantity × price', value: Q.rupees(expected) },
              { label: 'Printed amount', value: Q.rupees(l.taxablePaise), tone: 'attention' },
            ],
            why: ['Each line amount must equal quantity × price, to the paisa.'],
            corrections: [
              {
                path: `lines[${l.lineNo}].qtyMilli` as FieldPath,
                label: 'The quantity was misread',
              },
              {
                path: `lines[${l.lineNo}].unitPricePaise` as FieldPath,
                label: 'The price was misread',
              },
            ],
            recheckLabel: 'Check again',
          }),
        );
      }
    }

    // R07 tax amounts (each charged head with its own formula)
    this.checkTaxAmounts();

    // R08 tax type
    if (vendorState && posCode && H.cgst !== null && H.sgst !== null && H.igst !== null) {
      this.supply = determineSupplyType(vendorState as never, posCode as never);
      const check = checkTaxHeadsForSupplyType(this.supply, {
        cgstPaise: H.cgst as never,
        sgstPaise: H.sgst as never,
        igstPaise: H.igst as never,
      });
      if (check.consistent)
        this.rule(
          'R08',
          'pass',
          this.supply === 'intra_state'
            ? 'CGST and SGST for a supply within the state.'
            : 'IGST for a supply between states.',
        );
      else {
        const inter = this.supply === 'inter_state';
        this.rule('R08', 'fail', 'Wrong tax type for the supply.', {
          expected: check.allowedHeads,
          actual: check.issues,
        });
        this.ask(
          Q.vf({
            rule: 'R08',
            lineNo: null,
            summary: 'Wrong tax type',
            evidence: inter
              ? 'Inter-state supply charged CGST and SGST'
              : 'Supply within the state charged IGST',
            headline: inter
              ? 'The supplier is in another state, so the invoice should charge IGST.'
              : 'The supplier is in your state, so the invoice should charge CGST and SGST.',
            facts: [
              { label: 'Supplier state', value: vendorState },
              { label: 'Place of supply', value: posCode },
              {
                label: 'Charged',
                value: [H.cgst ? 'CGST' : '', H.sgst ? 'SGST' : '', H.igst ? 'IGST' : '']
                  .filter(Boolean)
                  .join(' + '),
                tone: 'attention',
              },
            ],
            why: ['The tax type follows from the supplier state and the place of supply.'],
            corrections: [
              { path: 'header.placeOfSupply', label: 'The place of supply was misread' },
            ],
            recheckLabel: 'Check again',
          }),
        );
      }
    } else this.rule('R08', 'not_evaluated', 'Waiting for the GSTIN and place of supply.');

    // R09 header totals, R10 round-off
    this.checkTotals();

    // R11 duplicate
    await this.checkDuplicate(vendorG);
  }

  placeOfSupply(): string | null {
    const ev = (key: string, ignoreDerived = false): EvidenceValue => {
      const r = this.h<string>(key);
      if (ignoreDerived && r.field?.source === 'derived_from_document_evidence')
        return { status: 'absent' };
      if (r.state === 'absent') return { status: 'absent' };
      if (r.state !== 'usable') return { status: 'unusable' };
      return { status: 'usable', text: String(r.field?.value ?? r.value) };
    };
    const printed = ev('placeOfSupply', true);
    const resolution = resolvePlaceOfSupply({
      printedPlaceOfSupply:
        printed.status === 'usable'
          ? { status: 'usable', text: String(this.h<string>('placeOfSupply').value) }
          : printed,
      shipToState: ev('shipToState'),
      shipToGstin: ev('shipToGstin'),
    });
    if (resolution.status === 'established') {
      if (resolution.basis === 'ship_to_evidence') {
        const field: StoredField = {
          path: 'header.placeOfSupply',
          value: resolution.stateCode,
          confidenceBp: null,
          source: 'derived_from_document_evidence',
          evidence: null,
          evidenceDetail: {
            basis: 'ship_to_evidence',
            evidence: resolution.evidence.map((e) => ({
              source: e.source,
              text: e.text,
              stateCode: e.stateCode,
            })),
          },
        };
        this.fields.set(field.path, field);
        this.derived.push(field);
      }
      return resolution.stateCode;
    }
    const reason: Record<typeof resolution.reason, string> = {
      printed_unusable: 'The place of supply is printed but could not be read clearly.',
      printed_unparseable: 'The printed place of supply does not name a known state.',
      no_evidence:
        'No place of supply is printed and there is no ship-to state or GSTIN to establish it.',
      unusable_evidence: 'The ship-to details could not be read reliably.',
      conflicting_evidence: 'The ship-to state and ship-to GSTIN disagree.',
    };
    this.askMissing('header.placeOfSupply', this.h('placeOfSupply'), {
      why: [reason[resolution.reason], 'Your own GSTIN alone never decides the place of supply.'],
    });
    return null;
  }

  checkTaxAmounts(): void {
    const H = this.header;
    const linesReady = this.lines.every((l) => l.taxablePaise !== null && l.gstRateBp !== null);
    if (!linesReady || H.cgst === null || H.sgst === null || H.igst === null) {
      this.rule('R07', 'not_evaluated', 'Waiting for the line amounts and tax.');
      return;
    }
    const heads = (taxable: number, rate: number) => ({
      cgst: computeTax(taxable as never, rate as never, 'intra_state').cgstPaise as number,
      igst: computeTax(taxable as never, rate as never, 'inter_state').igstPaise as number,
    });
    const diffs: { what: string; printed: number; expected: number; path: FieldPath }[] = [];
    if (this.perLineTax) {
      for (const l of this.lines) {
        const c = heads(l.taxablePaise ?? 0, l.gstRateBp ?? 0);
        const check = (printed: number | null, expected: number, what: string, key: string) => {
          if (printed !== null && printed !== 0 && printed !== expected)
            diffs.push({
              what: `${what} on line ${l.lineNo}`,
              printed,
              expected,
              path: `lines[${l.lineNo}].${key}` as FieldPath,
            });
        };
        check(l.cgstPaise, c.cgst, 'CGST', 'cgstPaise');
        check(l.sgstPaise, c.cgst, 'SGST', 'sgstPaise');
        check(l.igstPaise, c.igst, 'IGST', 'igstPaise');
      }
    } else {
      const groups = new Map<number, number>();
      for (const l of this.lines)
        groups.set(l.gstRateBp ?? 0, (groups.get(l.gstRateBp ?? 0) ?? 0) + (l.taxablePaise ?? 0));
      let cgst = 0;
      let igst = 0;
      for (const [rate, taxable] of groups) {
        const c = heads(taxable, rate);
        cgst += c.cgst;
        igst += c.igst;
      }
      if (H.cgst !== 0 && H.cgst !== cgst)
        diffs.push({ what: 'CGST', printed: H.cgst, expected: cgst, path: 'header.cgstPaise' });
      if (H.sgst !== 0 && H.sgst !== cgst)
        diffs.push({ what: 'SGST', printed: H.sgst, expected: cgst, path: 'header.sgstPaise' });
      if (H.igst !== 0 && H.igst !== igst)
        diffs.push({ what: 'IGST', printed: H.igst, expected: igst, path: 'header.igstPaise' });
    }
    if (diffs.length === 0) {
      this.rule('R07', 'pass', 'Tax is calculated correctly.');
      return;
    }
    this.rule('R07', 'fail', 'Tax differs from the calculation.', {
      expected: diffs.map((d) => d.expected),
      actual: diffs.map((d) => d.printed),
    });
    const first = diffs[0];
    const delta = first ? first.printed - first.expected : 0;
    const sameDelta = diffs.every((d) => d.printed - d.expected === delta);
    this.ask(
      Q.vf({
        rule: 'R07',
        lineNo: null,
        summary: "Tax doesn't add up",
        evidence: `${diffs.map((d) => d.what).join(' and ')} ${diffs.length > 1 ? 'are' : 'is'} ${sameDelta ? `${Q.rupees(Math.abs(delta))} too ${delta > 0 ? 'high' : 'low'}` : 'different from the calculation'}`,
        headline: 'The tax printed on the invoice does not match the calculation.',
        facts: diffs.flatMap((d) => [
          { label: `${d.what} printed`, value: Q.rupees(d.printed), tone: 'attention' as const },
          { label: `${d.what} calculated`, value: Q.rupees(d.expected) },
        ]),
        why: ['GST is calculated to the paisa from the taxable value and the rate.'],
        corrections: diffs
          .slice(0, 2)
          .map((d) => ({ path: d.path, label: `The ${d.what} was misread` })),
        recheckLabel: 'Check again',
      }),
    );
  }

  checkTotals(): void {
    const H = this.header;
    if (
      H.taxable === null ||
      H.cgst === null ||
      H.sgst === null ||
      H.igst === null ||
      this.lines.some((l) => l.taxablePaise === null)
    ) {
      this.rule('R09', 'not_evaluated', 'Waiting for the amounts.');
      this.rule('R10', 'not_evaluated', 'Waiting for the amounts.');
      return;
    }
    const lineSum = this.lines.reduce((s, l) => s + (l.taxablePaise ?? 0), 0);
    const pre = H.taxable + H.cgst + H.sgst + H.igst;
    const issues: {
      fact: string;
      printed: number;
      expected: number;
      path: FieldPath;
      label: string;
    }[] = [];
    if (lineSum !== H.taxable)
      issues.push({
        fact: 'Taxable value',
        printed: H.taxable,
        expected: lineSum,
        path: 'header.taxablePaise',
        label: 'The taxable value was misread',
      });
    if (this.perLineTax) {
      const sum = (k: 'cgstPaise' | 'sgstPaise' | 'igstPaise') =>
        this.lines.reduce((s, l) => s + (l[k] ?? 0), 0);
      if (sum('cgstPaise') !== H.cgst)
        issues.push({
          fact: 'CGST',
          printed: H.cgst,
          expected: sum('cgstPaise'),
          path: 'header.cgstPaise',
          label: 'The CGST was misread',
        });
      if (sum('sgstPaise') !== H.sgst)
        issues.push({
          fact: 'SGST',
          printed: H.sgst,
          expected: sum('sgstPaise'),
          path: 'header.sgstPaise',
          label: 'The SGST was misread',
        });
      if (sum('igstPaise') !== H.igst)
        issues.push({
          fact: 'IGST',
          printed: H.igst,
          expected: sum('igstPaise'),
          path: 'header.igstPaise',
          label: 'The IGST was misread',
        });
    }
    if (H.total !== null) {
      const expectedTotal = pre + (H.roundOff ?? 0);
      if (expectedTotal !== H.total)
        issues.push({
          fact: 'Total',
          printed: H.total,
          expected: expectedTotal,
          path: 'header.totalPaise',
          label: 'The total was misread',
        });
    }
    // R10 round-off (D2): only when printed, and only the exact amount to the nearest rupee.
    if (H.roundOff === null)
      this.rule('R10', 'not_applicable', 'No round-off is printed.', {
        naReason: 'NO_ROUND_OFF_LINE',
      });
    else {
      const required = requiredRoundOff(pre as never) as number;
      if (required === H.roundOff)
        this.rule('R10', 'pass', 'Round-off reaches the nearest rupee exactly.', {
          expected: required,
          actual: H.roundOff,
        });
      else {
        this.rule('R10', 'fail', 'Round-off is not the amount needed to reach the nearest rupee.', {
          expected: required,
          actual: H.roundOff,
        });
        this.ask(
          Q.vf({
            rule: 'R10',
            lineNo: null,
            summary: 'Round-off differs',
            evidence: `${Q.rupees(H.roundOff)} printed · ${Q.rupees(required)} needed`,
            headline: 'The round-off does not match the amount needed to reach the nearest rupee.',
            facts: [
              { label: 'Calculated total', value: Q.rupees(pre) },
              { label: 'Round-off printed', value: Q.rupees(H.roundOff), tone: 'attention' },
              { label: 'Round-off needed', value: Q.rupees(required) },
              ...(H.total !== null ? [{ label: 'Invoice total', value: Q.rupees(H.total) }] : []),
            ],
            why: [
              'A round-off is accepted only when it is exactly the amount needed to reach the nearest rupee.',
            ],
            corrections: [{ path: 'header.roundOffPaise', label: 'The round-off was misread' }],
            recheckLabel: 'Check again',
          }),
        );
      }
    }
    if (H.total === null) {
      this.rule('R09', 'not_evaluated', 'Waiting for the total.');
      return;
    }
    if (issues.length === 0) {
      this.rule('R09', 'pass', 'The lines, tax and total agree.', {
        expected: pre + (H.roundOff ?? 0),
        actual: H.total,
      });
      return;
    }
    this.rule('R09', 'fail', 'The totals do not agree.', {
      expected: issues.map((i) => i.expected),
      actual: issues.map((i) => i.printed),
    });
    this.ask(
      Q.vf({
        rule: 'R09',
        lineNo: null,
        summary: "Totals don't add up",
        evidence: issues
          .map((i) => `${i.fact} ${Q.rupees(i.printed)} · calculated ${Q.rupees(i.expected)}`)
          .join('; '),
        headline: 'The totals on the invoice do not add up.',
        facts: [
          { label: 'Calculated total', value: Q.rupees(pre) },
          ...(H.roundOff !== null ? [{ label: 'Round-off', value: Q.rupees(H.roundOff) }] : []),
          { label: 'Invoice total', value: Q.rupees(H.total), tone: 'attention' as const },
        ],
        why: [
          'The total must equal the taxable value plus tax, plus a printed round-off if there is one.',
          'A difference is never absorbed.',
        ],
        corrections: issues.slice(0, 2).map((i) => ({ path: i.path, label: i.label })),
        recheckLabel: 'Check again',
      }),
    );
  }

  async checkDuplicate(vendorGstin: string | null): Promise<void> {
    const { invoiceNumber, invoiceDate } = this.header;
    const parsed = vendorGstin ? validateGstin(vendorGstin) : null;
    if (!parsed?.ok || !invoiceNumber || !invoiceDate) {
      this.rule('R11', 'not_evaluated', 'Waiting for the supplier GSTIN, number and date.');
      return;
    }
    const fy = financialYearOf(invoiceDate as IsoDate);
    const key: DuplicateKey = {
      vendorGstin: parsed.value.gstin,
      invoiceNoNormalized: normalizeInvoiceNumber(invoiceNumber),
      fy,
    };
    this.duplicateKey = key;
    const vendor = await this.input.erp.findVendorByGstin(parsed.value.gstin);
    const inErp = vendor
      ? await this.input.erp.findPurchaseInvoice(vendor.id, key.invoiceNoNormalized, fy)
      : null;
    const others = await this.input.otherInvoicesWithKey(key);
    if (!inErp && others.length === 0) {
      this.rule('R11', 'pass', 'Not recorded before.');
      return;
    }
    const where = inErp
      ? {
          at: `your ERP as ${inErp.id}`,
          date: inErp.invoiceDate as string,
          total: inErp.totalPaise as number,
          created: inErp.createdAt.slice(0, 10),
        }
      : {
          at: 'another invoice in Veyra',
          date: others[0]?.invoiceDate ?? null,
          total: others[0]?.totalPaise ?? null,
          created: null,
        };
    this.rule('R11', 'fail', 'The same invoice is already recorded.', {
      actual: { erp: inErp?.id ?? null, veyra: others.map((o) => o.id) },
    });
    const sameAmount = where.total !== null && where.total === this.header.total;
    this.ask(
      Q.vf({
        rule: 'R11',
        lineNo: null,
        summary: 'Possible duplicate',
        evidence: where.created
          ? `Same invoice recorded on ${Q.dateText(where.created)}`
          : 'Same invoice is already in Veyra',
        headline: `Invoice ${invoiceNumber} from this supplier is already in ${where.at}.`,
        facts: [
          { label: 'Invoice number', value: invoiceNumber, tone: 'attention' },
          ...(where.date
            ? [{ label: 'Recorded invoice date', value: Q.dateText(where.date) }]
            : []),
          ...(where.total !== null
            ? [
                {
                  label: 'Recorded total',
                  value: `${Q.rupees(where.total)}${sameAmount ? ' (same amount)' : ''}`,
                },
              ]
            : []),
        ],
        why: ['A supplier invoice number can be recorded only once in a financial year.'],
        corrections: [{ path: 'header.invoiceNumber', label: 'The invoice number was misread' }],
        recheckLabel: 'Check again',
      }),
    );
  }

  // ── Stage 2: vendor (R12, R13) ────────────────────────────────────────────

  async stage2(): Promise<void> {
    const erp = this.input.erp;
    const gstinText = this.h<string>('vendorGstin').value ?? '';
    const g = validateGstin(gstinText);
    if (!g.ok) throw new Error('stage 2 requires a valid vendor GSTIN');
    const name = this.h<string>('vendorName').value ?? '';

    const byGstin = await erp.findVendorByGstin(g.value.gstin);
    let vendor: Vendor | null = byGstin;
    if (byGstin) this.matches.push(found('vendor', 'gstin', byGstin.id));
    else {
      const answer = this.latest(['AM_VENDOR', 'AM_VENDOR_PAN'], 'vendor');
      if (answer?.effect.type === 'LINK_ERP_RECORD') {
        vendor = await erp.getVendor(erpId(answer.effect.erpId));
        if (vendor) this.matches.push(found('vendor', 'user_choice', vendor.id));
      }
      if (!vendor) {
        const byPan = await erp.findVendorsByPan(g.value.pan);
        const byName = name ? await erp.findVendorsByNormalizedName(normalizeName(name)) : [];
        const candidates = byPan.length ? byPan : byName;
        const wantsNew = answer?.effect.type === 'REQUEST_CREATION';
        const address = this.h<string>('vendorAddress');
        if (candidates.length > 0 && !wantsNew) {
          this.ask(
            Q.amVendor(
              byPan.length ? 'AM_VENDOR_PAN' : 'AM_VENDOR',
              name,
              candidates.map(vendorCandidate),
              false,
            ),
          );
          if (candidates.length > 1)
            this.matches.push({
              entity: 'vendor',
              lineNo: null,
              outcome: 'ambiguous',
              method: byPan.length ? 'pan' : 'normalized_name',
              candidates: candidates.map((c) => c.id),
              chosenErpId: null,
            });
        } else if (address.state !== 'usable') {
          this.askMissing('header.vendorAddress', address, {
            why: ['A new supplier needs an address.'],
          });
        } else {
          this.matches.push({
            entity: 'vendor',
            lineNo: null,
            outcome: 'not_found',
            method: 'gstin',
            candidates: [],
            chosenErpId: null,
          });
          const payload = { name, gstin: g.value.gstin, address: address.value ?? '' };
          if (candidates.length > 0) {
            // The user said it is new despite similar suppliers: creation needs their approval.
            const approval = this.latest(['CA_VENDOR'], 'vendor');
            if (approval?.effect.type === 'APPROVE_CREATION') {
              const a = this.stage('vendor', 'CP_VENDOR_APPROVED', payload, approval);
              this.vendorRef = { kind: 'staged', actionId: a.id };
            } else this.ask(Q.caVendor(name, g.value.gstin, payload.address, g.value.stateCode));
          } else {
            const a = this.stage('vendor', 'CP_VENDOR_AUTO', payload, null);
            this.vendorRef = { kind: 'staged', actionId: a.id };
          }
          if (this.vendorRef)
            this.vendorView = { name, code: 'New supplier', stateCode: g.value.stateCode };
        }
      }
    }

    if (vendor) {
      this.vendorRef = { kind: 'erp', id: vendor.id };
      this.vendorView = { name: vendor.name, code: vendor.code, stateCode: vendor.stateCode };
    }
    if (!this.vendorRef) {
      this.rule('R12', 'fail', 'The supplier is not identified yet.');
      this.rule('R13', 'not_evaluated', 'Waiting for the supplier.');
      return;
    }
    this.rule('R12', 'pass', vendor ? `${vendor.name} (${vendor.code}).` : 'New supplier staged.');

    if (vendor && vendor.status === 'inactive') {
      const decision = this.latest(['BD_VENDOR_INACTIVE'], 'vendor');
      if (decision?.effect.type === 'APPROVE_CREATION') {
        this.stage(
          'vendor_reactivation',
          'CP_VENDOR_REACTIVATED',
          { vendorId: vendor.id },
          decision,
        );
        this.rule('R13', 'pass', 'Reactivation approved; it is written with the invoice.');
      } else {
        this.rule('R13', 'fail', 'The supplier is inactive.', { actual: 'inactive' });
        this.ask(Q.bdVendorInactive(vendor.name, vendor.code));
      }
    } else this.rule('R13', 'pass', 'The supplier is active.');
  }

  // ── Stage 3: purchase order and items (R14–R24, R27) ──────────────────────

  async stage3(): Promise<void> {
    const erp = this.input.erp;
    const vendorRef = this.vendorRef;
    if (!vendorRef) return;
    const poNumber = this.h<string>('poNumber').value;
    const itemCache = new Map<string, Item | null>();
    const item = async (id: string): Promise<Item | null> => {
      if (!itemCache.has(id)) itemCache.set(id, await erp.getItem(erpId(id)));
      return itemCache.get(id) ?? null;
    };
    const viewOf = (i: Item): ItemView => ({
      ref: { kind: 'erp', id: i.id },
      code: i.code,
      name: i.name,
      hsnSac: i.hsnSac,
      uom: i.uom,
      gstRateBp: i.gstRateBp,
    });
    const loadPo = async (po: PurchaseOrder): Promise<PoView> => {
      const lines: PoLineView[] = [];
      for (const l of po.lines) {
        const it = await item(l.itemId);
        if (it)
          lines.push({
            ref: { kind: 'erp', id: l.id },
            lineNo: l.lineNo,
            item: viewOf(it),
            qtyMilli: l.qtyMilli,
            unitPricePaise: l.unitPricePaise,
            gstRateBp: l.gstRateBp,
          });
      }
      return {
        ref: { kind: 'erp', id: po.id },
        label: po.poNumber,
        poDate: po.poDate,
        vendorRef: { kind: 'erp', id: po.vendorId },
        status: po.status,
        derived: false,
        lines,
      };
    };

    // Which PO (RULES §2.2).
    let path: 'erp' | 'derived' | 'undecided' = 'undecided';
    let citedMissing = false;
    if (poNumber) {
      const po = await erp.getPurchaseOrderByNumber(poNumber);
      if (po) {
        this.po = await loadPo(po);
        path = 'erp';
        this.matches.push(found('po', 'po_number', po.id));
      } else {
        citedMissing = true;
        this.matches.push({
          entity: 'po',
          lineNo: null,
          outcome: 'not_found',
          method: 'po_number',
          candidates: [],
          chosenErpId: null,
        });
      }
    } else {
      const open =
        vendorRef.kind === 'erp' ? await erp.listOpenPurchaseOrders(erpId(vendorRef.id)) : [];
      const answer = this.latest(['AM_OPEN_PO'], 'po');
      const chosen =
        answer?.effect.type === 'LINK_ERP_RECORD'
          ? await erp.getPurchaseOrder(erpId(answer.effect.erpId))
          : null;
      if (chosen) {
        this.po = await loadPo(chosen);
        path = 'erp';
        this.matches.push(found('po', 'user_choice', chosen.id));
      } else if (open.length === 0 || answer?.effect.type === 'DECLARE_NON_PO') {
        path = 'derived';
      } else {
        const candidates = await Promise.all(
          open.map(async (po) => ({
            id: po.id,
            poNumber: po.poNumber,
            summary: await this.poSummary(po, item),
          })),
        );
        this.ask(Q.amOpenPo(candidates, this.vendorView?.name ?? 'The supplier'));
        if (open.length > 1)
          this.matches.push({
            entity: 'po',
            lineNo: null,
            outcome: 'ambiguous',
            method: 'open_po',
            candidates: open.map((p) => p.id),
            chosenErpId: null,
          });
      }
    }

    if (citedMissing) {
      this.rule('R17', 'fail', 'The order number printed on the invoice is not in the ERP.', {
        actual: poNumber,
      });
      this.ask(
        Q.vf({
          rule: 'R17',
          lineNo: null,
          summary: 'Order not found',
          evidence: `${poNumber} isn't in your records`,
          headline: `The invoice cites ${poNumber}, which is not in your records.`,
          facts: [
            { label: 'Order number on the invoice', value: poNumber ?? '', tone: 'attention' },
          ],
          why: ['Veyra never creates an order to fill a number printed on an invoice.'],
          corrections: [{ path: 'header.poNumber', label: 'The order number was misread' }],
          recheckLabel: 'It is in the ERP now. Check again',
        }),
      );
    }
    if (path === 'undecided') {
      if (!citedMissing) this.rule('R17', 'fail', 'The order is not decided yet.');
      return;
    }

    // Items and PO lines (RULES §2.3).
    let itemsResolved = true;
    for (const l of this.lines) {
      const lineNo = l.lineNo;
      const subject = `line:${lineNo}`;
      let alias: Item | null = null;
      if (vendorRef.kind === 'erp' && l.vendorItemCode)
        alias = await erp.findItemByVendorAlias(erpId(vendorRef.id), l.vendorItemCode);

      if (path === 'erp' && this.po) {
        const candidates = alias
          ? this.po.lines.filter((pl) => pl.item.ref.kind === 'erp' && pl.item.ref.id === alias.id)
          : this.po.lines.filter((pl) => pl.item.hsnSac === l.hsnSac);
        const answer = this.latest(['AM_PO_LINE'], subject);
        const picked =
          answer?.effect.type === 'LINK_ERP_RECORD'
            ? candidates.find(
                (c) =>
                  c.ref.kind === 'erp' && c.ref.id === (answer.effect as { erpId: string }).erpId,
              )
            : undefined;
        const chosen = picked ?? (candidates.length === 1 ? candidates[0] : undefined);
        if (chosen) {
          this.lineMap.set(lineNo, { item: chosen.item, poLine: chosen });
          const method = picked ? 'user_choice' : alias ? 'vendor_alias' : 'po_line_hsn';
          this.matches.push({
            entity: 'item',
            lineNo,
            outcome: 'found',
            method,
            candidates: [(chosen.item.ref as { id: string }).id],
            chosenErpId: (chosen.item.ref as { id: string }).id,
          });
          if (
            !alias &&
            !picked &&
            l.vendorItemCode &&
            vendorRef.kind === 'erp' &&
            chosen.item.ref.kind === 'erp'
          ) {
            this.stage(
              'alias',
              'CP_ALIAS_UNIQUE_PO_LINE',
              {
                vendor: refJson(vendorRef),
                vendorItemCode: l.vendorItemCode,
                item: refJson(chosen.item.ref),
              },
              null,
            );
          }
        } else if (candidates.length > 1) {
          itemsResolved = false;
          this.ask(
            Q.amPoLine(
              lineNo,
              l.description ?? '',
              candidates.map((c) => ({
                id: (c.ref as { id: string }).id,
                label: `${this.po?.label} line ${c.lineNo}: ${c.item.name}, ${Q.qtyText(c.qtyMilli, c.item.uom)} at ${Q.rupees(c.unitPricePaise)}`,
              })),
            ),
          );
        } else {
          itemsResolved = false;
          this.lineMap.set(lineNo, { item: null, poLine: null });
          this.rule('R20', 'fail', 'The line is not on the order.', { lineNo });
          this.ask(
            Q.vf({
              rule: 'R20',
              lineNo,
              summary: 'Item not on the order',
              evidence: `"${l.description}" is not on ${this.po.label}`,
              headline: `Line ${lineNo}, "${l.description}", is not on ${this.po.label}.`,
              facts: [
                {
                  label: 'Invoice line',
                  value: `${l.description} · HSN ${l.hsnSac}`,
                  tone: 'attention',
                },
                { label: this.po.label, value: this.po.lines.map((pl) => pl.item.name).join(', ') },
              ],
              why: ['Every invoice line must match a line on the order.'],
              corrections: [
                { path: `lines[${lineNo}].hsnSac` as FieldPath, label: 'The HSN code was misread' },
              ],
              recheckLabel: 'The order was updated. Check again',
            }),
          );
        }
        continue;
      }

      // No PO yet (PO-less path): find the item on its own (I5–I7).
      const approval = this.latest(['CA_ITEM'], subject);
      const pick = this.latest(['AM_ITEM'], subject);
      if (approval?.effect.type === 'APPROVE_CREATION' && isItemInput(approval.input)) {
        const payload = {
          name: approval.input.name,
          hsnSac: approval.input.hsnSac,
          uom: approval.input.uom,
          gstRateBp: approval.input.gstRateBp,
        };
        const a = this.stage('item', 'CP_ITEM_APPROVED', payload, approval);
        this.lineMap.set(lineNo, {
          item: { ref: { kind: 'staged', actionId: a.id }, code: 'New item', ...payload },
          poLine: null,
        });
        continue;
      }
      if (alias) {
        this.lineMap.set(lineNo, { item: viewOf(alias), poLine: null });
        this.matches.push(found('item', 'vendor_alias', alias.id, lineNo));
        continue;
      }
      if (pick?.effect.type === 'LINK_ERP_RECORD') {
        const chosen = await item(pick.effect.erpId);
        if (chosen) {
          this.lineMap.set(lineNo, { item: viewOf(chosen), poLine: null });
          this.matches.push(found('item', 'user_choice', chosen.id, lineNo));
          continue;
        }
      }
      const exact = await erp.findItemsByNormalizedNameAndHsn(
        normalizeName(l.description ?? ''),
        l.hsnSac ?? '',
      );
      if (exact.length === 1 && exact[0]) {
        this.lineMap.set(lineNo, { item: viewOf(exact[0]), poLine: null });
        this.matches.push(found('item', 'item_name_hsn', exact[0].id, lineNo));
        continue;
      }
      itemsResolved = false;
      const candidates = exact.length > 1 ? exact : await erp.findItemsByHsn(l.hsnSac ?? '');
      this.lineMap.set(lineNo, { item: null, poLine: null });
      if (candidates.length > 0 && pick?.effect.type !== 'REQUEST_CREATION') {
        this.ask(
          Q.amItem(
            lineNo,
            l.description ?? '',
            l.hsnSac ?? '',
            candidates.map((c) => ({ id: c.id, code: c.code, name: c.name })),
          ),
        );
        if (candidates.length > 1)
          this.matches.push({
            entity: 'item',
            lineNo,
            outcome: 'ambiguous',
            method: 'item_hsn',
            candidates: candidates.map((c) => c.id),
            chosenErpId: null,
          });
      } else {
        this.matches.push({
          entity: 'item',
          lineNo,
          outcome: 'not_found',
          method: 'item_hsn',
          candidates: [],
          chosenErpId: null,
        });
        this.ask(
          Q.caItem(lineNo, {
            description: l.description ?? '',
            hsnSac: l.hsnSac ?? '',
            uom: l.uom ?? '',
            gstRateBp: l.gstRateBp ?? 0,
          }),
        );
      }
    }

    // Master-data rules per line (R14, R15, R16, R27).
    this.itemRules(itemsResolved);
    const masterOk = this.rules
      .filter((r) => ['R14', 'R15', 'R16', 'R27'].includes(r.ruleCode))
      .every((r) => r.outcome === 'pass');

    // PO creation policy (RULES §3.4): only once everything it would copy is certain.
    if (path === 'derived') {
      if (!masterOk || this.hasQuestions()) {
        this.rule(
          'R17',
          'not_evaluated',
          'A purchase order is considered only once the supplier and items are settled.',
        );
        return;
      }
      const total = this.header.total ?? 0;
      const approval = this.latest(['CA_PO'], 'po');
      const s = this.input.settings;
      let policy: 'CP_PO_BELOW_THRESHOLD' | 'CP_PO_APPROVED' | null = null;
      if (approval?.effect.type === 'APPROVE_CREATION') policy = 'CP_PO_APPROVED';
      else if (s.poAutoCreateEnabled && total < s.poAutoCreateBelowPaise)
        policy = 'CP_PO_BELOW_THRESHOLD';
      if (!policy) {
        this.rule('R17', 'fail', 'No order yet; creating one needs your approval.');
        this.ask(
          Q.caPo(
            s.poAutoCreateEnabled ? 'at_or_above' : 'disabled',
            total,
            s.poAutoCreateBelowPaise,
          ),
        );
        return;
      }
      const lines = this.lines.map((l) => ({
        lineNo: l.lineNo,
        item: refJson(this.lineMap.get(l.lineNo)?.item?.ref as Ref),
        qtyMilli: l.qtyMilli ?? 0,
        unitPricePaise: l.unitPricePaise ?? 0,
        gstRateBp: l.gstRateBp ?? 0,
      }));
      const approved = policy === 'CP_PO_APPROVED' ? (approval ?? null) : null;
      const a = this.stage(
        'po',
        policy,
        {
          vendor: refJson(vendorRef),
          poDate: this.header.invoiceDate ?? '',
          origin: approved ? 'created_from_invoice_on_approval' : 'auto_created_from_invoice',
          approvedByUserId: approved?.userId ?? null,
          lines,
        },
        approved,
      );
      const ref: Ref = { kind: 'staged', actionId: a.id };
      this.po = {
        ref,
        label: 'the new order',
        poDate: this.header.invoiceDate ?? '',
        vendorRef,
        status: 'open',
        derived: true,
        lines: this.lines.map((l) => {
          const it = this.lineMap.get(l.lineNo)?.item as ItemView;
          const pl: PoLineView = {
            ref: { kind: 'staged', actionId: a.id, lineNo: l.lineNo },
            lineNo: l.lineNo,
            item: it,
            qtyMilli: l.qtyMilli ?? 0,
            unitPricePaise: l.unitPricePaise ?? 0,
            gstRateBp: l.gstRateBp ?? 0,
          };
          this.lineMap.set(l.lineNo, { item: it, poLine: pl });
          return pl;
        }),
      };
      this.rule(
        'R17',
        'pass',
        policy === 'CP_PO_APPROVED'
          ? 'Order created from the invoice on your approval.'
          : 'Order created from the invoice under your automatic limit.',
      );
    } else {
      this.rule('R17', 'pass', `${this.po?.label}.`);
    }
    await this.poRules();
  }

  async poSummary(po: PurchaseOrder, item: (id: string) => Promise<Item | null>): Promise<string> {
    const parts = await Promise.all(
      po.lines.map(async (l) => {
        const it = await item(l.itemId);
        return `${it?.name ?? 'Item'} × ${Q.qtyText(l.qtyMilli, it?.uom ?? '')} at ${Q.rupees(l.unitPricePaise)}`;
      }),
    );
    return `${Q.dateText(po.poDate)} · ${parts.join('; ')}`;
  }

  itemRules(itemsResolved: boolean): void {
    this.rule(
      'R14',
      itemsResolved ? 'pass' : 'fail',
      itemsResolved ? 'Every line has an item.' : 'Some lines have no item yet.',
    );
    for (const l of this.lines) {
      const it = this.lineMap.get(l.lineNo)?.item;
      if (!it) {
        for (const code of ['R15', 'R16', 'R27'] as const)
          this.rule(code, 'not_evaluated', 'Waiting for the item.', { lineNo: l.lineNo });
        continue;
      }
      const cmp = (
        code: 'R15' | 'R16' | 'R27',
        printed: string | number | null,
        master: string | number,
        ok: string,
        q: () => QuestionDraft,
      ) => {
        if (printed === master)
          this.rule(code, 'pass', ok, { lineNo: l.lineNo, expected: master, actual: printed });
        else {
          this.rule(code, 'fail', 'Differs from the item master.', {
            lineNo: l.lineNo,
            expected: master,
            actual: printed,
          });
          this.ask(q());
        }
      };
      cmp('R15', l.hsnSac, it.hsnSac, 'HSN matches the item.', () =>
        Q.vf({
          rule: 'R15',
          lineNo: l.lineNo,
          summary: 'HSN differs',
          evidence: `Invoice says ${l.hsnSac} · item uses ${it.hsnSac}`,
          headline: `Line ${l.lineNo}: the HSN code differs from ${it.name}.`,
          facts: [
            { label: 'On the invoice', value: String(l.hsnSac), tone: 'attention' },
            { label: `${it.code} in your records`, value: it.hsnSac },
          ],
          why: ['The HSN code on the invoice must match the item.'],
          corrections: [
            { path: `lines[${l.lineNo}].hsnSac` as FieldPath, label: 'The HSN code was misread' },
          ],
          recheckLabel: 'The item was updated. Check again',
        }),
      );
      cmp('R16', l.gstRateBp, it.gstRateBp, 'GST rate matches the item.', () =>
        Q.vf({
          rule: 'R16',
          lineNo: l.lineNo,
          summary: 'GST rate differs',
          evidence: `Invoice says ${l.gstRateBp === null ? '?' : Q.displayValue('rate', l.gstRateBp)} · item uses ${Q.displayValue('rate', it.gstRateBp)}`,
          headline: `Line ${l.lineNo}: the GST rate differs from ${it.name}.`,
          facts: [
            {
              label: 'On the invoice',
              value: Q.displayValue('rate', l.gstRateBp),
              tone: 'attention',
            },
            { label: `${it.code} in your records`, value: Q.displayValue('rate', it.gstRateBp) },
          ],
          why: ['The GST rate on the invoice must match the item.'],
          corrections: [
            { path: `lines[${l.lineNo}].gstRateBp` as FieldPath, label: 'The rate was misread' },
          ],
          recheckLabel: 'The item was updated. Check again',
        }),
      );
      cmp('R27', l.uom, it.uom, 'Unit matches the item.', () =>
        Q.vf({
          rule: 'R27',
          lineNo: l.lineNo,
          summary: 'Unit differs',
          evidence: `Invoice says ${l.uom} · item uses ${it.uom}`,
          headline: `Line ${l.lineNo} is in ${l.uom}, but ${it.name} is kept in ${it.uom}.`,
          facts: [
            { label: 'On the invoice', value: String(l.uom), tone: 'attention' },
            { label: `${it.code} in your records`, value: it.uom },
          ],
          why: [
            'Veyra does not convert units: the invoice unit must match the item exactly.',
            `${l.uom} and ${it.uom} are different units.`,
          ],
          corrections: [
            { path: `lines[${l.lineNo}].uom` as FieldPath, label: 'The unit was misread' },
          ],
          recheckLabel: 'The item was updated. Check again',
        }),
      );
    }
  }

  async poRules(): Promise<void> {
    const po = this.po;
    if (!po) return;
    const erp = this.input.erp;
    const na = (code: RuleCode) =>
      this.rule(
        code,
        'not_applicable',
        'The order was created from this invoice, so comparing them proves nothing.',
        { naReason: 'PO_DERIVED_FROM_INVOICE' },
      );

    // R18 vendor
    const vendorOk =
      po.derived ||
      (this.vendorRef?.kind === 'erp' &&
        po.vendorRef.kind === 'erp' &&
        po.vendorRef.id === this.vendorRef.id);
    if (vendorOk) this.rule('R18', 'pass', 'The order is for this supplier.');
    else {
      this.rule('R18', 'fail', 'The order belongs to another supplier.');
      const owner =
        po.vendorRef.kind === 'erp' ? await erp.getVendor(erpId(po.vendorRef.id)) : null;
      this.ask(
        Q.vf({
          rule: 'R18',
          lineNo: null,
          summary: 'Order is for another supplier',
          evidence: `${po.label} belongs to ${owner?.name ?? 'another supplier'}`,
          headline: `${po.label} was placed with ${owner?.name ?? 'another supplier'}, not ${this.vendorView?.name}.`,
          facts: [
            { label: 'Supplier', value: this.vendorView?.name ?? '' },
            { label: `${po.label} is with`, value: owner?.name ?? '', tone: 'attention' },
          ],
          why: ['An invoice can only be recorded against an order with the same supplier.'],
          corrections: po.derived
            ? []
            : [{ path: 'header.poNumber', label: 'The order number was misread' }],
          recheckLabel: 'Check again',
        }),
      );
    }

    // R19 open
    if (po.status === 'open') this.rule('R19', 'pass', 'The order is open.');
    else {
      this.rule('R19', 'fail', 'The order is closed.');
      this.ask(Q.bdPoClosed(po.label));
    }

    // R20 each line on exactly one PO line, no PO line used twice
    if (!this.rules.some((r) => r.ruleCode === 'R20')) {
      const used = this.lines
        .map((l) => this.lineMap.get(l.lineNo)?.poLine?.ref)
        .filter(Boolean)
        .map((r) => JSON.stringify(r));
      const allMapped = this.lines.every((l) => this.lineMap.get(l.lineNo)?.poLine);
      if (allMapped && new Set(used).size === used.length)
        this.rule('R20', 'pass', 'Every line is on the order.');
      else if (!allMapped) this.rule('R20', 'not_evaluated', 'Waiting for the order lines.');
      else {
        this.rule('R20', 'fail', 'Two invoice lines use the same order line.');
        this.ask(
          Q.vf({
            rule: 'R20',
            lineNo: null,
            summary: 'Order line used twice',
            evidence: 'Two lines match the same order line',
            headline: 'Two invoice lines match the same order line.',
            facts: [],
            why: ['Each order line can be matched once per invoice.'],
            corrections: [],
            recheckLabel: 'Check again',
          }),
        );
      }
    }

    if (po.derived) {
      (['R21', 'R22', 'R23', 'R24'] as const).forEach(na);
      return;
    }

    // R21–R23 per line
    for (const l of this.lines) {
      const pl = this.lineMap.get(l.lineNo)?.poLine;
      if (!pl) {
        for (const code of ['R21', 'R22', 'R23'] as const)
          this.rule(code, 'not_evaluated', 'Waiting for the order line.', { lineNo: l.lineNo });
        continue;
      }
      const uom = pl.item.uom;
      if (l.unitPricePaise === pl.unitPricePaise)
        this.rule('R21', 'pass', 'Price matches the order.', {
          lineNo: l.lineNo,
          expected: pl.unitPricePaise,
          actual: l.unitPricePaise,
        });
      else {
        this.rule('R21', 'fail', 'Price differs from the order.', {
          lineNo: l.lineNo,
          expected: pl.unitPricePaise,
          actual: l.unitPricePaise,
        });
        this.ask(
          Q.vf({
            rule: 'R21',
            lineNo: l.lineNo,
            summary: 'Price differs',
            evidence: `${Q.rupees(l.unitPricePaise ?? 0)} per ${uom} · order says ${Q.rupees(pl.unitPricePaise)}`,
            headline: `The price on line ${l.lineNo} is different from ${po.label}.`,
            facts: [
              {
                label: 'Invoice price',
                value: `${Q.rupees(l.unitPricePaise ?? 0)} per ${uom}`,
                tone: 'attention',
              },
              { label: `${po.label} price`, value: `${Q.rupees(pl.unitPricePaise)} per ${uom}` },
              {
                label: 'Difference',
                value: `${Q.rupees(Math.abs((l.unitPricePaise ?? 0) - pl.unitPricePaise))} per ${uom}`,
              },
            ],
            why: [
              `${po.label} agreed ${Q.rupees(pl.unitPricePaise)} per ${uom} of ${pl.item.name}.`,
              'Even one paisa is a difference.',
            ],
            corrections: [
              {
                path: `lines[${l.lineNo}].unitPricePaise` as FieldPath,
                label: 'The price was misread',
              },
            ],
            recheckLabel: 'The order was updated. Check again',
          }),
        );
      }
      if (l.gstRateBp === pl.gstRateBp)
        this.rule('R22', 'pass', 'GST rate matches the order.', { lineNo: l.lineNo });
      else {
        this.rule('R22', 'fail', 'GST rate differs from the order.', {
          lineNo: l.lineNo,
          expected: pl.gstRateBp,
          actual: l.gstRateBp,
        });
        this.ask(
          Q.vf({
            rule: 'R22',
            lineNo: l.lineNo,
            summary: 'GST rate differs from the order',
            evidence: `${Q.displayValue('rate', l.gstRateBp)} · order says ${Q.displayValue('rate', pl.gstRateBp)}`,
            headline: `The GST rate on line ${l.lineNo} is different from ${po.label}.`,
            facts: [
              { label: 'Invoice', value: Q.displayValue('rate', l.gstRateBp), tone: 'attention' },
              { label: po.label, value: Q.displayValue('rate', pl.gstRateBp) },
            ],
            why: ['The rate must match the order.'],
            corrections: [
              { path: `lines[${l.lineNo}].gstRateBp` as FieldPath, label: 'The rate was misread' },
            ],
            recheckLabel: 'The order was updated. Check again',
          }),
        );
      }
      const invoiced =
        pl.ref.kind === 'erp'
          ? ((await erp.getInvoicedQtyByPoLine(erpId(pl.ref.id))) as number)
          : 0;
      const remaining = pl.qtyMilli - invoiced;
      if ((l.qtyMilli ?? 0) <= remaining)
        this.rule('R23', 'pass', 'Within the quantity left on the order.', {
          lineNo: l.lineNo,
          expected: remaining,
          actual: l.qtyMilli,
        });
      else {
        this.rule('R23', 'fail', 'More than the quantity left on the order.', {
          lineNo: l.lineNo,
          expected: remaining,
          actual: l.qtyMilli,
        });
        this.ask(
          Q.vf({
            rule: 'R23',
            lineNo: l.lineNo,
            summary: 'More than ordered',
            evidence: `${Q.qtyText(l.qtyMilli ?? 0, uom)} invoiced · ${Q.qtyText(Math.max(0, remaining), uom)} left on the order`,
            headline: `Line ${l.lineNo} invoices more than is left on ${po.label}.`,
            facts: [
              { label: 'Invoiced', value: Q.qtyText(l.qtyMilli ?? 0, uom), tone: 'attention' },
              { label: 'Ordered', value: Q.qtyText(pl.qtyMilli, uom) },
              { label: 'Already invoiced', value: Q.qtyText(invoiced, uom) },
            ],
            why: ['An invoice cannot bill more than was ordered.'],
            corrections: [
              {
                path: `lines[${l.lineNo}].qtyMilli` as FieldPath,
                label: 'The quantity was misread',
              },
            ],
            recheckLabel: 'The order was updated. Check again',
          }),
        );
      }
    }

    // R24 date
    const date = this.header.invoiceDate ?? '';
    if (date >= po.poDate) this.rule('R24', 'pass', 'Dated on or after the order.');
    else {
      this.rule('R24', 'fail', 'Dated before the order.', {
        expected: `>= ${po.poDate}`,
        actual: date,
      });
      this.ask(
        Q.vf({
          rule: 'R24',
          lineNo: null,
          summary: 'Dated before the order',
          evidence: `Invoice ${Q.dateText(date)} · order ${Q.dateText(po.poDate)}`,
          headline: `The invoice is dated before ${po.label}.`,
          facts: [
            { label: 'Invoice date', value: Q.dateText(date), tone: 'attention' },
            { label: 'Order date', value: Q.dateText(po.poDate) },
          ],
          why: ['An invoice cannot come before its order.'],
          corrections: [{ path: 'header.invoiceDate', label: 'The date was misread' }],
          recheckLabel: 'Check again',
        }),
      );
    }
  }

  // ── Stage 4: goods receipt (R25, R26) ────────────────────────────────────

  async stage4(): Promise<void> {
    const po = this.po;
    if (!po) return;
    const erp = this.input.erp;
    const subject = `grn:${po.ref.kind === 'erp' ? po.label : 'new-po'}`;
    const erpGrns: Grn[] = po.ref.kind === 'erp' ? await erp.listGrnsForPo(erpId(po.ref.id)) : [];
    this.matches.push(
      erpGrns.length === 1 && erpGrns[0]
        ? found('grn', 'po_grns', erpGrns[0].id)
        : {
            entity: 'grn',
            lineNo: null,
            outcome: erpGrns.length ? 'ambiguous' : 'not_found',
            method: 'po_grns',
            candidates: erpGrns.map((g) => g.id),
            chosenErpId: null,
          },
    );

    // Receipts the user confirmed for this invoice (every one is kept, in order).
    const confirmations = this.input.answers
      .filter(
        (a) =>
          a.code === 'CA_GRN' &&
          a.subjectKey === subject &&
          a.effect.type === 'APPROVE_CREATION' &&
          isGrnInput(a.input),
      )
      .sort((a, b) => a.seq - b.seq);
    const coverage = new Map<string, number>();
    const key = (r: PoLineRef) => JSON.stringify(r);
    for (const g of erpGrns)
      for (const gl of g.lines)
        coverage.set(
          key({ kind: 'erp', id: gl.poLineId }),
          (coverage.get(key({ kind: 'erp', id: gl.poLineId })) ?? 0) + gl.acceptedQtyMilli,
        );
    for (const c of confirmations) {
      const inputGrn = c.input as unknown as GrnInput;
      const lines = inputGrn.lines
        .map((gl) => {
          const pl = po.lines.find((p) => p.lineNo === gl.poLineNo);
          return pl
            ? {
                poLine: pl.ref,
                receivedQtyMilli: gl.receivedQtyMilli,
                acceptedQtyMilli: gl.acceptedQtyMilli,
              }
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null && x.receivedQtyMilli > 0);
      if (lines.length === 0) continue;
      this.stage(
        'grn',
        'CP_GRN_USER_CONFIRMED',
        {
          po: refJson(po.ref),
          grnDate: inputGrn.grnDate,
          confirmedByUserId: c.userId,
          lines: lines.map((x) => ({
            poLine: poLineJson(x.poLine),
            receivedQtyMilli: x.receivedQtyMilli,
            acceptedQtyMilli: x.acceptedQtyMilli,
          })),
        },
        c,
      );
      for (const x of lines)
        coverage.set(key(x.poLine), (coverage.get(key(x.poLine)) ?? 0) + x.acceptedQtyMilli);
    }

    const grnQuestion = (additional: boolean) =>
      Q.caGrn(
        subject,
        { label: po.derived ? 'the new order' : po.label, date: po.poDate },
        this.input.today,
        this.lines.map((l) => {
          const pl = this.lineMap.get(l.lineNo)?.poLine;
          return {
            poLineNo: pl?.lineNo ?? l.lineNo,
            label: `${pl?.item.name ?? l.description}`,
            uom: pl?.item.uom ?? l.uom ?? '',
            suggestedQtyMilli: l.qtyMilli ?? 0,
          };
        }),
        additional,
      );

    const anyReceipt = erpGrns.length > 0 || confirmations.length > 0;
    if (!anyReceipt) {
      this.rule('R25', 'fail', 'No goods receipt for the order.');
      this.rule('R26', 'not_evaluated', 'Waiting for the goods receipt.');
      this.ask(grnQuestion(false));
      return;
    }
    this.rule(
      'R25',
      'pass',
      `${erpGrns.length + confirmations.length} goods receipt${erpGrns.length + confirmations.length === 1 ? '' : 's'}.`,
    );

    // An "add a receipt" request not yet followed by a receipt: ask for it.
    const request = this.input.answers
      .filter((a) => a.code === 'VF_R26' && a.effect.type === 'REQUEST_CREATION')
      .sort((a, b) => b.seq - a.seq)[0];
    const lastConfirmation = confirmations.at(-1);
    if (request && (!lastConfirmation || lastConfirmation.seq < request.seq)) {
      this.rule('R26', 'not_evaluated', 'Waiting for the additional receipt.');
      this.ask(grnQuestion(true));
      return;
    }

    for (const l of this.lines) {
      const pl = this.lineMap.get(l.lineNo)?.poLine;
      if (!pl) continue;
      const accepted = coverage.get(key(pl.ref)) ?? 0;
      const invoiced =
        pl.ref.kind === 'erp'
          ? ((await erp.getInvoicedQtyByPoLine(erpId(pl.ref.id))) as number)
          : 0;
      const available = accepted - invoiced;
      const uom = pl.item.uom;
      if ((l.qtyMilli ?? 0) <= available) {
        this.rule('R26', 'pass', 'Covered by goods received.', {
          lineNo: l.lineNo,
          expected: available,
          actual: l.qtyMilli,
        });
        continue;
      }
      this.rule('R26', 'fail', 'More than the goods received.', {
        lineNo: l.lineNo,
        expected: available,
        actual: l.qtyMilli,
      });
      this.ask(
        Q.vf({
          rule: 'R26',
          lineNo: l.lineNo,
          summary: 'Quantity differs',
          evidence: `${Q.qtyText(l.qtyMilli ?? 0, uom)} invoiced · ${Q.qtyText(Math.max(0, available), uom)} received`,
          headline: `The invoice is for more ${pl.item.name} than was received.`,
          facts: [
            { label: 'Invoiced', value: Q.qtyText(l.qtyMilli ?? 0, uom), tone: 'attention' },
            { label: 'Received and accepted', value: Q.qtyText(accepted, uom) },
            ...(invoiced ? [{ label: 'Already invoiced', value: Q.qtyText(invoiced, uom) }] : []),
          ],
          why: [
            `Goods receipts for ${po.derived ? 'the order' : po.label} cover ${Q.qtyText(Math.max(0, available), uom)} not yet invoiced.`,
          ],
          corrections: [
            { path: `lines[${l.lineNo}].qtyMilli` as FieldPath, label: 'The quantity was misread' },
          ],
          recheckLabel: 'A receipt was added in the ERP. Check again',
          offerReceipt: true,
        }),
      );
    }
  }

  // ── Commit plan ──────────────────────────────────────────────────────────

  plan(): CommitPlan | null {
    if (!this.vendorRef || !this.po) return null;
    const H = this.header;
    const order: CreationEntity[] = ['vendor_reactivation', 'vendor', 'item', 'alias', 'po', 'grn'];
    const lines = this.lines.map((l) => {
      const m = this.lineMap.get(l.lineNo);
      if (!m?.item || !m.poLine) throw new Error(`line ${l.lineNo} is not resolved`);
      return {
        lineNo: l.lineNo,
        item: m.item.ref,
        poLine: m.poLine.ref,
        qtyMilli: l.qtyMilli ?? 0,
        unitPricePaise: l.unitPricePaise ?? 0,
        taxablePaise: l.taxablePaise ?? 0,
        gstRateBp: l.gstRateBp ?? 0,
        cgstPaise: this.perLineTax ? l.cgstPaise : null,
        sgstPaise: this.perLineTax ? l.sgstPaise : null,
        igstPaise: this.perLineTax ? l.igstPaise : null,
      };
    });
    return {
      vendor: this.vendorRef,
      po: this.po.ref,
      actionIds: [...this.actions]
        .sort((a, b) => order.indexOf(a.entity) - order.indexOf(b.entity))
        .map((a) => a.id),
      invoice: {
        vendorInvoiceNo: H.invoiceNumber ?? '',
        invoiceDate: H.invoiceDate ?? '',
        taxablePaise: H.taxable ?? 0,
        cgstPaise: H.cgst ?? 0,
        sgstPaise: H.sgst ?? 0,
        igstPaise: H.igst ?? 0,
        roundOffPaise: H.roundOff,
        totalPaise: H.total ?? 0,
        lines,
      },
    };
  }
}

// ── small helpers ────────────────────────────────────────────────────────

function found(
  entity: MatchRecord['entity'],
  method: MatchRecord['method'],
  id: string,
  lineNo: number | null = null,
): MatchRecord {
  return { entity, lineNo, outcome: 'found', method, candidates: [id], chosenErpId: id };
}

function vendorCandidate(v: Vendor): Q.VendorCandidate {
  return { id: v.id, code: v.code, name: v.name, gstin: v.gstin };
}

export interface GrnInput {
  grnDate: string;
  lines: { poLineNo: number; receivedQtyMilli: number; acceptedQtyMilli: number }[];
}
export interface ItemInput {
  name: string;
  hsnSac: string;
  uom: string;
  gstRateBp: number;
}

function isGrnInput(v: JsonValue): v is JsonValue & GrnInput {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof v.grnDate === 'string' &&
    Array.isArray(v.lines)
  );
}
function isItemInput(v: JsonValue): v is JsonValue & ItemInput {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof v.name === 'string' &&
    typeof v.gstRateBp === 'number'
  );
}

export type { AnswerEffect };
