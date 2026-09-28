# Veyra — Business Rules (V1)

Status: **Approved (rev 3)**. This file is the specification for the deterministic core. Every rule here gets a unit test named after its code.

Scope: **India · GST · INR · one buyer company · one PO per invoice.**

Core principle: **READ → FIND → USE → IF MISSING, CREATE → VALIDATE → ASK HUMAN WHEN UNCERTAIN.**
**Never guess. No tolerance. No approval hierarchy. No timeout. No payment execution.**

---

## 1. READ: extraction policy

### 1.1 Units

| Kind | Storage | Example |
|---|---|---|
| Money | integer paise | ₹1,13,870.00 → `11387000` |
| Quantity | integer milli-units | 12.5 kg → `12500` |
| Rate | integer basis points | 18% → `1800` |

Parsing accepts Indian digit grouping (`1,13,870.00`). A money value with more than 2 decimals, or a quantity with more than 3 decimals, is unparseable and becomes `MISSING_DATA`. It is never rounded.

### 1.2 Required fields

Header: `vendorGstin`, `vendorName`, `buyerGstin`, `placeOfSupply`, `invoiceNumber`, `invoiceDate`, `taxablePaise`, `totalPaise`, and the applicable tax heads.
Per line: `description`, `hsnSac`, `qtyMilli`, `uom`, `unitPricePaise`, `taxablePaise`, `gstRateBp`.
`poNumber` is **optional** (its absence is handled by the PO rules in §3.4). `roundOffPaise` is optional.

### 1.3 Confidence

- A field is **usable** when `source ∈ {human_confirmed, human_corrected, derived_from_erp_choice, derived_from_document_evidence}`, or when `source = extracted` and `confidence ≥ extraction_confidence_min_bp` (default 0.90) and the value passes its format parser.
- A required field that is not usable raises **`MD_FIELD`** (MISSING_DATA). The system does not fill it from elsewhere, including the ERP.
- Exception: an unusable `header.vendorGstin` is handled by vendor matching V5/V6 (§2.1). If name candidates exist, the stage-1 question is `AM_VENDOR` instead of `MD_FIELD`.
- Human-sourced values are never overwritten by re-extraction.

### 1.4 Parsers (deterministic, India locale)

| Field | Rule |
|---|---|
| Dates | Accept `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `DD-Mon-YYYY`, `YYYY-MM-DD`. Day-first is the India locale rule, applied uniformly. **Two-digit years are unparseable.** |
| GSTIN | 15 chars `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`, valid state code, valid mod-36 checksum. |
| PAN | GSTIN characters 3–12. |
| Place of supply | State name or 2-digit code, mapped through the GST state table. Unknown → unparseable. Resolved by the hierarchy in §1.6. |
| HSN/SAC | 4, 6 or 8 digits. |
| UOM | Mapped through a fixed synonym table (`KG,KGS,KILOGRAM→KGS`, `NOS,NO,NUMBERS→NOS`, `PCS,PIECES→PCS`, `REAM,REAMS→REAM`, `BOX,BOXES→BOX`, …). Unknown → unparseable. `NOS` and `PCS` are **distinct**. |
| Invoice number | Normalised for comparison: Unicode NFKC, uppercase, remove all whitespace. Nothing else changes (leading zeros, `/`, `-` are kept). |
| Financial year | From invoice date: 1 Apr – 31 Mar, e.g. `2026-27`. |

### 1.5 Name normalisation

Name normalisation is used **only to build candidate lists**, never to auto-link. Steps: NFKC, lowercase, `&` → space, strip `. , ( ) ' " - /`, collapse whitespace, drop the tokens `m s ms pvt private ltd limited llp co company and the`.


### 1.6 Place of supply (decision D3)

The steps are applied in order, and the first one that yields a result wins:

1. **Printed.** The invoice has an explicit "Place of Supply" field that is usable → use it (`source = extracted`).
   If a place of supply is printed but is not usable (low confidence, or it names no known state, or its name and code disagree), it is still "printed", so step 2 does not apply: go to step 3.
2. **Established from GST evidence on the document.** This applies only when the invoice prints a **ship-to / consignee block** that carries a usable state (a state code, or a GSTIN whose checksum passes). The value is derived deterministically as `derived_from_document_evidence`, and the evidence is recorded.
   - If several pieces of evidence disagree, or the evidence is unusable, go to step 3.
