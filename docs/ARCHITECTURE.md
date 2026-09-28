# Veyra — Architecture (V1)

Status: **Approved (rev 3: decisions D1–D4 recorded)**. Phases 0–2 complete (scaffold; shared contracts, India tax, ERP connector contract; fake ERP + SQLite). **Phase 3B complete**: the first real vertical slice (see §13).

Veyra is an AI-assisted business transaction automation platform. The V1 use case:

> Purchase invoice (photo / PDF) → extract data → find vendor / items / PO / GRN →
> create missing records only when policy allows → validate → ask the designated user
> when uncertain → **Verified Pending Payment**.

## 0. Non-negotiable principles

| # | Principle | What it means in code |
|---|---|---|
| 1 | **READ → FIND → USE → IF MISSING, CREATE → VALIDATE → ASK HUMAN WHEN UNCERTAIN** | Pipeline stages, in this order, on every run. |
| 2 | **Never guess** | Missing, low-confidence, ambiguous or failing → a Question. No defaults, no "best candidate" auto-picks, no fuzzy auto-links. |
| 3 | **No tolerance** | All comparisons are exact integer comparisons (paise, milli-units, basis points). |
| 4 | **No approval hierarchy** | Exactly one designated user answers every question. |
| 5 | **No timeout** | An invoice in `NEEDS_INPUT` waits indefinitely. Nothing escalates or auto-resolves. |
| 6 | **No payment execution** | Terminal success state is `VERIFIED_PENDING_PAYMENT`. Veyra has no payment code path. |
| 7 | **AI only reads** | AI (OCR / LLM) proposes extracted field values with evidence. All matching, creation, validation and state transitions are deterministic code. |
| 8 | **No human "Verify" click** | If every deterministic rule passes, the invoice transitions automatically to `VERIFIED_PENDING_PAYMENT`. |
| 9 | **₹0 to build and run** | Only free/open-source tooling; everything runs locally and offline. |

V1 scope: **India, GST, INR only.** One buyer company. One PO per invoice.

## 1. System overview

```
┌──────────────────────────── apps/web (React + TS, Vite) ────────────────────────────┐
│ Inbox · Upload · Invoice Review · Questions · ERP Browser · Audit · Settings        │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │ REST/JSON (polling; no websockets in V1)
┌───────────────────────────── apps/api (Node + TS, Fastify) ─────────────────────────┐
│ routes → services                                                                   │
│                                                                                     │
│  READ            FIND            USE / CREATE        VALIDATE         ASK           │
│ ┌──────────┐   ┌──────────┐    ┌──────────────┐    ┌───────────┐   ┌───────────┐    │
│ │Extraction│──▶│ Matching │──▶ │  Resolution  │──▶ │ Validation│──▶│ Questions │    │
│ │ (AI)     │   │          │    │ (policy,     │    │ (rules)   │   │           │    │
│ └────┬─────┘   └────┬─────┘    │  staging)    │    └─────┬─────┘   └─────┬─────┘    │
│      │              │          └──────┬───────┘          │               │          │
│      │              └────────┬────────┘                  │               │          │
│      │              ┌────────▼────────────────────────────▼───────────────▼──┐       │
│      │              │ Workflow engine: state machine · job runner · audit    │       │
│      │              │ Commit: executes staged creations + records invoice    │       │
│      │              └────────┬───────────────────────────────────────────────┘       │
│ ┌────▼─────────┐     ┌───────▼───────┐                                               │
│ │ Extractor    │     │ ErpConnector  │   ← ports (interfaces)                        │
│ └────┬─────────┘     └───────┬───────┘                                               │
└──────┼───────────────────────┼───────────────────────────────────────────────────────┘
       │                       │
 FixtureExtractor (demo/test)  FakeErpConnector ──▶ fake_erp.db (SQLite)
 LocalOcrExtractor (default)   (later: Tally / Zoho Books / SAP B1 / …)
 OllamaExtractor (optional)
                               veyra.db (SQLite): workflow, extraction, matches,
                               staged creations, validations, questions, audit, jobs
```

### Key decisions

| Area | Decision | Rationale |
|---|---|---|
| Runtime | Node 20+, TypeScript strict, npm workspaces | Free, one language end to end. |
| API | Fastify + Zod (schemas shared with web) | Typed, fast, request/response validation. |
| DB | SQLite via `better-sqlite3` + Drizzle ORM/migrations | Zero-cost, file-based, synchronous transactions. |
| ERP boundary | **Two SQLite files**: `veyra.db` and `fake_erp.db`. Veyra reaches ERP data only via `ErpConnector`. | Makes replacing the fake ERP with a real connector a drop-in change. |
| Money | Integer **paise** (`*_paise`). Never floats. | No tolerance requires exact arithmetic. |
| Quantity | Integer **milli-units** (`*_milli`, 1 kg = 1000). | Exact fractional quantities. |
| Rates | Integer **basis points** (`*_bp`, 18% = 1800). | Exact tax arithmetic. |
| Background work | SQLite-backed `jobs` table, in-process runner. Commit jobs run with global concurrency 1. | No Redis, no cost; serialised commits avoid races on GRN quantities. |
| Web | React 18 + Vite + React Router + TanStack Query; plain CSS modules | Free, minimal. |
| PDF/Images | `pdfjs-dist` (text layer + page render), `sharp` (image preprocessing), `tesseract.js` (OCR, `eng`) | All free, offline. |
| Tests | Vitest (unit/integration), Playwright (e2e, pre-installed Chromium) | Free. |

## 2. Folder structure

