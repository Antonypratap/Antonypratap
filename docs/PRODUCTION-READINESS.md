# Production readiness

What Veyra's runtime can and cannot do today. Read before deploying; how to deploy is in
[DEPLOYMENT.md](DEPLOYMENT.md).

## In place

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
  - A lease-based recovery re-queues jobs left running by a crashed worker.
  - Retries are bounded (5 attempts) and happen only for temporary outages.
  - Idempotent re-runs, so ERP writes are never duplicated.
  - Graceful shutdown.
- **Health:** liveness and readiness probes.
- **Requests and errors:** request ids on every response and log line, and safe error responses.
- **Logs and audit:** structured JSON logs with redaction; the business audit trail stays separate
  in the database.
- **Rate limits:** on uploads, processing actions and demo endpoints.
- **Documentation:** deployment, migration, backup, restore and rollback procedures.

## Current limitations

| Area | Today | Consequence |
|---|---|---|
| Application database | **SQLite** on a local persistent disk | One instance only; no horizontal scaling or failover. Backups are periodic file copies, so work after the last backup can be lost. |
| Document storage | **Local disk** (the only storage adapter) | As available as that one disk. Not replicated. Back it up. |
| Rate limiting | **Per process**, in memory | Correct for the single instance; not a distributed limiter, and it resets on restart. |
| Authentication | **None.** The demo PIN is a browser-side demo curtain, not security. | Deploy only behind network access control (VPN, private network, authenticating proxy). |
| Users and roles | One designated user, no roles | Anyone who can reach the app acts as that user. |
| Multi-tenancy | None | One business per deployment. |
| Billing | None | |
| ERP | The built-in **fake ERP** only | The home-grown ERP connector is waiting for the ERP team's API documentation. |
| Error monitoring | None integrated | Logs are structured JSON, ready for log-based alerting. |
| Container image | Not provided | Deploy on a VM with the steps in DEPLOYMENT.md, or build an image from them. |

## Deliberately deferred

- **PostgreSQL** (a separate future phase). The persistence layer is synchronous better-sqlite3 in
  every data access. Moving it is a rewrite of that layer, not configuration, so it was kept out
  of this phase. Horizontal scaling, managed backups and point-in-time recovery arrive with it.
- **Object storage** for documents: a future `DocumentStorage` adapter. The interface is ready;
  no adapter is built until a deployment needs it.
- **Authentication, multi-tenancy and billing:** separate phases.
