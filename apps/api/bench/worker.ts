/**
 * A separate worker PROCESS for the load test (bench/load.ts): the same application over the same
 * database, data directory and ERP file, running only the job loop, like a second API instance.
 * Prints its resource peaks as one JSON line when told to stop.
 */
import { createApp } from '../src/app';

const url = process.env.BENCH_DATABASE_URL;
const dataDir = process.env.BENCH_DATA_DIR;
if (!url || !dataDir) throw new Error('BENCH_DATABASE_URL and BENCH_DATA_DIR are required');

const app = await createApp({
  dataDir,
  demo: true,
  allowFixtureExtractor: false,
  nodeEnv: 'test',
  migrate: false,
  database: { url, pool: { max: 5 } },
});
app.runner.start();
let peakRss = 0;
let peakHeap = 0;
const cpu0 = process.cpuUsage();
const t0 = Date.now();
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
}, 200);
process.stdout.write('ready\n');
process.on('SIGTERM', () => {
  clearInterval(sampler);
  const cpu = process.cpuUsage(cpu0);
  void app.close(5_000).then(() => {
    process.stdout.write(
      `${JSON.stringify({
        pid: process.pid,
        peakRssMb: Math.round(peakRss / 1048576),
        peakHeapMb: Math.round(peakHeap / 1048576),
        cpuSeconds: Math.round((cpu.user + cpu.system) / 1e4) / 100,
        wallSeconds: Math.round((Date.now() - t0) / 10) / 100,
      })}\n`,
    );
    process.exit(0);
  });
});
