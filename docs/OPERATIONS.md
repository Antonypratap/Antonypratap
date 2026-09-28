# Veyra operations guide

How to run Veyra as a hosted application: environments, configuration, deployment, migrations,
health, logs, backups and the limits of what is production-ready today. Design background is in
[ARCHITECTURE §18](ARCHITECTURE.md).

> **Read this first.** Veyra has **no user authentication yet**. The demo PIN is a demo curtain in
> the browser, not security: the API does not check it. Until authentication exists, deploy Veyra
> only where the network already limits who can reach it (VPN, private network, or a reverse proxy
> that authenticates users, e.g. an SSO/identity-aware proxy or IP allow-list). Never expose the
> API to the open internet.

## 1. Environments

| | development | staging | production |
|---|---|---|---|
| `VEYRA_ENV` | `development` (default) | `staging` | `production` (also implied by `NODE_ENV=production`) |
| Demo, `/dev/*` endpoints, demo seed | on | allowed (`VEYRA_DEMO=true`) | **refused at startup and not registered** |
| Fixture extractor | allowed | allowed | **refused** |
| Migrations at startup | yes | yes (default) | **no**: run `db:migrate` as a deploy step |
| Storage | local folder | local volume or bucket | local volume or bucket, set explicitly |
| Default log level | `warn` | `info` | `info` |

Staging must be a separate copy: its own data directory, its own bucket (or prefix), its own ERP
connection and its own configuration file. Nothing is shared with production. The environment name
is in every log line (`env`), in `/api/v1/health` and in `/api/v1/health/ready`, so an instance can
always tell you what it is.

## 2. Configuration

All configuration comes from environment variables. [`.env.example`](../.env.example) lists every
variable with its rules and defaults. At startup the API validates all of them. If anything is
missing or invalid it prints what is wrong **by variable name** and exits with status 1. It never
prints values, because some are secrets. It never starts half-configured.

Secrets are the storage credentials (`VEYRA_S3_ACCESS_KEY_ID`, `VEYRA_S3_SECRET_ACCESS_KEY`) and,
later, ERP credentials:

- Put them in the platform's secret store (AWS Secrets Manager/SSM, DigitalOcean App secrets,
  systemd `EnvironmentFile` with mode 600, …).
- Never put them in Git, the image, the database or the frontend build.
- The web app is static files with no configuration; anything given to a frontend build is public.

## 3. What runs

One Node.js process runs the REST API **and** the background worker (document reading, matching,
ERP commits). With SQLite this process must be the **only** instance for a data directory: do not
scale it horizontally. Scale-out needs PostgreSQL (Phase 6A, not built yet).

- **API + worker:** `npm run start -w @veyra/api`, which runs `tsx src/main.ts`. It needs Node ≥ 22.12
  and the repository's installed dependencies, including dev dependencies (`tsx`).
- **Frontend:** `npm run build -w @veyra/web` produces `apps/web/dist/`, static files. Serve them from
  any static host or the same reverse proxy, and route `/api/` to the API on the same origin.
- **Reverse proxy:** terminates TLS, authenticates users (see the warning above), and forwards the
  client address. Set `VEYRA_TRUST_PROXY` to the number of proxies in front. Allow request bodies of
  at least 21 MB on `/api/v1/documents` and 45 MB on `/api/v1/imports`.

Example (Caddy):

```
veyra.example.com {
  # authentication in front of everything (forward_auth / your SSO proxy) goes here
  handle /api/* {
    reverse_proxy 127.0.0.1:8787
  }
  handle {
    root * /srv/veyra/web
    try_files {path} /index.html
    file_server
  }
}
```

## 4. Deploying a version

```
git fetch && git checkout <release tag or commit>
npm ci                                   # exact dependency versions from package-lock.json
npm run check                            # optional on the host; required in CI
npm run build -w @veyra/web              # → apps/web/dist
# back up first (section 7), then:
npm run db:migrate -w @veyra/api         # applies pending migrations once; "already up to date" if none
# restart the service (systemd / container), then check:
curl -fsS https://veyra.example.com/api/v1/health/ready
```

**Migrations**

- **Development:** `npm run db:generate -w @veyra/api` creates a migration from `src/db/schema.ts`
  and `npm run db:verify` checks for drift. Commit both the schema and the migration.