```
veyra/                               (repo root)
├── package.json                     npm workspaces, root scripts (check, test, dev, demo)
├── tsconfig.base.json
├── .github/workflows/ci.yml         typecheck + lint + test (free GitHub Actions minutes)
├── docs/
│   ├── ARCHITECTURE.md              this file
│   ├── RULES.md                     matching, creation, validation & question rules
│   └── DEMO.md                      seed data + demo scenarios
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── server.ts            Fastify bootstrap
│   │   │   ├── config.ts            env + settings loader
│   │   │   ├── auth/                single designated-user dev login (cookie session)
│   │   │   ├── db/                  veyra.db schema, migrations, client
│   │   │   ├── routes/              invoices, questions, erp, audit, settings, auth, dev
│   │   │   ├── workflow/            state machine, transitions, job runner, pipeline
│   │   │   ├── extraction/          runs Extractor, normalises, applies confidence policy
│   │   │   ├── matching/            vendor / item / PO / GRN finders (read-only)
│   │   │   ├── resolution/          creation policy, staging of creation_actions
│   │   │   ├── validation/          rule registry; one file per rule, pure functions
│   │   │   ├── questions/           question builders + deterministic answer effects
│   │   │   ├── commit/              executes staged creations + recordPurchaseInvoice
│   │   │   └── audit/               append-only audit writer
│   │   ├── storage/uploads/         original files (gitignored)
│   │   └── test/
│   └── web/
│       └── src/
│           ├── pages/               Inbox, Upload, InvoiceReview, Questions, Erp/*, Audit, Settings, Login
│           ├── components/          DocumentViewer, FieldPanel, LineMatchTable, ChecksList,
│           │                        QuestionCard, StatusBadge, Timeline, MoneyText
│           ├── api/                 typed client using packages/shared schemas
│           └── App.tsx
├── packages/
│   ├── shared/                      Zod schemas, DTOs, enums (states, question kinds, rule codes),
│   │                                money/qty/rate helpers
│   ├── india-tax/                   GSTIN checksum, state codes, PAN, HSN/SAC format,
│   │                                FY derivation, GST computation (half-up to paisa)
│   ├── erp-connector/               ErpConnector interface + reusable contract test suite
│   ├── fake-erp/                    FakeErpConnector, fake_erp.db schema, seed data
│   └── extractor/                   Extractor interface + fixture / local-ocr / ollama
├── fixtures/
│   └── invoices/                    S01…S17 PDFs/photos + *.expected.json (see DEMO.md)
└── scripts/
    ├── generate-fixtures.ts         renders demo invoices with pdfkit; photo variants via sharp
    └── reset-demo.ts                recreates both DBs and seeds them
```

## 3. Ports (interfaces)

### 3.1 Extractor

All three implementations implement exactly this interface. Nothing downstream knows which one ran.

```ts
interface Extractor {
  readonly id: 'fixture' | 'local_ocr' | 'ollama';
  readonly version: string;
  isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }>;
  extract(input: { documentId: string; filePath: string; mime: string; sha256: string })
    : Promise<ExtractionResult>;
}

interface ExtractedField<T> {
  value: T | null;                 // null = not found
  confidenceBp: number;            // integer 0..10000 (no floats anywhere)
  evidence: { page: number; text: string; bbox: [number, number, number, number] | null } | null;
}

interface ExtractionResult {
  header: {
    vendorName, vendorGstin, vendorAddress, buyerGstin, placeOfSupply,
    shipToState, shipToGstin,          // place-of-supply evidence (RULES §1.6)
    invoiceNumber, invoiceDate, poNumber,
    taxablePaise, cgstPaise, sgstPaise, igstPaise, roundOffPaise, totalPaise
  };                                // each an ExtractedField<...>
  lines: Array<{                    // lineNo 1..n; field paths use lines[<lineNo>]
    description, vendorItemCode, hsnSac, qtyMilli, uom,
    unitPricePaise, taxablePaise, gstRateBp, cgstPaise, sgstPaise, igstPaise
  }>;                               // each an ExtractedField<...>
  pages: number;
  warnings: string[];
}
```

| Implementation | Purpose | How confidence is produced |
|---|---|---|
| `FixtureExtractor` | **Demo and tests only.** Looks up `fixtures/invoices/<sha256>.expected.json`. Disabled unless `VEYRA_ALLOW_FIXTURE_EXTRACTOR=true`, and refuses in `NODE_ENV=production`. | Taken from the fixture file, so scripted low-confidence cases work. |
| `LocalOcrExtractor` | **Real, free default.** 1) `pdfjs-dist` text layer when present. 2) Otherwise render page → `sharp` (grayscale, deskew, threshold) → `tesseract.js`. 3) Deterministic field parser: label-anchored patterns (GSTIN regex, "Invoice No", "PO No", dates), and table reconstruction from word bounding boxes. | Text-layer values start at 1.0. OCR values use the Tesseract word confidence. Either is reduced to 0 if the value fails format validation (e.g. a GSTIN pattern). |
| `OllamaExtractor` | **Optional.** Local vision model via Ollama HTTP (e.g. `qwen2.5vl:7b`). Prompted for strict JSON, parsed by Zod. | LLMs do not provide calibrated confidence. Each value is **cross-checked verbatim** against the OCR/text-layer tokens. If found, the OCR confidence is used; if not found, confidence 0 (it becomes a question). |

Honest limitation: reconstructing line-item tables from phone photos with Tesseract is the weakest part. Weak reads produce questions, not guesses.

### 3.2 ErpConnector

Defined in `packages/erp-connector/src/connector.ts` (Phase 1). All ids, money, quantities and rates are branded integer/ID types from `@veyra/shared`; GSTIN, PAN and FY types come from `@veyra/india-tax`.

