# Commercial entitlements

**Phase 8A.** A feature existing in the code does not mean a customer may use it. What a customer
may use is decided by one server-side service, per capability key:

```
PLAN → PLAN ENTITLEMENTS → ORGANIZATION → ORGANIZATION OVERRIDES → EFFECTIVE CAPABILITY
     → SERVER-SIDE CHECK → FEATURE
```

The web app only reads the result, to hide what would be refused. The server enforces it on
every route, whatever the browser does. How the Veyrafy team operates this day to day is in
[OPERATIONS.md](OPERATIONS.md).

## 1. Capabilities (the catalogue)

The only list is `packages/shared/src/commercial.ts`.

- **Keys are stable.** They are stored in the database and the audit trail. A key is never
  renamed or reused; a changed meaning gets a new key.
- **Only real capabilities are registered.** A switch for a feature that does not exist would
  promise something Veyrafy cannot do. The planned ones are listed in §9.

| Key | Type | What it controls | Enforced in |
|---|---|---|---|
| `erp.business_record_import` | BOOLEAN | Importing suppliers, items, POs and GRNs from Excel/CSV into the ERP. Also needs the ERP capability `business_records.import` | `imports/service.ts` (check and confirm) |
| `reports.exports` | BOOLEAN | Excel/CSV exports: invoices, decisions, audit, business records | `GET /api/v1/exports/:name` |
| `invoice.monthly_limit` | LIMIT (invoices) | Invoice documents uploaded per calendar month (UTC) | `Veyra.upload`: every upload path, including demo scenarios |
| `users.max` | LIMIT (users) | Active user accounts at once | `Users.create` and re-enabling a user (HTTP and CLI) |
| `storage.max_bytes` | LIMIT (bytes) | Total size of uploaded invoice documents | `Veyra.upload` |

- **BOOLEAN** is on or off.
- **LIMIT** is a whole number, or unlimited. A quota is never modelled as a boolean.

**Not capabilities, ever:** validation, GST checks, duplicate detection, 3-way matching, the state
machine, security, authorization, audit. These are Veyrafy's safety rules. No plan or override
reaches them, so a commercial setting cannot switch one off.

## 2. Plans

A plan (`plans`) has a key, a name, a status (`active` or `retired`), a description, and created
and updated times. It has **no price**: billing is a separate concern (§8).

What a plan includes is in `plan_entitlements`, one row per capability:

- a BOOLEAN row has `enabled`;
- a LIMIT row has `limit_value` (NULL means unlimited).

**A capability with no row is not included.** The initial plans (seeded by migration
`0003_commercial`):

| | Starter | Business | Enterprise |
|---|---|---|---|
| Import business records | Off | On | On |
| Exports | Off | On | On |
| Invoices per month | 500 | 2,000 | Unlimited |
| Active users | 3 | 10 | Unlimited |
| Document storage | 5 GB | 20 GB | Unlimited |

- **Existing and new deployments start on Enterprise,** so upgrading changes nothing a customer
  could do before. Veyrafy Operations then assigns the real plan.
- **Code never asks for a plan by name.** It asks for a capability key. Changing what a plan
  includes is a data change, never a code change.

## 3. Organization overrides

An override (`entitlement_overrides`) is an exception for one organization: enable a beta
feature, raise a negotiated quota, switch something off, or run a pilot. Each one records:

