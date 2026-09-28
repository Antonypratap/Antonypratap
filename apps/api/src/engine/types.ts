import type {
  AnswerEffect,
  CreationEntity,
  CreationPolicyCode,
  CreationTrigger,
  MatchEntity,
  MatchMethod,
  MatchOutcome,
  NaReason,
  QuestionCode,
  QuestionKind,
  RuleCode,
  ValidationOutcome,
} from '@veyra/shared';
import type { ErpConnector } from '@veyra/erp-connector';
import type { JsonValue, StoredField } from './fields';

/** The read-only part of the ERP port the engine may use. Writes happen only in COMMITTING. */
export type ErpReader = Pick<
  ErpConnector,
  | 'getCompany'
  | 'getVendor'
  | 'findVendorByGstin'
  | 'findVendorsByPan'
  | 'findVendorsByNormalizedName'
  | 'getItem'
  | 'findItemByVendorAlias'
  | 'findItemsByNormalizedNameAndHsn'
  | 'findItemsByHsn'
  | 'getPurchaseOrder'
  | 'getPurchaseOrderByNumber'
  | 'listOpenPurchaseOrders'
  | 'listGrnsForPo'
  | 'getInvoicedQtyByPoLine'
  | 'findPurchaseInvoice'
>;

/** A record the invoice uses: already in the ERP, or staged by this invoice (the overlay). */
export type Ref = { kind: 'erp'; id: string } | { kind: 'staged'; actionId: string };
export type PoLineRef =
  { kind: 'erp'; id: string } | { kind: 'staged'; actionId: string; lineNo: number };

export interface EngineSettings {
  confidenceMinBp: number;
  poAutoCreateEnabled: boolean;
  poAutoCreateBelowPaise: number;
}

/** A designated-user answer, kept as data and re-applied on every run (ARCHITECTURE §5). */
export interface AnsweredDecision {
  questionId: string;
  code: QuestionCode;
  subjectKey: string;
  optionId: string;
  effect: AnswerEffect;
  /** Canonical, server-validated input (GRN quantities, item details), if the option took one. */
  input: JsonValue;
  userId: string;
  seq: number;
}

export interface ExistingAction {
  id: string;
  signature: string;
  status: 'staged' | 'committed' | 'discarded';
}

/** Another Veyra invoice with the same business key (RULES R11). */
export interface OtherInvoice {
  id: string;
  state: string;
  invoiceDate: string | null;
  totalPaise: number | null;
}

export interface EngineInput {
  invoiceId: string;
  today: string;
  settings: EngineSettings;
  fields: ReadonlyMap<string, StoredField>;
  lineCount: number;
  answers: readonly AnsweredDecision[];
  existingActions: readonly ExistingAction[];
  erp: ErpReader;
  otherInvoicesWithKey: (key: DuplicateKey) => Promise<OtherInvoice[]>;
  newId: () => string;
}

export interface DuplicateKey {
  vendorGstin: string;
  invoiceNoNormalized: string;
  fy: string;
}

export interface MatchRecord {
  entity: MatchEntity;
  lineNo: number | null;
  outcome: MatchOutcome;
  method: MatchMethod;
  candidates: string[];
  chosenErpId: string | null;
}

export interface PlannedAction {
  id: string;
  entity: CreationEntity;
  policyCode: CreationPolicyCode;
  trigger: CreationTrigger;
  approvedByUserId: string | null;
  questionId: string | null;
  payload: Record<string, JsonValue>;
  signature: string;
}

export interface RuleRecord {
  ruleCode: RuleCode;
  lineNo: number | null;
  outcome: ValidationOutcome;
  naReason: NaReason | null;
  expected: JsonValue;
  actual: JsonValue;
  message: string;
}

/** How the user types an answer. Server-side parsing is authoritative; this only drives the form. */
export type InputSpec =
  | {
      kind: 'value';
      field:
        | 'text'
        | 'gstin'
        | 'state'
        | 'date'
        | 'money'
        | 'signedMoney'
        | 'qty'
        | 'rate'
        | 'hsn'
        | 'uom';
      label: string;
      initial: string;
    }
  | {
      kind: 'grn';
      poLabel: string;
      minDate: string;
      maxDate: string;
      lines: { poLineNo: number; label: string; uom: string; suggestedQty: string }[];
    }
  | {
      kind: 'item';
      initial: { name: string; hsnSac: string; uom: string; gstRate: string };
    };

export interface OptionDraft {
  id: string;
  label: string;
  effect: AnswerEffect;
  emphasis: 'primary' | 'secondary' | 'quiet';
  /** What the confirmation says once chosen. */
  result: string;
  input: InputSpec | null;
}

export interface Fact {
  label: string;
  value: string;
  tone?: 'attention';
}

export interface QuestionDraft {
  code: QuestionCode;
  kind: QuestionKind;
  subjectKey: string;
  /** Short label for queues ("Quantity differs"). */
  summary: string;
  /** One line of evidence for queues ("200 KGS invoiced · 180 KGS received"). */
  evidence: string;
  /** The question itself. Stored as the question's prompt. */
  headline: string;
  facts: Fact[];
  why: string[];
  /** Field paths the question is about, for highlighting the document. */
  paths: string[];
  options: OptionDraft[];
}

export interface PlannedInvoiceLine {
  lineNo: number;
  item: Ref;
  poLine: PoLineRef;
  qtyMilli: number;
  unitPricePaise: number;
  taxablePaise: number;
  gstRateBp: number;
  cgstPaise: number | null;
  sgstPaise: number | null;
  igstPaise: number | null;
}

/** Everything COMMITTING writes, frozen when the invoice passes validation (decision D4). */
export interface CommitPlan {
  vendor: Ref;
  po: Ref;
  /** Staged action ids in commit dependency order. */
  actionIds: string[];
  invoice: {
    vendorInvoiceNo: string;
    invoiceDate: string;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    roundOffPaise: number | null;
    totalPaise: number;
    lines: PlannedInvoiceLine[];
  };
}

export interface LineResolution {
  lineNo: number;
  item: Ref | null;
  poLine: PoLineRef | null;
}

export interface EngineOutput {
  matches: MatchRecord[];
  actions: PlannedAction[];
  validations: RuleRecord[];
  questions: QuestionDraft[];
  /** Values the engine established deterministically (place of supply, GSTIN from a vendor choice). */
  derivedFields: StoredField[];
  duplicateKey: DuplicateKey | null;
  vendor: Ref | null;
  po: Ref | null;
  lines: LineResolution[];
  /** Set only when every rule passed (or is not applicable) and nothing needs the user. */
  plan: CommitPlan | null;
}
