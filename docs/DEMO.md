# Veyra — Demo Data & Scenarios (V1)

Status: **Approved (rev 3)**. The numbers in this file were verified with a script: integer paise, GST half-up to the paisa. They become the fixture `*.expected.json` files and the API integration tests (Phase 10).

- Run everything with `npm run demo`, which resets both DBs, seeds them, generates fixtures and starts the API and web app.
- Demo mode uses the **FixtureExtractor** (`VEYRA_ALLOW_FIXTURE_EXTRACTOR=true`) so results are reproducible.
- The same PDFs can also be run through **LocalOcrExtractor**, the real default, to show honest OCR behaviour.
- "Today" in the demo is fixed at **2026-09-28** (FY 2026-27). Every scenario assumes a fresh `reset-demo` unless stated.

## 1. Seed data

### 1.1 Veyra

| Setting | Value |
|---|---|
| User | `usr_demo`, "Demo Approver", `approver@veyra.local`, the **designated user** |
| `extractor_mode` | `fixture` (demo) |
| `extraction_confidence_min_bp` | `9000` |
| `po_auto_create_enabled` | `true` |
| `po_auto_create_below_paise` | `2500000` (**₹25,000.00**, compared with the grand total incl. GST, strictly below) |

### 1.2 Fake ERP: company

| Name | GSTIN | State |
|---|---|---|
| Veyra Demo Industries Pvt Ltd, Bengaluru | `29AAACS1111A1Z6` | 29 Karnataka |

### 1.3 Fake ERP: vendors

All GSTINs below pass the mod-36 checksum.

| Code | Name | GSTIN | State | Status |
|---|---|---|---|---|
| V001 | Shakti Steel Suppliers Pvt Ltd | `29AAFCS5678K1ZK` | 29 KA (intra) | active |
| V002 | Apex Components Pvt Ltd | `27AAACA4321M1ZT` | 27 MH (inter) | active |
| V003 | Bharat Packaging | `29ABCPB2468Q1Z9` | 29 KA | **inactive** |
| V004 | Kaveri Tools & Hardware Pvt Ltd | `33AAHCK1357R1Z3` | 33 TN (inter) | active |
| V005 | Vasudha Traders | `29AAACV1234F1ZL` | 29 KA | active |
| V006 | Vasudha Traders & Co | `29AAJFV2222B1ZG` | 29 KA | active |
| V007 | Eastline Office Supplies Pvt Ltd | `29AAKCE3344D1ZP` | 29 KA | active (no POs) |

Not in the ERP (these appear only on invoices): **Nandi Stationers Pvt Ltd** `29AADCN9753P1ZH` (valid) and **Meridian Fasteners** `29AAGCM4455J1Z5` (**invalid checksum**; the correct check character would be `2`).

V005 and V006 normalise to the same name (`vasudha traders`). This is intentional, for the ambiguity scenario.

### 1.4 Fake ERP: items

| Code | Name | HSN | UOM | GST |
|---|---|---|---|---|
| ITM-001 | MS Steel Rod 12mm | 7214 | KGS | 18% |
| ITM-002 | MS Steel Plate 6mm | 7208 | KGS | 18% |
| ITM-003 | Ball Bearing 6204 ZZ | 8482 | NOS | 18% |
| ITM-004 | Corrugated Box 5 Ply | 4819 | NOS | 12% |
| ITM-005 | A4 Copier Paper 75 GSM | 4802 | REAM | 12% |
| ITM-006 | Cutting Disc 4 inch | 6804 | NOS | 18% |
| ITM-007 | Printer Toner Cartridge 88A | 8443 | NOS | 18% |

No items exist with HSN 9608 (markers) or 7318 (fasteners). There are no vendor-item aliases for Apex.

### 1.5 Fake ERP: purchase orders and GRNs (all dated 2026, status open unless noted)

