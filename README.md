# Veyrafy

<img src="docs/brand-logo.png" alt="Veyrafy" width="96">

**Name:** the product is **Veyrafy**. `veyra` remains the internal code name: package names (`@veyra/*`), environment variables (`VEYRA_*`), the session cookie, the `VEYRA_ADMIN` role and database names. Customers never see these, and renaming them would force a configuration change and log everyone out, so they stay.

AI-assisted business transaction automation. The V1 use case is purchase invoice → **Verified Pending Payment**.

**READ → FIND → USE → IF MISSING, CREATE → VALIDATE → ASK HUMAN WHEN UNCERTAIN.**
Never guess · No tolerance · No approval hierarchy · No timeout · No payment execution.

Status: architecture approved (rev 3). Phases 0–2 complete; Phase 3B vertical slice complete: upload → extract (fixture) → resolve → match → ask → validate → commit to the ERP → **Verified Pending Payment**, with the product UI on the real API. Phase 3C adds the Excel business data bridge: businesses without a connected ERP import vendors, items, purchase orders and goods receipts from Excel/CSV templates (validated, previewed, imported atomically) and export invoices, decisions and the audit trail ([ARCHITECTURE §14](docs/ARCHITECTURE.md), [DEMO §6](docs/DEMO.md)). Phase 3D reads real invoices: PDF (text layer), scanned PDFs, JPEG and PNG (Tesseract OCR), locally and for free, with an optional grounded Ollama assist; the extraction is untrusted and the deterministic rules decide ([ARCHITECTURE §15](docs/ARCHITECTURE.md), [DEMO §7](docs/DEMO.md)). Phase 3E makes it demonstrable in about three minutes: one-click demo scenarios and reset, questions presented as decisions, and an evidence-backed "Invoice ready" ([DEMO §8](docs/DEMO.md)). Phase 4 hardens the ERP boundary: declared capabilities (unsupported is an error, never a fallback), typed connection status and safe errors, a write ledger with reconciliation so a lost ERP response is never recorded twice or shown as ready, and a read-only "Business system" view ([ARCHITECTURE §17](docs/ARCHITECTURE.md)). Phase 6B hardens the production runtime (SQLite kept): configuration validated per environment, documents behind a storage interface (local disk today), explicit migrations, job leases and bounded retries, liveness/readiness checks, request ids, safe errors, structured logs, per-process rate limits, graceful shutdown and server-side lock-down of demo endpoints in production. Phase 6A moves the Veyrafy application database to PostgreSQL (async, pooled, safe with several workers), with a verified one-time import from SQLite; development runs embedded PostgreSQL with no setup. Phase 6C adds the security and data protection foundation: sign-in with Argon2id passwords and server-side sessions, three roles (ADMIN, FINANCE, REVIEWER) enforced by the server on every route, CSRF protection, security headers, audited document access, a security audit trail, redacted logs, secret handling and a least-privilege database role ([SECURITY](docs/SECURITY.md)). See [DEPLOYMENT](docs/DEPLOYMENT.md) and [PRODUCTION-READINESS](docs/PRODUCTION-READINESS.md) (documents on local disk; no multi-factor authentication yet).

- [Architecture & implementation plan](docs/ARCHITECTURE.md)
- [Business rules](docs/RULES.md)
- [Demo data & scenarios](docs/DEMO.md)
- [Security & data protection](docs/SECURITY.md)

**Signing in.** The product workspace (`#/app/…`) needs a signed-in session; the marketing homepage stays public. Users sign in with email and password; the server enforces each role's permissions on every API route. In demo environments (never production) the sign-in page also offers the demo PIN (`8824` in development; *See Veyrafy in action* on the homepage leads there): the server checks it and opens a session as the demo's designated user (an ADMIN). To use a password account locally, create one with `npm run users -w @veyra/api -- create` (see the table below).

## Development

Requires Node 22.12 or newer (see `.nvmrc`). Check with `node -v`. Nothing else: OCR runs in Node.

```sh
npm install
export TEST_DATABASE_URL=postgres://…   # a disposable PostgreSQL for the API tests (docs/DEPLOYMENT.md §13)
npm run check        # format:check → lint → typecheck → test → db:verify → secrets:scan → health (what CI runs)
```

