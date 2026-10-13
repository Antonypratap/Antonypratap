# Connecting a business's own ERP over its API (read-only)

A business that has an ERP with a REST/JSON API can connect it to Veyrafy. Its admin enters
the API's address and login, confirms which of its fields hold what, and syncs. From then on
every invoice is checked against the ERP's own suppliers, items, purchase orders, goods
receipts and booked purchase bills, using the same matching engine as before.

**This phase is read-only.**
- Veyrafy never writes to the ERP: no supplier, item, order, receipt or invoice is created
  there.
- Veyrafy never approves or makes a payment.
- A verified invoice is "Verified, pending payment": ready for the business's own team.

The connector is generic: it is not tied to any ERP vendor. A connection made for one ERP can be
reused as a **preset** for the next customer on the same ERP. iBEAM (Innosolv) becomes a preset
once its API documentation is available (§9). Nothing about its API is assumed before then.

## 1. How it works

```
ERP API ──(sync: pages, retries, rate limits)──▶ mirror (erp_sync_records) ──▶ ErpConnector port ──▶ matching engine
         ▲ address safety, encrypted login                 ▲ records Veyrafy can rely on; issues for the rest
```

| Part | Where |
|---|---|
| Profile: address, login method, paths, paging, field mapping | `packages/shared/src/erp-profile.ts` (`ProfileSchema`, `FIELDS`) |
| Credentials, encrypted at rest (AES-256-GCM) | `apps/api/src/erp-api/secrets.ts`, table `erp_credentials` |
| HTTP: timeouts, retries, Retry-After, pacing, address safety | `apps/api/src/erp-api/http.ts`, `ssrf.ts` |
| Reading pages and mapping records | `apps/api/src/erp-api/source.ts`, `mapping.ts`, `inspect.ts` |
| Sync into the mirror | `apps/api/src/erp-api/sync.ts`; tables `erp_sync_records`, `erp_sync_runs`, `erp_sync_state`, `erp_sync_issues` |
| The mirror as an `ErpConnector` (read-only) | `apps/api/src/erp-api/mirror.ts` |
| Built-in records or ERP connection, as chosen | `apps/api/src/erp-api/switchable.ts`, `app.ts` |
| Workflow: read-only completion, holds, no creation | `apps/api/src/workflow/veyra.ts`, `workflow/read-only.ts` |
| API routes | `apps/api/src/erp-api/routes.ts` |
| Screen | ERP › Business system (`apps/web/src/product/screens/ErpConnection.tsx`) |
| The built-in Example ERP (for showing prospects) | `apps/api/src/erp-api/sample/`, preset in `presets.ts` |

## 2. Rules that keep checks honest

- **The ERP's own IDs are kept.** Each record is stored with:
  - its ERP id, record type and company/outlet scope;
  - the ERP's "last changed" time, when the ERP gives one;
  - when Veyrafy first and last saw it, and which sync last changed it.

  The invoice page lists the ERP records an invoice was checked against, with when each was
  synced. The audit trail records `erp.read_only_verified` with the record IDs.
- **Repeating a sync changes nothing.** A record is rewritten only when its content (a hash of
  the record as received) changed.
- **An interrupted sync continues where it stopped.** Each page is saved with the place to
  continue from, in one transaction. A sync that fails part-way continues from that point next
  time. A sync whose process stopped (no heartbeat for 5 minutes) is closed as "interrupted".
- **One sync at a time.** A database lease enforces this across processes.
- **Incremental where the ERP can.** If a record type has an "updated since" parameter, later
  syncs read only what changed since the last complete pass. Otherwise every sync is a full pass.
- **Missing records are marked, not deleted.** After a full pass, records the ERP no longer
  returns are marked missing and not used. They are never deleted.
- **Nothing is guessed.** A record is kept out, and listed as an issue with field names only,
  never values, when it:
  - lacks a required field, or has a value that does not convert cleanly (a bad date, a
    non-number);
  - is a supplier without a valid GSTIN, or an item without HSN, unit or GST rate;
  - links to something that does not exist (a PO for an unknown supplier, a receipt line that
    matches no PO line or several);
  - claims the same GSTIN or PO number as another record. A lookup by that key then finds
    nothing certain, so the engine asks which one is meant.
- **A changed API is not trusted.** If an answer no longer has its list where the mapping
  expects it, that record type is not trusted. The same applies when more than 5% of its records
  are unreadable. Its previous records stay, and invoices that need it wait (below).
- **Old data is never used.** Before an invoice is checked, the mirror is synced if it is older
  than `VEYRA_ERP_SYNC_MAX_AGE_MINUTES` (default 60). If it is still not up to date (the ERP is
  down, the login was refused, a record type is not trusted), the invoice waits. It shows
  "Waiting for up-to-date records from your ERP", with an audit event `erp.check_held`. It is
  checked automatically after the next good sync.
