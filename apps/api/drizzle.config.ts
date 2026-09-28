import { defineConfig } from 'drizzle-kit';

// `npm run db:generate -w @veyra/api` regenerates the PostgreSQL migration from src/db/schema.ts.
// (drizzle-sqlite/ holds the retired SQLite migrations, used only by `db:migrate-from-sqlite`.)
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