```ts
interface ErpConnector {
  readonly info: { name: string; version: string };
  // READ / FIND: by key → null | []; by parent id → ErpNotFoundError if the parent is unknown
  getCompany(): Promise<Company>;
  getVendor(vendorId): Promise<Vendor | null>;
  findVendorByGstin(gstin: Gstin): Promise<Vendor | null>;
  findVendorsByPan(pan: Pan): Promise<Vendor[]>;
  findVendorsByNormalizedName(normalizedName): Promise<Vendor[]>;         // exact, pre-normalised
  getItem(itemId): Promise<Item | null>;
  findItemByVendorAlias(vendorId, vendorItemCode): Promise<Item | null>;  // exact code
  findItemsByNormalizedNameAndHsn(normalizedName, hsnSac): Promise<Item[]>;
  findItemsByHsn(hsnSac): Promise<Item[]>;
  getPurchaseOrder(poId): Promise<PurchaseOrder | null>;
  getPurchaseOrderByNumber(poNumber): Promise<PurchaseOrder | null>;
  listOpenPurchaseOrders(vendorId): Promise<PurchaseOrder[]>;  // open = status open AND uninvoiced qty
  listGrnsForPo(poId): Promise<Grn[]>;
  getInvoicedQtyByPoLine(poLineId): Promise<MilliQty>;
  findPurchaseInvoice(vendorId, normalizedInvoiceNo, fy): Promise<PurchaseInvoice | null>;

  // WRITE: COMMITTING only; all idempotent on `key`
  reactivateVendor(input: { vendorId, sourceInvoiceId, approvedByUserId }, key): Promise<Vendor>;
  createVendor(input, key): Promise<Vendor>;                 // natural key: GSTIN
  createItem(input /* approvedByUserId required */, key): Promise<Item>;
  createVendorItemAlias(input, key): Promise<VendorItemAlias>;  // natural key: (vendor, code)
  createPurchaseOrder(input /* origin tag; ERP assigns number */, key): Promise<PurchaseOrder>;
  createGrn(input /* confirmedByUserId required */, key): Promise<Grn>;
  recordPurchaseInvoice(input, key): Promise<PurchaseInvoice>;  // natural key: (vendor, no, FY)
}
```

**Errors** (all extend `ErpConnectorError`): `NOT_FOUND`, `CONFLICT` (natural key taken; carries `existingId`), `VALIDATION`, `IDEMPOTENCY_CONFLICT`, `UNAVAILABLE` (the only retryable one), `UNSUPPORTED_OPERATION`.

**Idempotency contract** (`idempotency.ts`):

1. On first use of a key, validate, write, and record `{key, operation, payloadHash, resultId}` atomically with the write.
2. Same key + same operation + same payload → no write; return the same record. This must survive restarts.
3. Same key with a different operation or payload → `IDEMPOTENCY_CONFLICT`, and nothing is written.
4. Failed writes do not consume the key.
5. A natural-key collision with a record written under another key → `CONFLICT`. It is never resolved silently.

`payloadHash` is SHA-256 of canonical JSON, which rejects non-integer numbers.

`packages/erp-connector` ships a **contract test suite** (`@veyra/erp-connector/contract`, `describeErpConnectorContract`) that any connector (fake or real) must pass. There is deliberately no `pay*` method, and a type test enforces that.

## 4. Database schema

Conventions: ids are ULIDs (TEXT). Timestamps are ISO-8601 UTC TEXT. Money is `_paise` INTEGER, quantity is `_milli` INTEGER, rates are `_bp` INTEGER.

### 4.1 `fake_erp.db`

```sql
company(id, name, gstin, state_code)

vendors(id, code UNIQUE, name, name_normalized, gstin UNIQUE, pan, state_code, address,
        status CHECK IN ('active','inactive'),
        origin CHECK IN ('seed','created_by_veyra'), source_invoice_id NULL, created_at)

items(id, code UNIQUE, name, name_normalized, hsn_sac, uom, gst_rate_bp,
      origin, source_invoice_id NULL, created_at)

vendor_item_aliases(id, vendor_id, vendor_item_code, item_id, origin, source_invoice_id NULL, created_at,
      UNIQUE(vendor_id, vendor_item_code))

purchase_orders(id, po_number UNIQUE, vendor_id, po_date, status CHECK IN ('open','closed'),
      origin CHECK IN ('seed','auto_created_from_invoice','created_from_invoice_on_approval'),
      source_invoice_id NULL, approved_by_user_id NULL, created_at)

po_lines(id, po_id, line_no, item_id, qty_milli, unit_price_paise, gst_rate_bp,
      UNIQUE(po_id, line_no))

grns(id, grn_number UNIQUE, po_id, grn_date,
      origin CHECK IN ('seed','user_confirmed_via_veyra'),
      confirmed_by_user_id NULL, source_invoice_id NULL, created_at)

grn_lines(id, grn_id, po_line_id, received_qty_milli, accepted_qty_milli,
      UNIQUE(grn_id, po_line_id), CHECK(accepted ≤ received))

purchase_invoices(id, vendor_id, vendor_invoice_no, vendor_invoice_no_normalized, invoice_date, fy,
      po_id, taxable_paise, cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise,
      status CHECK IN ('verified_pending_payment'),
      veyra_invoice_id UNIQUE, idempotency_key UNIQUE, created_at,
      UNIQUE(vendor_id, vendor_invoice_no_normalized, fy))

purchase_invoice_lines(id, purchase_invoice_id, line_no, po_line_id, item_id,
      qty_milli, unit_price_paise, taxable_paise, gst_rate_bp,
      cgst_paise NULL, sgst_paise NULL, igst_paise NULL,     -- null when the invoice shows no per-line tax
      UNIQUE(purchase_invoice_id, line_no))

idempotency_log(key PRIMARY KEY, operation, payload_hash, result_id, created_at)
```

**Implementation (Phase 2, `packages/fake-erp`).**

