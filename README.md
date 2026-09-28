# Veyra

AI-assisted business transaction automation. The V1 use case is purchase invoice → **Verified Pending Payment**.

**READ → FIND → USE → IF MISSING, CREATE → VALIDATE → ASK HUMAN WHEN UNCERTAIN.**
Never guess · No tolerance · No approval hierarchy · No timeout · No payment execution.

Status: architecture approved (rev 3). Phases 0–2 complete; Phase 3B vertical slice complete: upload → extract (fixture) → resolve → match → ask → validate → commit to the ERP → **Verified Pending Payment**, with the product UI on the real API.

- [Architecture & implementation plan](docs/ARCHITECTURE.md)
- [Business rules](docs/RULES.md)
- [Demo data & scenarios](docs/DEMO.md)

## Development

Requires Node 22.12 or newer (see `.nvmrc`). Check with `node -v`.

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
| `npm run dev:api` / `dev:web` | The API alone (http://127.0.0.1:8787/api/v1) / the web app alone (proxies `/api` to the API) |
| `npm run fixtures:generate` | Regenerate the deterministic demo invoice files in `fixtures/invoices/` |
| `npm run erp:reset [-- <path>]` | Recreate `data/fake_erp.db` with the DEMO.md seed (deterministic) |

Workspaces: `packages/{shared,india-tax,erp-connector,fake-erp,extractor}`, `apps/{api,web}`.