3. **Ask.** Raise `MD_FIELD` for `header.placeOfSupply`.

Never used as evidence: the **buyer (bill-to) GSTIN on its own**, the tax heads charged (that would be circular with R08), or any ERP default.

---

## 2. FIND → USE: matching

Every FIND result is `found` (exactly one), `not_found` or `ambiguous` (more than one). **Only `found` is ever used automatically.** Lookups see ERP data plus this invoice's own staged creations (the overlay).

### 2.1 Vendor

| Step | Condition | Result |
|---|---|---|
| V1 | `vendorGstin` usable and an ERP vendor has that GSTIN | **found**. GSTIN is authoritative; a differing trade name is not a failure. |
| V2 | `vendorGstin` usable, no GSTIN match, but ERP vendors share the **PAN** | `AM_VENDOR_PAN`: link to one of them, or approve a new vendor (a new GST registration of the same entity) |
| V3 | `vendorGstin` usable, no GSTIN/PAN match, but normalised-name candidates exist | `AM_VENDOR`: pick one or "none, it's a new vendor" |
| V4 | `vendorGstin` usable, no match of any kind | Go to creation policy §3.1 |
| V5 | `vendorGstin` **not** usable and name candidates exist (even exactly one) | `AM_VENDOR`: pick the vendor (the GSTIN field is then set from the chosen vendor, `source = derived_from_erp_choice`) |
| V6 | `vendorGstin` not usable and no candidates | `MD_FIELD` for `header.vendorGstin` |

### 2.2 Purchase order

| Step | Condition | Result |
|---|---|---|
| P1 | `poNumber` usable and exists in the ERP | **found** (then R18/R19 check vendor and status) |
| P2 | `poNumber` usable but **not in the ERP** | Rule `R17` fails → `VF_R17`. **A PO is never created with that number or to fill that gap.** |
| P3 | No `poNumber`; vendor resolved; vendor has **open** POs | `AM_OPEN_PO`: pick one of the open POs, or "this is a non-PO purchase". The PO is never auto-created while open POs exist. |
| P4 | No `poNumber`; vendor has no open POs | Go to PO creation policy §3.4 |

An **open PO** has `status = open` and at least one line with uninvoiced quantity.

### 2.3 Items and PO lines (per invoice line)

| Step | Condition | Result |
|---|---|---|
| I1 | Vendor alias `(vendor, vendorItemCode)` exists | item **found** |
| I2 | PO resolved and **exactly one** PO line has an item whose HSN equals the line's HSN | PO line + item **found**. If `vendorItemCode` is present and unaliased → stage alias (§3.3). |
| I3 | PO resolved and **more than one** PO line matches the HSN | `AM_PO_LINE`: pick the PO line |
| I4 | PO resolved and **no** PO line matches | Rule `R20` fails → `VF_R20` (the line is not on the PO) |
| I5 | No PO yet (PO-less path): exactly one item with the same normalised name **and** HSN | item **found** |
| I6 | No PO yet: candidates by HSN only | `AM_ITEM`: pick one, or "new item" → `CA_ITEM` |
| I7 | No PO yet: no candidates | `CA_ITEM` |

Price is **never** used to find a PO line. Price is what gets validated, so using it to match would be circular.

### 2.4 GRN

GRNs are looked up for the resolved PO. Coverage per PO line = Σ `accepted_qty` over all GRNs of that line. A PO with **no GRN at all** raises `CA_GRN` (§3.5). **A GRN is never inferred from the invoice.**

---

## 3. IF MISSING, CREATE: creation policy

All creations are **staged** and reach the ERP only at commit, after every rule passes (ARCHITECTURE §4.3). Every staged record carries `policy_code`, `trigger` (`auto_policy` | `user_approval`), `source_invoice_id` and, for approvals, `approved_by_user_id`.

| Entity | Auto-create allowed? | Policy code |
|---|---|---|
| Vendor | Yes, under strict conditions | `CP_VENDOR_AUTO` / `CP_VENDOR_APPROVED` |
| Item master | **No**, always approval | `CP_ITEM_APPROVED` |
| Vendor-item alias | Yes, when the PO line is unique | `CP_ALIAS_UNIQUE_PO_LINE` |
| Purchase order | Yes, only below the configured threshold | `CP_PO_BELOW_THRESHOLD` / `CP_PO_APPROVED` |
| GRN | **Never**, only explicit user confirmation | `CP_GRN_USER_CONFIRMED` |
| Vendor reactivation | **No**, only a business decision | `CP_VENDOR_REACTIVATED` |