Schema and migrations:
- The schema is defined with Drizzle (`src/db/schema.ts`). The SQL migration is generated by drizzle-kit (`drizzle/`) and applied when a connector opens a database.
- `npm run db:verify` (part of `npm run check`) fails if the schema and the migration drift apart.
- Foreign keys are enforced (`PRAGMA foreign_keys = ON`).
- Every money, quantity and rate column is declared `integer` and also carries `CHECK(typeof(col) = 'integer')`, because SQLite would otherwise store a REAL value.
- Further CHECK constraints enforce:
  - GSTIN-derived PAN and state
  - real calendar dates
  - GST rates 0–10000 bp
  - HSN of 4, 6 or 8 digits
  - origin ↔ source invoice, approver and confirmer consistency
  - invoice total = taxable + taxes + round-off
  - `purchase_invoices.status = 'verified_pending_payment'` as the only possible status
  - `company` as a single row

Record identifiers are opaque to Veyra. The fake ERP makes them readable and deterministic:
- masters use their code (`V001`, `ITM-001`)
- documents use their number (`PO-2026-0101`)
- lines use `<parent>#<n>`

Numbers assigned for new records:
- vendor `V###`, item `ITM-###`, alias `ALIAS-####`
- PO `AUTO/<FY>/<n>`, GRN `GRN/<FY>/<n>`, purchase invoice `PINV/<FY>/<n>`

Connector behaviour:
- Each write runs in one `BEGIN IMMEDIATE` transaction: idempotency lookup → integrity checks → inserts → ledger row. Any error rolls back everything, including the ledger row.
- Lock and I/O errors map to `UNAVAILABLE`.
- `FakeErpConnector.open({ filename, reset?: 'demo' | 'company-only', clock?, busyTimeoutMs? })` is the only public API. It has `reset()` and `close()`; no SQL, schema or connection is exported.
- ESLint forbids deep imports of `@veyra/fake-erp/*`, and forbids SQLite imports in other packages.
- `npm run erp:reset [-- <path>]` deterministically recreates `data/fake_erp.db` with the DEMO.md seed.

### 4.2 `veyra.db`

```sql
users(id, name, email UNIQUE, active, created_at)
    -- V1: one user. No roles table. Multi-user later = more rows + a roles table; no reshaping.

settings(key PRIMARY KEY, value_json, updated_by_user_id, updated_at)
    -- designated_user_id, extractor_mode, extraction_confidence_min_bp,
    -- po_auto_create_enabled, po_auto_create_below_paise

sessions(id, user_id, created_at, expires_at)            -- dev login cookie

documents(id, sha256 UNIQUE, filename, mime, pages, storage_path,
          uploaded_by_user_id, uploaded_at)

invoices(id, document_id, state, state_version,            -- optimistic locking
         vendor_erp_id NULL, po_erp_id NULL, erp_purchase_invoice_id NULL,
         failed_stage NULL, failure_reason NULL,
         rejected_by_user_id NULL, rejected_reason NULL,
         created_at, updated_at)

extractions(id, invoice_id, extractor_id, extractor_version, raw_json, created_at)

fields(id, invoice_id, path, value_json, confidence_bp,
       evidence_json, source CHECK IN ('extracted','human_confirmed','human_corrected','derived_from_erp_choice',
                     'derived_from_document_evidence'),
       extraction_id, updated_by_user_id NULL, updated_at,
       UNIQUE(invoice_id, path))
       -- path: 'header.vendorGstin', 'lines[2].unitPricePaise', ...
       -- human_* values are never overwritten by re-extraction

invoice_lines(id, invoice_id, line_no,
       item_erp_id NULL, po_line_erp_id NULL,
       item_ref_staged_action_id NULL)              -- links to a staged item creation

match_results(id, invoice_id, run_no, entity CHECK IN ('vendor','item','po','grn'), line_no NULL,
       outcome CHECK IN ('found','not_found','ambiguous'), method, candidates_json, chosen_erp_id NULL)

creation_actions(id, invoice_id, entity CHECK IN ('vendor','item','alias','po','grn','vendor_reactivation'),
       payload_json, policy_code,                   -- which rule allowed it (see RULES.md)
       trigger CHECK IN ('auto_policy','user_approval'),
       approved_by_user_id NULL, question_id NULL,
       status CHECK IN ('staged','committed','discarded'),
       erp_id NULL, idempotency_key UNIQUE, created_at, committed_at NULL)

validation_results(id, invoice_id, run_no, rule_code,
       outcome CHECK IN ('pass','fail','not_applicable','not_evaluated'),
       na_reason NULL,                               -- e.g. 'PO_DERIVED_FROM_INVOICE'
       expected_json, actual_json, message, created_at)

questions(id, invoice_id, kind, code, subject_key,
       prompt, context_json, options_json, input_schema_json NULL,
       status CHECK IN ('open','answered','superseded'),
       assigned_to_user_id,
       answer_json NULL, answered_by_user_id NULL, answered_at NULL,
       created_at)
       -- kind ∈ MISSING_DATA | AMBIGUOUS_MATCH | BUSINESS_DECISION | VALIDATION_FAILURE | CREATION_APPROVAL
       -- partial unique index: (invoice_id, code, subject_key) WHERE status='open'

audit_events(id, invoice_id NULL, actor_type CHECK IN ('system','ai','user'), actor_user_id NULL,
       event, from_state NULL, to_state NULL, detail_json, created_at)   -- append-only

jobs(id, invoice_id, type CHECK IN ('pipeline','commit'), status, attempts,
       run_after, locked_at NULL, last_error NULL, created_at)
```

### 4.3 Staging and commit

Nothing is written to the ERP until an invoice is fully valid. Creations (vendor, item, alias, PO, GRN, vendor reactivation) are **staged** in `creation_actions`. Matching and validation read from **ERP data plus this invoice's staged records** (an overlay). When all rules pass, the `COMMITTING` step executes the staged actions in dependency order, then calls `recordPurchaseInvoice`:

`vendor_reactivation → vendor → item → alias → po → grn → purchase invoice`

