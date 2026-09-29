import { createApp, type AppConfig } from '../app';
import { createTestDatabase } from './database';
import { injectAs, testSession, type TestSession } from './auth';

/**
 * `createApp` for tests: the app gets its own fresh PostgreSQL database (TEST_DATABASE_URL), which
 * `close()` drops again. `app.server.inject` is signed in as the demo's designated user (an ADMIN)
 * unless a call sets its own cookie; `anonymous` sends requests without any session.
 */
export async function createTestApp(config: AppConfig): Promise<
  Awaited<ReturnType<typeof createApp>> & {
    session: TestSession;
    anonymous: Awaited<ReturnType<typeof createApp>>['server']['inject'];
  }
> {
  const database = await createTestDatabase();
  const app = await createApp({ ...config, database: { url: database.url } });
  const session = await testSession(app);
  const anonymous = injectAs(app, session);
  const close = app.close;
  return Object.assign(app, {
    session,
    anonymous,
    close: async (graceMs?: number) => {
      await close(graceMs);
      await database.drop();
    },
  });
}
