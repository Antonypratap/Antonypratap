# Deploying Veyrafy

How to run Veyrafy as a hosted application: prerequisites, configuration, build, database
migrations, startup, health, shutdown, storage, logs, backups and rollback. What is **not**
production-ready yet is in [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md); design background is
in [ARCHITECTURE §18–20](ARCHITECTURE.md). The threat model, the security controls and what each
deployment must provide are in [SECURITY.md](SECURITY.md); work through its **Before Production
Customer** checklist before real customer data goes in.

> **Read this first.** Every API request except the health probes and sign-in needs a signed-in
> session; roles are enforced by the server (SECURITY.md §4–7). What Veyrafy does **not** provide
> itself: TLS (the reverse proxy), keeping PostgreSQL off the internet, encrypted backups,
> multi-factor authentication. The demo PIN exists only in demo environments and never in
> production.

## 1. Prerequisites

- **PostgreSQL 14 or newer** (16 recommended) for the Veyrafy application database. A managed
  service (AWS RDS, DigitalOcean Managed PostgreSQL, …) or your own server. Staging and production
  each get their **own** database.
- A Linux VM or container host with **Node.js ≥ 22.12** and `npm`.
- A **persistent disk** mounted for Veyrafy's data (for example `/var/lib/veyra`). It holds the
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
| `VEYRA_ORGANIZATION_NAME` | `Toit` | **required** | **required** |
| `VEYRA_PUBLIC_ORIGIN` | the Vite dev/preview origins | **required** | **required**, `https://` |
| `VEYRA_COOKIE_SECURE` | off (plain http on localhost) | on | on, **cannot be turned off** |
| `VEYRA_DEMO_PIN` | `8824` when the demo is on | **required** if the demo is on | ignored (no demo sign-in) |
| `DATABASE_MIGRATION_URL` | optional | optional | recommended (schema owner, `db:migrate` only) |

- **`DATABASE_URL`**: `postgres://veyra_app:password@host:5432/veyra?sslmode=verify-full`, the
  least-privilege runtime role (SECURITY.md §13). It is a **secret**: keep it in the platform's
  secret store. Veyrafy never prints, logs or returns it; a malformed URL is reported by name only.
  In production a database on another host must use TLS (`sslmode=verify-full` or `require`);
  startup refuses otherwise unless `VEYRA_DB_REQUIRE_TLS=false` is set explicitly (only on a
  private network; a documented risk).
- **`DATABASE_MIGRATION_URL`**: the schema owner's URL, used only by `db:migrate` (falls back to
  `DATABASE_URL`). Keep it out of the running API's environment where practical.
- **Sign-in:** `VEYRA_SESSION_IDLE_MINUTES` (default 30) and `VEYRA_SESSION_ABSOLUTE_HOURS`
  (default 12) bound every session. `VEYRA_PUBLIC_ORIGIN` is the exact address users open (for
  example `https://veyra.toit.example`): state-changing requests from any other origin are refused.
  `VEYRA_CORS_ORIGINS` lists other origins allowed to call the API with credentials (normally
  none: the web app and the API share one origin). `*` is refused.
- **Local AI:** `VEYRA_OLLAMA_URL` must be on the same machine or a private network;
  `VEYRA_OLLAMA_ALLOW_REMOTE=true` is required to send document text anywhere else
  (SECURITY.md §12).
- **Pool:**
  - `VEYRA_DB_POOL_MAX` (default 10) is the number of connections per API process.
  - `VEYRA_DB_CONNECT_TIMEOUT_MS` (default 5 s) bounds a connection attempt.
  - `VEYRA_DB_STATEMENT_TIMEOUT_MS` (default 30 s) cancels a runaway statement.
  - Keep `processes × VEYRA_DB_POOL_MAX` below the server's `max_connections`.
- **Development without `DATABASE_URL`:** Veyrafy runs PostgreSQL **embedded in the process** (PGlite,
  stored in `<VEYRA_DATA_DIR>/pgdata`). It is the same SQL, schema and migrations, with nothing to
  install, so `npm run demo` works out of the box. It is refused outside development. Point
  `DATABASE_URL` at a real server to develop against one.

