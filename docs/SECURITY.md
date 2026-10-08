# Veyrafy security and data protection

The security foundation added in Phase 6C: the threat model, the controls that are implemented, the
ones the deployment must provide, and what remains open. It describes what the code does and what
the tests prove. It is not a certification. Veyrafy has not been audited or penetration-tested, and
it makes no claim of SOC 2, ISO 27001, GDPR or any other compliance. Do not describe it as "secure";
describe the controls below.

Words used precisely:

- **Implemented control:** enforced by Veyrafy's code and covered by tests (file named).
- **Deployment responsibility:** something Veyrafy depends on but cannot do itself (TLS, disk
  encryption, backups, network exposure). [DEPLOYMENT.md](DEPLOYMENT.md) says how.
- **Mitigation:** reduces a risk without removing it.
- **Remaining risk:** known, not addressed yet (the list is in section 21).

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Invoice documents (PDF, JPEG, PNG) | Document storage (local disk, `VEYRA_STORAGE_DIR`) | Supplier identities, GSTIN, PAN, bank details, amounts |
| Extracted data, questions, answers, decisions | PostgreSQL | The same data in structured form, and the finance team's decisions |
| Workflow audit trail (`audit_events`) | PostgreSQL | Evidence of who decided what; must not be rewritten |
| Security audit trail (`security_events`) | PostgreSQL | Sign-ins, denials, user changes, document access |
| User accounts (email, name, role, Argon2id hash) | PostgreSQL | Access to all of the above |
| Sessions (SHA-256 of the token, CSRF token) | PostgreSQL; the token itself only in the user's cookie | A stolen token is a signed-in user until it ends |
| ERP records and the ability to write to the ERP | The ERP (today the fake ERP, a SQLite file) | Vendors, POs, goods receipts, purchase invoices |
| Secrets: `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `VEYRA_DEMO_PIN`, future ERP credentials | The platform's secret store / environment | Direct access to the data or the ERP |
| Backups | Operator-managed | A full copy of everything above |

## 2. Trust boundaries

```
 Browser ──HTTPS──▶ Reverse proxy (TLS, edge limits) ──▶ Veyrafy API ──▶ PostgreSQL
 (untrusted)          deployment responsibility          │   │   └──▶ Document storage (local disk)
                                                         │   └──────▶ ERP connector ──▶ ERP
                                                         └──────────▶ Ollama (optional, local)
