# Veyrafy Client Invoice Verification API

ERP partners and other client software send Veyrafy one supplier invoice together with their own
record of what that invoice should say (the **reference**). Veyrafy reads the invoice and returns
a machine-readable verdict: **PASSED**, **FAILED** or **REVIEW_REQUIRED**, with every check made.

The API is **off by default**. It exists only when the server runs with `VEYRA_VERIFY_API=true`;
otherwise every route below answers 404.

## Scope: what a verdict means and does not mean

A verdict compares **the invoice as Veyrafy read it** with **the reference you sent**, and checks
the invoice's own arithmetic and the format of the supplier's GSTIN. Nothing else.

It does **not**:
- match the invoice against purchase orders or goods receipts held in Veyrafy;
- look for duplicate invoices;
- establish that the supplier is genuine, or detect fraud;
- establish GST compliance, or that input tax credit is available;
- authorise payment.

Every response carries `"scope": "invoice_vs_reference"` to say so. A PASSED verdict means the
values read on the invoice match your reference; what you do next is your system's decision.

Values are never copied from the reference into the invoice. A value Veyrafy did not read with
certainty is reported as **unverified**, never as matching.

## Authentication

Every request carries an API key:

```
Authorization: Bearer vfy_<prefix>_<secret>
```

- Keys are issued per client by the Veyrafy operator with the CLI (below). A key is shown **once**
  when it is created; Veyrafy stores only its SHA-256 hash.
- A key sees only its own verifications. Another client's verification id answers **404**,
  exactly like an id that does not exist.
- Revoking a key takes effect on the next request.
- Session cookies are never accepted on these routes, and a browser's cross-origin request is
  refused. Call the API from your server, never from a web page, and never put the key in client
  code.
- On a production or staging instance the API answers only over **HTTPS** (`403 HTTPS_REQUIRED`
  otherwise). Behind a reverse proxy this relies on `VEYRA_TRUST_PROXY` being set correctly so the
  forwarded protocol is trusted.
- A suspended Veyrafy account answers `403 ACCOUNT_SUSPENDED`.

### Issuing and revoking keys (operator)

Run on a machine with the instance's `DATABASE_URL` (the CLI does not run migrations):

```sh
npm run api-clients -w @veyra/api -- create --name "Partner name"   # prints the key once
npm run api-clients -w @veyra/api -- list                          # prefixes and status, never keys
npm run api-clients -w @veyra/api -- revoke --id <client id>
```

Creation and revocation are recorded in the audit trail (`api_client.created`,
`api_client.revoked`). Hand the key to the client over a secure channel; if it is lost, revoke it
and issue a new one.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/verify` | Submit an invoice and its reference. Answers `202 Accepted`. |
| `GET` | `/api/v1/verification/{verification_id}` | Read a verification and, once done, its result. |
| `DELETE` | `/api/v1/verification/{verification_id}` | Delete the stored reference and result. |

### `POST /api/v1/verify`

Send the request in either of two ways. Both give the same verification: the same request sent
both ways is recognised as one (see Idempotency).

**1. JSON, with the invoice inside your record (recommended for an ERP export).**
`Content-Type: application/json`. The body is your receipt export, with `reference_id` added
beside `data`, and the invoice file as base64 in the record's `images`:

```json
{
  "reference_id": "PO-7701/INV-501",
  "data": [
    {
      "invoice_info": {
        "grn_id": "9001",
        "grn_no": "501",
        "po_id": "7701",
        "dc_no": "SSS/26-27/0501",
        "grn_date": "28/09/2026",
        "invoice_date": "2026-09-27",
        "invoice_amount": 7375,
        "vendor_name": "Shakti Steel Suppliers Pvt Ltd",
        "vendor_code": "V-1"
      },
      "items": [
        {
          "item_name": "MS Steel Rod 12mm",
          "hsn_sac_code": "7214",
          "uom": "KGS",
          "quantity": "100",
          "basic_rate": "62.50",
          "basic_amount": "6250.00",
          "other_charges": [
            { "code": "GTC0000001", "value": "562.50" },
            { "code": "GTC0000002", "value": "562.50" }
          ]
        }
      ],
      "images": [
        { "file_name": "SSS-0501.pdf", "mime_type": "application/pdf", "base64": "JVBERi0xLjQK…" }
      ]
    }
  ]
}
```

- `data` holds **exactly one** record; `images` holds **exactly one** file: the invoice (PDF, JPEG
  or PNG, at most 20 MB before encoding). A single record sent without the `data` wrapper is
  also accepted.
- The base64 may be plain or URL-safe, may include line breaks, and may start with a data URL
  prefix (`data:application/pdf;base64,`). The file type is decided by its content, not by
  `mime_type` or `file_name`.
- The record itself, without `images`, may be up to 1 MB. The whole body may be up to about 28 MB.

```sh
curl https://<your-veyrafy-host>/api/v1/verify \
  -H "Authorization: Bearer $VEYRAFY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: PO-7701-INV-501-v1" \
  --data-binary @request.json