### 3.1 Vendor

Auto-stage (`CP_VENDOR_AUTO`) only if **all** hold:
1. `vendorGstin` is usable and passes R03 (format, state code, checksum).
2. No ERP vendor has that GSTIN, that PAN, or the same normalised name (V4).
3. `vendorName` and `vendorAddress` are usable.

The vendor state code is taken from GSTIN characters 1–2, which is a legal fact, not an inference. If condition 3 fails, the question is `MD_FIELD`. `CA_VENDOR` is raised only when the user chose "new vendor" in `AM_VENDOR` / `AM_VENDOR_PAN`.

### 3.2 Item master

Always `CA_ITEM`. The approval form shows name (from the invoice description, editable), HSN, UOM and GST rate from the invoice line; all are required, and the item code is generated. The staged item is used for this invoice only after approval.

### 3.3 Vendor-item alias

Auto-stage when step I2 matched a single PO line and the line has a `vendorItemCode` with no existing alias.

### 3.4 Purchase order (configurable policy)

A PO is **not** created simply because one is missing. Evaluated only in case P4 (no PO number on the invoice and the vendor has no open PO). All **prerequisites** must hold first:

1. Vendor resolved (existing and active, or staged).
2. Every line resolved to an item (existing or approved).
3. Invoice-intrinsic rules R01–R11 and master-data rules R12–R16 all **pass**.

While a prerequisite is unresolved, **no PO question is raised**. The approval is never asked on data that is still uncertain.

Then:

| Condition | Outcome |
|---|---|
| `po_auto_create_enabled = true` **and** invoice `totalPaise` (grand total incl. GST) **<** `po_auto_create_below_paise` | Stage PO, origin **`auto_created_from_invoice`** (`CP_PO_BELOW_THRESHOLD`) |
| otherwise (disabled, or total **≥** threshold, **equal counts as above**) | `CA_PO`: approve PO creation from the invoice, or enter an existing PO number, or reject |
| user approves `CA_PO` | Stage PO, origin **`created_from_invoice_on_approval`** (`CP_PO_APPROVED`) |

**Content of a PO created from an invoice.** It uses the vendor, PO date = invoice date, and exactly the invoice lines (item, qty, unit price, GST rate). The PO number is assigned by the ERP at commit as `AUTO/<FY>/<seq>`.