```

1. **Browser → API.** Everything from the browser is untrusted: bodies, files, headers, cookies.
   The API authenticates, authorizes and validates every request itself. The web app only hides
   what a role cannot do; it decides nothing.
2. **API → PostgreSQL.** The API is trusted with a least-privilege role (section 13). The database
   must not be reachable from the internet.
3. **API → document storage.** Only the API reads or writes documents, under keys it makes from
   ids. No web server serves the storage folder.
4. **API → ERP.** Only the ERP connector talks to the ERP, and only the connector will hold ERP
   credentials (section 11). The ERP's answers are untrusted input to Veyrafy's rules.
5. **API → extractor/AI.** Document text goes to the local extractor and, if configured, to Ollama.
   What comes back is untrusted (section 12).
6. **Operator.** Whoever holds shell or secret-store access is fully trusted. That trust is outside
   what the application can control.

## 3. Attackers considered

| Attacker | Examples | Main controls |
|---|---|---|
| Anonymous internet user | Reaches the public site or the API directly | Every API route but health and sign-in needs a session; rate-limited sign-in; generic errors |
| Signed-in user beyond their role | A REVIEWER calling reject, imports or user administration directly | Server-side permission on every route, plus a second check in the application core |
| Malicious website | Cross-site requests riding the user's cookie (CSRF), framing | SameSite=Strict cookie, Origin/Fetch-Metadata check, CSRF token, `frame-ancestors 'none'` |
| Malicious document | A supplier sends a crafted PDF/image, or a file disguised as one | Type from magic bytes, size/page/pixel limits, nothing executed, served inert |
| Malicious spreadsheet (imports) | ZIP bombs, oversized sheets | Entry/size/ratio limits in the ZIP reader, file limits |
| Someone who obtains logs or a DB copy | Logs shipped to a vendor; a stolen backup | Redacted logs; only token hashes and password hashes in the DB. **Backups contain everything; see section 14** |
| Stolen ERP credentials | Leaked from a config file or a compromised host | Backend-only, secret store, incident procedure (section 19) |

Out of scope today: a compromised host or operator, a malicious PostgreSQL provider, targeted
denial of service beyond per-process rate limits, and a compromised dependency (partly addressed by
`npm audit`, section 17).

## 4. Authentication (implemented)

- **Email and password**, checked by the API (`apps/api/src/auth/users.ts`, `passwords.ts`).
  - Passwords are hashed with **Argon2id** (`@node-rs/argon2`, OWASP baseline: 19 MiB, t=2, p=1),
    salted, and stored as PHC strings. Plain-text passwords are never stored, logged or returned.
  - The only rule is 12–256 characters (NIST SP 800-63B style).
  - There is no custom cryptography and no third-party identity provider.
- **No account enumeration.** An unknown email, a wrong password, a disabled account and an
  account without a password all:
  - do the same work (a dummy hash is verified when there is no account);
  - return the same `401 INVALID_CREDENTIALS` with the same message.
- **Rate limits.** Sign-in is limited per client address **and** per account (default 10 a minute,
  `VEYRA_RATE_LIMIT_LOGIN_PER_MINUTE`).
- **Accounts.**
  - Each account has: id, email (lower-cased, unique), display name, active flag, role,
    organization, password hash, password-changed time, created and updated times.
  - The first administrator is created on the server with `npm run users -w @veyra/api -- create`
    (the password comes from stdin, never arguments). After that, an ADMIN manages users through
    `/api/v1/users`.
  - The last active ADMIN can be neither disabled nor demoted.
- **Demo sign-in (demo environments only).** `POST /api/v1/auth/demo` with the demo PIN.
  - The server compares the PIN in constant time and opens a real session as the demo's
    designated user.
  - The route is not registered unless the demo is on, and never in production (production also
    refuses `VEYRA_DEMO=true` at startup). A deployed demo must set its own `VEYRA_DEMO_PIN`.
  - The PIN is never authentication in production. The browser no longer contains any PIN check.

Tests: `src/auth/auth.test.ts`, `src/http/security.test.ts` ("authentication").

## 5. Sessions (implemented)

- **Token.** 32 random bytes from the OS CSPRNG (base64url), sent only as a cookie.
  - The database stores its SHA-256, never the token, so a database copy does not give usable
    sessions.
  - The token is never in a URL, a response body, localStorage or sessionStorage.
- **Cookie.**
  - `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`.
  - Outside development it is `Secure` and named `__Host-veyra_session`, which binds it to the
    exact origin. Production refuses `VEYRA_COOKIE_SECURE=false`.
- **Ending a session.** A session ends at the first of:
  - sign-out, which is revoked on the server;
  - `VEYRA_SESSION_IDLE_MINUTES` without a request (default 30);
  - `VEYRA_SESSION_ABSOLUTE_HOURS` after sign-in (default 12), however active;
  - the user being disabled;
  - the user's password changing (every session of that user ends).
- **Rotation.** Signing in always creates a new session and ends the one the browser held before,
  so a session cannot be fixed. A password change also issues a fresh session for the browser that
  made it.
- **Concurrent sessions** are allowed, one per browser. Each is independent and revocable; the
  CLI can end all of a user's sessions, or everyone's.
- **Comparisons.** Tokens are compared by hash lookup, and CSRF tokens and the demo PIN with
  `timingSafeEqual`.

## 6. Authorization (implemented)

**Roles** (`packages/shared/src/auth.ts`). There are three customer roles and a small, flat permission list.

**Veyrafy's operators are separate** (Phase 8A, [OPERATIONS.md](OPERATIONS.md)):

- `VEYRA_ADMIN` lives in Veyrafy's own platform organization. It has only `ops.view` and
  `ops.manage` (Veyrafy Operations: plans, entitlements, usage, health), and no customer permission.
- Customer routes refuse it; ops routes refuse every customer role, including ADMIN.
- It is created only with the server CLI.
- The database refuses the role in a customer organization, and any customer role in the platform
  organization.
- Commercial entitlements ([COMMERCIAL_ENTITLEMENTS.md](COMMERCIAL_ENTITLEMENTS.md)) decide what the
  organization may use. They never bypass authorization, validation or audit.

The customer roles:

| Permission | ADMIN | FINANCE | REVIEWER |
|---|:-:|:-:|:-:|
| `invoices.view`: inbox, invoices, questions, evidence | ✓ | ✓ | ✓ |
| `documents.view`: open the original document | ✓ | ✓ | ✓ |
| `questions.answer` | ✓ | ✓ | ✓ (not options that reject the invoice) |
| `audit.invoice`: one invoice's trail | ✓ | ✓ | ✓ |
| `documents.upload` | ✓ | ✓ | |
| `invoices.reject`, `invoices.reprocess` | ✓ | ✓ | |
| `erp.view`: ERP records and connection | ✓ | ✓ | |
| `audit.view`: the whole trail, business-record events | ✓ | ✓ | |
| `imports.manage`: templates, import (an ERP write) | ✓ | ✓ | |
| `exports.download` | ✓ | ✓ | |
| `demo.manage`: reset and scenarios (demo only) | ✓ | ✓ | |
| `users.manage` | ✓ | | |
| `security.audit`: the security audit trail | ✓ | | |

**Enforcement.** Enforcement is centralized, in `apps/api/src/http/access.ts`.

- Every route declares `config.access`: `public`, `session` or a permission. A route without a
  declaration **stops the server from starting**, so a new endpoint cannot be added unprotected
  by accident.
- The check runs in `onRequest`, before any body is read. It returns:
  - `401 UNAUTHENTICATED` with no valid session;
  - `403 FORBIDDEN` when the role lacks the permission (recorded as `access.denied`);
  - `404` for unknown routes.
- Public routes: the three health probes, `GET /auth/session`, `POST /auth/login` and, in demo
  environments, `POST /auth/demo`. The marketing homepage is static and public.

**Defence in depth.** The application core checks again. `Veyra.requireActor(userId, permission)`
runs in upload, answer, reject, reprocess and imports: the user must exist, be active, belong to
this organization and hold the permission. The acting user is always the session's user, never a
value from the request. The audit trail records that user.

**Organization boundary.** One deployment serves one configured organization
(`VEYRA_ORGANIZATION_NAME`, for example Toit).

- Each user belongs to it, and authorization runs user → organization → resource.
- Every invoice, document and record of the deployment belongs to its one organization, so no
  per-row organization column exists yet.
- This is **not multi-tenancy**. There is no organization switching, and adding a second
  organization would need per-row ownership (see section 21).

Tests: `src/http/security.test.ts` ("authorization"). The test walks every route and checks that
it refuses anonymous requests, then checks each role.

## 7. CSRF, origins and CORS (implemented)

Authentication uses cookies, so cross-site request forgery is addressed in three layers:

1. **SameSite=Strict** session cookie.
2. **Origin check.** Every state-changing request (anything but GET/HEAD/OPTIONS), sign-in
   included, is refused (`403 CSRF_REJECTED`) when:
   - its `Origin` is not one of Veyrafy's origins (`VEYRA_PUBLIC_ORIGIN`, `VEYRA_CORS_ORIGINS`); or
   - it has no `Origin` and `Sec-Fetch-Site` says `cross-site` or `same-site`.
3. **Synchronizer token.**
   - Every state-changing request with a session must send the session's CSRF token in
     `x-veyra-csrf`, compared in constant time.
   - The web app receives the token from `GET /auth/session` and keeps it in memory only.

The tests send cross-site requests to reject, reprocess, answer, logout and login, with a valid
cookie and token, and check that each is refused and nothing changed.

**CORS** is off by default: the web app and the API share one origin. `VEYRA_CORS_ORIGINS` enables
it for listed origins only, exactly, with credentials. `*` is refused at startup, and production
requires `https://`.