If something is missing or invalid, the API prints what is wrong **by variable name** and exits
with status 1. It never prints values and never starts half-configured. Secrets (today:
`DATABASE_URL`, `DATABASE_MIGRATION_URL`, `VEYRA_DEMO_PIN`; later ERP credentials) go in the
platform's secret store, never in Git, the image or the frontend (SECURITY.md §11). The web app is static files with no configuration; anything given
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

The Veyrafy application database is **PostgreSQL**. Migrations are the versioned SQL files in
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
- **Production:** never automatic. Take a backup (section 10), then, with the schema owner's
  credential:

  ```
  DATABASE_MIGRATION_URL=… npm run db:migrate -w @veyra/api   # "applied N migration(s): …" or "already up to date"
  psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 -f apps/api/sql/runtime-role.sql
  ```

  The second command (re)grants the runtime role on every table, including new ones: rows only,
  no DELETE or DDL, and the two audit trails append-only. Its header shows how to create the two
  roles once (SECURITY.md §13).

  Migration `0002_perf_indexes` (Phase 7) adds four indexes with plain `CREATE INDEX`, which
  blocks writes to `questions`, `extractions` and `jobs` while it builds. That is well under a
  second at today's sizes (about 1 MB per index at 19,000 invoices). On a very large database,
  run it in a quiet window.

  If this step is skipped, the API refuses to start and names the pending migrations. Nothing in
  Veyrafy resets or deletes production data (`/dev/reset` does not exist in production).

### Moving an existing SQLite database (once)

Veyrafy used SQLite (`veyra.db`) before Phase 6A. To carry an existing installation over:

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

