/**
 * Load and concurrency test (Phase 7, docs/PERFORMANCE.md).
 *
 *   TEST_DATABASE_URL=postgres://… npm run bench:load -w @veyra/api -- <label>
 *
 * With 1 and with 3 workers (the API process plus separate worker processes on the same
 * database, documents and ERP): 10 concurrent digital uploads, 6 concurrent photo uploads (OCR),
 * 10 concurrent question answers plus a double-answer race, and 10 concurrent inbox clients.
 * After each scenario the invariants are checked: every invoice settled, no job lost or stuck, no
 * duplicate ERP record, every ERP write confirmed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { eq, sql } from 'drizzle-orm';
import * as t from '../src/db/schema';
import { rowsOf } from '../src/db/open';
import { closeRenderer, realisticMany } from './documents';
import { benchApp, call, count, mb, now, stats, upload, waitSettled, type BenchApp } from './lib';

const [label = 'load'] = process.argv.slice(2);
const results: Record<string, unknown> = { label, at: new Date().toISOString() };
const log = (...a: unknown[]) => console.log(...a);

async function startWorkers(b: BenchApp, extra: number) {
  const children: { proc: ChildProcess; report: Promise<unknown> }[] = [];
  for (let i = 0; i < extra; i++) {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'bench/worker.ts'], {
      env: { ...process.env, BENCH_DATABASE_URL: b.database.url, BENCH_DATA_DIR: b.dir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: proc.stdout as NodeJS.ReadableStream });
    let ready: () => void = () => undefined;
    const isReady = new Promise<void>((r) => (ready = r));
    const report = new Promise<unknown>((resolve) => {
      lines.on('line', (l) => {
        if (l === 'ready') ready();
        else if (l.startsWith('{')) resolve(JSON.parse(l));
      });
    });
    await isReady;
    children.push({ proc, report });
  }
  return {
    async stop() {
      for (const c of children) c.proc.kill('SIGTERM');
      return Promise.all(children.map((c) => c.report));
    },
  };
}

/** Samples this process's memory and CPU, and the database's connections. */
function sampler(b: BenchApp) {
  let peakRss = 0;
  let peakHeap = 0;
  let peakConnections = 0;
  let peakPoolWaiting = 0;
  const cpu0 = process.cpuUsage();
  const t0 = now();
  const dbName = new URL(b.database.url).pathname.slice(1);
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakPoolWaiting = Math.max(
      peakPoolWaiting,
      (b.app.database as { poolStats?: () => { waiting: number } | null }).poolStats?.()?.waiting ??
        0,
    );
    void b.app.veyra.db
      .execute(sql`select count(*)::int as n from pg_stat_activity where datname = ${dbName}`)
      .then((r) => {
        peakConnections = Math.max(peakConnections, rowsOf<{ n: number }>(r)[0]?.n ?? 0);
      })
      .catch(() => undefined);
  }, 200);
  return () => {
    clearInterval(timer);
    const cpu = process.cpuUsage(cpu0);
    const wall = (now() - t0) / 1000;
    return {
      apiProcessPeakRssMb: mb(peakRss),
      apiProcessPeakHeapMb: mb(peakHeap),
      apiProcessCpuPercent: Math.round(((cpu.user + cpu.system) / 1e6 / wall) * 100),
      peakDbConnections: peakConnections,
      peakPoolWaiting,
    };
  };
}