## 8. Security headers (implemented)

- **API responses** (`@fastify/helmet` plus one header of our own):
  - `Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
    `Cross-Origin-Resource-Policy: same-origin`;
  - HSTS when cookies are Secure;
  - `Permissions-Policy` (camera, microphone, geolocation, payment, … all off). Helmet has no
    Permissions-Policy support, so Veyrafy sets this header itself.
  - `Cache-Control: no-store` on every API response.
- **Web app** (`apps/web/src/security-headers.ts`):
  - A strict CSP allowing only same-origin scripts and styles (no inline scripts, no eval,
    no third parties), with `frame-ancestors 'none'`, plus the same companion headers.
  - `vite preview` serves the production build with exactly these headers. The browser regression
    runs against it with no CSP violations. Zod runs in its `jitless` mode in the browser
    (`apps/web/src/csp.ts`), so it never tries `eval`.
  - The reverse proxy must send the same headers in production (DEPLOYMENT.md §5).
- **Response compression** (Phase 7, `@fastify/compress`, brotli or gzip above 1 KB): only
  JSON and CSV responses. Never documents, images or spreadsheets (already compressed, and the
  document downloads keep their exact bytes). Never the sign-in responses (`/auth/login`,
  `/auth/demo`, `/auth/session`): they carry the CSRF token, and a compressed secret next to
  attacker-influenced text is what BREACH-style attacks measure. Other responses carry no secret.
  Compression never removes a security header (tested in `http/performance.test.ts`).
- **Public probes carry no diagnostics** (Phase 7C). In staging and production, anonymous
  `/health` and `/health/ready` return statuses and failure codes only. The environment, ERP and
  extractor identity, job counts and pool are at `/api/v1/system/status`, for an ADMIN.

## 9. Documents (implemented)

- **Type.** The type comes from the file's **bytes** (PDF, JPEG or PNG only), never the name or
  the browser's claim. Executables, HTML, SVG, ZIP and anything else are refused (415).
- **Limits.** Size (20 MB), PDF pages (20) and image dimensions (12,000 px a side, 40 MP) are
  enforced before processing.
- **Storage.** Files are stored under keys made from internal ids (`<documentId>.pdf`), outside
  any web root.
  - The user's filename is sanitized and kept only as metadata; it never becomes a path.
  - Storage keys are validated (no `..`, no separators), and every read is checked against the
    SHA-256 recorded at upload.
- **Nothing uploaded is ever executed.** Documents are read by pdf.js and Tesseract (WebAssembly)
  in-process. There is no shell and no interpolation of file content into commands.
- **Imports.** Imported spreadsheets go through a ZIP reader with limits: at most 200 entries,
  30 MB per entry, 60 MB in total, and inflation bounded by the declared size.
- **Downloads.**
  - Only `GET /api/v1/documents/:id/file`, which requires a session with `documents.view` and
    takes an opaque 26-character id.
  - Every download is recorded as `document.accessed`.
  - The response carries `nosniff`, `Cache-Control: private, no-store` and a CSP that allows
    nothing active. Images are also served with `sandbox`.
  - The filename is sanitized in `Content-Disposition`.
  - There are no public URLs, signed URLs, or storage paths in any response.

## 10. Logging, errors and the redaction helper (implemented)

- **What a log line holds.** Logs are JSON with opaque ids: request id, user id, invoice id,
  document id, job id.
- **Never logged:**
  - passwords, password hashes, session tokens, CSRF tokens, cookies, authorization headers,
    API keys;
  - `DATABASE_URL`;
  - request and response bodies, document contents, OCR text;
  - bank details, PAN, GSTIN, ERP payloads.
- **Redaction as a second line of defence.**
  - `redact()` (`apps/api/src/http/logging.ts`) runs on every log line. It replaces sensitive keys
    and masks secret-looking values: database URLs, PAN, GSTIN and bearer tokens.
  - Errors are logged through `safeError`: type, code and stack frames. A database error's message
    (SQL, parameters, row values) is never logged.
- **Client errors.** Clients get a stable `code`, a safe `message` and the `requestId`. They never
  get stack traces, SQL, paths, environment values, the database URL, credentials, raw ERP bodies
  or internals. The typed ERP error boundary (Phase 4) is unchanged: ERP failures reach the client
  only as `ERP_*` codes with fixed messages.

## 11. Secrets and the ERP credential boundary

**Inventory.** Every variable is described in `.env.example`, which holds placeholders only.

| Secret | Used by | Must live in |
|---|---|---|
| `DATABASE_URL` (runtime role) | API process | Platform secret store / root-only env file, never Git |
| `DATABASE_MIGRATION_URL` (schema owner) | `db:migrate` only | Secret store; not given to the running API where practical |
| `VEYRA_DEMO_PIN` | Demo/staging API only | Secret store; not set in production |
| ERP credentials (future) | ERP connector only | Secret store; see below |
| AI provider credentials (future, if ever configured) | Extractor only | Secret store; none exist today |
| `VEYRA_GOOGLE_SERVICE_ACCOUNT` (Google service-account key) | Spreadsheet registers only | Secret store; checked at start, held as a `Secret`, never logged or echoed |

**Controls:**

- `.env` and `.env.*` are git-ignored, except `.env.example`.
- In the configuration, `DATABASE_URL`, the migration URL and the demo PIN are wrapped in a
  `Secret`. Printing, logging or JSON-serializing one gives `[secret]`, and only the code that
  opens the pool calls `reveal()`.
- Configuration errors name variables, never values.
- The secret scan (section 17) fails the build on committed credentials, and on server
  configuration names appearing in the web build.
- **The web build accepts one variable only** (Phase 7C): `VITE_API_BASE_URL`, an address. Any
  other `VITE_` variable stops the build, because Vite would publish it in the JavaScript. The
  demo PIN is checked by the server and never reaches the browser.
- **`apps/web/vercel.json` cannot hold environment variables.** The Vercel build fails if it
  does, and also if its security headers differ from `security-headers.ts` (section 8).
- **The API container image** (`apps/api/Dockerfile`) holds no secret and no data, and runs as an
  unprivileged user with read-only application files. A build-time CA bundle, if one is needed,
  is passed as a BuildKit secret and not kept in the image.

**ERP credential boundary.** Implemented as a structure; there are no ERP credentials yet because
only the fake ERP exists.

- ERP configuration is a dedicated `ErpConnectorConfig` object (`apps/api/src/config.ts`). It is
  built from the environment and handed only to the composition root's connector factory.
- The workflow sees only the `ErpConnector` port. The HTTP layer, the audit trail, error responses
  and the browser never receive connector configuration.
- There is no UI for entering credentials. When the real connector arrives, its credentials are
  `Secret` fields of that object, loaded from the secret store.
- The web app has no configuration and no secrets. Anything in a frontend build is public.

**Google Sheets (spreadsheet registers).** A business can connect the Google Sheet holding its
purchase register (ARCHITECTURE.md §21).

- Veyrafy reads it as its own Google service account, with the `spreadsheets.readonly` scope
  only: it can open what was shared with it, and can never change a sheet.
- The business shares the sheet with the service address as Viewer, and ends the access by
  unsharing it. No customer password or token is stored.
- Requests go to two fixed hosts, `oauth2.googleapis.com` and `sheets.googleapis.com`, with the
  access token in a header, never in an address. Each request has a 15-second timeout, a 40 MB
  response cap and the 20,000-row limit.
- The audit trail records counts and the reason for a failed sync, never a value from the sheet.

## 12. AI and Document Data Handling

Veyrafy reads invoices with AI-assisted extraction. Where document data goes depends on the
configuration:

**LOCAL PROCESSING (default; the only mode Veyrafy ships with)**

- **pdf.js** (text layer) and **Tesseract** (OCR, WebAssembly, bundled English model) run inside
  the API process. Nothing is downloaded at run time and nothing leaves the host.
- **Ollama** (optional, off unless `VEYRA_OLLAMA_URL` is set) is a model on the same machine or
  private network.
  - It receives the document's extracted text for fields the parser could not find.
  - The configuration **refuses** an Ollama URL that is not loopback or private (RFC 1918,
    unique-local, `localhost`, single-label, `.local` or `.internal` names), unless
    `VEYRA_OLLAMA_ALLOW_REMOTE=true`.
- **FixtureExtractor** returns scripted readings of the demo's sample invoices. It is for tests
  and demos only; production refuses it at startup.

**EXTERNAL PROCESSING (Gemini; off unless configured)**

- With `VEYRA_AI_READER=gemini` and `GEMINI_API_KEY`, each uploaded invoice (the original file, or
  its pages as images) is sent to Google's Gemini API to be read. That **sends the whole invoice
  off the host**: supplier and buyer names, GSTINs, PAN, bank details, amounts.
- It is for the demo only by default: a production instance refuses to start with it unless
  `VEYRA_AI_ALLOW_PRODUCTION=true`, set only after that client agreed in writing.
- Use a **paid** (billing-enabled) Gemini API key. Check Google's current Gemini API terms for how
  paid and free usage data is handled before sending real invoices.
- The key is a secret: Railway variables only, never in Git, logs or chat. Restrict it in Google
  Cloud to the Generative Language API, and set a budget alert.
- The request carries the key in a header, never the URL. Google's error messages are logged
  (they never contain the key or the document); people see plain wording only.
- A busy or failing AI service never loses an invoice: the local reader reads it instead.
- An Ollama URL that is not local requires the explicit `VEYRA_OLLAMA_ALLOW_REMOTE=true`, which
  also sends invoice text off the host.

**Model output is untrusted.**

- Every extracted value carries its source.
- Ollama may only fill fields the parser found nothing for, only by quoting text printed on the
  document. Its confidence is capped at 0.50, so a person always confirms it.
- The deterministic rules decide, with no tolerance and no guessing, and a person answers what is
  unclear (ARCHITECTURE §15).

## 13. Database security

- **Least privilege** (implemented and tested). `apps/api/sql/runtime-role.sql` defines a runtime
  role for the API:
  - it can SELECT, INSERT and UPDATE rows;
  - it has no DELETE, TRUNCATE or DDL;
  - it cannot UPDATE `audit_events` or `security_events`, so both trails are append-only for the
    application.

  `src/db/least-privilege.test.ts` runs the whole workflow under that role and checks that
  deletes, audit rewrites and schema changes are refused.
- **Separate migration credential.** `DATABASE_MIGRATION_URL`, the schema owner, is used only by
  `db:migrate`. The running API uses `DATABASE_URL`, the runtime role.
- **TLS.** In production a database on another host must use TLS: `sslmode=require` or
  `verify-full` in the URL, preferably `verify-full`. Startup refuses a URL without it unless
  `VEYRA_DB_REQUIRE_TLS=false` is set explicitly. That waiver is a documented risk, acceptable
  only on a private network.
- **Deployment responsibility.** PostgreSQL must not be reachable from the internet: use a
  private network or security group.
- **Never logged.** `DATABASE_URL` is never logged or returned.
- **Row-Level Security** is not used. There is one organization per deployment.

## 14. Backups (deployment responsibility)

Veyrafy does not create, encrypt or store backups. The operator does (DEPLOYMENT.md §10). Required:

- **Encrypted at rest.**
  - Managed PostgreSQL snapshots are encrypted by most providers; confirm it is on.
  - `pg_dump` files and document copies must be written to encrypted storage, or encrypted before
    copying (for example `age` or `gpg`).
  - Veyrafy itself encrypts nothing at rest.
- **Access-restricted.** Backups should be readable by a separate backup role or account, not the
  application's credentials. Backups contain every invoice, answer and account.
- **Restore-tested.** A weekly automated restore check and a monthly restore into staging.
- **Provider boundary.** A managed provider is responsible for the physical security and
  encryption of its storage and snapshots, as its terms state. Veyrafy's operator is responsible
  for:
  - turning backups on;
  - retention;
  - who can restore;
  - off-provider copies;
  - testing restores.

## 15. Security audit events (implemented)

These are recorded in `security_events` and shown to ADMINs at `GET /api/v1/security/events`:

- `login.succeeded` and `login.failed` (the method; the account id when the email belongs to one;
  never the email typed or the password);
- `logout`;
- `user.created`, `user.updated` (role change), `user.disabled`, `user.enabled`;
- `password.changed`, `password.reset`;
- `access.denied` (method, route, permission);
- `document.accessed` (document id).

Invoice rejection and reprocessing, answered questions and ERP writes (attempt, result, conflict,
reconciliation) are already recorded in the workflow trail (`audit_events`), with the acting user.
Its VEYRA/YOU semantics and events are unchanged. The two trails are separate so the business
timeline never shows security noise.

## 16. Rate limiting

The limiter is in-process and in-memory, per client address per minute:

- uploads 60, processing actions 120, demo endpoints 60, sign-in 10 (per address and per
  account).
- With several API processes, each counts separately, and a restart resets the counts.
- A **distributed** limiter (a shared store) is future work. Until then, add limits at the
  reverse proxy.

## 17. Dependency and secret scanning

- **Dependencies.** `npm run audit:deps` (`npm audit --omit=dev --audit-level=high`) runs in CI and
  fails on a high or critical advisory in a shipped dependency.
  - At the time of writing it reports 0.
  - The full `npm audit` reports 4 moderate advisories in development-only tooling (esbuild,
    through drizzle-kit, the migration generator; not shipped, not reachable at run time).
    Review them when drizzle-kit is updated.
- **Secrets.** `npm run secrets:scan` (`scripts/secret-scan.ts`) is part of `npm run check` and
  CI. It scans every repository file and the web build for:
  - private keys, cloud and SaaS token shapes;
  - database URLs with real-looking passwords;
  - tracked `.env` files;
  - server configuration names in the browser bundle.

  **Limitations:**
  - it is pattern-based, so a secret without a known shape can pass;
  - it does not scan git history;
  - it ignores git-ignored files.

  Also turn on the hosting provider's secret scanning (for example GitHub secret scanning and
  push protection).

## 18. Data retention

Veyrafy keeps everything it stores until an operator removes it:

- documents, invoice data, answers, the workflow audit trail;
- ended sessions (revoked or expired rows);
- security events.

It deletes nothing automatically. **No retention period is set in Veyrafy.** The customer decides
it: accounting-record retention rules (for example under Indian GST and Companies Act
requirements) and privacy obligations apply, and should be confirmed with the customer's advisers.
Automatic deletion, purging old sessions and exporting or erasing one person's data are future
work (section 21).

## 19. Incident response

**Suspected ERP credential compromise:**

1. **Revoke** the credential in the ERP itself, first (disable the API user or key).
2. **Stop the integration.** Stop the Veyrafy API or its worker so no ERP writes are attempted.
   Invoices wait; nothing is lost.
3. **Preserve evidence.** Export the ERP's own access logs, Veyrafy's logs for the period,
   `erp_writes`, `audit_events` and `security_events`. Take a database dump before changing
   anything.
4. **Rotate.** Issue a new credential and store it only in the secret store.
5. **Investigate.** Compare ERP-side changes against Veyrafy's `erp_writes` ledger: every legitimate
   write has an idempotency key there. Anything else was not Veyrafy.
6. **Restore after verification.** Restart only when the credential is replaced, the source of the
   leak is closed, and unexpected ERP changes are reversed in the ERP.

**Suspected application compromise** (a stolen session, an account takeover, or a host or secret
exposure):

1. **Revoke sessions:** `npm run users -w @veyra/api -- revoke-sessions --all`, or `--email` for
   one account.
2. **Rotate secrets:** the database passwords (both roles), `VEYRA_DEMO_PIN` if set, and ERP
   credentials. Then restart.
3. **Investigate:** use `security_events` (sign-ins, failures, denials, document access, user
   changes), `audit_events` and the request logs (request ids tie them together). Preserve copies
   first.
4. **Reset credentials:** use `users -- set-password --email …` for affected accounts, which also
   ends their sessions. Disable unknown accounts with `users -- disable`.
5. Restore from a backup taken before the compromise if data was changed (DEPLOYMENT.md §10), and
   record what happened.

## 20. Before Production Customer checklist

Each item must be done and checked before a real customer's data goes in:

- [ ] Served only over HTTPS; `VEYRA_PUBLIC_ORIGIN` is the `https://` address; cookies are Secure
      (the default when deployed).