**Anti-fabrication guarantees:**
- Never created when the invoice cites a PO number (P2), or when the vendor has open POs (P3).
- Never reuses a number printed on the invoice. Never edits an existing PO.
- For a PO derived from the invoice, the invoice-vs-PO comparison rules (R21–R24) are recorded as **`not_applicable`** with reason **`PO_DERIVED_FROM_INVOICE`**, **never as `pass`**. The Checks tab shows this plainly.
- The remaining independent controls are the threshold (or the user's approval) and a **user-confirmed GRN**, which is always required.

### 3.5 GRN

- Never automatically inferred or created.
- If the resolved PO has no GRN → `CA_GRN`. If GRNs exist but coverage is short → `VF_R26`, which includes an option to record an additional receipt (this opens the same `CA_GRN` form).
- The `CA_GRN` form requires the GRN date (≤ today, ≥ PO date) and, per PO line, `received_qty` and `accepted_qty` (`accepted ≤ received`). The UI may offer a "fill with invoiced quantities" button, but the user must still submit the values explicitly. The API only accepts explicit values.
- Staged GRN origin: `user_confirmed_via_veyra`, with `confirmed_by_user_id`.

### 3.6 Vendor reactivation

An inactive vendor raises `BD_VENDOR_INACTIVE`. Only the explicit option "Reactivate vendor" stages a reactivation (`CP_VENDOR_REACTIVATED`).

---

## 4. VALIDATE: rules

Every rule is a pure function `(context) → pass | fail | not_applicable(reason) | not_evaluated`, and every rule runs on every pass.

- `not_evaluated` means a prerequisite is unresolved and already has its own question.
- `fail` raises `VF_<code>`, except where noted.

**Question gating (stage order).** Stages are: 1 intrinsic, 2 vendor (R12, R13), 3 PO and items (R14–R24, R27), 4 GRN (R25, R26). Questions for stage *N* are raised only when stages before *N* have no open questions. Until then, rules of later stages are `not_evaluated`. The user therefore sees the earliest problem first and is never asked to approve, for example, a PO for an invoice whose arithmetic is wrong.

**Auto-verify condition:** every rule is `pass` or `not_applicable` with an **allowed reason**, there are zero open questions, and every staged creation requiring approval has been approved. The transition to `COMMITTING` then happens **automatically**. There is no human verify step.

Safety net: if no question is open but some rule is `fail` / `not_evaluated`, the invoice goes to `FAILED` with `INVARIANT_VIOLATION`. It never silently passes and never gets stuck.

### 4.1 Arithmetic

`round_half_up(x)` to the nearest paisa, computed on integers only.

- Line taxable = `round_half_up(qty_milli × unit_price_paise / 1000)`
- Intra-state: `cgst = sgst = round_half_up(taxable × (rate_bp / 2) / 10000)`
- Inter-state: `igst = round_half_up(taxable × rate_bp / 10000)`
- **Tax method.** If *every* line shows its tax amounts, tax is checked **per line** and header tax heads must equal the line sums. If *no* line shows tax amounts, tax is checked **per rate group** (`round_half_up(Σ taxable in group × rate)`). A mix of both is unparseable and raises `MD_FIELD`.
- **Round-off.** `pre = taxable + cgst + sgst + igst`. If a round-off line is printed, it must equal exactly `round_to_rupee_half_up(pre) − pre` (a value in −49…+50 paise), and `total = pre + round_off`. If none is printed, `total = pre` exactly. Any other difference fails R09/R10 and is **never silently absorbed**. The UI always displays *calculated total → round-off → invoice total* (decision D2).

### 4.2 Rule catalogue

| Code | Stage | Rule (exact) | Allowed `not_applicable` reasons |
|---|---|---|---|
| R01 `REQUIRED_FIELDS` | intrinsic | All required fields usable (§1.2) | — |
| R02 `LINES_PRESENT` | intrinsic | ≥ 1 line; no line with all-null fields | — |
| R03 `GSTIN_VALID` | intrinsic | Vendor and buyer GSTIN pass format + state code + checksum | — |
| R04 `BUYER_IS_COMPANY` | intrinsic | Buyer GSTIN = company GSTIN | — |
| R05 `INVOICE_DATE_VALID` | intrinsic | Parsed date ≤ today (Asia/Kolkata) | — |
| R06 `LINE_AMOUNT` | intrinsic | Stated line taxable = computed (§4.1) | — |
| R07 `TAX_AMOUNT` | intrinsic | For each tax head the invoice actually charges, stated tax (per line or per rate group) = computed. Whether the right heads were charged is R08's job. | — |
| R08 `TAX_TYPE` | intrinsic | Vendor state = place of supply ⇒ IGST = 0 and CGST = SGST; otherwise CGST = SGST = 0 | — |
| R09 `HEADER_TOTALS` | intrinsic | Header taxable = Σ lines; each tax head = Σ (or group sum); total per §4.1 | — |
| R10 `ROUND_OFF` | intrinsic | Round-off per §4.1 | `NO_ROUND_OFF_LINE` |
| R11 `NOT_DUPLICATE` | intrinsic | No ERP purchase invoice and no other non-REJECTED Veyra invoice with the same (vendor GSTIN, normalised invoice no, FY). Re-checked at commit. | — |
| R12 `VENDOR_RESOLVED` | master | Vendor found or staged | — |
| R13 `VENDOR_ACTIVE` | master | Vendor status active (or reactivation staged). Fail → **`BD_VENDOR_INACTIVE`** (not VF) | — |
| R14 `ITEMS_RESOLVED` | master | Every line has an item (found / staged-approved) | — |
| R15 `HSN_MATCH` | master | Line HSN = item HSN | — |
| R16 `ITEM_GST_RATE` | master | Line GST rate = item master rate | — |
| R17 `PO_RESOLVED` | PO | PO found, chosen or staged; a cited PO number exists in the ERP | — |
| R18 `PO_VENDOR` | PO | PO vendor = invoice vendor | — |
| R19 `PO_OPEN` | PO | PO status open. Fail → **`BD_PO_CLOSED`** (not VF) | — |
| R20 `LINE_ON_PO` | PO | Every line mapped to exactly one PO line with the same item; no PO line used twice | — |
| R21 `PO_PRICE` | PO | Line unit price = PO line unit price | `PO_DERIVED_FROM_INVOICE` |
| R22 `PO_GST_RATE` | PO | Line GST rate = PO line GST rate | `PO_DERIVED_FROM_INVOICE` |
| R23 `PO_QTY_REMAINING` | PO | Line qty ≤ PO line qty − qty already invoiced in the ERP. Re-checked at commit. | `PO_DERIVED_FROM_INVOICE` |
| R24 `DATE_NOT_BEFORE_PO` | PO | Invoice date ≥ PO date | `PO_DERIVED_FROM_INVOICE` |
| R25 `GRN_EXISTS` | GRN | ≥ 1 GRN (ERP or staged user-confirmed) for the PO. Missing → **`CA_GRN`** (not VF) | — |
| R26 `GRN_QTY_COVERS` | GRN | Line qty ≤ Σ accepted qty − qty already invoiced in the ERP. Re-checked at commit. | — |
| R27 `UOM_MATCH` | master | Line UOM = item UOM (no conversion in V1) | — |

There is no warning level, no tolerance, and no override. A failing rule is resolved only by correcting a misread value, fixing the data in the ERP and re-checking, or rejecting the invoice.

---

## 5. ASK HUMAN: question catalogue

All questions go to the single designated user. They never time out and never escalate. `subject_key` makes each question idempotent across re-runs.

| Code | Kind | Subject | Options → deterministic effect |
|---|---|---|---|
| `MD_FIELD` | MISSING_DATA | field path | Confirm shown value → `CONFIRM_FIELD` · Enter value → `SET_FIELD` · Reject → `REJECT_INVOICE` |
| `AM_VENDOR` | AMBIGUOUS_MATCH | `vendor` | Pick candidate → `LINK_ERP_RECORD` (+ GSTIN `derived_from_erp_choice` if it was unreadable) · New vendor → raises `CA_VENDOR` · Reject |
| `AM_VENDOR_PAN` | AMBIGUOUS_MATCH | `vendor` | Link existing (same PAN) → `LINK_ERP_RECORD` · New registration → `CA_VENDOR` · Reject |
| `AM_OPEN_PO` | AMBIGUOUS_MATCH | `po` | Pick open PO → `LINK_ERP_RECORD` · Non-PO purchase → continue to §3.4 · Reject |
| `AM_PO_LINE` | AMBIGUOUS_MATCH | `line:<n>` | Pick PO line → `LINK_ERP_RECORD` · Reject |
| `AM_ITEM` | AMBIGUOUS_MATCH | `line:<n>` | Pick item → `LINK_ERP_RECORD` · New item → `CA_ITEM` · Reject |
| `BD_VENDOR_INACTIVE` | BUSINESS_DECISION | `vendor` | Reactivate vendor → `APPROVE_CREATION(vendor_reactivation)` · Reject |
| `BD_PO_CLOSED` | BUSINESS_DECISION | `po` | "Reopened in ERP, re-check" → `RECHECK` · Reject |
| `VF_<Rxx>` | VALIDATION_FAILURE | rule + line | Correct a misread field (only the fields that rule depends on) → `SET_FIELD` · "Fixed in ERP, re-check" → `RECHECK` · Reject. **No override.** `VF_R26` also offers "Record additional receipt" → `CA_GRN` |
| `CA_VENDOR` | CREATION_APPROVAL | `vendor` | Approve (shows name, GSTIN, PAN, state, address) → `APPROVE_CREATION` · Decline → Reject |
| `CA_ITEM` | CREATION_APPROVAL | `line:<n>` | Approve with required inputs → `APPROVE_CREATION` · Decline → Reject |
| `CA_PO` | CREATION_APPROVAL | `po` | Approve PO from invoice lines → `APPROVE_CREATION` · Enter existing PO number → `SET_FIELD(header.poNumber)` · Reject |
| `CA_GRN` | CREATION_APPROVAL | `grn:<po>` | Confirm receipt with required inputs (§3.5) → `APPROVE_CREATION` · "Goods not received" → Reject |

Answer handling:
1. The answer is validated against `input_schema_json`.
2. The effect is persisted as data.
3. An audit event is written.
4. The invoice goes `NEEDS_INPUT → MATCHING` for a full deterministic re-run.

Rejecting discards all staged creations.
