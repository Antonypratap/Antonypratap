# Deploying Veyra

How to run Veyra as a hosted application: prerequisites, configuration, build, database
migrations, startup, health, shutdown, storage, logs, backups and rollback. What is **not**
production-ready yet is in [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md); design background is
in [ARCHITECTURE §18–19](ARCHITECTURE.md).

> **Read this first.** Veyra has **no user authentication**. The demo PIN is a curtain in the
> browser for demos, not security: the API does not check it, and production does not depend on
> it. Deploy Veyra only where the network already controls who reaches it (a VPN, a private
> network, or a reverse proxy that authenticates users). Never expose it to the open internet.

## 1. Prerequisites

- **PostgreSQL 14 or newer** (16 recommended) for the Veyra application database. A managed
  service (AWS RDS, DigitalOcean Managed PostgreSQL, …) or your own server. Staging and production
  each get their **own** database.
- A Linux VM or container host with **Node.js ≥ 22.12** and `npm`.
- A **persistent disk** mounted for Veyra's data (for example `/var/lib/veyra`). It holds the
  uploaded documents and, while it is the ERP, the fake ERP's SQLite file. It must survive restarts
  and redeploys; a container's own filesystem is not enough.
- A reverse proxy for TLS and access control (Caddy, Nginx, a cloud load balancer, …).
- `pg_dump` / `pg_restore` (PostgreSQL client tools) for backups (section 10).

## 2. Configuration

All configuration comes from environment variables, read and validated once at startup in
`apps/api/src/config.ts`. [`.env.example`](../.env.example) lists every variable with its default.

| Variable | development | staging | production |
|---|---|---|---|
| `VEYRA_ENV` | `development` (default) | `staging` | `production` (also implied by `NODE_ENV=production`) |
| `NODE_ENV` | any | `production` recommended | **must be** `production` |
| `DATABASE_URL` | optional (see below) | **required** | **required** |
| `VEYRA_DATA_DIR` | `<repo>/data/veyra` | **required**, absolute | **required**, absolute |
| `VEYRA_ERP` | `fake` | **required** (`fake`) | **required** (`fake`) |
| `VEYRA_DEMO` | on | allowed | **refused** |
| `VEYRA_ALLOW_FIXTURE_EXTRACTOR` | allowed | allowed | **refused** |
| Migrations at startup | yes | yes | **no** (`VEYRA_MIGRATE_ON_START` defaults off) |

- **`DATABASE_URL`**: `postgres://user:password@host:5432/veyra?sslmode=require` (use TLS to a
  managed database). It is a **secret**: keep it in the platform's secret store. Veyra never
  prints, logs or returns it; a malformed URL is reported by name only.
- **Pool:**
  - `VEYRA_DB_POOL_MAX` (default 10) is the number of connections per API process.
  - `VEYRA_DB_CONNECT_TIMEOUT_MS` (default 5 s) bounds a connection attempt.
  - `VEYRA_DB_STATEMENT_TIMEOUT_MS` (default 30 s) cancels a runaway statement.
  - Keep `processes × VEYRA_DB_POOL_MAX` below the server's `max_connections`.
- **Development without `DATABASE_URL`:** Veyra runs PostgreSQL **embedded in the process** (PGlite,
  stored in `<VEYRA_DATA_DIR>/pgdata`). It is the same SQL, schema and migrations, with nothing to
  install, so `npm run demo` works out of the box. It is refused outside development. Point
  `DATABASE_URL` at a real server to develop against one.

If something is missing or invalid, the API prints what is wrong **by variable name** and exits
with status 1. It never prints values and never starts half-configured. Secrets (today:
`DATABASE_URL`; later ERP and storage credentials) go in the platform's secret store, never in
Git, the image or the frontend. The web app is static files with no configuration; anything given
to a frontend build is public.

**Environment identity.** The environment name is in every log line (`env`), in
`/api/v1/health/ready` and in `/api/v1/health`. Nothing else about the configuration is exposed.

**Staging** is a separate copy: its own PostgreSQL database, data directory, documents and, once
one exists, its own ERP connection and credentials. Never point staging at production data.
Staging may run the demo; production cannot.

## 3. Build