- [ ] The reverse proxy sends the web security headers (DEPLOYMENT.md §5), and the browser console
      shows no CSP violations.
- [ ] PostgreSQL is not internet-reachable; TLS with `sslmode=verify-full`; runtime and migration
      roles separated; `sql/runtime-role.sql` applied after every migration.
- [ ] Secrets are only in the secret store; `.env` files are not in images or Git; `npm run
      secrets:scan` passes.
- [ ] `VEYRA_DEMO` is off, and there is no `VEYRA_DEMO_PIN` in production.
- [ ] The first ADMIN was created with the CLI. Every user has their own account; no shared
      accounts.
- [ ] Backups are encrypted, access-restricted, and a restore was tested this month.
- [ ] Log shipping destination reviewed (logs are redacted but contain ids and routes).
- [ ] Ollama, if used, is local (no `VEYRA_OLLAMA_ALLOW_REMOTE`), unless the customer agreed in
      writing.
- [ ] Retention period agreed with the customer (section 18).
- [ ] `npm run audit:deps` passes on the release commit.
- [ ] Incident contacts and the procedures in section 19 are known to whoever operates the service.
- [ ] Remaining risks (section 21) reviewed and accepted by the customer where they apply.
- [ ] An independent security review or penetration test is planned before scaling beyond the
      first customer.