- the capability and the value (of the capability's type);
- the reason (required);
- an optional expiry;
- who set it and when.

Rules:

- **Never edited in place.** A new override revokes the active one (`revoked_at`, `revoked_by`)
  and inserts a new row. The history stays.
- **At most one active override** per organization and capability (a partial unique index).
- **Removing an override** revokes it; the plan applies again.
- **A customer-specific change is always an override.** Changing a plan changes it for every
  organization on that plan.

## 4. Precedence (evaluated at every check)

1. **System safety** (validation, security, the ERP's technical capabilities, audit) is outside
   entitlements and always applies.
2. **An active organization override**: not revoked, and its expiry not reached.
3. **Otherwise the plan's entitlement.**
4. **Otherwise nothing**, which means unavailable: BOOLEAN off, LIMIT 0.

**Expiry** is compared with the clock on every check, and is never cached. The millisecond an
override expires, the plan's value applies. No clean-up job is needed for correctness; the
expired row stays for the record, and Operations shows it as expired.

## 5. Enforcement

One service: `apps/api/src/commercial/entitlements.ts`.

| Method | Answers |
|---|---|
| `all(org)` | every capability resolved: plan, override, effective value, source (for Operations) |
| `get(org, key)` | one resolved capability |
| `can(org, key)` | available? |
| `require(org, key)` | throws `NotEntitledError` → 403 `NOT_ENTITLED`, "This is not included in your Veyrafy plan." |
| `limit(org, key)` | the quota (null = unlimited) |
| `requireWithin(org, key, used, adding, message)` | throws `LimitReachedError` → 403 `LIMIT_REACHED` with a business message |

- **Checks live in the service layer,** not only in HTTP handlers, so no route can bypass them:
  - the upload limits sit in `Veyra.upload`, which demo scenarios also use;
  - the import check sits in the imports service;
  - the user limit sits in `Users`.
- **Limits are counted exactly.** Inside the transaction that records the upload or the user, an
  advisory lock serializes the count, so parallel uploads at the limit cannot pass it together
  (tested).
- **Nothing beyond a limit is processed:** the document is not stored or recorded.
- **Refusals are business messages,** for example "Monthly invoice processing limit reached." They
  never contain plan names or implementation detail.
- **Order of checks on a request:** authenticate → authorize (role permission) → resolve the
  organization → capability check → validate → act → audit. A commercial entitlement grants
  access; it never skips validation, the workflow's own checks or the audit.

## 6. ERP technical capability vs commercial entitlement

These are two different questions:

- **ERP capability:** what can the connected ERP technically do? (`ErpConnector.capabilities()`)
- **Commercial entitlement:** what is this customer allowed to use?

Both are needed (`commercial/erp.ts`):

| Commercial | ERP | Result |
|---|---|---|
| on | supported | allowed |
| on | not supported | refused: `ERP_UNSUPPORTED` (the entitlement never forces an operation the ERP cannot do) |
| off | supported | refused: `NOT_ENTITLED` (the ERP supporting it grants nothing) |

## 7. Audit

Every commercial change is written, **in the same transaction as the change**, to
`commercial_events`:

| Field | What it holds |
|---|---|
| event | `plan.assigned`, `plan.entitlement_changed`, `override.set` or `override.removed` |
| organization, plan, capability | what changed |
| old and new value | the effective value before, and the new value |
| actor, timestamp | who, and when |
| reason, expiry | why, and until when |
| request id | the request that made it |

- **Append-only:** the runtime database role has no UPDATE or DELETE on it
  (`apps/api/sql/runtime-role.sql`).
- **Never deleted.**
- **Only Veyrafy Operations can make a change** (`ops.manage`, VEYRA_ADMIN only).

## 8. Caching and performance

- **An organization's plan rows and active overrides are loaded with 2 queries,** then cached for
  5 seconds (`ENTITLEMENT_CACHE_MS`). The cache key is the organization id, so nothing leaks
  across organizations.
- **Hundreds of checks cost no query** (tested). No check runs per row, so there is no N+1.
- **A change through Veyrafy Operations invalidates the cache at once** in that process.
- **Another API process sees the change within 5 seconds.** That is the documented staleness
  window.
- **Expiry is never cached** (§4).
- **Limit checks count with indexed aggregate queries:** `documents_uploaded` covers the monthly
  count. The customer's capability view adds 5 aggregate queries (usage), run in parallel.

## 9. Billing and what is next

- **No payment provider is integrated (Phase 8A).** Organizations show "Billing: Not
  configured".
- **The engine is provider-agnostic.** Later: payment provider → subscription state → plan
  assignment (the same audited `assignPlan`) → entitlements. Nothing in the entitlement path
  changes when that arrives.
- **Planned capabilities are registered when they exist:**
  - human correction (`invoice.human_correction`, with Phase 7B);
  - email ingestion;
  - external AI extraction;
  - GST return and e-invoice checks;
  - notifications;
  - a supplier portal;
  - API access;
  - multiple ERP connections.

**One organization per deployment.** Every service call already takes an organization id, and the
cache is keyed by it. A central, multi-customer console would need multi-tenancy first, which is
a separate phase.