/** Invariants after a scenario. Any violation is reported and fails the run. */
async function verify(b: BenchApp) {
  const db = b.app.veyra.db;
  const jobs = count((await db.select({ s: t.jobs.status }).from(t.jobs)).map((j) => j.s));
  const invoices = count(
    (await db.select({ s: t.invoices.state }).from(t.invoices)).map((i) => i.s),
  );
  const writes = count(
    (await db.select({ s: t.erpWrites.status }).from(t.erpWrites)).map((w) => w.s),
  );
  const erpInvoices = await b.app.veyra.erp.listPurchaseInvoices();
  const keys = erpInvoices.map((p) => `${p.vendorId}|${p.vendorInvoiceNo}`);
  const duplicateErpInvoices = keys.length - new Set(keys).size;
  const perInvoice = rowsOf<{ n: number }>(
    await db.execute(
      sql`select count(*)::int as n from erp_writes where operation = 'recordPurchaseInvoice' group by invoice_id having count(*) > 1`,
    ),
  ).length;
  const problems: string[] = [];
  if ((jobs.queued ?? 0) + (jobs.running ?? 0) > 0) problems.push('jobs left queued/running');
  for (const s of ['UPLOADED', 'EXTRACTING', 'MATCHING', 'RESOLVING', 'VALIDATING', 'COMMITTING'])
    if (invoices[s]) problems.push(`invoices left in ${s}`);
  if (duplicateErpInvoices)
    problems.push(`${duplicateErpInvoices} duplicate ERP purchase invoices`);
  if (perInvoice) problems.push(`${perInvoice} invoices with more than one ERP invoice write`);
  const failedWrites = (
    await db
      .select({
        op: t.erpWrites.operation,
        status: t.erpWrites.status,
        code: t.erpWrites.errorCode,
      })
      .from(t.erpWrites)
  ).filter((w) => w.status !== 'confirmed');
  if (failedWrites.length)
    problems.push(
      `unconfirmed ERP writes: ${JSON.stringify(count(failedWrites.map((w) => `${w.op}:${w.status}:${w.code ?? '-'}`)))}`,
    );
  return { jobs, invoices, erpWrites: writes, erpPurchaseInvoices: erpInvoices.length, problems };
}

/** BENCH_ONLY=workers3.digital10 runs one scenario (to reproduce a single result). */
const only = process.env.BENCH_ONLY;

async function scenario(
  name: string,
  workers: number,
  warmKind: string,
  fn: (b: BenchApp) => Promise<Record<string, unknown>>,
  key = '',
) {
  if (only && only !== `workers${workers}.${key}`) return undefined;
  const b = await benchApp();
  const w = await startWorkers(b, workers - 1);
  // Warm every worker process with one document of the same kind first (not measured): a fresh
  // process pays a one-time start of its document readers, which would otherwise dominate.
  const warm = await realisticMany(Array.from({ length: workers }, () => warmKind));
  const warmIds = (await Promise.all(warm.map((d) => upload(b, d.file, d.bytes, d.mime)))).map(
    (r) => (r.json as { invoiceId: string }).invoiceId,
  );
  await waitSettled(b, warmIds, now());
  const stop = sampler(b);
  try {
    const measured = await fn(b);
    const resources = stop();
    const workerReports = await w.stop();
    const checks = await verify(b);
    const out = { ...measured, resources, workerReports, checks };
    log(`\n${name} — ${workers} worker(s)`);
    log(JSON.stringify(out, null, 1).replace(/\n\s*/g, ' '));
    if (checks.problems.length) process.exitCode = 1;
    return out;
  } finally {
    await b.close();
  }
}

async function concurrentUploads(
  b: BenchApp,
  docs: { file: string; bytes: Uint8Array; mime: string }[],
) {
  const t0 = now();
  const res = await Promise.all(docs.map((d) => upload(b, d.file, d.bytes, d.mime)));
  const errors = res.filter((r) => r.status !== 201).length;
  const ids = res
    .filter((r) => r.status === 201)
    .map((r) => (r.json as { invoiceId: string }).invoiceId);
  const settled = await waitSettled(b, ids, t0);
  const wall = now() - t0;
  return {
    uploadApiMs: stats(
      res.map((r) => r.ms),
      errors,
    ),
    uploadToSettledMs: stats([...settled.values()].map((s) => s.ms)),
    allSettledMs: Math.round(wall),
    invoicesPerMinute: Math.round((ids.length / wall) * 60_000 * 10) / 10,
    outcomes: count([...settled.values()].map((s) => s.state)),
  };
}