## 21. Remaining security risks

These are known and **not** addressed by Phase 6C:

- **No multi-factor authentication**, no password-reset-by-email, no breached-password check, and
  no account lockout beyond rate limiting.
- **Rate limiting is per process and in memory.** It is not distributed, and a restart resets it.
- **Single organization per deployment.** There is no per-row organization ownership, so a second
  organization in the same database would need schema and authorization changes first.
- **Documents on local disk,** unencrypted by Veyrafy. Encryption at rest depends on the disk or
  volume.
- **PDFs are served inline from the app origin.** Types are verified and the response is inert,
  but a flaw in a browser's PDF viewer is outside Veyrafy's control. Serving documents from a
  separate origin would be stronger.
- **Security events are append-only only when the least-privilege role is used.** A superuser or
  owner role can still change them.
- **Sessions and security events are never purged,** and there is no retention automation.
- **No malware scanning** of uploads beyond type and structure checks.
- **The secret scan is pattern-based**, and git history is not scanned.
- **Dev-only moderate advisories** in drizzle-kit's esbuild remain.
- **Denial of service** beyond the rate limits and body limits depends on the proxy and host.
- **No independent audit or penetration test** has been done.
- **Real customer documents must never go into the hosted demo.** The demo is protected only by a
  shared PIN, everyone signs in as the same ADMIN, and imported ERP receipt files keep the
  invoice PDFs inside them. A real client gets its own instance with individual accounts.