- Each call carries `idempotencyKey = veyra:<invoiceId>:<actionId>`, so a crashed commit can resume safely.
- Commit jobs run one at a time. Immediately before committing, the ERP-dependent rules (duplicate, remaining GRN qty, vendor/PO status) are re-evaluated against live ERP data.
- A natural-key conflict at commit (another invoice created the same vendor GSTIN first) sends the invoice back to `MATCHING`, which now finds the existing record. It does not fail.
- On `REJECTED`, staged actions become `discarded`. The ERP never receives orphan records from abandoned invoices. **Consequence (decision D1):** a GRN confirmed on an invoice that is later rejected is never written to the ERP. The confirmation remains in Veyra's `creation_actions` (`discarded`) and in the audit trail.
- **Restartability (decision D4):** `COMMITTING` is automatic. Each staged action records its `erp_id` as soon as the connector returns it. A restarted commit skips actions that already have an `erp_id` and re-sends the rest with the same idempotency key, and the connector returns the existing record for a key it has seen before. `recordPurchaseInvoice` is also protected by the ERP's `UNIQUE(vendor, invoice_no, FY)` constraint.

## 5. Workflow state machine

`AWAITING_CONFIRMATION` has been **removed**. There is no final human verify step.

```
                 upload
                    │
                    ▼
               ┌─────────┐
               │UPLOADED │
               └────┬────┘
                    ▼
               ┌──────────┐  extractor error   ┌────────┐
               │EXTRACTING├───────────────────▶│ FAILED │── reprocess ──┐
               └────┬─────┘                    └────────┘               │
                    ▼                               ▲                   │
               ┌──────────┐ ◀───────────────────────┼───────────────────┘
          ┌──▶ │ MATCHING │   FIND                  │ unexpected error
          │    └────┬─────┘                         │ (any system state)
          │         ▼
          │    ┌──────────┐
          │    │RESOLVING │   USE / IF MISSING, CREATE (stage per policy)
          │    └────┬─────┘
          │         ▼
          │    ┌──────────┐
          │    │VALIDATING│   VALIDATE (all rules, all failures recorded)
          │    └────┬─────┘
          │         │
          │   any open question            all rules pass/N-A and
          │   or failed rule               zero open questions
          │         │                              │
          │         ▼                              ▼
          │   ┌────────────┐              ┌────────────┐  natural-key conflict
          └───┤NEEDS_INPUT │              │ COMMITTING ├──────────────▶ MATCHING
   answer     └─────┬──────┘              └─────┬──────┘
   (re-run)         │ reject                    │ success
                    ▼                           ▼
              ┌──────────┐          ┌──────────────────────────┐
              │ REJECTED │          │ VERIFIED_PENDING_PAYMENT │
              └──────────┘          └──────────────────────────┘
               (terminal)                    (terminal)
```

| From | To | Trigger | Actor |
|---|---|---|---|
| — | UPLOADED | `POST /invoices` | user |
| UPLOADED | EXTRACTING | pipeline job picked up | system |
| EXTRACTING | MATCHING | extraction stored | system (AI output) |
| EXTRACTING / MATCHING / RESOLVING / VALIDATING / COMMITTING | FAILED | unexpected error (`failed_stage` recorded) | system |
| FAILED | EXTRACTING | `POST /invoices/:id/reprocess` | user |
| MATCHING | RESOLVING | matches recorded | system |
| RESOLVING | VALIDATING | creation actions staged / questions raised | system |
| VALIDATING | NEEDS_INPUT | ≥1 open question or ≥1 failed rule | system |
| VALIDATING | COMMITTING | all rules `pass` or `not_applicable`, zero open questions | system (**automatic**) |
| NEEDS_INPUT | MATCHING | a question answered, or a field corrected (full deterministic re-run) | user |
| NEEDS_INPUT | NEEDS_INPUT | nothing (no timeout; waits indefinitely) | — |
| NEEDS_INPUT / FAILED | REJECTED | reject answer or `POST /invoices/:id/reject` | designated user |
| COMMITTING | VERIFIED_PENDING_PAYMENT | all staged actions + invoice recorded in ERP | system |
| COMMITTING | MATCHING | pre-commit re-check found new ERP state (e.g. vendor now exists) | system |

Notes:
- Every run is a **full deterministic re-run** from MATCHING using current fields, which include human corrections. Answers are stored as data (fields, choices, approvals), not as one-off patches, so re-runs are reproducible.
- Questions are idempotent by `(invoice_id, code, subject_key)`. A re-run keeps questions that are still valid, marks resolved ones `superseded`, and adds new ones.
- Illegal transitions throw, and every transition writes an `audit_events` row.
- There is no payment state and no transition beyond `VERIFIED_PENDING_PAYMENT`.

## 6. Questions

| Kind | Raised when | Typical options |
|---|---|---|
| `MISSING_DATA` | Required field absent, below confidence threshold, or unparseable | Confirm shown value · Enter correct value · Reject invoice |
| `AMBIGUOUS_MATCH` | More than one candidate (vendor, item, PO line, open PO), or a name-only vendor candidate without a readable GSTIN | Pick candidate · None of these · Reject invoice |
| `BUSINESS_DECISION` | Facts are clear but a policy choice is needed (inactive vendor, closed PO) | Explicit decision (e.g. reactivate vendor) · Reject invoice |
| `VALIDATION_FAILURE` | A deterministic rule failed | Correct a misread field · "Fixed in ERP — re-check" · Reject invoice (**there is no override option**) |
| `CREATION_APPROVAL` | A record may be created only with the user's approval (vendor not auto-eligible, item master, PO ≥ threshold, **every GRN**) | Approve (with required inputs, e.g. GRN quantities) · Decline / reject invoice |

Every option maps to a **typed, deterministic effect** (`SET_FIELD`, `CONFIRM_FIELD`, `LINK_ERP_RECORD`, `REQUEST_CREATION`, `DECLARE_NON_PO`, `APPROVE_CREATION`, `RECHECK`, `REJECT_INVOICE`; declining a creation is `REJECT_INVOICE`, per RULES §5, and there is no override effect). All questions are assigned to the single designated user. See RULES.md for every question code.