- **Staging:** migrations apply at startup by default. Deploy to staging first; this is the
  rehearsal for production.
- **Production:**
  - `VEYRA_MIGRATE_ON_START` is off. After a backup, run `npm run db:migrate -w @veyra/api` as an
    explicit step.
  - If you skip it, the API refuses to start and names the pending migrations.
  - Migrations are versioned files in `apps/api/drizzle/`. They apply in order, each exactly once,
    and each is recorded in `__drizzle_migrations`.
  - Nothing in Veyra resets or deletes production data. `/dev/reset` does not exist in production.

**Stopping.** On SIGTERM or SIGINT the process:

1. Stops accepting connections and lets in-flight requests finish.
2. Gives the running job up to `VEYRA_SHUTDOWN_GRACE_MS` (25 s) to finish. If it doesn't finish, it
   is put back in the queue for the next start.
3. Closes the database, the ERP and the OCR workers, then exits 0.

Give the platform's stop timeout at least 30 s (Docker `--stop-timeout 30`, systemd
`TimeoutStopSec=30`).

**Rollback**

- **Code only (no migration in the release):** redeploy the previous commit and restart.
- **With a migration:** migrations only go forward. Stop the service, restore the backup taken just
  before `db:migrate` (section 7), deploy the previous commit and start. Invoices processed after
  the backup would be lost. Prefer fixing forward when data has already changed.

## 5. Health and monitoring

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /api/v1/health/live` | The process is up (`{"status":"ok"}`). Checks nothing else. | Liveness probe / restart policy |
| `GET /api/v1/health/ready` | 200 `ready` or 503 `not_ready`. Checks the database, document storage and the worker loop; reports ERP status and job counts. | Readiness probe / load balancer / uptime monitor |
| `GET /api/v1/health` | Identity: environment, whether the demo is on, ERP and extractor versions. Kept for compatibility. | Diagnostics |

The ERP does not make an instance unready: while it is unavailable, work waits and retries, and the
UI keeps working. Watch `checks.erp.status` separately. The response contains only statuses, codes
and counts, never hosts, paths or credentials.

**What to alert on:**

- `/health/ready` not 200 for more than 2 minutes: database, storage or worker is down.
- `jobs.expired > 0`: a worker stopped mid-job. It is recovered automatically, but frequent expiry
  means crashes.
- `jobs.failedLast24h` rising: document processing is failing (see the `job failed` logs).
- `jobs.oldestQueuedAgeMs` above a few minutes: the worker is stuck or overloaded.
- `checks.erp.status` other than `CONNECTED`: the ERP connection is failing.

## 6. Logs

Logs are JSON lines on stdout. Every line has `time`, `level`, `service`, `env` and `msg`.

- **Requests:** one line each, with `reqId`, `method`, `route`, `status` and `durationMs`. Health
  probes are logged at debug level only.
- **Jobs:** `component: "jobs"` with `jobId`, `invoiceId`, `type`, `attempt`, and on failure a
  stable `errorCode` (`ERP_UNAVAILABLE`, `STORAGE_UNAVAILABLE`, `DATABASE_BUSY`, `INTERNAL`, …).
- **Unexpected errors:** full detail and stack, server-side only, with the `reqId`.
- **Correlation:** every API response has an `x-request-id` header, and every error body has
  `error.requestId`. When a user reports a problem, that id finds the log line. A caller may send
  its own `x-request-id` (8–64 characters `[A-Za-z0-9._-]`); anything else is replaced.

**Never logged:** credentials, authorization headers, cookies, request or response bodies,
uploaded documents, OCR text, ERP payloads. A redaction list also blanks those fields if something
ever tries.

**Logs are not the audit trail.** Business events (who uploaded, what Veyra read and matched, who
decided, what was recorded in the ERP) are in the `audit_events` table and in the product's Audit
screen. Keep that database backed up; logs can rotate away.

## 7. Backups and recovery (SQLite, current)

**What to back up**

- `<VEYRA_DATA_DIR>/veyra.db`: all Veyra data, including the audit trail.
- `<VEYRA_DATA_DIR>/fake_erp.db`: only while the fake ERP is in use.
- The document store: the uploads folder, or the bucket.

**Frequency and retention**

- **Database:** at least every hour, and always immediately before `db:migrate`. Keep hourly backups
  for 48 hours, daily for 30 days and monthly for 12 months, or as your accounting-record policy
  requires.
- **Documents:** they are never modified after upload. For a bucket, turn on **versioning** and a
  lifecycle rule for old versions. For a local folder, copy it daily with `rsync` to another
  machine or bucket.

**Taking a backup (online, safe while Veyra runs)**

```
sqlite3 /var/lib/veyra/veyra.db ".backup '/backups/veyra-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Copy the file off the host (for example to a different bucket or account) and encrypt it at rest.
Do not copy `veyra.db` with `cp` while the service runs: WAL mode keeps recent writes in
`veyra.db-wal`.