- **Missing ERP data is never a match.**
  - Where the built-in records let Veyrafy add a supplier, item, order or receipt (with
    approval), an API connection instead asks the person to record it in the ERP and check
    again. They can also reject the invoice.
  - No new supplier is ever created automatically, and no order is created below a limit.
  - Every ERP write is refused (`UNSUPPORTED`) by the capability guard and by the mirror itself.
- **Duplicates.** A purchase bill already booked in the ERP (same supplier, normalised number and
  financial year) is flagged by the existing duplicate rule (R11).

## 3. Setting it up (the customer's admin)

ERP › **Business system**:

1. **Address and login.**
   - Enter the API's base address (https only in production).
   - Pick the login method:
     - an API key in a header;
     - a username and password;
     - an access token;
     - OAuth 2 client credentials (token address, client ID, secret).
   - Enter the secret. It is stored encrypted and never shown again; the screen says only when it
     was saved.
   - Changing the address or login method forgets the saved secret.
   - Changing the address or the company/outlet scope also forgets every synced record and stops
     using the connection for checks, until a new complete sync: one ERP's records are never used
     for another.

   Use a **read-only** API user made for Veyrafy, limited to the company or outlet concerned.
2. **Which fields hold what.** For each record type (suppliers, items, purchase orders, goods
   receipts, purchase bills):
   - enter its path and how its pages work: one answer, page+size, offset+limit, a next cursor,
     or a next link;
   - "Read the first page" shows the fields found with sample values and a suggested mapping;
   - confirm or change the mapping, check the preview of the first records, and save.
   - Changing a record type's mapping later makes the next sync read that type again in full, so
     every record is rewritten through the new mapping.

   Purchase orders and receipts carry their lines inside each record. Bills are optional; they
   enable the duplicate check against the ERP.
3. **Check and sync.**
   - "Test the connection" reads the first page of each type through the saved mapping.
   - "Sync now" reads everything.
   - The table shows what was read, changed and unreadable per type, and the issues list shows
     what Veyrafy will not rely on.
4. **Use for invoice checks.** This is possible once every needed record type synced completely.
   "Switch back to built-in records" returns to the previous records, which are never changed.
   Neither switch is made while an invoice is being recorded (try again a moment later).

Roles and plan:
- Changing the connection needs `erp.manage`, which admins have.
- Viewing it needs `erp.view`.
- The plan needs `erp.api_connection`, which is on Business and Enterprise and can be granted to
  any plan in the operations console.

## 4. Configuration

| Variable | Meaning | Default |
|---|---|---|
| `VEYRA_SECRETS_KEY` | Encrypts connection credentials at rest. 32 random bytes, base64 (`openssl rand -base64 32`). A secret: set it in the host's secret store only. Without it no credentials can be saved. Changing it makes saved credentials unreadable (re-enter them). | none |
| `VEYRA_ERP_SYNC_MINUTES` | Scheduled sync of the connection in use (5 to 1440). | 30 |
| `VEYRA_ERP_SYNC_MAX_AGE_MINUTES` | Records older than this are synced before a check; if that fails, the check waits, and checks try again at most every 2 minutes (5 to 10080). | 60 |
| `VEYRA_SAMPLE_ERP` | Offers the built-in Example ERP (§6). For a showcase instance such as dev.veyrafy.com; leave unset for customers. | false |

Demo mode (`VEYRA_DEMO=true`) never uses an ERP connection; it always uses the built-in records.

## 5. Security

- **Credentials:**
  - stored encrypted with AES-256-GCM, a fresh IV each time, and the purpose bound in, so a value
    copied to another row does not decrypt;
  - never returned by the API, never logged, never put in an error;
  - changes are audited by field name only (`erp.credentials_updated`).