```
git fetch && git checkout <release tag or commit>
npm ci                          # exact versions from package-lock.json (dev dependencies included:
                                # the API runs its TypeScript with tsx)
npm run check                   # in CI (needs TEST_DATABASE_URL, section 13); optional on the host
npm run build -w @veyra/web     # → apps/web/dist (static files)
```

## 4. Database migrations

The Veyra application database is **PostgreSQL**. Migrations are the versioned SQL files in
`apps/api/drizzle/`:

- Each applies once, in order, inside a transaction.
- Each is recorded in `drizzle.__drizzle_migrations`, so running them again is a no-op.
- None drops or resets data.

**Per environment:**

- **Development:** applied automatically at startup. To change the schema:
  1. Edit `apps/api/src/db/schema.ts`.
  2. Run `npm run db:generate -w @veyra/api`.
  3. Run `npm run db:verify` (it fails when the schema and the migrations drift apart).
  4. Commit both files. The API tests also rebuild the schema from the migrations and compare it
     with the declared one.
- **Staging:** applied automatically at startup. Deploying to staging first is the rehearsal.
- **Production:** never automatic. Take a backup (section 10), then:

  ```
  DATABASE_URL=… npm run db:migrate -w @veyra/api   # "applied N migration(s): …" or "already up to date"
  ```

  If this step is skipped, the API refuses to start and names the pending migrations. Nothing in
  Veyra resets or deletes production data (`/dev/reset` does not exist in production).

### Moving an existing SQLite database (once)

Veyra used SQLite (`veyra.db`) before Phase 6A. To carry an existing installation over:

1. Stop the old version. Keep `veyra.db`, `fake_erp.db` and the `uploads/` folder where they are.
2. Create the PostgreSQL database and run `npm run db:migrate -w @veyra/api` against it.
3. Rehearse: `npm run db:migrate-from-sqlite -w @veyra/api -- --from /var/lib/veyra/veyra.db --dry-run`.
   This copies and verifies everything, then rolls back.
4. For real: run the same command without `--dry-run`.
5. Start the new version with the same `VEYRA_DATA_DIR`, since documents and the fake ERP stay on
   disk. Check the app, then keep `veyra.db` as a backup.

What the import does:

- **Reads** the SQLite file (an online backup copy, so the source is never written) and brings the
  copy up to the last SQLite schema.
- **Refuses** a target that is not empty.
- **Copies** every table in one PostgreSQL transaction. Ids, text, JSON and integers are copied
  unchanged. 0/1 becomes boolean, ISO timestamps become `timestamptz`, and insertion order is
  kept as `seq`.
- **Verifies inside that transaction:**
  - row counts per table and every value of every row;
  - insertion order;
  - invoices by state, questions by status, ERP writes by status;
  - audit events per invoice, invoice ↔ document, the order of answers, jobs by status.

Any difference, or any value it would have to reinterpret (such as a timestamp not in Veyra's
format), rolls everything back and names the problem. The report prints the counts per table on
both sides.

## 5. Startup

```
npm run start -w @veyra/api
```

- One Node.js process serves the REST API **and** runs the background worker (reading documents,
  matching, ERP commits). There is no separate worker to start.
- **Several processes may share one PostgreSQL database.**
  - Job claims are atomic: no job is taken twice, and one invoice is never worked on by two
    workers at once.
  - Answers are serialised, and duplicates are refused.
  - Abandoned jobs are recovered by lease expiry.
  - **But** documents are on local disk (section 8), so every process must see the *same*
    documents folder: one host, or a shared filesystem. Across separate hosts, wait for the
    object-storage adapter.
- **Frontend:** serve `apps/web/dist/` as static files and route `/api/` to the API on the same
  origin.
- **Proxy:** set `VEYRA_TRUST_PROXY` to the number of proxies in front, so rate limits see the
  real client address and the proxy's `x-request-id` is kept. Allow request bodies of at least
  21 MB on `/api/v1/documents` and 45 MB on `/api/v1/imports`.

Example systemd unit:

```
[Service]
WorkingDirectory=/srv/veyra
EnvironmentFile=/etc/veyra/production.env      # mode 600, owned by root; holds DATABASE_URL
ExecStart=/usr/bin/npm run start -w @veyra/api
Restart=on-failure
TimeoutStopSec=30
User=veyra
```

Example Caddy site (put authentication in front of everything):