Any difference, or any value it would have to reinterpret (such as a timestamp not in Veyrafy's
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
- **Document readers are loaded before the process listens** (Phase 7): pdf.js and the
  Tesseract OCR engine are started, and a tiny generated PDF is read once. It takes about 1–2 s
  at startup (the log says `document readers loaded`) and saves that much on the first invoice.
  A failure here is logged and does not stop startup.
- **Frontend:** serve `apps/web/dist/` as static files and route `/api/` to the API on the same
  origin (on Vercel: `apps/web/vercel.json`, §14). Send the web security headers from `apps/web/src/security-headers.ts` with the static
  files (the Caddy example below has them); the API sets its own.
- **First administrator** (once per environment; the password is read from stdin, never from
  arguments or the environment):

  ```
  read -rs P && printf '%s\n' "$P" | npm run users -w @veyra/api -- create \
    --email you@toit.example --name "Your Name" --role ADMIN && unset P
  ```

  Other users are then created by an ADMIN in the product (`/api/v1/users`) or with the same
  command. `npm run users -w @veyra/api` also lists, disables, resets passwords and ends sessions.
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

Example Caddy site (TLS is automatic; `VEYRA_PUBLIC_ORIGIN=https://veyra.example.com`,
`VEYRA_TRUST_PROXY=1`):

```
veyra.example.com {
  handle /api/* {
    reverse_proxy 127.0.0.1:8787
  }
  handle {
    root * /srv/veyra/apps/web/dist
    try_files {path} /index.html
    file_server
    # Exactly the headers in apps/web/src/security-headers.ts (vite preview sends the same).
    header {
      Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
      X-Content-Type-Options nosniff
      Referrer-Policy no-referrer
      X-Frame-Options DENY
      Permissions-Policy "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()"
      Cross-Origin-Opener-Policy same-origin
      Strict-Transport-Security "max-age=31536000"
    }
  }
}
```

## 6. Health checks

| Endpoint | Answers | Use for |
|---|---|---|
| `GET /api/v1/health/live` | `200 {"status":"ok"}` whenever the process is up. Checks nothing else, not even the database. | Liveness probe (restart when it fails) |
| `GET /api/v1/health/ready` | `200 ready` or `503 not_ready`. Checks that PostgreSQL answers, document storage and the worker loop. In staging and production an anonymous caller gets only these statuses and failure codes. | Readiness probe, uptime monitor |
| `GET /api/v1/health` | `{ok, demo}` (the web app asks whether the demo is on). In development it also names the environment, ERP and extractor. | Compatibility |
| `GET /api/v1/system/status` | The full readiness report: the checks, ERP status, job counts, pool, worker tick. **ADMIN only** (a signed-in session). | Operations, alert checks |

The full report (`/api/v1/system/status`, or `/health/ready` in development) also shows the
database connection pool (`pool`: open, idle, waiting and
the maximum, `VEYRA_DB_POOL_MAX`, default 10). A `waiting` count that stays above zero while the
host has idle CPU is the evidence for a larger pool (docs/PERFORMANCE.md §8).

The ERP does not make the instance unready: while it is unavailable, work waits and retries, and
the UI keeps working. Responses hold only statuses, codes and counts, never URLs, paths or errors.

Deployed instances keep the detail off the public probes (Phase 7C): the environment, ERP and
extractor identity, job counts and pool are diagnostics, not for the internet.

**Worth alerting on** (the job and ERP figures come from `/api/v1/system/status`):

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

- **Signed-in requests:** also carry `userId` (an opaque id, never a name or email).

Never logged: passwords, session and CSRF tokens, cookies, authorization headers, the database
URL, request or response bodies, document contents, OCR text, bank details, PAN, GSTIN, ERP
payloads. A redaction helper masks these on every line as a second line of defence, and database
errors are logged without their SQL or values (SECURITY.md §10). The business audit trail lives in
the database (`audit_events`) and the product's Audit screen; sign-ins, denials, user changes and
document access are in `security_events` (SECURITY.md §15), not in logs.

## 10. Backups and recovery

**What to back up**

| What | Where | How |
|---|---|---|
| Veyrafy application database (all workflow data and the audit trail) | PostgreSQL | managed backups with point-in-time recovery, plus `pg_dump` |
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

Copy backups off the server. **Veyrafy does not encrypt backups; the operator must.** Write dumps
and document copies to encrypted storage, or encrypt them before they leave the server (for
example `age -r <recipient> -o dump.age dump`), and confirm the database provider's snapshots are
encrypted. Only a backup role or account may read them, not the application's credentials. The
dump file contains every invoice, answer and user account (SECURITY.md §14).

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
  60, sign-in 10 (also per account). Over the limit: 429 with `Retry-After`. These limits are **per process**, not a distributed
  limiter; with several processes each counts its own. Add edge limits at the proxy.
- **Errors:** a stable `code`, a safe `message` and the `requestId`; never stack traces, SQL,
  paths, headers or credentials.
- **Production:** no `/dev/*` endpoints (reset, demo scenarios), no demo sign-in, no demo seed and
  no fixture extractor. These are enforced by the server.
- **Access:** every route but the health probes and sign-in needs a session; each role gets only
  its permissions; state-changing requests need the session's CSRF token and one of Veyrafy's
  origins (SECURITY.md §6–7).

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

## 14. Public demo: Vercel frontend and a persistent API host (Phase 7C)

> **Superseded for veyrafy.com by §15** (one image; website, demo and each client as separate
> services). This section remains valid for a Vercel-hosted frontend.

The target is `https://veyra-demo.vercel.app`:

1. The landing page.
2. **See Veyrafy in action**.
3. The demo PIN.
4. `/app/inbox`.
5. The demo scenarios, questions, audit trail and ERP demo data.

What to show and how to run the demo is in [DEMO.md §9](DEMO.md). This section covers where
each part runs and why.

### 14.1 What can run where (inspection)

| Question | Answer |
|---|---|
| A. Can `apps/web` run on Vercel as a static Vite site? | **Yes.** It is static files, hash-routed, with no server code and no secrets. |
| B. Can `apps/api` run as Vercel serverless functions? | **No.** See C–F: it is a long-lived process with a background loop, state on disk, and ~500–750 MB of memory once warm. |
| C. Is a persistent process required? | **Yes.** One process serves the API **and** runs the job loop that reads documents, matches and commits to the ERP. A function that stops after each request would leave uploaded invoices unread. |
| D. Does Tesseract need native binaries? | **No.** OCR is `tesseract.js` (WebAssembly) with its language data from npm (`@tesseract.js-data/eng`): no system packages, no download at run time. The native modules are `better-sqlite3` (fake ERP) and `@node-rs/argon2` (passwords). Both install from prebuilt binaries, or compile with the Dockerfile's build stage. |
| E. Does local storage survive an ephemeral filesystem? | **No.** Uploaded documents *and* the fake ERP's SQLite file live in `VEYRA_DATA_DIR`. On an ephemeral disk both vanish at every restart or redeploy, while PostgreSQL still points at them. The data directory must be a **persistent volume**. |
| F. PGlite vs PostgreSQL? | PGlite (embedded) is **development only**. Staging and production refuse to start without `DATABASE_URL` (a real PostgreSQL). The fake ERP stays SQLite, on the persistent volume. |
| G. Migrations on deploy? | `VEYRA_MIGRATE_ON_START=false` for the demo. Migrations run as an explicit release step (§14.3); without it the API refuses to start and names the pending migrations. Nothing resets data on deploy. |
| H. What must be hosted outside Vercel? | The API + worker process (one container, with a persistent volume) and PostgreSQL. |

**Decision:** Vercel serves the frontend only. A container host with a persistent volume runs
the API. A managed PostgreSQL holds the application database. No architectural change was
needed: the API image is the same single process as everywhere else.

### 14.2 How the pieces connect

```
browser ──https──▶ veyra-demo.vercel.app ── /            → static files (apps/web/dist)
                                          ── /app/*       → index.html (single-page app)
                                          ── /api/*       → rewrite ──https──▶ API host /api/*
                                                                               │  persistent volume:
                                                                               │  uploads + fake_erp.db
                                                                               └─▶ PostgreSQL (TLS)
```

- **The browser only ever talks to `veyra-demo.vercel.app`.** Vercel forwards `/api/*` to the API
  host (`apps/web/vercel.json`), so:
  - the session cookie (`__Host-veyra_session`, HttpOnly, Secure, SameSite=Strict) is
    first-party;
  - CSRF and origin checks see `https://veyra-demo.vercel.app`;
  - the CSP stays `connect-src 'self'`;
  - CORS stays off.
- **A direct cross-origin call would not work.** An API on another registrable domain (for example
  `*.fly.dev` next to `*.vercel.app`) would be a third-party site for the browser, and the
  SameSite=Strict session cookie would not be sent. This is by design; do not loosen it.
  `VITE_API_BASE_URL` exists for an API on a same-site subdomain (`api.example.com` next to
  `app.example.com`, with `VEYRA_CORS_ORIGINS`).
- **`vercel.json` is checked by the build on Vercel** (`apps/web/src/vercel-config.ts`):
  - the `/api` rewrite must point at a real https host;
  - the security headers must be exactly those of `security-headers.ts`, plus HSTS;
  - no environment variables may be set in the file.

  The committed file points at the placeholder `https://veyra-api.example.invalid`, so a Vercel
  build **fails until you set your API host there**. That is on purpose: a demo deployed without
  its API would look broken.

### 14.3 Steps

**1. PostgreSQL.** Create a managed PostgreSQL 14+ database for the demo only: the host's own,
or a free tier such as Neon or Supabase. Check current offers; nothing here depends on a
provider. Keep the connection URL for the secret store, with `sslmode=require` or
`verify-full`. Optionally create the least-privilege runtime role (§4, `sql/runtime-role.sql`).

**2. API host.** Any host that runs a long-lived container with a **persistent volume** and
**at least 1 GB of memory**, and does **not** stop the container when idle. Examples at the time
of writing: Fly.io (a Machine with a volume, auto-stop off), Railway (a service with a volume),
Render (a paid instance with a disk), or a small VPS with Docker. Free tiers that sleep or have no
disk do not qualify. A sleeping instance stops reading invoices until a request wakes it, and
without a disk every restart loses the documents and the ERP file. Build from the repository root:

```
docker build -f apps/api/Dockerfile -t veyra-api .
```

The image runs as the unprivileged `node` user and holds no data or secret. `/var/lib/veyra` is
the data volume. Set these variables in the host's **secret store** (never in Git, never in
Vercel):

