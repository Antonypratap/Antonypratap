# Veyrafy Operations

**Phase 8A.** Veyrafy has two separate surfaces:

| | Customer application | Veyrafy Operations (control plane) |
|---|---|---|
| Who | the customer's users (ADMIN, FINANCE, REVIEWER) | the Veyrafy team (VEYRA_ADMIN) |
| Where | `/#/app/…` | `/#/ops/…` (or `/ops/…` as a path) |
| API | `/api/v1/…` | `/api/v1/ops/…` |
| Does | processes and resolves invoices | operates the customer: plans, entitlements, usage, platform health |

**The rules are enforced by the server**, not just hidden in the browser:

- **VEYRA_ADMIN is a separate platform account.** It lives in Veyrafy's own platform organization.
  It has the two ops permissions and nothing else: it cannot see invoices, documents or the
  customer's audit trail. Customer routes refuse it.
- **A customer ADMIN never gets VEYRA_ADMIN.** The product's user API cannot create one, and the
  database refuses a platform role in a customer organization. Every ops route refuses customer
  roles (tested route by route).
- **One deployment serves one customer organization,** so the Organizations list has one row. The
  console runs inside each deployment. A central, multi-customer console needs multi-tenancy
  first.

## 1. Operator accounts

Operator accounts are created **only on the server**, with the users CLI. The password is read
from stdin.

```
read -rs P && printf '%s\n' "$P" | npm run users -w @veyra/api -- create \
  --email you@veyra.example --name "Your Name" --role VEYRA_ADMIN && unset P
```

`list`, `set-password`, `disable`, `enable` and `revoke-sessions` work for operator accounts as
for customer accounts (see the README). Sign in at `/#/ops`, with email and password.

## 2. The console

| Section | Shows |
|---|---|
| Overview | organizations, organizations per plan, trials, active and expiring overrides, organizations near or over a limit (80% or more), system health, billing (not configured) |
| Organizations | each organization, its plan, status and "plan since" date, with a link to Commercial |
| Commercial | per organization, for every capability: **plan default, organization override, effective value and why**, plus usage for limits. Assign the plan, set or remove overrides, and see the organization's commercial history |
| Plans | what each plan includes and how many organizations are on it. Changing a plan entitlement affects all of them |
| Capabilities | the capability catalogue: keys, types, visibility, the ERP capability each needs |
| Usage | invoices this month and in total, outcomes, OCR, ERP writes, storage, active users; usage against each limit |
| ERP Connections | the connected ERP, its status and what it technically supports |
| Processing | job and invoice-outcome counts |
| Exceptions | failed invoices: id, stage and time only (no contents) |
| System Health | the full readiness report: database, storage, worker, ERP, jobs, pool |
| Security | the latest security events |
| Audit | the commercial audit trail: every change, before and after, reason, who, when |
| Settings | environment, billing (not configured), the entitlement cache window |

## 3. Commercial procedures

Every change needs a **reason**. It is validated and applied by the server, and audited in the
same transaction. Nothing is ever deleted.

**Assign or change a plan.** Go to Commercial → the organization. Choose the plan and the status
(active or trial), give a reason, and choose **Assign plan**.

**Enable a beta feature, or a pilot, for one customer.** Go to Commercial → the organization →
the capability → **Change**. Set it On, give a reason (for example "Pilot"), and set an expiry
date if it is temporary. The plan itself is not touched.

**Raise a negotiated quota.** Go to Commercial → the organization → the limit → **Change**. Enter
the number (or tick Unlimited), give a reason, and set an expiry if it applies.

**Temporarily disable a capability.** Set an override to Off, with a reason and optionally an
expiry.

**Remove an override.** Go to **Change** → give a reason → **Remove override**. The plan's value
applies again.

**Change what a plan includes.** Go to Plans → the value to change. Give a reason and choose
**Change the plan**. This applies to every organization on the plan; for a single customer, use an
override instead.

**Expiry and cache timing:**

- Expired overrides stop applying at their expiry time, automatically. They stay visible, marked
  expired.
- A change is effective at once in the process that made it, and within 5 seconds in any other
  API process.

**What an override can never do:** switch off validation, security, audit or the ERP's own
limits. It also cannot make the ERP do something it does not support (see
[COMMERCIAL_ENTITLEMENTS.md](COMMERCIAL_ENTITLEMENTS.md) §6).

## 4. What the customer sees

The customer application reads `GET /api/v1/capabilities`. That returns availability and, for
limits, usage. It never returns plans, overrides or reasons.

- A feature that is not included is hidden, or shown plainly as "not included in your Veyrafy
  subscription". There is no upsell.
- A limit that is reached is refused by the server with a business message, for example "Monthly
  invoice processing limit reached.", shown on the page.
- The UI contains no plan names or plan logic (tested).

## 5. What Operations cannot do (by design)

- Delete an organization, a user, an override or an audit record.
- Run SQL, or switch on a generic "bypass".
- See or change invoices, documents or the customer's workflow.
- Take payments: billing is not configured (COMMERCIAL_ENTITLEMENTS.md §9).