## 7. Users and auth (V1)

- `users` table plus `settings.designated_user_id`. V1 seeds exactly one user.
- Dev login: `POST /auth/dev-login { userId }` sets an httpOnly session cookie. No passwords in V1; bind to localhost.
- A single guard, `requireDesignatedUser`, protects answering questions, correcting fields, rejecting invoices and changing settings. **No RBAC, no hierarchy.**
- Every actor reference is a `user_id` (`uploaded_by`, `answered_by`, `approved_by`, audit `actor_user_id`), so adding users later needs no schema reshaping.

## 8. REST API (`/api/v1`)

```
Auth
POST   /auth/dev-login                 { userId } → session cookie
POST   /auth/logout
GET    /auth/me

Invoices
POST   /invoices                       multipart (pdf|jpg|png, ≤ 20 MB) → 201 {invoice}
                                       409 if identical file (sha256) already uploaded
GET    /invoices?state=&q=&page=       inbox list
GET    /invoices/:id                   full view: state, fields, lines, matches, staged creations,
                                       validation results, questions
GET    /invoices/:id/document          original file
GET    /invoices/:id/audit             timeline
PATCH  /invoices/:id/fields            [{ path, value }] → human_corrected; re-run   (designated user)
POST   /invoices/:id/fields/confirm    [{ path }] → human_confirmed; re-run          (designated user)
POST   /invoices/:id/reprocess         FAILED → EXTRACTING                           (designated user)
POST   /invoices/:id/reject            { reason } → REJECTED                         (designated user)

Questions
GET    /questions?status=open&invoiceId=
GET    /questions/:id
POST   /questions/:id/answer           { optionId, input? } → effect applied, re-run (designated user)

ERP (read-only, via ErpConnector)
GET    /erp/company
GET    /erp/vendors         /erp/vendors/:id
GET    /erp/items           /erp/items/:id
GET    /erp/purchase-orders /erp/purchase-orders/:id   (lines, GRNs, invoiced qty)
GET    /erp/grns/:id
GET    /erp/purchase-invoices

Settings / Admin
GET    /settings
PUT    /settings                                                                    (designated user)
GET    /audit?invoiceId=&page=
GET    /health
POST   /dev/reset-demo                 reseed both DBs (only when NODE_ENV!=production)
```

Errors use one shape: `{ "error": { "code": "INVALID_TRANSITION", "message": "...", "details": {} } }`. `409` means a state_version conflict or a duplicate upload, and `422` means a schema violation.

## 9. Main screens

1. **Login (dev)**: choose the designated user.
2. **Inbox**: invoices with state badge, vendor, total, open-question count and age. Filter by state.
3. **Upload**: drag-and-drop or phone camera capture; multiple files.
4. **Invoice Review** (core screen). The **document viewer** on the left highlights the evidence bbox of the selected field. Tabs on the right:
   - **Fields**: value, confidence, source badge (extracted / confirmed / corrected), inline correct/confirm.
   - **Lines**: invoice ↔ PO line ↔ GRN accepted ↔ already invoiced ↔ remaining, with mismatches highlighted.
   - **Records**: FIND results and staged creations, each tagged `auto_created_from_invoice`, `user approval` or `existing`.
   - **Checks**: every rule as pass / fail / N-A with expected vs actual. N-A shows its reason (e.g. "PO derived from this invoice"). The totals block always shows **calculated total → round-off → invoice total** (D2).
   - **Questions**: open and answered.
   - **Timeline**: audit trail.
5. **Questions Queue**: all open questions, grouped by invoice. Each card has kind, prompt, evidence snippet, options and required inputs (e.g. the GRN quantity form).
6. **ERP Browser**: vendors, items, POs (with origin tags), GRNs, purchase invoices. Read-only.
7. **Audit Log**: global and filterable.
8. **Settings**: designated user, extractor mode, confidence threshold, PO auto-create switch + threshold, demo reset (dev only).

## 10. Settings (defaults)

| Key | Default | Notes |
|---|---|---|
| `designated_user_id` | seeded user | Exactly one. |
| `extractor_mode` | `local_ocr` | `fixture` is allowed only with `VEYRA_ALLOW_FIXTURE_EXTRACTOR=true` (demo/tests). |
| `extraction_confidence_min_bp` | `9000` (0.90) | Below → `MISSING_DATA`. |
| `po_auto_create_enabled` | `false` | Safe default; the demo seed turns it on. |
| `po_auto_create_below_paise` | `0` | Eligible only if invoice **grand total incl. GST < value**. `0` means nothing is eligible. The demo uses ₹25,000.00. |

## 11. Implementation plan