| Variable | Value |
|---|---|
| `VEYRA_ENV` | `staging` (the demo is refused in `production`) |
| `DATABASE_URL` | the PostgreSQL URL (secret) |
| `VEYRA_DEMO` | `true` |
| `VEYRA_DEMO_PIN` | a fresh 6–12 digit PIN (secret; share it out of band) |
| `VEYRA_PUBLIC_ORIGIN` | `https://veyra-demo.vercel.app` |
| `VEYRA_ORGANIZATION_NAME` | e.g. `Toit (demo)` |
| `VEYRA_ERP` | `fake` |
| `VEYRA_ALLOW_FIXTURE_EXTRACTOR` | `false` (documents are read for real: pdf.js and Tesseract) |
| `VEYRA_MIGRATE_ON_START` | `false` |
| `VEYRA_TRUST_PROXY` | the proxies in front of the API: Vercel's edge plus the host's own router, usually `2` (see 14.4) |
| `PORT` or `VEYRA_API_PORT` | the platform's port (`PORT` is read when `VEYRA_API_PORT` is unset); the image listens on `0.0.0.0` |

Before the first start, and before any later start that ships a migration, run the release step
with the same environment:

```
docker run --rm --env-file <secrets> veyra-api node --import tsx apps/api/src/cli/migrate.ts
```