| PO | Vendor | Date | Line: item × qty @ price | GRN (accepted) |
|---|---|---|---|---|
| PO-2026-0099 | V001 Shakti | 05-Aug | ITM-001 × 100 KGS @ ₹62.50 | GRN-2026-0199 (100). **PO closed** |
| PO-2026-0101 | V001 Shakti | 01-Sep | ITM-001 × 1000 KGS @ ₹62.50; ITM-002 × 500 KGS @ ₹68.00 | GRN-2026-0201 (1000; 500) |
| PO-2026-0102 | V001 Shakti | 02-Sep | ITM-001 × 200 KGS @ ₹62.50 | GRN-2026-0202 (**180**) |
| PO-2026-0103 | V002 Apex | 03-Sep | ITM-003 × 100 NOS @ ₹145.00 | GRN-2026-0203 (100) |
| PO-2026-0104 | V002 Apex | 04-Sep | ITM-003 × 50 NOS @ ₹145.00 | **none** |
| PO-2026-0105 | V004 Kaveri | 05-Sep | ITM-006 × 200 NOS @ ₹38.00 | GRN-2026-0204 (200) |
| PO-2026-0106 | V004 Kaveri | 06-Sep | ITM-006 × 100 NOS @ ₹38.00 | GRN-2026-0205 (100) |
| PO-2026-0107 | V003 Bharat | 07-Sep | ITM-004 × 500 NOS @ ₹24.00 | GRN-2026-0206 (500) |
| PO-2026-0108 | V005 Vasudha Traders | 08-Sep | ITM-007 × 10 NOS @ ₹2,450.00 | GRN-2026-0207 (10) |
| PO-2026-0109 | V001 Shakti | 09-Sep | ITM-002 × 100 KGS @ ₹68.00 | GRN-2026-0208 (100) |
| PO-2026-0110 | V001 Shakti | 10-Sep | ITM-001 × 100 KGS @ ₹62.50 | GRN-2026-0209 (100) |
| PO-2026-0111 | V002 Apex | 11-Sep | ITM-003 × 20 NOS @ ₹145.00 | GRN-2026-0210 (20) |
| PO-2026-0112 | V001 Shakti | 12-Sep | ITM-002 × 200 KGS @ ₹68.00 | GRN-2026-0211 (200) |

No purchase invoices and no vendor-item aliases are seeded. The duplicate scenario (S11b) relies on S01 being recorded first.

DEMO.md gives one GRN figure per line and no GRN dates or vendor addresses. The seed therefore sets:
- received quantity = accepted quantity
- GRN date = PO date
- vendor address = the vendor's state name
- PO line GST rate = the item master rate

`npm run erp:reset` loads this seed. `packages/fake-erp/src/demo-seed.test.ts` verifies every row above through `ErpConnector`.

## 2. Scenarios

Buyer GSTIN and place of supply are Karnataka (29) on every invoice unless stated. The "Questions" column lists them in the order they are raised, which follows the stage gating in RULES §4.