| Command | What it does |
|---|---|
| `npm run check` | Full gate: format check, lint, typecheck, tests, schema drift, secret scan, health |
| `npm run secrets:scan` | Fails on committed credentials, tracked `.env` files or server configuration in the web build (pattern-based; see SECURITY §17) |
| `npm run audit:deps` | `npm audit` of the shipped dependencies, failing on high/critical (CI runs it) |
| `npm run users -w @veyra/api -- <command>` | Users from the server: `list`, `create --email E --name N --role ADMIN\|FINANCE\|REVIEWER\|VEYRA_ADMIN` (password on stdin; VEYRA_ADMIN is a Veyrafy operator, [OPERATIONS](docs/OPERATIONS.md)), `set-password`, `disable`, `enable`, `revoke-sessions (--email E \| --all)` |
| `npm run typecheck` | `tsc` for every workspace plus `scripts/` |
| `npm run lint` / `lint:fix` | ESLint (typescript-eslint strict + Prettier-compatible) |
| `npm run format` / `format:check` | Prettier |
| `npm test` / `test:watch` | Vitest across all workspaces |
| `npm run health` | Toolchain and workspace wiring check |
| `npm run db:verify` | Fails if the fake ERP or Veyrafy schema and its migration drift apart |
| `npm run demo` | API (fixture extractor, demo ERP) + web app. `npm run demo -- --reset` starts from the DEMO.md seed. Open http://localhost:5173/#/app/inbox and upload files from `fixtures/invoices/` |
| `npm run demo -- --empty` | The same, starting from a business with only its company record: import records from `fixtures/imports/` (DEMO.md §6) |
| `npm run dev:api` / `dev:web` | The API alone (http://127.0.0.1:8787/api/v1) / the web app alone (proxies `/api` to the API) |
| `npm run fixtures:documents` | Re-render the synthetic real-extraction invoices in `fixtures/documents/` (needs Chromium: `VEYRA_CHROMIUM=/path/to/chrome`, or a Playwright browser) |
| `npm run fixtures:generate` | Regenerate the deterministic demo invoice files in `fixtures/invoices/` and the import templates and demo files in `fixtures/imports/` |
| `npm run db:migrate -w @veyra/api` | Apply pending PostgreSQL migrations to the Veyrafy database and exit (a deployment step in production; see [DEPLOYMENT](docs/DEPLOYMENT.md)) |
| `npm run db:migrate-from-sqlite -w @veyra/api -- --from <veyra.db> [--dry-run]` | One-time, verified, non-destructive import of a pre-6A SQLite database into PostgreSQL |
| `npm run bench -w @veyra/api -- <label> [suites]` | Performance benchmark on a disposable database from `TEST_DATABASE_URL` (suites `db,api,erp,flows,answer,reprocess,ocr`); writes `apps/api/bench/results/<label>.json`. Compare two runs with `cd apps/api && npx tsx bench/compare.ts a b`; query plans with `npx tsx bench/explain.ts` ([PERFORMANCE](docs/PERFORMANCE.md)) |
| `npm run bench:load -w @veyra/api -- <label>` | Load test with 1 and 3 workers: concurrent uploads, photos (OCR), answers, inbox clients, plus invariant checks (no lost job, no duplicate ERP record) |
| `docker build -f apps/api/Dockerfile -t veyra-api .` | The API + worker image for a container host with a persistent volume ([DEPLOYMENT §14](docs/DEPLOYMENT.md)) |
| `VEYRA_DEMO_URL=… VEYRA_DEMO_PIN=… node scripts/demo-check.mjs` | End-to-end check of a hosted demo in a real browser (the public journey, the scenarios, what anonymous callers cannot reach) |
| `npm run erp:reset [-- <path>]` | Recreate `data/fake_erp.db` with the DEMO.md seed (deterministic) |

Workspaces: `packages/{shared,india-tax,erp-connector,fake-erp,extractor}`, `apps/{api,web}`.

## Reading invoices (local, free)

| Document | How it is read | Field `source` |
|---|---|---|
| PDF with a text layer | Its text, exactly (`pdfjs-dist`) | `pdf_text` |
| Scanned PDF (image only), JPEG, PNG | Tesseract OCR (`tesseract.js`, WebAssembly) | `tesseract` |
| Anything the parser could not find | Optional local model, grounded in the document text | `ollama` |
| Demo sample invoices in `fixtures/invoices/` (demo only) | Their scripted reading | `fixture` |

**Tesseract needs no installation.** `npm install` brings `tesseract.js` and its English model (`@tesseract.js-data/eng`); nothing is downloaded at run time and no system package is needed. The first OCR after start-up takes about a second longer while the engine loads; a page then takes 1–3 s.

**Ollama (optional).** Install [Ollama](https://ollama.com), pull a model (e.g. `ollama pull llama3.1`), then start the API with:

```sh
VEYRA_OLLAMA_URL=http://127.0.0.1:11434 VEYRA_OLLAMA_MODEL=llama3.1 npm run demo
```

Without it, nothing changes: fields the parser cannot find are asked. With it, the model may only propose values for such fields, only by quoting text printed on the document, and every proposal is shown to the designated user to confirm (confidence capped at 0.50).

**Limits.** PDF, JPEG, PNG only (type from the file's bytes); 20 MB per file; 20 pages per PDF; images up to 12,000 px a side and 40 MP; one invoice per file. What is unclear becomes a question; nothing is guessed. See [ARCHITECTURE §15](docs/ARCHITECTURE.md) for the trust and evidence model and the current limitations.