Then start the container with the volume mounted at `/var/lib/veyra`. Point the platform's
health check at `/api/v1/health/ready`, and set a stop timeout of at least 30 s (§7). The API
host's own address never needs to be shared.

**3. Vercel project.**

- **Project:** `veyra-demo`. **Root Directory:** `apps/web`.
- **Framework Preset:** Vite. **Build Command, Install Command, Output Directory:** the preset's
  defaults (`npm run build`, the npm install Vercel runs for the workspace, `dist`). Nothing
  custom.
- **Node.js:** 22.x.
- **Environment variables:** none. `VITE_API_BASE_URL` stays unset (same origin through the
  rewrite). The build refuses any `VITE_` variable except `VITE_API_BASE_URL`, because every one
  of them would be published in the JavaScript.
- **Edit `apps/web/vercel.json`:** replace `https://veyra-api.example.invalid` with the API
  host's https address, keeping `/api/:path*`. Then commit and deploy.
- **No domain purchase:** `veyra-demo.vercel.app` is Vercel's free subdomain.

**4. Verify the deployed URL** (not localhost). Use a browser machine with Chromium:

```
VEYRA_DEMO_URL=https://veyra-demo.vercel.app/ VEYRA_DEMO_PIN=… RESET=1 node scripts/demo-check.mjs
```

It walks the whole journey and exits non-zero on any failure:

- landing, **See Veyrafy in action**, a wrong PIN, the right PIN, `/app/inbox`, and a refresh on
  `/app/inbox`;
- the seven scenarios, answering the goods-receipt question, the audit trail and the ERP data;
- that anonymous callers cannot reset or read diagnostics, and a foreign origin cannot sign in;
- that the PIN appears in no script or response, with no CSP violations.

Only call the demo deployed once this passes against the public URL.

### 14.4 What to check on the real hosts

These depend on Vercel and the API host, so they cannot be proven from this repository:

- **Client addresses.** With the rewrite, requests reach the API from Vercel's edge. Check that
  the API's request logs show varying client addresses (`VEYRA_TRUST_PROXY` counts every proxy in
  front). If they all show the same address, the per-address rate limits (sign-in: 10 per minute)
  apply to all visitors together. Correct the hop count before sharing the link.
- **Upload size.** Upload a 10–20 MB photo through the Vercel URL. If Vercel's proxy refuses
  large bodies, lower `VEYRA_MAX_UPLOAD_BYTES` to what passes, or give uploads a same-site API
  subdomain.
