/**
 * Starts the Veyra API: `npm run dev:api` (or `npm run demo` for API + web).
 * Data lives in VEYRA_DATA_DIR (default <repo>/data/veyra): veyra.db, fake_erp.db and uploads/.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';

const port = Number(process.env.VEYRA_API_PORT ?? 8787);
const app = await createApp({
  dataDir: resolve(
    process.env.VEYRA_DATA_DIR ?? fileURLToPath(new URL('../../../data/veyra', import.meta.url)),
  ),
  demo: process.env.VEYRA_DEMO !== 'false',
  allowFixtureExtractor: process.env.VEYRA_ALLOW_FIXTURE_EXTRACTOR === 'true',
  nodeEnv: process.env.NODE_ENV,
  ollama: process.env.VEYRA_OLLAMA_URL
    ? { baseUrl: process.env.VEYRA_OLLAMA_URL, model: process.env.VEYRA_OLLAMA_MODEL ?? 'llama3.1' }
    : null,
  logger: process.env.VEYRA_LOG === 'true',
});
app.runner.start();
await app.server.listen({ host: '127.0.0.1', port });
console.log(`Veyra API on http://127.0.0.1:${port}/api/v1`);

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
