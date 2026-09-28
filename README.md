# Veyra

AI-assisted business transaction automation. The V1 use case is purchase invoice → **Verified Pending Payment**.

**READ → FIND → USE → IF MISSING, CREATE → VALIDATE → ASK HUMAN WHEN UNCERTAIN.**
Never guess · No tolerance · No approval hierarchy · No timeout · No payment execution.

Status: architecture approved (rev 3). Phases 0–2 complete (scaffold; shared contracts and India tax; fake ERP connector on SQLite).

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
| `npm run db:verify` | Fails if the fake ERP schema and its migration drift apart |
| `npm run dev -w @veyra/web` | Marketing homepage at http://localhost:5173 (`build` / `preview` also available) |
| `npm run erp:reset [-- <path>]` | Recreate `data/fake_erp.db` with the DEMO.md seed (deterministic) |

Workspaces: `packages/{shared,india-tax,erp-connector,fake-erp,extractor}`, `apps/{api,web}`.
