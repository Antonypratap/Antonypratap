# Deploying Veyra

How to run Veyra as a hosted application today: prerequisites, configuration, build, migrations,
startup, health, shutdown, storage, logs, backups and rollback. What is **not** production-ready
yet is in [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md); design background is in
[ARCHITECTURE §18](ARCHITECTURE.md).

> **Read this first.** Veyra has **no user authentication**. The demo PIN is a curtain in the
> browser for demos, not security: the API does not check it, and production does not depend on
> it. Deploy Veyra only where the network already controls who reaches it (a VPN, a private
> network, or a reverse proxy that authenticates users). Never expose it to the open internet.

## 1. Prerequisites

- Linux VM or container host with **Node.js ≥ 22.12** and `npm`.
- A **persistent disk** mounted for Veyra's data (for example `/var/lib/veyra`). It holds the SQLite
  database and the uploaded documents, and it must survive restarts and redeploys. A container's
  own filesystem is not enough.
- A reverse proxy for TLS and access control (Caddy, Nginx, a cloud load balancer, …).
- `sqlite3` command-line tool for backups (section 10).

## 2. Configuration

All configuration comes from environment variables, read and validated once at startup in
`apps/api/src/config.ts`. [`.env.example`](../.env.example) lists every variable with its default.

| Variable | development | staging | production |
|---|---|---|---|
| `VEYRA_ENV` | `development` (default) | `staging` | `production` (also implied by `NODE_ENV=production`) |
| `NODE_ENV` | any | `production` recommended | **must be** `production` |
| `VEYRA_DATA_DIR` | `<repo>/data/veyra` | **required**, absolute | **required**, absolute |
| `VEYRA_ERP` | `fake` | **required** (`fake`) | **required** (`fake`) |
| `VEYRA_DEMO` | on | allowed | **refused** |
| `VEYRA_ALLOW_FIXTURE_EXTRACTOR` | allowed | allowed | **refused** |
| Migrations at startup | yes | yes | **no** (`VEYRA_MIGRATE_ON_START` defaults off) |

If something is missing or invalid, the API prints what is wrong **by variable name** and exits
with status 1. It never prints values and never starts half-configured.

Veyra needs **no secrets** today: the only ERP is the built-in fake ERP and documents are on
local disk. When a real ERP connector or object storage arrives, its credentials go in the
platform's secret store (not Git, the image, the database or the frontend). The web app is static
files with no configuration; anything given to a frontend build is public.

**Environment identity.** The environment name is in every log line (`env`), in
`/api/v1/health/ready` and in `/api/v1/health`. Nothing else about the configuration is exposed.

**Staging** is a separate copy with its own data directory, its own documents and, once one
exists, its own ERP connection and credentials. Never point staging at production data. Staging
may run the demo; production cannot.

## 3. Build

```
git fetch && git checkout <release tag or commit>
npm ci                          # exact versions from package-lock.json (dev dependencies included:
                                # the API runs its TypeScript with tsx)
npm run check                   # in CI; optional on the host
npm run build -w @veyra/web     # → apps/web/dist (static files)
```

## 4. Database migrations

The application database is **SQLite** (`<VEYRA_DATA_DIR>/veyra.db`). Migrations are the
versioned files in `apps/api/drizzle/`. Each applies once, in order, and is recorded in
`__drizzle_migrations`. Running them again is a no-op.

- **Development:** applied automatically at startup. To change the schema, edit
  `apps/api/src/db/schema.ts`, then run `npm run db:generate -w @veyra/api` and
  `npm run db:verify`, and commit both files.
- **Staging:** applied automatically at startup. Deploying to staging first is the rehearsal.
- **Production:** never automatic. Take a backup (section 10), then:

  ```
  npm run db:migrate -w @veyra/api    # "applied N migration(s)…" or "already up to date"
  ```

  If this step is skipped, the API refuses to start and names the pending migrations. Nothing in
  Veyra resets or deletes production data.

## 5. Startup

```
npm run start -w @veyra/api
```

- One Node.js process serves the REST API **and** runs the background worker (reading documents,
  matching, ERP commits). There is no separate worker to start.
- With SQLite, run **exactly one** process per data directory. Do not scale horizontally or run a
  second instance against the same disk.
- **Frontend:** serve `apps/web/dist/` as static files and route `/api/` to the API on the same
  origin.
- **Proxy:** set `VEYRA_TRUST_PROXY` to the number of proxies in front, so rate limits see the
  real client address and the proxy's `x-request-id` is kept. Allow request bodies of at least
  21 MB on `/api/v1/documents` and 45 MB on `/api/v1/imports`.

Example systemd unit:

