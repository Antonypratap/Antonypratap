import { defineConfig } from 'drizzle-kit';

// `npm run db:generate -w @veyra/fake-erp` regenerates the SQL migration from src/db/schema.ts.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