**Verifying (at least weekly, automated)**

```
sqlite3 /backups/veyra-….db "PRAGMA integrity_check;"   # must print: ok
sqlite3 /backups/veyra-….db "SELECT count(*) FROM invoices; SELECT max(created_at) FROM audit_events;"
```

A backup that was never restored is not verified. Once a month, restore the latest backup into
staging and open the app.

**Restoring**

1. Stop the service.
2. Move the current `veyra.db`, `veyra.db-wal` and `veyra.db-shm` aside.
3. Copy the backup to `veyra.db`.
4. Run `npm run db:migrate -w @veyra/api`, in case the backup is older than the code.
5. Start the service and check `/api/v1/health/ready`.

Invoices whose documents are missing from storage show a storage error when opened. Restore the
matching document backup.

**After PostgreSQL (Phase 6A)**

- Use the provider's automated backups with point-in-time recovery (7–35 days), plus a nightly
  `pg_dump -Fc` copied off-site.
- Restore into a new instance with `pg_restore`, and verify the same way.

## 8. Where data lives (privacy)

| Data | Where | Notes |
|---|---|---|
| Original invoice files | Document storage (`<id>.pdf/png/jpg`) | One copy. The only other copy is a temporary file while OCR reads it, deleted right after. |
| Uploaded business-record spreadsheets | Document storage (`imports/<id>/…`) | |
| Extracted fields, the extractor's raw result, matches, questions, decisions, audit | `veyra.db` | The raw extraction may include text read from the document. |
| ERP records | The ERP (the fake ERP: `fake_erp.db`) | Veyra keeps references, not copies. |
| Logs | stdout → your log platform | No document contents, OCR text or payloads. |

Access to the data directory, the bucket and the backups is access to every invoice. Restrict it
accordingly.

## 9. Limits and protection

- **Uploads:**
  - The type is decided by the file's bytes (PDF, PNG or JPEG), not by its name or the browser.
  - Up to 20 MB (`VEYRA_MAX_UPLOAD_BYTES` can lower it); one file per invoice upload.
  - Business-record imports: up to 8 files of 5 MB.
  - PDFs up to 20 pages, and images up to 12,000 px a side and 40 MP. Each can be lowered.
  - Files are stored under keys made from ids, so a filename can never choose a path.
  - Stored files are checked against their SHA-256 before every read.
- **JSON bodies:** up to 1 MB (`VEYRA_MAX_JSON_BODY_BYTES`).
- **Rate limits, per client address per minute:** uploads 60, processing actions (answer, reject,
  reprocess, confirm import) 120, demo endpoints 60. Over the limit the API answers 429 with
  `Retry-After`. This limit is in-process; add edge limits at the proxy for anything
  internet-facing.
- **Errors:** a stable `code`, a safe `message` and the `requestId`. Never a stack trace, SQL,
  path, header or credential.

## 10. Not production-ready yet

- **PostgreSQL (Phase 6A):** the data layer is synchronous better-sqlite3. That means one instance
  per data directory, SQLite on a persistent volume, and no horizontal scaling.
- **Authentication and authorisation:** none. See the warning at the top.
- **Real ERP connector:** only the fake ERP exists. The home-grown ERP connector is waiting for its
  API documentation.
- **Container image:** not provided yet. The steps in section 4 work on any VM, or in a container
  built from them. An official Dockerfile should be added and tested where a container build is
  available.
- **Error-monitoring service:** none is integrated. Logs are structured, so any log-based alerting
  can consume them.
