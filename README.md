# Veyra

AI-assisted business transaction automation. The V1 use case is purchase invoice → **Verified Pending Payment**.

**READ → FIND → USE → IF MISSING, CREATE → VALIDATE → ASK HUMAN WHEN UNCERTAIN.**
Never guess · No tolerance · No approval hierarchy · No timeout · No payment execution.

Status: architecture approved (rev 3). Phase 0 (scaffold) and Phase 1 (shared contracts, India tax, ERP connector contract) complete.

- [Architecture & implementation plan](docs/ARCHITECTURE.md)
- [Business rules](docs/RULES.md)
- [Demo data & scenarios](docs/DEMO.md)

## Development

Requires Node 22 (see `.nvmrc`; Node ≥ 20.19 works).

```sh
npm install
npm run check        # format:check → lint → typecheck → test → health (what CI runs)
```

| Command | What it does |
|---|---|
| `npm run check` | Full gate: format check, lint, typecheck, tests, health |
| `npm run typecheck` | `tsc` for every workspace plus `scripts/` |
| `npm run lint` / `lint:fix` | ESLint (typescript-eslint strict + Prettier-compatible) |
| `npm run format` / `format:check` | Prettier |
| `npm test` / `test:watch` | Vitest across all workspaces |
| `npm run health` | Toolchain and workspace wiring check |

Workspaces: `packages/{shared,india-tax,erp-connector,fake-erp,extractor}`, `apps/{api,web}`.