```
veyra.example.com {
  # forward_auth / your SSO proxy here
  handle /api/* {
    reverse_proxy 127.0.0.1:8787
  }
  handle {
    root * /srv/veyra/apps/web/dist
    try_files {path} /index.html
    file_server
  }
}
```

## 6. Health checks

| Endpoint | Answers | Use for |
|---|---|---|
| `GET /api/v1/health/live` | `200 {"status":"ok"}` whenever the process is up. Checks nothing else, not even the database. | Liveness probe (restart when it fails) |
| `GET /api/v1/health/ready` | `200 ready` or `503 not_ready`. Checks that PostgreSQL answers, document storage and the worker loop, and reports ERP status and job counts. | Readiness probe, uptime monitor |
| `GET /api/v1/health` | Kept for compatibility: environment, whether the demo is on, ERP and extractor identity. | Diagnostics |

The ERP does not make the instance unready: while it is unavailable, work waits and retries, and
the UI keeps working. Responses hold only statuses, codes and counts, never URLs, paths or errors.

**Worth alerting on:**

- `/health/ready` not 200 for more than 2 minutes (`checks.database` names a database outage).
- `jobs.expired > 0`: a worker stopped mid-job. It is recovered automatically, but frequent expiry
  means crashes.
- `jobs.failedLast24h` rising.
- `jobs.oldestQueuedAgeMs` above a few minutes.
- `checks.erp.status` not `CONNECTED`.

## 7. Graceful shutdown

On SIGTERM or SIGINT the process:

1. Stops accepting connections and lets in-flight requests finish.
2. Stops claiming jobs.
3. Gives the running job up to `VEYRA_SHUTDOWN_GRACE_MS` (default 25 s) to finish. A job that has
   not finished is put back in the queue, never left running.
4. Closes the PostgreSQL pool, the ERP connection and the OCR workers, then exits 0.

No database transaction spans slow work: document reading and ERP calls happen outside
transactions.

Set the platform's stop timeout above the grace period (systemd `TimeoutStopSec=30`, Docker
`--stop-timeout 30`).

**If the process is killed hard,** a job may be left `running`. Its lease (`VEYRA_JOB_LEASE_MS`,
default 5 min) is no longer renewed, and any worker, including the restarted one, re-queues it
once the lease expires. A job that keeps being abandoned fails visibly after 5 attempts. A re-run
is safe: every step no-ops when already done, and ERP writes reuse their idempotency keys, so
nothing is recorded twice.

## 8. Document storage

Documents are kept through the `DocumentStorage` interface. Today there is one implementation,
**local storage**:

- The folder is `VEYRA_STORAGE_DIR`, default `<VEYRA_DATA_DIR>/uploads`.
- Files are stored as `<documentId>.pdf|png|jpg`, and business-record uploads as `imports/<id>/…`.
  A user's filename is only metadata and never becomes a path.
- Every file is verified against the SHA-256 recorded at upload before it is read or served.

**Limitation:** local disk is exactly as available as the one server and disk it lives on. It is
not replicated or highly available. Use a persistent, backed-up disk (section 10). Object storage
(S3-compatible or similar) is a planned future adapter behind the same interface; it is not built
yet.

## 9. Logs

JSON lines on stdout. Every line has `time`, `level`, `service`, `env` and `msg`.

- **Requests:** one line each, with `reqId`, `method`, `route`, `status` and `durationMs`. Health
  probes are logged at debug level.
- **Uploads:** a `document stored` line with `documentId` and `invoiceId`.
- **Jobs:** `component: "jobs"` with `jobId`, `invoiceId`, `type`, `attempt`, and on failure a
  safe `errorCode` (and `erpOperation` when the ERP names one).
- **Unexpected errors:** logged in full, server-side only. Clients get `INTERNAL` and the
  request id.

Never logged: credentials, the database URL, authorization headers, cookies, request or response
bodies, document contents, OCR text, ERP payloads. The business audit trail lives in the database
(`audit_events`) and the product's Audit screen, not in logs.

## 10. Backups and recovery

**What to back up**

