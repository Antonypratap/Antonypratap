# Production readiness

What Veyra's runtime can and cannot do today. Read before deploying; how to deploy is in
[DEPLOYMENT.md](DEPLOYMENT.md).

## In place

- **Database:**
  - PostgreSQL for the Veyra application database.
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
- **Rate limits:** on uploads, processing actions and demo endpoints.
- **Documentation:** deployment, migration, backup, restore and rollback procedures.

## Current limitations

| Area | Today | Consequence |
|---|---|---|
| Document storage | **Local disk** (the only storage adapter) | As available as that one disk. Not replicated. Several API processes must share the same folder: one host or a shared filesystem. |
| Rate limiting | **Per process**, in memory | Each process counts its own requests; not a distributed limiter, and it resets on restart. |
| Authentication | **None.** The demo PIN is a browser-side demo curtain, not security. | Deploy only behind network access control (VPN, private network, authenticating proxy). |
| Users and roles | One designated user, no roles | Anyone who can reach the app acts as that user. |
| Multi-tenancy | None | One business per deployment. |
| Billing | None | |
| ERP | The built-in **fake ERP** only (a SQLite file behind the ERP connector) | The home-grown ERP connector is waiting for the ERP team's API documentation. |
| Development database | Embedded PostgreSQL (PGlite) when no `DATABASE_URL` is set | Development only; refused in staging and production. |
| Error monitoring | None integrated | Logs are structured JSON, ready for log-based alerting. |
| Container image | Not provided | Deploy on a VM with the steps in DEPLOYMENT.md, or build an image from them. |

## Where SQLite remains

- **The fake ERP** (`packages/fake-erp`, `fake_erp.db`): a development and demo ERP behind the
  `ErpConnector` boundary. It is not part of the Veyra application database.
- **The one-time import tool** (`db:migrate-from-sqlite`): it only *reads* an old `veyra.db`.

No Veyra workflow data (invoices, documents, questions, answers, audit, jobs, imports, ERP write
log, settings) is stored in SQLite any more.

## Deliberately deferred

- **Object storage** for documents: a future `DocumentStorage` adapter, which multi-host
  deployments need.
- **Authentication, multi-tenancy and billing:** separate phases.