for (const workers of [1, 3]) {
  const key = `workers${workers}`;
  const r: Record<string, unknown> = {};
  // Rendered before anything is measured (rendering is not part of Veyra).
  const MIX = ['D01', 'D07', 'D08', 'D09', 'D10', 'D12', 'D06', 'D01', 'D07', 'D08'];
  const digitalDocs = await realisticMany([...MIX, ...MIX, ...MIX]);
  const photoDocs = await realisticMany(['D02', 'D03', 'D04', 'D05', 'D03', 'D04']);
  const answerDocs = await realisticMany(Array.from({ length: 11 }, () => 'D12'));
  const inboxDocs = await realisticMany(MIX);
  r.digital10 = await scenario(
    '30 concurrent digital PDF uploads',
    workers,
    'D01',
    (b) => concurrentUploads(b, digitalDocs),
    'digital10',
  );
  r.photo6 = await scenario(
    '6 concurrent photo uploads (OCR)',
    workers,
    'D03',
    (b) => concurrentUploads(b, photoDocs),
    'photo6',
  );
  r.answers10 = await scenario(
    '10 concurrent answers + a double-answer race',
    workers,
    'D12',
    async (b) => {
      const docs = answerDocs;
      const ids: string[] = [];
      for (const d of docs)
        ids.push(
          ((await upload(b, d.file, d.bytes, d.mime)).json as { invoiceId: string }).invoiceId,
        );
      await waitSettled(b, ids, now());
      const open = await b.app.veyra.db
        .select()
        .from(t.questions)
        .where(eq(t.questions.status, 'open'));
      const byInvoice = new Map(open.map((q) => [q.invoiceId, q]));
      const answerFor = (q: (typeof open)[number]) => {
        const spec = (
          JSON.parse(q.inputSchemaJson ?? '{}') as Record<
            string,
            { lines?: { poLineNo: number; suggestedQty: string }[]; minDate?: string } | undefined
          >
        ).confirm;
        return {
          optionId: 'confirm',
          input: {
            grnDate: spec?.minDate ?? '2026-09-20',
            lines: (spec?.lines ?? []).map((l) => ({
              poLineNo: l.poLineNo,
              received: l.suggestedQty,
              accepted: l.suggestedQty,
            })),
          },
        };
      };
      const qs = ids.map((id) => byInvoice.get(id)).filter((q) => q !== undefined);
      const race = qs.pop();
      const t0 = now();
      const answers = await Promise.all(
        qs.map((q) => call(b, 'POST', `/questions/${q.id}/answer`, answerFor(q))),
      );
      const raced = race
        ? await Promise.all(
            [0, 1].map(() => call(b, 'POST', `/questions/${race.id}/answer`, answerFor(race))),
          )
        : [];
      await waitSettled(b, ids, t0);
      return {
        questionCodes: count(open.map((q) => q.code)),
        answerApiMs: stats(
          answers.filter((a) => a.status === 200).map((a) => a.ms),
          answers.filter((a) => a.status !== 200).length,
        ),
        answerStatuses: count(answers.map((a) => String(a.status))),
        doubleAnswerStatuses: raced.map((a) => a.status).sort(),
        outcomes: count(
          (await b.app.veyra.db.select({ s: t.invoices.state }).from(t.invoices)).map((i) => i.s),
        ),
      };
    },
    'answers10',
  );
  r.inbox10 = await scenario(
    '10 concurrent inbox clients during processing',
    workers,
    'D01',
    async (b) => {
      const docs = inboxDocs;
      const t0 = now();
      const uploads = Promise.all(docs.map((d) => upload(b, d.file, d.bytes, d.mime)));
      const samples: number[] = [];
      let errors = 0;
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          for (let i = 0; i < 20; i++) {
            const res = await call(b, 'GET', '/invoices');
            if (res.status === 200) samples.push(res.ms);
            else errors++;
          }
        }),
      );
      const ids = (await uploads).map((u) => (u.json as { invoiceId: string }).invoiceId);
      await waitSettled(b, ids, t0);
      return { inboxMs: stats(samples, errors, now() - t0) };
    },
    'inbox10',
  );
  results[key] = r;
}

await closeRenderer();
if (only) process.exit(process.exitCode ?? 0);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = new URL(`./results/${label}.json`, import.meta.url);
writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
log(`\nwritten ${file.pathname}`);
process.exit(process.exitCode ?? 0);
