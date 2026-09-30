# Production readiness

What Veyrafy's runtime can and cannot do today. Read before deploying; how to deploy is in
[DEPLOYMENT.md](DEPLOYMENT.md).

## In place

- **Database:**
  - PostgreSQL for the Veyrafy application database.
  - A connection pool, closed on shutdown; statement and connection timeouts.
  - Versioned migrations, explicit in production.
  - A verified, non-destructive import from the earlier SQLite database.
- **Several processes on one database:**
  - Atomic job claims: never twice, and never two workers on one invoice.
  - Serialised answers.
  - Duplicate uploads refused.
  - Idempotent ERP writes.
  - Lease-based recovery of abandoned jobs.
- **Environments and configuration:**
  - Separate development, staging and production environments.
  - Configuration is validated at startup and fails safely, naming variables, never values.
  - Production refuses demo mode and the fixture extractor.
- **Production lock-down:** no dev or demo endpoints (reset, demo scenarios) and no demo seed.
  This is enforced by the server, not the UI.
- **Documents:**
  - Stored through a `DocumentStorage` interface, under keys made from ids.
  - Checksum-verified on every read.
  - The type is decided by content; size, page and image limits apply.
- **Jobs:**
  - Retries are bounded (5 attempts) and happen only for temporary outages.
  - Idempotent re-runs, so ERP writes are never duplicated.
  - Graceful shutdown.
- **Health:** liveness and readiness probes; readiness checks that PostgreSQL answers.
- **Requests and errors:** request ids on every response and log line, and safe error responses.
- **Logs and audit:** structured JSON logs with redaction; the business audit trail stays separate
  in the database.
- **Rate limits:** on uploads, processing actions, demo endpoints and sign-in.
- **Security (Phase 6C, [SECURITY.md](SECURITY.md)):**
  - Sign-in with email and password (Argon2id); server-side sessions with idle and absolute
    expiry, rotation, sign-out and revocation; HttpOnly, SameSite=Strict, Secure cookies.
  - Three roles (ADMIN, FINANCE, REVIEWER), enforced on every route by one central layer (a route
    without a declared access fails startup) and again in the application core.
  - CSRF protection (origin checks and a per-session token), strict CORS, security headers and a
    Content-Security-Policy for the web build.
  - Authorized, audited, inert document downloads; a security audit trail.
  - Redacted logs and safe errors; secrets wrapped in configuration; a secret scan and dependency
    audit in CI; a least-privilege database role with append-only audit trails.
- **Documentation:** deployment, migration, backup, restore and rollback procedures.

## Current limitations

| Area | Today | Consequence |
|---|---|---|
| Document storage | **Local disk** (the only storage adapter) | As available as that one disk. Not replicated. Several API processes must share the same folder: one host or a shared filesystem. |
| Rate limiting | **Per process**, in memory | Each process counts its own requests; not a distributed limiter, and it resets on restart. |
| Authentication | Email and password with server-side sessions; **no multi-factor authentication**, no password reset by email | Administrators reset passwords (product or CLI). Consider an authenticating proxy with MFA in front for high-risk deployments. |
| Users and roles | Three fixed roles (ADMIN, FINANCE, REVIEWER); questions are still assigned to the one designated approver | Any user with `questions.answer` may answer them; per-user assignment is future work. |
| Multi-tenancy | None: one configured organization per deployment | One business per deployment. |
| Security review | No independent audit or penetration test | See the remaining risks in SECURITY.md §21. |
| Billing | None | |
| ERP | The built-in **fake ERP** only (a SQLite file behind the ERP connector) | The home-grown ERP connector is waiting for the ERP team's API documentation. |
| Development database | Embedded PostgreSQL (PGlite) when no `DATABASE_URL` is set | Development only; refused in staging and production. |
| Error monitoring | None integrated | Logs are structured JSON, ready for log-based alerting. |
| Container image | Not provided | Deploy on a VM with the steps in DEPLOYMENT.md, or build an image from them. |

## Where SQLite remains

- **The fake ERP** (`packages/fake-erp`, `fake_erp.db`): a development and demo ERP behind the
  `ErpConnector` boundary. It is not part of the Veyrafy application database.
- **The one-time import tool** (`db:migrate-from-sqlite`): it only *reads* an old `veyra.db`.

No Veyrafy workflow data (invoices, documents, questions, answers, audit, jobs, imports, ERP write
log, settings) is stored in SQLite any more.

## Deliberately deferred

- **Object storage** for documents: a future `DocumentStorage` adapter, which multi-host
  deployments need.
- **Multi-factor authentication, multi-tenancy and billing:** separate phases.
- **Distributed rate limiting** (a shared store) for several API processes.