Each phase ends green on `npm run check` (typecheck + lint + tests) and is pushed separately.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Scaffold** | npm workspaces, tsconfig, ESLint/Prettier, Vitest, CI workflow, empty apps/packages | `npm run check` passes in CI |
| **1. Domain foundations** | `shared` (enums, Zod schemas, money/qty/rate helpers), `india-tax` (GSTIN checksum, state codes, PAN, FY, GST calc half-up) | 100% unit coverage of the arithmetic and GSTIN code |
| **2. ERP port + fake ERP** | `ErpConnector` interface, contract test suite, `FakeErpConnector`, `fake_erp.db` migrations, seed from DEMO.md, idempotency log | Contract suite passes; seed loads; idempotent re-calls return the same ids |
| **3. Veyra DB + workflow core** | `veyra.db` migrations, state machine, job runner (commit concurrency 1), audit writer, users/settings, dev auth | Every legal transition tested; illegal transitions throw; the audit row is written in the same transaction |
| **4. Extraction** | `Extractor` interface; `FixtureExtractor`; `LocalOcrExtractor` (pdf text layer → OCR → field parser); `OllamaExtractor` with verbatim cross-check; fixture generator script | All S01–S17 fixtures extract as expected via fixture mode; LocalOcr reproduces header fields on the generated text-layer PDFs; Ollama skipped when unavailable |
| **5. Matching (FIND/USE)** | Vendor, item, PO, GRN finders + overlay of staged records | Unit tests per RULES.md §2 |
| **6. Resolution (CREATE)** | Creation policy (vendor, item, alias, PO threshold, GRN never auto), staging | Unit tests per RULES.md §3, including the threshold boundary (equal → question) |
| **7. Validation** | Rule registry; each rule a pure function `(ctx) → pass/fail/NA` | Unit tests per rule, including 1-paisa and 1-milli boundaries |
| **8. Questions + re-run loop** | Builders per code, answer effects, supersede logic, reject | Every question code has an answer-effect test |
| **9. Commit** | Ordered execution of staged actions, pre-commit re-check, conflict → MATCHING, idempotent resume | Crash-mid-commit test resumes without duplicates |
| **10. API** | Fastify routes, Zod validation, error shape | API integration tests drive S01–S17 to their expected terminal/waiting state |
| **11. Web UI** | All screens in §9 | Scenarios can be clicked through manually |
| **12. Demo polish** | `npm run demo` (reset + seed + start), DEMO.md script, Playwright e2e for S01, S03, S08 | e2e green in CI |

Phases 1–10 are headless and API-first. The UI is built last on tested logic.

## 12. Decision log

| # | Decision | Where |
|---|---|---|
| D1 | New ERP records are staged and written only when the whole invoice transaction commits. User-confirmed GRN data stays in Veyra's `creation_actions` and audit trail if the invoice is rejected, but it is **never** written to the ERP unless the commit succeeds. | §4.3 |
| D2 | Round-off is accepted only when printed on the invoice and exactly equal to the amount needed to reach the nearest rupee. The UI shows *calculated total → round-off → invoice total*. A difference is never silently absorbed. | RULES §4.1, R10 |
| D3 | Place of supply follows a deterministic hierarchy: printed → established from valid GST evidence on the document → ask. It is never inferred from the buyer GSTIN alone. | RULES §1.6 |
| D4 | `COMMITTING` is automatic, restartable and idempotent. A crash never creates duplicate ERP records. | §4.3 |

## 13. Phase 3B: the first real vertical slice

Upload → extract → resolve → match → ask → validate → commit → `VERIFIED_PENDING_PAYMENT`, end to end, with the approved product UI reading the real API. This section records what was built and every choice made on the way. Each item is labelled:

- **CLIENT REQUIREMENT**: fixed by the client (this document, RULES.md, DEMO.md or the Phase 3B brief).
- **IMPLEMENTATION DECISION**: a choice made while building, within the requirements.
- **TECHNICAL CONSTRAINT**: something the tools or the slice's scope impose.

### 13.1 What runs

| Part | Where | Notes |
|---|---|---|
| Extractor port + `FixtureExtractor` | `packages/extractor` | Demo/test only (below). |
| Veyra database | `apps/api/src/db` | Drizzle schema + generated migration; `npm run db:verify` checks drift. |
| Deterministic engine | `apps/api/src/engine` | `runEngine()` is FIND → USE → CREATE → VALIDATE in one pure pass; it only reads the ERP (through the port) and returns what to persist. |
| Workflow | `apps/api/src/workflow` | State machine, persistence of each run, answers, rejection, commit, job runner. |
| REST API | `apps/api/src/http` | Fastify + Zod; responses validated against `packages/shared/src/schemas/api.ts`. |
| Composition root | `apps/api/src/app.ts` | The only module that knows the ERP is the fake ERP and the extractor is the fixture extractor (enforced by ESLint). |
| Product UI | `apps/web/src/product` | Same screens and visual system; data from `/api/v1` only. |

### 13.2 Client requirements implemented as specified

- **CLIENT REQUIREMENT** State machine exactly as §5: UPLOADED → EXTRACTING → MATCHING → RESOLVING → VALIDATING → NEEDS_INPUT | COMMITTING → VERIFIED_PENDING_PAYMENT; FAILED from any system state; REJECTED only by the designated user. No other state was added. Every transition is checked (`workflow/state-machine.ts`), bumps `state_version`, and writes an audit row in the same transaction.
- **CLIENT REQUIREMENT** Extraction output is untrusted: it is parsed with `ExtractionResultSchema` before anything reads it; failures move the invoice to FAILED (stage EXTRACTING). Extractors cannot reach the ERP.
- **CLIENT REQUIREMENT** Never guess: only `found` matches are used; ambiguity and missing records become the fixed question codes of RULES §5 with typed effects. No question offers override, ignore or continue-anyway (tested).
- **CLIENT REQUIREMENT** Question gating by stage (RULES §4); every rule has a result on every run; a failed or unevaluated rule with no question moves the invoice to FAILED (`INVARIANT_VIOLATION`), never to COMMITTING.
- **CLIENT REQUIREMENT** Vendor V1–V6, items I1–I7, PO P1–P4 and the PO policy of RULES §3.4 (strictly below the threshold; equal asks). Auto-created POs are tagged `auto_created_from_invoice`; R21–R24 are `not_applicable` / `PO_DERIVED_FROM_INVOICE`, never `pass`. A cited PO number that is not in the ERP fails R17; no PO is created for it.
- **CLIENT REQUIREMENT** GRNs only from the designated user's explicit date and quantities (`CA_GRN`). A confirmed GRN on a rejected invoice is discarded, kept in `creation_actions` and the audit trail, and never written to the ERP (D1).
- **CLIENT REQUIREMENT** Three-way match with no tolerance (R21, R23, R26); round-off per D2; place of supply per D3 (the buyer GSTIN is never evidence).
- **CLIENT REQUIREMENT** Staging and COMMITTING per §4.3 and D4: staged creations reach the ERP only when the whole invoice passes; commit re-checks the ERP before its first write, executes in dependency order with `veyra:<invoice>:<action>` keys, records each ERP id immediately, checks the invoice's natural key, then records the purchase invoice. A crash at any point resumes without duplicates (tested at four crash points). A natural-key conflict sends the invoice back to MATCHING.
- **CLIENT REQUIREMENT** One designated user; questions never time out or escalate; no payment code path.

