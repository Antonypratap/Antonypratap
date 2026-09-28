import { createApp, type AppConfig } from '../app';
import { createTestDatabase } from './database';

/**
 * `createApp` for tests: the app gets its own fresh PostgreSQL database (TEST_DATABASE_URL), which
 * `close()` drops again.
 */
export async function createTestApp(
  config: AppConfig,
): Promise<Awaited<ReturnType<typeof createApp>>> {
  const database = await createTestDatabase();
  const app = await createApp({ ...config, database: { url: database.url } });
  const close = app.close;
  return Object.assign(app, {
    close: async (graceMs?: number) => {
      await close(graceMs);
      await database.drop();
    },
  });
}
