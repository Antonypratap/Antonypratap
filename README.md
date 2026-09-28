# Veyra

AI-assisted business transaction automation. The V1 use case is purchase invoice → **Verified Pending Payment**.

**READ → FIND → USE → IF MISSING, CREATE → VALIDATE → ASK HUMAN WHEN UNCERTAIN.**
Never guess · No tolerance · No approval hierarchy · No timeout · No payment execution.

Status: architecture approved (rev 3). Phases 0–2 complete; Phase 3B vertical slice complete: upload → extract (fixture) → resolve → match → ask → validate → commit to the ERP → **Verified Pending Payment**, with the product UI on the real API. Phase 3C adds the Excel business data bridge: businesses without a connected ERP import vendors, items, purchase orders and goods receipts from Excel/CSV templates (validated, previewed, imported atomically) and export invoices, decisions and the audit trail ([ARCHITECTURE §14](docs/ARCHITECTURE.md), [DEMO §6](docs/DEMO.md)). Phase 3D reads real invoices: PDF (text layer), scanned PDFs, JPEG and PNG (Tesseract OCR), locally and for free, with an optional grounded Ollama assist; the extraction is untrusted and the deterministic rules decide ([ARCHITECTURE §15](docs/ARCHITECTURE.md), [DEMO §7](docs/DEMO.md)). Phase 3E makes it demonstrable in about three minutes: one-click demo scenarios and reset, questions presented as decisions, and an evidence-backed "Invoice ready" ([DEMO §8](docs/DEMO.md)). Phase 4 hardens the ERP boundary: declared capabilities (unsupported is an error, never a fallback), typed connection status and safe errors, a write ledger with reconciliation so a lost ERP response is never recorded twice or shown as ready, and a read-only "Business system" view ([ARCHITECTURE §17](docs/ARCHITECTURE.md)). Phase 6 lays the production foundation: development/staging/production configuration validated at startup, document storage on a local volume or any S3-compatible bucket, explicit migrations, job leases and bounded retries, liveness/readiness checks, safe errors with request ids, structured logs, rate limits and graceful shutdown. See [OPERATIONS](docs/OPERATIONS.md) for deployment, backups and the current limits (SQLite single instance; no authentication yet).

- [Architecture & implementation plan](docs/ARCHITECTURE.md)
- [Business rules](docs/RULES.md)
- [Demo data & scenarios](docs/DEMO.md)

**Demo access gate.** In the demo environment the product workspace (`#/app/…`) asks for a demo PIN once per browser tab (*See Veyra in action* on the homepage leads there); the marketing homepage stays public. It is a gate for demos, not authentication: there are no users or sessions, the API is not gated, and the PIN (shared with the demo team, never shown in the UI) is compared by digest in `apps/web/src/access/`, which real authentication will replace.

## Development

Requires Node 22.12 or newer (see `.nvmrc`). Check with `node -v`. Nothing else: OCR runs in Node.

```sh
npm install
npm run check        # format:check → lint → typecheck → test → db:verify → health (what CI runs)
```

| Command | What it does |
|---|---|
| `npm run check` | Full gate: format check, lint, typecheck, tests, health |
| `npm run typecheck` | `tsc` for every workspace plus `scripts/` |
| `npm run lint` / `lint:fix` | ESLint (typescript-eslint strict + Prettier-compatible) |
| `npm run format` / `format:check` | Prettier |
| `npm test` / `test:watch` | Vitest across all workspaces |
| `npm run health` | Toolchain and workspace wiring check |
| `npm run db:verify` | Fails if the fake ERP or Veyra schema and its migration drift apart |
| `npm run demo` | API (fixture extractor, demo ERP) + web app. `npm run demo -- --reset` starts from the DEMO.md seed. Open http://localhost:5173/#/app/inbox and upload files from `fixtures/invoices/` |
| `npm run demo -- --empty` | The same, starting from a business with only its company record: import records from `fixtures/imports/` (DEMO.md §6) |
| `npm run dev:api` / `dev:web` | The API alone (http://127.0.0.1:8787/api/v1) / the web app alone (proxies `/api` to the API) |
| `npm run fixtures:documents` | Re-render the synthetic real-extraction invoices in `fixtures/documents/` (needs Chromium: `VEYRA_CHROMIUM=/path/to/chrome`, or a Playwright browser) |
| `npm run fixtures:generate` | Regenerate the deterministic demo invoice files in `fixtures/invoices/` and the import templates and demo files in `fixtures/imports/` |
| `npm run db:migrate -w @veyra/api` | Apply pending Veyra database migrations and exit (a deployment step in production; see [OPERATIONS](docs/OPERATIONS.md)) |
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