### 13.3 Implementation decisions

- **IMPLEMENTATION DECISION** Answers are stored as data on the answered question (`answer_json`, ordered by `answer_seq`) and re-applied on every run; field corrections are `human_corrected` / `human_confirmed` fields. A re-run is therefore a pure function of fields + answers + ERP state.
- **IMPLEMENTATION DECISION** Staged actions carry a deterministic `signature` (entity, policy, approving question, payload). A re-run that stages the same thing reuses the same action id, so idempotency keys are stable across runs.
- **IMPLEMENTATION DECISION** The commit plan is frozen as `invoices.commit_plan_json` when validation passes. COMMITTING executes that plan and never re-plans mid-way (re-planning after a partial commit would see its own new records and ask new questions).
- **IMPLEMENTATION DECISION** Duplicate detection (R11) keys on vendor GSTIN + normalised invoice number + FY, across the ERP and other non-rejected Veyra invoices (`invoices.dup_*`). Invoice date and amount are shown in the question ("same amount") but are not part of the key: an invoice number reused with a different amount is still a conflict the user must see. A possible duplicate is asked (`VF_R11`), never auto-rejected.
- **IMPLEMENTATION DECISION** Table naming follows the Phase 3B brief: `extracted_fields` (called `fields` in §4.2). Added columns: `documents.size_bytes`; `invoices.run_no`, `dup_vendor_gstin`, `dup_invoice_no`, `dup_fy`, `commit_plan_json`; `creation_actions.signature`; `questions.answer_seq`; `jobs.updated_at`. There is no `sessions` table (no authentication in this slice).
- **IMPLEMENTATION DECISION** API naming follows the brief: `POST /api/v1/documents` uploads (it creates the document and its invoice; 409 on an identical file). The other routes are §8's, plus `GET /documents`, `GET /documents/:id/file`, `GET /erp/grns` and `POST /dev/reset` (not registered in production). Responses are presentation-ready (status, question wording, audit titles) so the browser derives nothing.
- **IMPLEMENTATION DECISION** UI status is derived on the server: NEEDS_INPUT and FAILED → *Needs your attention*; system states → *Processing*; VERIFIED_PENDING_PAYMENT → *Handled* (no decision was needed) or *Ready* (the user decided something); REJECTED → *Rejected*. The Inbox count, the Questions count and the queue all come from this one status.
- **IMPLEMENTATION DECISION** The ErpConnector gained read-only browsing operations for the ERP screen: `listVendors`, `listItems`, `listPurchaseOrders`, `listGrns`, `listPurchaseInvoices`. They are covered by the contract suite and are never used for matching.
- **IMPLEMENTATION DECISION** A UOM synonym table (RULES §1.4) was added to `@veyra/shared` (`normalizeUom`); NOS and PCS stay distinct.
- **IMPLEMENTATION DECISION** Upload type is decided by the file's bytes (PDF/PNG/JPEG signatures), not its name or the browser's claim; files are stored under the data directory; the ULID-named copy is served back with `nosniff`.
- **IMPLEMENTATION DECISION** Jobs: one in-process loop over the `jobs` table. A restarted process re-queues jobs left `running`; every job is safe to repeat. ERP `UNAVAILABLE` is retried with a deterministic backoff (1 s × attempt, up to 5 attempts); any other error fails the invoice visibly.

### 13.4 Technical constraints

- **TECHNICAL CONSTRAINT** Extraction in this slice is the `FixtureExtractor` only: it recognises the demo documents in `fixtures/invoices/` by SHA-256 and returns what is printed on them (including deliberately weak reads). It refuses production (`NODE_ENV=production`) and runs only with `VEYRA_ALLOW_FIXTURE_EXTRACTOR=true`. Any other file fails visibly at EXTRACTING. LocalOcr/Ollama are later phases.
- **TECHNICAL CONSTRAINT** The fixture documents are generated deterministically (`npm run fixtures:generate`, hand-written PDF and stored-deflate PNG writers) so their hashes never change; a test checks the committed files. Scenario data lives in `packages/extractor/src/fixture/scenarios.ts` instead of per-file `*.expected.json`.
- **TECHNICAL CONSTRAINT** No authentication: the server acts as the single designated user (`settings.designated_user_id`) and binds to 127.0.0.1. Every actor reference is still a `user_id`.
- **TECHNICAL CONSTRAINT** The web app polls (1 s while anything is processing, 4 s otherwise); there are no websockets (§8).

### 13.5 Conflicts between the Phase 3B brief and the fixed requirements (not silently changed)

| # | Brief asks for | Fixed requirement | What was built | Needs a client decision |
|---|---|---|---|---|
| C1 | UoM: apply a known conversion; otherwise ask for a factor and save the mapping | RULES R27: "Line UOM = item UOM (no conversion in V1)" | R27 as written: a mismatch raises `VF_R27` (correct a misread unit, re-check, or reject). No factor is asked for or stored. | Whether V2 adds approved UoM conversions (and where they live: ERP or Veyra). |
| C2 | Items: allow "classify as non-stock expense" | RULES §2.3/§5 offer link, create or reject only; `recordPurchaseInvoice` requires an item and a PO line on every line | Not built. | Whether non-stock lines are in scope, and how they are recorded in the ERP. |
| C3 | "Ask supplier" moves the invoice to a processing/follow-up state | §5 has no such state; RULES §5 has no such option | Not built. The invoice stays in NEEDS_INPUT (it waits indefinitely); the user can re-check once the supplier has answered, or reject. | Whether a follow-up state (and its exit conditions) should be added. |