- **Headers.** `curl -sI https://veyra-demo.vercel.app/` shows the CSP, `X-Frame-Options: DENY`
  and HSTS. `curl -s https://veyra-demo.vercel.app/api/v1/health` returns `{"ok":true,"demo":true}`.

### 14.5 Tested before deployment (locally, not on Vercel)

- The image was built.
- It refused to start with pending migrations, and ran the migration step.
- It served the demo as `staging` behind a **local emulation** of `vercel.json`: static files,
  the same headers, the `/api` rewrite, and the SPA fallback. `scripts/demo-check.mjs` passed all
  31 checks against it.
- `docker stop` (SIGTERM) exited 0 after "shutting down" → "stopped".
- Invoices, document bytes, ERP vendors and ERP purchase invoices were identical after a restart,
  and after replacing the container on the same volume.
- Inside the container, a digital invoice took 60–250 ms, a photo 1.7 s (OCR 1.5 s), and the
  process used about 505 MB.

The emulation is not Vercel. §14.4 still has to be checked on the real deployment.

## 15. Production on Railway: one image, the website and one instance per client

The step-by-step guide for the account owner is [RUNBOOK-RAILWAY.md](RUNBOOK-RAILWAY.md). This
section is the technical summary.

| Service | Address | Role | Database |
|---|---|---|---|
| website | `veyrafy.com` | `VEYRA_SITE_ONLY=true`: the built web app and its headers only | none |
| demo | `demo.veyrafy.com` | `VEYRA_ENV=staging`, `VEYRA_DEMO=true`, sample data, PIN sign-in | own PostgreSQL |
| client | `<slug>.veyrafy.com` (e.g. `toit`) | `VEYRA_ENV=production`, e-mail sign-in | own PostgreSQL |

- **One image** (`apps/api/Dockerfile`) for every service. It builds the web app (`apps/web/dist`)
  and sets `VEYRA_WEB_DIST`, so each instance serves its web app **and** `/api/v1` from one
  origin: the session cookie, CSRF and `connect-src 'self'` work unchanged, and nothing depends
  on `127.0.0.1`. `vite preview` is for local use only, never production.
- **Static files** (`apps/api/src/http/web-static.ts`): the build is read into memory at start;
  only exact build files are served (no request path reaches the file system); `/assets/*` is
  `immutable`, `index.html` and app routes are `no-cache`; encoded dots, separators and NUL are
  refused; `/api/*` stays the API (JSON 404). Pages get `webSecurityHeaders()`
  (`apps/web/src/security-headers.ts`, the same policy Vercel and `vite preview` send), API
  responses the API's own stricter policy.
- **The website process** (`apps/api/src/site-main.ts`, chosen by `main.ts` before anything else
  is loaded) reads only `VEYRA_WEB_DIST`, the port, `VEYRA_ENV`, `VEYRA_LOG_LEVEL`,
  `VEYRA_TRUST_PROXY`. It opens no database, runs no migrations, starts no ERP, storage, sign-in
  or jobs, and does not need `DATABASE_URL`. `/api/*` answers only `health/live` and `health`.
- **Addresses** (`apps/web/src/site/host.ts`): `veyrafy.com`/`www` are the website (never the
  app or a sign-in form); `<valid-slug>.veyrafy.com` is a client address, confirmed by that
  instance's `GET /api/v1/instance` (`{ name, demo }`, strict); anything else under veyrafy.com,
  or an address with no instance, shows "This Veyrafy address isn't set up." No client list
  exists in the web build, so a new client never needs a website release. The address never
  grants access: each instance serves one organization and checks the session on every call.
- **Deployed version:** `GET /api/v1/health` returns `version`, the `RAILWAY_GIT_COMMIT_SHA` of
  the running build (a plain commit hash, or null).
- **Database TLS:** production requires `sslmode=require` (or `verify-full`) for a database on
  another host; on Railway use the database's TLS address (RUNBOOK §5.3).
- **Migrations:** Railway's pre-deploy command `node --import tsx apps/api/src/cli/migrate.ts`
  on each instance (never on the website).