```

**2. Multipart, with the invoice as a separate file.** `multipart/form-data` with these parts:

| Part | Required | Content |
| --- | --- | --- |
| `invoice` | no | One file: PDF, JPEG or PNG, checked by its content, at most 20 MB. Without it, the invoice is taken from `images` in `reference_json`, as above. When both are sent, this file is used. |
| `reference_json` | yes | Your record as JSON, in the export shape above (without `reference_id`), with **exactly one** record. |
| `reference_id` | yes | Your own identifier for this check. |

```sh
curl https://<your-veyrafy-host>/api/v1/verify \
  -H "Authorization: Bearer $VEYRAFY_API_KEY" \
  -H "Idempotency-Key: PO-7701-INV-501-v1" \
  -F "reference_id=PO-7701/INV-501" \
  -F "reference_json=<reference.json" \
  -F "invoice=@invoice.pdf"
```

Any other part, a second file, or a file under another name is refused with `400 INVALID_REQUEST`.

**For both:**

- `reference_id`: your own identifier for this check, 1–128 characters from
  `A–Z a–z 0–9 . _ : / -`. Returned unchanged.
- Header `Idempotency-Key` (optional, recommended): 1–128 characters from `A–Z a–z 0–9 . _ : -`.
- `dc_no` is compared with the invoice number printed on the invoice; `invoice_amount` with its
  total. All values in this document are made up.
- The invoice file is read and then deleted. `images` is never stored with your record.

**Answer: `202 Accepted`**, with `Location: /api/v1/verification/{verification_id}` and
`Cache-Control: no-store`. The invoice is read in the background.

```json
{
  "verification_id": "01M59MWQH18FRFF68301RCBPXX",
  "reference_id": "PO-7701/INV-501",
  "processing_status": "processing",
  "status": null,
  "review_required": null,
  "scope": "invoice_vs_reference",
  "checks": [],
  "failed_fields": [],
  "unverified_fields": [],
  "error": null,
  "created_at": "2026-09-28T06:30:00.000Z",
  "completed_at": null
}
```

### `GET /api/v1/verification/{verification_id}`

Returns the same object. While `processing_status` is `processing` the answer carries
`Retry-After: 2`; poll no faster than that. A verification usually completes within seconds;
scanned documents read by OCR take longer.

**`processing_status`**

| Value | Meaning | `status` |
| --- | --- | --- |
| `processing` | Accepted, not yet read. | `null` |
| `completed` | Read and compared. | `PASSED`, `FAILED` or `REVIEW_REQUIRED` |
| `error` | Could not be processed. See `error`. | `null` |
| `deleted` | Deleted by the client. | `null` |

**A processing error is never a verdict.** When the document cannot be processed, `status` stays
`null` and `error` says why. Do not treat it as FAILED: nothing was compared.

**`status`** (only when `processing_status` is `completed`)

| Value | Meaning |
| --- | --- |
| `PASSED` | Every check that could be made passed, and the supplier name, the invoice number and the invoice total were each read with certainty and matched. Never returned while any check is unverified or failed. |
| `FAILED` | At least one value read on the invoice differs from the reference, or an item is on only one side. See `failed_fields`. |
| `REVIEW_REQUIRED` | Nothing failed, but at least one value needed could not be read with certainty or compared. See `unverified_fields`. A person should look at the invoice. |

`review_required` is `true` whenever any check is unverified (including on a FAILED result that
also has unverified values).

**How values are compared**

FAILED is only returned for a difference Veyrafy can prove. What it cannot prove is
`unverified`, with the reason, never `failed`:

- **Units.** When the invoice and the reference count an item in different units (for example
  `NOS` packs of 500 g on the invoice and `KGS` in the reference), quantity and rate are not
  compared as numbers. The quantity is `unverified` ("counted in different units") and the
  amount is compared. Spellings of the same unit (`NOS`, `PCS`, `EACH`; `KG`, `KGS`) are treated
  as one.
- **Item names.** The supplier's wording and your item name rarely match word for word. Lines
  are paired by the words their names share, or, when none are shared, by quantity, rate and
  amount (amount alone when the units differ). A paired line whose names differ is `unverified`
  ("confirm it is the same item"). Its quantity, rate and amount are still compared, and a
  difference there is `failed`.
- **`other_charges`.** `GTC0000001`, `GTC0000002` and `GTC0000004` are CGST, SGST and IGST, and
  `FRTWITHGST` is freight. `ASSESSABLE` (and `TAXABLE`) repeat the line's taxable value and are
  never added to the total. Any other code is shown as an unrecognised charge to confirm.
- **Round-off.** `invoice_amount` matches whether you recorded the invoice total or the amount
  before its round-off (₹7,374.60 for a ₹7,375.00 invoice). When the round-off printed on the
  invoice cannot be read, the total is compared rounded to the rupee.
- **The invoice's own arithmetic.** When the invoice's figures as read do not add up (lines,
  tax and total), a difference in those figures may be a misreading. It is `unverified`, not
  `failed`. A supplier name that reads like a registration line ("MSME No: …") is `unverified`
  for the same reason.
- **Scans and photos.** A value is used only when it was read with certainty. A low-confidence
  OCR value counts as read when the invoice itself proves it: a GSTIN by its check character,
  and amounts that agree to the paisa (each line's quantity × rate, the lines' sum, the tax on
  them, and the total).

**Fields**

| Field | Content |
| --- | --- |
| `verification_id` | Veyrafy's id (26-character ULID). |
| `reference_id` | Yours, unchanged. |
| `scope` | Always `invoice_vs_reference` in this version. |
| `checks[]` | Every check made: `id` (stable slug), `section`, `label`, `field` (the invoice field compared, or `null`), `result` (`passed`, `failed`, `unverified`, `not_compared`), `invoice_value`, `reference_value`, `reason`. |
| `failed_fields[]` | One entry per failed check: `field`, `check_id`, `invoice_value`, `reference_value`, `difference` (`{value, unit}`: invoice minus reference, for amounts in `INR` and quantities in their unit; `null` when not numeric), `reason`. |
| `unverified_fields[]` | One entry per unverified check: `field`, `check_id`, `reason`. |
| `error` | `null`, or `{code, message}` when `processing_status` is `error`. |
| `created_at`, `completed_at` | ISO 8601 UTC. |

Values are formatted as read (`₹7,375.00`, `100 KGS`, `27 Sep 2026`). `not_compared` means the
check could not apply (for example, the reference holds no GSTIN); it does not block PASSED.

New checks and fields may be added in later versions. Ignore fields you do not recognise, and key
your logic on `status`, `result` and `field`, not on `label` or `reason` wording.

#### Sample: PASSED (some of the 20 checks shown)

```json
{
  "verification_id": "01M59MX9KGSW6404W4H24C5ARQ",
  "reference_id": "PO-7701/INV-501",
  "processing_status": "completed",
  "status": "PASSED",
  "review_required": false,
  "scope": "invoice_vs_reference",
  "checks": [
    {
      "id": "supplier_name",
      "section": "Supplier",
      "label": "Name",
      "field": "header.vendorName",
      "result": "passed",
      "invoice_value": "Shakti Steel Suppliers Pvt Ltd",
      "reference_value": "Shakti Steel Suppliers Pvt Ltd",
      "reason": null
    },
    {
      "id": "invoice_invoice_number",
      "section": "Invoice",
      "label": "Invoice number",
      "field": "header.invoiceNumber",
      "result": "passed",
      "invoice_value": "SSS/26-27/0501",
      "reference_value": "SSS/26-27/0501",
      "reason": null
    },
    {
      "id": "purchase_order_order",
      "section": "Purchase order",
      "label": "Order",
      "field": null,
      "result": "not_compared",
      "invoice_value": "PO-2026-0110",
      "reference_value": "ERP internal reference 7701",
      "reason": "The reference holds its internal order id, not the order number printed on the invoice, so the two are not compared."
    },
    {
      "id": "line_1_ms_steel_rod_12mm_rate",
      "section": "Line 1 · MS Steel Rod 12mm",
      "label": "Rate",
      "field": "lines[1].unitPricePaise",
      "result": "passed",
      "invoice_value": "₹62.50",
      "reference_value": "₹62.50",
      "reason": null
    },
    {
      "id": "totals_invoice_total",
      "section": "Totals",
      "label": "Invoice total",
      "field": "header.totalPaise",
      "result": "passed",
      "invoice_value": "₹7,375.00",
      "reference_value": "₹7,375.00",
      "reason": null
    }
  ],
  "failed_fields": [],
  "unverified_fields": [],
  "error": null,
  "created_at": "2026-09-28T06:30:00.000Z",
  "completed_at": "2026-09-28T06:30:00.000Z"
}
```

#### Sample: FAILED (a different rate; some checks and failed fields shown)

```json
{
  "verification_id": "01M59MWQH18FRFF68301RCBPXX",
  "reference_id": "PO-7701/INV-501",
  "processing_status": "completed",
  "status": "FAILED",
  "review_required": false,
  "scope": "invoice_vs_reference",
  "checks": [
    {
      "id": "line_1_ms_steel_rod_12mm_rate",
      "section": "Line 1 · MS Steel Rod 12mm",
      "label": "Rate",
      "field": "lines[1].unitPricePaise",
      "result": "failed",
      "invoice_value": "₹62.50",
      "reference_value": "₹60.00",
      "reason": "Rate differs."
    },
    {
      "id": "totals_invoice_total",
      "section": "Totals",
      "label": "Invoice total",
      "field": "header.totalPaise",
      "result": "failed",
      "invoice_value": "₹7,375.00",
      "reference_value": "₹7,080.00",
      "reason": "The invoice total differs from the reference’s total."
    }
  ],
  "failed_fields": [
    {
      "field": "lines[1].unitPricePaise",
      "check_id": "line_1_ms_steel_rod_12mm_rate",
      "invoice_value": "₹62.50",
      "reference_value": "₹60.00",
      "difference": {
        "value": "2.50",
        "unit": "INR"
      },
      "reason": "Rate differs."
    },
    {
      "field": "lines[1].taxablePaise",
      "check_id": "line_1_ms_steel_rod_12mm_amount",
      "invoice_value": "₹6,250.00",
      "reference_value": "₹6,000.00",
      "difference": {
        "value": "250.00",
        "unit": "INR"
      },
      "reason": "Amount differs."
    },
    {
      "field": "header.totalPaise",
      "check_id": "totals_invoice_total",
      "invoice_value": "₹7,375.00",
      "reference_value": "₹7,080.00",
      "difference": {
        "value": "295.00",
        "unit": "INR"
      },
      "reason": "The invoice total differs from the reference’s total."
    }
  ],
  "unverified_fields": [],
  "error": null,
  "created_at": "2026-09-28T06:30:00.000Z",
  "completed_at": "2026-09-28T06:30:00.000Z"
}
```

#### Sample: REVIEW_REQUIRED (the invoice total could not be read with certainty)

```json
{
  "verification_id": "01M59MWQM2FBKA4AYTT3GJ5648",
  "reference_id": "PO-7701/INV-501",
  "processing_status": "completed",
  "status": "REVIEW_REQUIRED",
  "review_required": true,
  "scope": "invoice_vs_reference",
  "checks": [
    {
      "id": "invoice_invoice_number",
      "section": "Invoice",
      "label": "Invoice number",
      "field": "header.invoiceNumber",
      "result": "passed",
      "invoice_value": "SSS/26-27/0515",
      "reference_value": "SSS/26-27/0515",
      "reason": null
    },
    {
      "id": "totals_invoice_total",
      "section": "Totals",
      "label": "Invoice total",
      "field": "header.totalPaise",
      "result": "unverified",
      "invoice_value": null,
      "reference_value": "₹13,275.00",
      "reason": "Not read on the invoice with certainty. Confirm it to compare."
    }
  ],
  "failed_fields": [],
  "unverified_fields": [
    {
      "field": "header.totalPaise",
      "check_id": "totals_invoice_total",
      "reason": "Not read on the invoice with certainty. Confirm it to compare."
    }
  ],
  "error": null,
  "created_at": "2026-09-28T06:30:00.000Z",
  "completed_at": "2026-09-28T06:30:00.000Z"
}
```

#### Sample: processing error (the file holds two invoices)

```json
{
  "verification_id": "01M59MWQNPXDB6BPNG2S5750PC",
  "reference_id": "PO-7701/INV-501",
  "processing_status": "error",
  "status": null,
  "review_required": null,
  "scope": "invoice_vs_reference",
  "checks": [],
  "failed_fields": [],
  "unverified_fields": [],
  "error": {
    "code": "MULTIPLE_INVOICES",
    "message": "The file holds more than one invoice. Submit each invoice on its own."
  },
  "created_at": "2026-09-28T06:30:00.000Z",
  "completed_at": "2026-09-28T06:30:00.000Z"
}
```

Processing error codes: `MULTIPLE_INVOICES`, `DOCUMENT_UNREADABLE` (no text found, even by OCR),
`UNSUPPORTED_DOCUMENT` (unreadable or damaged), `PROCESSING_FAILED` (Veyrafy could not complete
it; submit again later). Temporary failures are retried automatically before `error` is set.

### `DELETE /api/v1/verification/{verification_id}`

Answers `204 No Content`. Removes the stored reference and result (the invoice file itself is
already deleted after reading). The verification remains as a tombstone with
`processing_status: "deleted"` so its id is not reused, and the deletion is audited. A
verification still processing can be deleted; its result is then never stored.

## Idempotency

- **With `Idempotency-Key`:** the same key with the same request returns the existing
  verification with `200 OK` (not a new one). The same key with a different invoice, reference or
  reference id answers `409 IDEMPOTENCY_CONFLICT`. Keys are scoped to your API key.
- **Without it:** the same reference id, invoice file and reference sent again return the existing
  verification with `200 OK`. To verify the same invoice again deliberately, send a new key.

Retry a request that timed out or failed with a network error with the **same** key.

## Errors

Request errors use one envelope, separate from verification results:

```json
{
  "error": {
    "code": "INVALID_REFERENCE",
    "message": "reference_json is not a reference record Veyrafy recognises (docs/VERIFY-API.md).",
    "details": {
      "field": "reference_json",
      "issues": [{ "path": "data.0.items", "problem": "invalid_type" }]
    },
    "requestId": "…"
  }
}
```

Error messages and details never echo the values you sent. Every answer carries `X-Request-Id`;
quote it when reporting a problem.

| Status | Code | When |
| --- | --- | --- |
| `200` | — | Idempotent replay of an existing verification; or `GET`. |
| `202` | — | Verification accepted. |
| `204` | — | Deleted. |
| `400` | `INVALID_REQUEST` | Neither JSON nor multipart; no invoice, or more than one file in `images`; invalid base64; an unknown part; a bad `reference_id` or `Idempotency-Key`. |
| `400` | `INVALID_REFERENCE` | `reference_json` missing, not JSON, the wrong shape, or not exactly one record. |
| `401` | `UNAUTHENTICATED` | No key, an unknown key or a revoked key (`WWW-Authenticate: Bearer`). |
| `403` | `HTTPS_REQUIRED` | Plain HTTP to a deployed instance. |
| `403` | `CSRF_REJECTED` | A browser cross-origin request. |
| `403` | `ACCOUNT_SUSPENDED` | The Veyrafy account is suspended. |
| `404` | `NOT_FOUND` | No such verification for this key (or the API is not enabled). |
| `409` | `IDEMPOTENCY_CONFLICT` | The key was already used for a different request. |
| `413` | `TOO_LARGE` | The invoice, the record or the whole request is over its limit. |
| `415` | `UNSUPPORTED_FILE` | Empty, not a PDF/JPEG/PNG by content, a damaged PDF, or an image over the size limits. |
| `429` | `RATE_LIMITED` | Too many submissions this minute (`Retry-After` says when to retry). |
| `500` | `INTERNAL` | Unexpected; nothing about the cause is returned. Retry with the same key. |

## Limits

- Submissions are counted per minute both per API key and per network address, against
  `VEYRA_RATE_LIMIT_UPLOADS_PER_MINUTE` (60 by default). The counter is in memory per server
  process: with several processes each counts separately.
- `GET` and `DELETE` are not rate-limited by Veyrafy; poll at the `Retry-After` interval.

## Data handling

- The invoice file is stored only until it has been read (in the instance's document storage,
  encrypted when the instance has data keys configured) and is then deleted.
- Kept until you delete the verification: the reference record you sent (without `images`), the
  result, the file's SHA-256, type and size, and the timestamps.
- Verifications create **nothing** in Veyrafy's invoice workflow: no invoice, document, supplier,
  question or ERP record.
- The invoice is read by Veyrafy's local reader (PDF text and OCR on the Veyrafy server). It is
  not sent to an external AI service.
- Logs carry ids, counts and codes, never invoice or reference values.
- There is no automatic expiry of stored results yet: delete each verification when you have
  recorded its result.

## Integrating

1. Ask the Veyrafy operator for an API key and the instance's address; store the key in your
   secret store.
2. For each invoice: `POST /api/v1/verify` with the file, your record and your id, and an
   `Idempotency-Key` derived from your record (for example its id and version).
3. Poll `GET /api/v1/verification/{id}` honouring `Retry-After` until `processing_status` is not
   `processing`.
4. On `completed`, act on `status`: PASSED → continue in your workflow; FAILED → show
   `failed_fields`; REVIEW_REQUIRED → route to a person with `unverified_fields`. On `error`, show
   `error.message`, do not treat it as FAILED.
5. Store the result on your side, then `DELETE` the verification.

Test first with made-up invoices and references only.