```
[Service]
WorkingDirectory=/srv/veyra
EnvironmentFile=/etc/veyra/production.env      # mode 600, owned by root
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
| `GET /api/v1/health/ready` | `200 ready` or `503 not_ready`. Checks the database, document storage and the worker loop, and reports ERP status and job counts. | Readiness probe, uptime monitor |
| `GET /api/v1/health` | Kept for compatibility: environment, whether the demo is on, ERP and extractor identity. | Diagnostics |

The ERP does not make the instance unready: while it is unavailable, work waits and retries and
the UI keeps working. Responses hold only statuses, codes and counts, never paths, URLs or errors.

**Worth alerting on:**

- `/health/ready` not 200 for more than 2 minutes.
- `jobs.expired > 0` (a worker stopped mid-job; recovered automatically, but frequent means crashes).
- `jobs.failedLast24h` rising.
- `jobs.oldestQueuedAgeMs` above a few minutes.
- `checks.erp.status` not `CONNECTED`.

## 7. Graceful shutdown

On SIGTERM or SIGINT the process:

1. Stops accepting connections and lets in-flight requests finish.
2. Stops claiming jobs.
3. Gives the running job up to `VEYRA_SHUTDOWN_GRACE_MS` (default 25 s) to finish. A job that has
   not finished is put back in the queue for the next start, never left running.
4. Closes the database, the ERP connection and the OCR workers, then exits 0.

Set the platform's stop timeout above the grace period (systemd `TimeoutStopSec=30`, Docker
`--stop-timeout 30`).

If the process is killed hard, a job may be left `running`. At the next start it is re-queued. A
running instance also re-queues any job whose lease (`VEYRA_JOB_LEASE_MS`, 15 min) expired. A
re-run is safe: every step no-ops when already done, and ERP writes reuse their idempotency keys,
so nothing is recorded twice.

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
- **Correlation:** every response has `x-request-id`, and every error body has `error.requestId`.

Never logged: credentials, authorization headers, cookies, request or response bodies, document
contents, OCR text, ERP payloads (a redaction list is the second line of defence).

Logs are operational. The **business audit trail** (who uploaded, what Veyra read and matched,
who decided, what was recorded in the ERP) lives in the database table `audit_events` and the
product's Audit screen, and is backed up with the database.

## 10. Backups and recovery

SQLite has no built-in replication or point-in-time recovery. Backups are file copies taken on a
schedule, so anything after the last backup can be lost. PostgreSQL, with managed backups and
point-in-time recovery, is a **future phase**; until then these steps are the whole story.

**What to back up**

| What | Where | How |
|---|---|---|
| Application database | `<VEYRA_DATA_DIR>/veyra.db` | SQLite online backup (below) |
| Fake ERP database (while it is the ERP) | `<VEYRA_DATA_DIR>/fake_erp.db` | the same |
| Documents | `VEYRA_STORAGE_DIR` (default `<VEYRA_DATA_DIR>/uploads`) | `rsync` to another machine or bucket |
| Configuration and secrets | your secret store / `/etc/veyra/*.env` | handled separately, never with the data |

**Frequency and retention (recommendation)**

- Databases: every hour, and always immediately before `db:migrate`. Keep hourly backups for
  48 h, daily for 30 days and monthly for 12 months, or longer if your accounting records require
  it.
- Documents: at least daily. They never change after upload, so copies only ever add files.

**Taking a database backup (safe while Veyra runs)**

```
sqlite3 /var/lib/veyra/veyra.db ".backup '/backups/veyra-$(date -u +%Y%m%dT%H%M%SZ).db'"
sqlite3 /var/lib/veyra/fake_erp.db ".backup '/backups/fake_erp-$(date -u +%Y%m%dT%H%M%SZ).db'"
rsync -a /var/lib/veyra/uploads/ backup-host:/backups/veyra-uploads/
```

Do not copy `veyra.db` with `cp` while the service runs: recent writes are in `veyra.db-wal`.
Copy backups off the server and encrypt them at rest.

**Verifying (weekly, automated)**

```
sqlite3 /backups/veyra-….db "PRAGMA integrity_check;"      # must print: ok
sqlite3 /backups/veyra-….db "SELECT count(*) FROM invoices; SELECT max(created_at) FROM audit_events;"
```

A backup is only proven by restoring it. Once a month, restore the latest set into staging and
open the app.

**Restoring**

1. Stop the service.
2. Move `veyra.db`, `veyra.db-wal` and `veyra.db-shm` aside (and the same for `fake_erp.db`).
3. Copy the backups into place as `veyra.db` / `fake_erp.db`.
4. Restore the documents folder from its copy.
5. Run `npm run db:migrate -w @veyra/api`, in case the backup is older than the code.
6. Start the service and check `/api/v1/health/ready`.

An invoice whose document is missing answers "not available" when opened; restore that file.

## 11. Rollback

- **Release without a migration:** check out the previous commit, `npm ci`, rebuild the web app and
  restart.
- **Release with a migration:** migrations only go forward. Stop the service, restore the
  database backup taken just before `db:migrate`, deploy the previous commit and start. Work done
  after that backup is lost, so prefer fixing forward once real data has changed.

## 12. Limits and protection (defaults)

- **Uploads:** PDF, PNG or JPEG decided by the file's bytes (never its name or the browser), up to
  20 MB (`VEYRA_MAX_UPLOAD_BYTES` can lower it). An identical file (same SHA-256) is refused.
- **Documents:** PDFs up to 20 pages; images up to 12,000 px a side and 40 MP. Both can be lowered.
- **Imports:** up to 8 files of 5 MB.
- **JSON bodies:** up to 1 MB.
- **Rate limits, per client address per minute:** uploads 60, processing actions (answer, reject,
  reprocess, confirm import) 120, demo endpoints 60. Over the limit: 429 with `Retry-After`.
  These limits are **per process**. That covers the whole service while there is one instance,
  but they are not a distributed limiter; add edge limits at the proxy for anything
  internet-facing.
- **Errors:** a stable `code`, a safe `message` and the `requestId`; never stack traces, SQL,
  paths, headers or credentials.
- **Production:** no `/dev/*` endpoints (reset, demo scenarios), no demo seed and no fixture
  extractor. These are enforced by the server.