| # | Invoice | Amounts (taxable / tax / total) | Questions → answer | Final state | Demonstrates |
|---|---|---|---|---|---|
| **S01** | Shakti `SSS/26-27/0451`, 15-Sep, PO-2026-0101, rod 1000 KGS @ 62.50 + plate 500 KGS @ 68.00 | 96,500.00 / CGST 8,685.00 + SGST 8,685.00 / **1,13,870.00** | none | **VERIFIED_PENDING_PAYMENT** (automatic) | Happy path, no human involvement |
| **S02** | Apex `APX-7781`, 16-Sep, PO-2026-0103, line code `BRG-6204ZZ`, HSN 8482, 100 NOS @ 145.00 | 14,500.00 / IGST 2,610.00 / **17,110.00** | none | **VERIFIED** | Inter-state IGST; alias `BRG-6204ZZ → ITM-003` auto-created (`CP_ALIAS_UNIQUE_PO_LINE`) |
| **S03** | **Nandi Stationers** (new) `NS-0092`, 17-Sep, no PO, "A4 Copier Paper 75 GSM", 4802, 40 REAM @ 245.00 | 9,800.00 / 588.00 + 588.00 / **10,976.00** | `CA_GRN` → receipt 40/40 on 17-Sep | **VERIFIED** | Vendor auto-created (`CP_VENDOR_AUTO`), item found by name+HSN, **PO auto-created (below ₹25k), tagged `auto_created_from_invoice`**; R21–R24 shown as N/A `PO_DERIVED_FROM_INVOICE`; GRN only by explicit confirmation |
| **S04** | Eastline `EOS/1204`, 18-Sep, no PO, "Printer Toner Cartridge 88A", 8443, 12 NOS @ 2,450.00 | 29,400.00 / 2,646.00 + 2,646.00 / **34,692.00** | `CA_PO` → approve; `CA_GRN` → 12/12 | **VERIFIED** | Total ≥ threshold → **question, not auto-create**; PO origin `created_from_invoice_on_approval` |
| **S05** | Eastline `EOS/1210`, 19-Sep, no PO, "Whiteboard Marker Box of 10", HSN 9608, 30 BOX @ 180.00 | 5,400.00 / 486.00 + 486.00 / **6,372.00** | `CA_ITEM` → approve (BOX, 18%); `CA_GRN` → 30/30 | **VERIFIED** | Item master always needs approval; the PO question is deferred until the item resolves, then the PO is auto-created |
| **S06** | Shakti `SSS/26-27/0460`, 20-Sep, cites **PO-2026-0199** (not in ERP), rod 50 KGS @ 62.50, round-off +0.50 | 3,125.00 / 281.25 + 281.25 / round-off 0.50 / **3,688.00** | `VF_R17` → reject | **REJECTED** | **No PO fabricated** for a cited-but-missing number; R10 round-off passes |
| **S07** | Kaveri `KTH-3310`, 20-Sep, **no PO ref**, cutting disc 100 NOS @ 38.00 | 3,800.00 / IGST 684.00 / **4,484.00** | `AM_OPEN_PO` (0105, 0106) → pick PO-2026-0106 | **VERIFIED** | Below threshold but vendor has open POs, so **no auto PO**; ambiguity is asked, not guessed |
| **S08a** | Apex `APX-7790`, 21-Sep, PO-2026-0104, 50 NOS @ 145.00 | 7,250.00 / IGST 1,305.00 / **8,555.00** | `CA_GRN` → 50/50 on 20-Sep | **VERIFIED** | Missing GRN → question; GRN created only on confirmation (`user_confirmed_via_veyra`) |
| **S08b** | same as S08a (after reset) | same | `CA_GRN` → received 50, accepted **40**; `VF_R26` → reject | **REJECTED** | A confirmed GRN still has to cover the invoice; the staged GRN is discarded on reject |
| **S09** | Shakti `SSS/26-27/0466`, 22-Sep, PO-2026-0109, plate 100 KGS @ **68.01** | 6,801.00 / 612.09 + 612.09 / **8,025.18** | `VF_R21` (expected 6800 paise, actual 6801) → reject | **REJECTED** | **Zero tolerance**: 1 paisa blocks; no override option exists |
| **S10** | Shakti `SSS/26-27/0470`, 22-Sep, PO-2026-0102, rod **200** KGS @ 62.50 | 12,500.00 / 1,125.00 + 1,125.00 / **14,750.00** | `VF_R26` (200 > 180 accepted) → "Record additional receipt" → `CA_GRN` 20/20 | **VERIFIED** | Quantity control; additional GRN only by explicit confirmation |
| **S11a** | Re-upload the identical S01 file | — | — | HTTP **409** at upload | File-hash duplicate |
| **S11b** | Phone photo of S01 (after S01 verified) | same as S01 | `VF_R11` → reject | **REJECTED** | Business duplicate (vendor GSTIN + normalised invoice no + FY) |
| **S12** | Shakti `SSS/26-27/0475`, 23-Sep, PO-2026-0110, rod 100 KGS @ 62.50, printed CGST **563.00**, SGST **563.00** | 6,250.00 / 563.00 + 563.00 / **7,376.00** (correct: 562.50 each, 7,375.00) | `VF_R07` → reject | **REJECTED** | Tax arithmetic exact to the paisa |
| **S13** | Apex `APX-7795`, 23-Sep, PO-2026-0111, 20 NOS @ 145.00, charged **CGST+SGST** from MH | 2,900.00 / 261.00 + 261.00 / **3,422.00** | `VF_R08` → reject | **REJECTED** | Inter-state must be IGST |
| **S14** | **Blurry photo**, Shakti `SSS/26-27/0480`, 24-Sep, PO-2026-0112, plate 200 KGS @ 68.00; total read at confidence 0.41 | 13,600.00 / 1,224.00 + 1,224.00 / **16,048.00** | `MD_FIELD header.totalPaise` → user enters 16,048.00 | **VERIFIED** | Low confidence → ask; human value marked `human_corrected`; full re-validation |
| **S15** | Meridian Fasteners `MF-221`, 24-Sep, GSTIN `29AAGCM4455J1Z5`, no PO, hex bolt HSN 7318, 500 NOS @ 4.20 | 2,100.00 / 189.00 + 189.00 / **2,478.00** | `VF_R03` → reject | **REJECTED** | Invalid GSTIN: **no vendor creation**, no later-stage questions (gating) |
| **S16** | Bharat Packaging `BP-118`, 25-Sep, PO-2026-0107, box 500 NOS @ 24.00 | 12,000.00 / 720.00 + 720.00 / **13,440.00** | `BD_VENDOR_INACTIVE` → "Reactivate vendor" | **VERIFIED** | Business decision; reactivation committed with the invoice |
| **S17** | **Photo**, "VASUDHA TRADERS" `VT-5520`, 25-Sep, PO-2026-0108; GSTIN unreadable (0.35); toner 10 NOS @ 2,450.00 | 24,500.00 / 2,205.00 + 2,205.00 / **28,910.00** | `AM_VENDOR` (V005, V006) → pick V005 | **VERIFIED** | Name-only candidates are never auto-linked. (Picking V006 instead fails `VF_R18`.) |
| **S18** | Shakti `SSS/26-27/0490`, 26-Sep, cites **PO-2026-0099 (closed)**, rod 10 KGS @ 62.50, round-off +0.50 | 625.00 / 56.25 + 56.25 / 0.50 / **738.00** | `BD_PO_CLOSED` → reject | **REJECTED** | Closed PO → business decision |