| What | Where | How |
|---|---|---|
| Veyra application database (all workflow data and the audit trail) | PostgreSQL | managed backups with point-in-time recovery, plus `pg_dump` |
| Documents | `VEYRA_STORAGE_DIR` (default `<VEYRA_DATA_DIR>/uploads`) | `rsync` to another machine or bucket |
| Fake ERP database (while it is the ERP) | `<VEYRA_DATA_DIR>/fake_erp.db` (SQLite) | `sqlite3 … ".backup …"` |
| Configuration and secrets | your secret store / `/etc/veyra/*.env` | handled separately, never with the data |

**Frequency and retention (recommendation)**

- **PostgreSQL:** turn on the provider's automated backups with point-in-time recovery (7–35 days).
  Also take a nightly logical dump kept for 30 days, and monthly dumps for 12 months (or as your
  accounting-record policy requires). Always take a dump right before `db:migrate`.
- **Documents:** at least daily. They never change after upload.

**Taking backups**

```
pg_dump --format=custom --no-owner "$DATABASE_URL" --file=/backups/veyra-$(date -u +%Y%m%dT%H%M%SZ).dump
rsync -a /var/lib/veyra/uploads/ backup-host:/backups/veyra-uploads/
sqlite3 /var/lib/veyra/fake_erp.db ".backup '/backups/fake_erp-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Copy backups off the server and encrypt them at rest. The dump file contains every invoice.

**Verifying (weekly, automated).** Restore the latest dump into a scratch database and check it:

```
createdb veyra_verify && pg_restore --no-owner --dbname=veyra_verify /backups/veyra-….dump
psql veyra_verify -c "select count(*) from invoices; select max(created_at) from audit_events;"
```

A backup is only proven by restoring it. Once a month, restore the latest set into staging and
open the app.

**Restoring**

1. Stop the service.
2. Restore into a new, empty database: `pg_restore --no-owner --dbname=<new db> <dump>`, or use the
   provider's point-in-time restore.
3. Point `DATABASE_URL` at it and restore the documents folder and `fake_erp.db` from the same
   point in time.
4. Run `npm run db:migrate -w @veyra/api`, in case the backup is older than the code.
5. Start the service and check `/api/v1/health/ready`.

An invoice whose document is missing answers "not available" when opened; restore that file.

## 11. Rollback

- **Release without a migration:** check out the previous commit, `npm ci`, rebuild the web app and
  restart.
- **Release with a migration:** migrations only go forward. Stop the service, restore the dump taken
  just before `db:migrate` (or restore to that point in time), deploy the previous commit and
  start. Work done after that point is lost, so prefer fixing forward once real data has changed.

## 12. Limits and protection (defaults)

- **Uploads:** PDF, PNG or JPEG decided by the file's bytes (never its name or the browser), up to
  20 MB (`VEYRA_MAX_UPLOAD_BYTES` can lower it). An identical file (same SHA-256) is refused,
  including two uploads at the same moment.
- **Documents:** PDFs up to 20 pages; images up to 12,000 px a side and 40 MP. Both can be lowered.
- **Imports:** up to 8 files of 5 MB.
- **JSON bodies:** up to 1 MB.
- **Rate limits, per client address per minute:** uploads 60, processing actions 120, demo endpoints
  60. Over the limit: 429 with `Retry-After`. These limits are **per process**, not a distributed
  limiter; with several processes each counts its own. Add edge limits at the proxy.
- **Errors:** a stable `code`, a safe `message` and the `requestId`; never stack traces, SQL,
  paths, headers or credentials.
- **Production:** no `/dev/*` endpoints (reset, demo scenarios), no demo seed and no fixture
  extractor. These are enforced by the server.

## 13. Test database

The API tests run against **real PostgreSQL** and never fall back to SQLite or the embedded
engine. Set `TEST_DATABASE_URL` to a **disposable** server whose user may create databases:

```
# e.g. a throwaway container
docker run -d --name veyra-test-pg -p 5432:5432 -e POSTGRES_USER=veyra_test \
  -e POSTGRES_PASSWORD=veyra_test -e POSTGRES_DB=veyra_test postgres:16
export TEST_DATABASE_URL=postgres://veyra_test:veyra_test@127.0.0.1:5432/veyra_test
npm run check
```

Each test gets its own database, cloned from a migrated template, and drops it afterwards.
Without `TEST_DATABASE_URL` the API tests fail at once with that instruction. CI
(`.github/workflows/ci.yml`) provides a PostgreSQL 16 service.