- **Address safety:**
  - Veyrafy never calls private, loopback, link-local or cloud-metadata addresses, including
    after a redirect (at most 3, each checked again);
  - the check runs on the address actually connected to, so DNS cannot switch it after the check;
  - credentials never follow a redirect to another address, and neither does a request body
    (the OAuth token request's client secret): such a redirect is refused as a setup error;
  - blocked ranges include the IPv4-mapped, IPv4-compatible, NAT64, 6to4 and site-local IPv6
    forms of internal addresses;
  - a next-page link must stay on the ERP's own address.
- **Limits:** a 20-second timeout per request, a 20 MB answer cap, one request at a time with a
  pause between requests, and a rate limit on the API routes that call the ERP.
- **Failure handling:**
  - 429 and 5xx are retried with backoff, respecting Retry-After;
  - 401/403 stop at once and are reported as a refused login;
  - other 4xx are reported as a setup problem.
- **Logs and errors** never contain the ERP's address with its query, headers or bodies.

## 6. The built-in Example ERP (showing prospects)

With `VEYRA_SAMPLE_ERP=true`, the Business system screen offers **Use the Example ERP**:
- **What it is:** a made-up business ("Example Co. ERP") behind its own API, served inside
  Veyrafy at `sample://example-erp`, with no network call.
- **Its API:**
  - its own field names (`vendor_code`, `gst_no`, `po_no`, `qty_recd`, …);
  - cursor paging and "updated since";
  - lines nested in each record.
- **Its records:** the demo's manufacturing business, so the demo invoices behave as in the demo.
  It also already holds one purchase bill, so a duplicate can be shown.
- **Its demo key:** `sample-erp-demo-key`. It is not a secret and is shown on screen.

The whole story takes about two minutes:
1. Use the Example ERP.
2. Read the first page of suppliers to see the mapping.
3. Test the connection.
4. Sync now.
5. Use for invoice checks.
6. Try a sample invoice:
   - **Matches the order and receipt:** verified; nothing written to the ERP.
   - **Bills more than received:** stopped by the existing quantity check.
   - **Price differs from the order:** stopped by the existing rate check.
   - **Goods receipt not recorded:** "I recorded the receipt in our ERP. Check again", or
     reject.
   - **Already booked in the ERP:** flagged as a duplicate.

### Turning it on for dev.veyrafy.com (Railway)

dev.veyrafy.com is its own deployment. On its service only, set:

- `VEYRA_SECRETS_KEY` to a new value from `openssl rand -base64 32`, kept in Railway's variables;
- `VEYRA_SAMPLE_ERP=true`;
- `VEYRA_DEMO` unset or `false`. The connection is not used in demo mode.

Its organization's plan must include `erp.api_connection`: Business, Enterprise, or an override
in the operations console. Nothing changes on any other deployment.

## 7. Migration and rollback

- **Migration:** `0011_erp_api` only adds tables, plus the plan grant for `erp.api_connection`.
  Existing data is untouched. Deployments run it with `db:migrate` as usual.
- **Rollback:**
  - in the product: **Switch back to built-in records**. Nothing is lost on either side, and
    held invoices are checked against the built-in records again;
  - in the deployment: remove `VEYRA_SAMPLE_ERP` and deploy the previous release. The new tables
    stay and are simply unused. To remove them, drop the six `erp_*` tables added by `0011` and
    delete its row from the migrations journal: a manual, irreversible step.
- Invoices already verified against an ERP connection keep their audit trail, including which
  records they were checked against.

## 8. Limitations (this phase)

- **Read-only:**
  - no write-back of suppliers, items, orders, receipts or invoices;
  - no payment status used for anything (it is stored when the ERP gives it, for display only).
- **One connection per deployment.**
- **Lines must be nested** inside their order or receipt. A separate "lines" endpoint is not
  supported yet.
- **Bills read over an API carry no lines.** "Already invoiced against this PO line" is therefore
  0 for them. Over-billing across several invoices on one PO line is caught only among invoices
  that pass through Veyrafy.
- **No supplier item codes** (aliases) are read. Items are matched by HSN, name and the order's
  lines.
- **Companies and outlets:** one company/outlet per connection, chosen by a fixed query
  parameter and/or a field check.
- **Login methods:** API key, basic, bearer token and OAuth 2 client credentials. Other methods
  (signed requests, mutual TLS) are not supported.
- **Field names:** the mapping is suggested from field names. A person always confirms it.

## 9. Adding a preset (e.g. iBEAM by Innosolv)

A preset is a profile written **only from the ERP's real API documentation** and tested against
its sandbox. To add one:
1. Write the profile in `apps/api/src/erp-api/presets.ts`.
2. Add a sandbox end-to-end test that runs only when `VEYRA_ERP_SANDBOX_*` variables are set.
3. Note in this document anything the ERP cannot provide.

**iBEAM: still to confirm from Innosolv's documentation and sandbox** (none of this is assumed):
- **Access:** the authentication scheme and token lifetime; sandbox and production base
  addresses; whether a read-only API user can be issued.
- **Endpoints and fields for each record type:**
  - suppliers (code, name, **GSTIN**, PAN, status);
  - items (code, name, **HSN/SAC**, unit, **GST rate**);
  - purchase orders and their lines (number, date, supplier, item, quantity, rate, GST);
  - goods receipts / GRNs and their lines (number, date, PO, PO line or item, received and
    accepted quantities);
  - purchase bills (supplier invoice number, date, total), and payment status if exposed.
- **Organisation:** company and outlet identifiers, and how a request is limited to one.
- **Reading at scale:** the paging style and maximum page size; an "updated since" filter;
  whether deleted or cancelled records are visible.
- **Behaviour:** rate limits; the error format.

Earlier analysis of an iBEAM export (`docs/real-test/`, customer data, not in the product) found
several gaps: the export did not carry the supplier GSTIN, PO numbers or PO lines. If the API
does not provide them either, those checks cannot pass against iBEAM, and Veyrafy will ask
rather than guess.