| **S19** | Apex `APX-7799`, 26-Sep, PO-2026-0111, ball bearing 20 **PCS** @ 145.00 | 2,900.00 / IGST 522.00 / **3,422.00** | `VF_R27` (PCS ≠ NOS) → "The unit was misread" = NOS | **VERIFIED** | Units must match exactly; NOS and PCS are different; no conversion is invented (added in Phase 3B) |

**Waiting-forever check:** leave any `NEEDS_INPUT` invoice untouched. It stays in `NEEDS_INPUT` and nothing escalates (no timeout).

**No-payment check:** the ERP browser shows verified invoices with status `verified_pending_payment`. No screen or API endpoint pays anything.

## 3. Demo script (≈10 minutes)

1. `npm run demo`, then log in as Demo Approver.
2. Upload **S01**. It moves UPLOADED → … → VERIFIED automatically. Open Checks: all green.
3. Upload **S03**. Show the new vendor and the auto-PO staged with the `auto_created_from_invoice` tag, and R21–R24 as N/A. Answer the GRN question; the invoice verifies. Show the ERP browser: vendor, PO and GRN, all tagged with their origin.
4. Upload **S04**. It is above the threshold, so a PO approval question appears. Approve, then confirm the GRN.
5. Upload **S07**. The vendor has two open POs, so Veyra asks instead of creating one.
6. Upload **S09**. A 1-paisa difference blocks it; show that there is no override.
7. Upload **S14**. Correct the blurry total; the invoice verifies.
8. Upload **S17**. Resolve the ambiguous vendor.
9. Audit log: every AI read, system decision and human answer is visible.

## 4. Fixture layout (as built in Phase 3B)

```
fixtures/invoices/
  S01-clean.pdf        S02-apex-interstate.pdf   S03-new-vendor.pdf   …
  S11b-S01-photo.png   S14-blurry.png            S17-vasudha-photo.png
  S19-uom-differs.pdf
```