- **The hosted demo (Phase 7C) is a shared workspace.** Everyone with the PIN signs in as the same
  demo ADMIN. They can reset the demo, and create or disable demo users, for everyone. It holds
  sample data only, and production refuses the demo. Rotate the PIN, and revoke sessions, if it
  leaks further than intended (DEMO.md §9).
- **Behind Vercel's rewrite, client addresses depend on the forwarding headers** (DEPLOYMENT.md
  §14.4). If `VEYRA_TRUST_PROXY` is wrong, all demo visitors share one rate-limit bucket.

## 22. Security tests

| Area | File |
|---|---|
| Argon2id, sessions (hash-only storage, idle/absolute expiry, revocation, disabled user, password change), roles, last admin | `apps/api/src/auth/auth.test.ts` |
| Sign-in, cookie attributes, no enumeration, rotation, logout, expiry, concurrent sessions, sign-in rate limit, demo sign-in rules | `apps/api/src/http/security.test.ts` |
| Every route protected; per-role access (ADMIN, FINANCE, REVIEWER); a route without a declaration fails startup; core checks; acting user in the audit trail | `apps/api/src/http/security.test.ts` |
| CSRF token, cross-site requests refused, CORS allow-list, security headers | `apps/api/src/http/security.test.ts` |
| Document access control, audit, inert headers, opaque ids, traversal, disguised files | `apps/api/src/http/security.test.ts` |
| No secrets in responses or logs, the redaction helper, safe database error logging | `apps/api/src/http/security.test.ts`, `src/production.test.ts` |
| Production lock-down (no dev/demo/test routes) | `apps/api/src/http/security.test.ts`, `src/production.test.ts` |
| Configuration: secrets wrapped, cookie/origin/session rules, DB TLS, Ollama locality | `apps/api/src/config.test.ts` |
| Least-privilege database role | `apps/api/src/db/least-privilege.test.ts` |
| Browser: PIN checked by the server, CSRF token in memory only, no web storage or URL tokens | `apps/web/src/access/session.test.ts` |