- The scenarios are defined in `packages/extractor/src/fixture/scenarios.ts`: what is printed on each invoice and how well each value can be read (e.g. S14's total at 0.41, S17's GSTIN at 0.35). They contain facts only; the engine decides.
- `npm run fixtures:generate` renders each scenario to a small PDF (real text layer) or PNG "photo". The writers are deterministic, so each file's SHA-256 never changes; a test checks that the committed files match.
- The `FixtureExtractor` recognises an uploaded file by its SHA-256 and returns that scenario's reading. Any other file is refused, and the invoice fails visibly.

## 5. Running the vertical slice

```sh
npm run demo -- --reset      # API on :8787 (fixture extractor, DEMO.md seed) + web on :5173
```

1. Open http://localhost:5173/#/app/inbox and click **Upload invoice**. Choose files from `fixtures/invoices/`.
2. Each invoice shows as *Processing*, then either *Handled* (S01, S02) or *Needs your attention*.
3. Open one from the queue, answer the question (for example S08: **Record the receipt**, date and quantities), and watch it resume, commit and become *Ready* (`VERIFIED_PENDING_PAYMENT`).
4. **ERP** shows the records Veyra wrote, tagged by origin; **Audit** shows every step, Veyra vs You.

"Today" is the real date in Asia/Kolkata. The scenarios are dated September 2026 and the demo assumes it runs on or after 28 Sep 2026 (R05 rejects future-dated invoices).

## 6. Excel business records (Phase 3C)

A business with no ERP connection brings its records in Excel. The demo files in `fixtures/imports/` hold exactly the DEMO.md seed (§1.3–1.5), so every invoice scenario works against imported records as it does against the seed.

```
fixtures/imports/
  templates/                      Vendors.xlsx, Items.xlsx, PurchaseOrders.xlsx, PurchaseOrderLines.xlsx,
                                  GoodsReceipts.xlsx, GoodsReceiptLines.xlsx, Veyra-Master-Data-Import.xlsx
  Demo-1-Vendors.xlsx             7 vendors
  Demo-2-Items.xlsx               7 items
  Demo-3-PurchaseOrders.xlsx      13 purchase orders with their lines
  Demo-4-GoodsReceipts.xlsx       12 goods receipts with their lines
  Demo-Business-Records.xlsx      all of the above in one workbook
  Demo-Vendors.csv                the vendors as CSV
  Demo-Items-With-Errors.xlsx     5 items, 4 with row-level errors (nothing is imported)
```

```sh
npm run demo -- --empty      # starts from a business with only its company record
```

1. **ERP** → *Import business records* (or the **Import and export** tab). The Vendors tab is empty.
2. Upload `Demo-Items-With-Errors.xlsx`: *Fix these and upload again*, with each problem by sheet and row. There is no import button; nothing changed.
3. Upload `Demo-1-Vendors.xlsx`: *Check before importing* → *Import 7 records* → *Import complete*. Repeat with files 2, 3 and 4, in that order (uploading 3 before 1 and 2 fails: its vendors and items are unknown, and Veyra never creates them).
4. Upload `Demo-1-Vendors.xlsx` again: every row *already exists*; nothing to import.
5. **ERP** shows the records as *Imported by you*. **Audit** → *Business records* shows each upload and import (You) and what was added (Veyra).
6. **Inbox** → upload `S08-missing-grn.pdf`. It matches the imported vendor and PO-2026-0104, which was imported without a receipt, so Veyra asks *Did the goods arrive?* Record the receipt; the invoice becomes *Ready* (`VERIFIED_PENDING_PAYMENT`). `S01-clean.pdf` is *Handled* with no question.
7. **Invoices** / **Audit** → *Export*, or **ERP** → *Import and export* → *Export*: processed invoices, decisions and the audit trail as .xlsx or .csv; business records as .xlsx in the import format.

The same run is an automated test: `apps/api/src/imports/excel-to-invoice.test.ts`.

